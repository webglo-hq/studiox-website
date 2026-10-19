import { appendAudit } from '../../../audit/audit';
import type { Tx } from '../../../persistence/db';
import type { Row } from '../../../persistence/schema';
import { can, type Principal } from '../../../security/principal';
import type { DomainContext } from '../../../shared/context';
import { DomainError } from '../../../shared/errors';
import type { LedgerLookups } from '../domain/lookups';
import { fluxProblems } from './flux';
import { recTypeFor } from './recon';

/**
 * Period state machine (future -> open -> soft_closed -> locked; locked -> soft_closed on reopen) and the close
 * gate: a period locks only when every task is signed off, every required reconciliation is reviewed, nothing
 * awaits approval, the flux analysis is approved and the close package is final.
 */

export interface Blocker {
  kind: 'task' | 'reconciliation' | 'proposal' | 'flux' | 'package' | 'period';
  message: string;
  href?: string;
}

export async function closeBlockers(tx: Tx, lookups: LedgerLookups, closeId: string, opts: { ignoreTaskKeys?: string[] } = {}): Promise<Blocker[]> {
  const close = await tx.get('closes', closeId);
  if (!close) throw new DomainError('NOT_FOUND', 'close not found');
  const blockers: Blocker[] = [];
  const tasks = await tx.find('close_tasks', { close_id: closeId });
  for (const t of tasks) {
    if (opts.ignoreTaskKeys?.includes(t.key)) continue;
    if (t.status !== 'done' && t.status !== 'skipped') blockers.push({ kind: 'task', message: `${t.title}: ${t.status === 'ready_for_review' ? 'waiting for reviewer sign-off' : t.status.replace(/_/g, ' ')}`, href: `#/close/${closeId}?task=${t.id}` });
  }
  const periods = lookups.operatingEntities().map((e) => lookups.period(e.id, close.fiscal_year, close.period_number)).filter((p): p is Row<'periods'> => !!p);
  for (const p of periods) {
    const required = Array.from(lookups.accountsById.values()).filter((a) => recTypeFor(a) && ['bank', 'subledger_ap', 'subledger_ar'].includes(recTypeFor(a)!));
    const recs = await tx.find('reconciliations', { period_id: p.id });
    const entity = lookups.entitiesById.get(p.entity_id)!;
    for (const a of required) {
      const sums = await tx.sumLines({ tenantId: lookups.tenantId, entityIds: [p.entity_id], accountIds: [a.id], dateTo: p.end_date, groupBy: ['account_id'] });
      const used = sums.some((s) => s.line_count > 0);
      if (!used) continue;
      const rec = recs.filter((r) => r.account_id === a.id);
      if (!rec.length) blockers.push({ kind: 'reconciliation', message: `${entity.code} ${a.number} ${a.name}: reconciliation not started`, href: '#/recs' });
      for (const r of rec) if (r.status !== 'reviewed') blockers.push({ kind: 'reconciliation', message: `${entity.code} ${a.number} ${a.name}: ${r.status.replace('_', ' ')}`, href: `#/recs/${r.id}` });
    }
  }
  const pending = (await tx.find('proposals', { tenant_id: close.tenant_id, status: { in: ['pending', 'blocked'] } })).filter((p) => !p.period_id || periods.some((x) => x.id === p.period_id));
  if (pending.length) blockers.push({ kind: 'proposal', message: `${pending.length} proposal(s) still await a decision`, href: '#/inbox' });
  const flux = await tx.find('flux_analyses', { close_id: closeId });
  if (!flux.length) blockers.push({ kind: 'flux', message: 'Flux analysis has not been generated', href: '#/flux' });
  for (const f of flux) {
    if (f.status !== 'approved') blockers.push({ kind: 'flux', message: `Flux analysis (${f.comparison.replace('_', ' ')}) is not approved${(await fluxProblems(tx, f.id)).map((p) => `: ${p}`).join('')}`, href: '#/flux' });
  }
  const pkg = await tx.find('close_packages', { close_id: closeId, status: 'final' });
  if (!pkg.length) blockers.push({ kind: 'package', message: 'Close package is not approved', href: `#/close/${closeId}/package` });
  return blockers;
}

async function transition(tx: Tx, ctx: DomainContext, period: Row<'periods'>, to: Row<'periods'>['status'], principal: Principal, reason?: string): Promise<Row<'periods'>> {
  const now = ctx.clock.now();
  const patch: Partial<Row<'periods'>> = { status: to };
  if (to === 'soft_closed' && period.status === 'open') Object.assign(patch, { soft_closed_at: now, soft_closed_by: principal.user.id });
  if (to === 'locked') Object.assign(patch, { locked_at: now, locked_by: principal.user.id });
  if (to === 'soft_closed' && period.status === 'locked') Object.assign(patch, { reopened_count: period.reopened_count + 1 });
  const updated = await tx.update('periods', period.id, patch);
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: `period.${to === 'locked' ? 'lock' : period.status === 'locked' ? 'reopen' : to === 'soft_closed' ? 'soft_close' : 'open'}`, objectType: 'period', objectId: period.id, summary: `${period.name}: ${period.status} -> ${to}${reason ? ` (${reason})` : ''}` }, now);
  return updated;
}

export async function softClose(tx: Tx, ctx: DomainContext, principal: Principal, periodId: string): Promise<Row<'periods'>> {
  if (!can(principal, 'period.soft_close')) throw new DomainError('FORBIDDEN', 'Your role cannot soft-close periods.');
  const period = await tx.get('periods', periodId);
  if (!period || period.tenant_id !== ctx.tenantId) throw new DomainError('NOT_FOUND', 'period not found');
  if (period.status !== 'open') throw new DomainError('CONFLICT', `${period.name} is ${period.status.replace('_', ' ')}.`);
  return transition(tx, ctx, period, 'soft_closed', principal);
}

/** Lock every entity's period for a close (hard close). */
export async function lockClose(tx: Tx, ctx: DomainContext, lookups: LedgerLookups, principal: Principal, closeId: string, comment?: string): Promise<Row<'closes'>> {
  if (!can(principal, 'period.lock')) throw new DomainError('FORBIDDEN', 'Your role cannot lock periods.');
  const close = await tx.get('closes', closeId);
  if (!close || close.tenant_id !== ctx.tenantId) throw new DomainError('NOT_FOUND', 'close not found');
  if (close.status === 'closed') return close;
  const blockers = await closeBlockers(tx, lookups, closeId, { ignoreTaskKeys: ['lock'] });
  if (blockers.length) throw new DomainError('CONFLICT', `The period cannot be locked yet: ${blockers.slice(0, 3).map((b) => b.message).join('; ')}${blockers.length > 3 ? ` and ${blockers.length - 3} more` : ''}.`, { blockers });
  const entities = [...lookups.operatingEntities(), ...(lookups.eliminationEntity() ? [lookups.eliminationEntity()!] : [])];
  for (const e of entities) {
    const p = lookups.period(e.id, close.fiscal_year, close.period_number);
    if (!p) continue;
    let current = (await tx.get('periods', p.id))!;
    if (current.status === 'open') current = await transition(tx, ctx, current, 'soft_closed', principal);
    if (current.status === 'soft_closed') await transition(tx, ctx, current, 'locked', principal);
  }
  const lockTask = (await tx.find('close_tasks', { close_id: closeId, key: 'lock' }))[0];
  const now = ctx.clock.now();
  if (lockTask && lockTask.status !== 'done') {
    // The CFO (task reviewer) confirms the lock afterwards; maker-checker forbids self-review.
    await tx.update('close_tasks', lockTask.id, { status: lockTask.reviewer_id && lockTask.reviewer_id !== principal.user.id ? 'ready_for_review' : 'done', started_at: lockTask.started_at ?? now, completed_at: now, completed_by: principal.user.id, blocked_reason: null });
    await tx.insert('signoffs', { tenant_id: ctx.tenantId, object_type: 'close_task', object_id: lockTask.id, role: 'preparer', user_id: principal.user.id, comment: comment ?? 'Period locked' });
  }
  const updated = await tx.update('closes', closeId, { status: 'closed', closed_at: now, closed_by: principal.user.id });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'close.lock', objectType: 'close', objectId: closeId, summary: `Locked ${close.name} for all entities${comment ? `: ${comment}` : ''}` }, now);
  return updated;
}

export async function reopenPeriod(tx: Tx, ctx: DomainContext, lookups: LedgerLookups, principal: Principal, closeId: string, reason: string): Promise<Row<'closes'>> {
  if (!can(principal, 'period.reopen')) throw new DomainError('FORBIDDEN', 'Only the CFO can reopen a locked period.');
  if (!reason || reason.trim().length < 10) throw new DomainError('VALIDATION', 'Reopening a locked period needs a documented reason (at least 10 characters).');
  const close = await tx.get('closes', closeId);
  if (!close || close.tenant_id !== ctx.tenantId) throw new DomainError('NOT_FOUND', 'close not found');
  for (const e of [...lookups.operatingEntities(), ...(lookups.eliminationEntity() ? [lookups.eliminationEntity()!] : [])]) {
    const p = lookups.period(e.id, close.fiscal_year, close.period_number);
    const current = p ? await tx.get('periods', p.id) : null;
    if (current?.status === 'locked') await transition(tx, ctx, current, 'soft_closed', principal, reason.trim());
  }
  const updated = await tx.update('closes', closeId, { status: 'in_review', closed_at: null, closed_by: null });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'close.reopen', objectType: 'close', objectId: closeId, summary: `Reopened ${close.name}: ${reason.trim()}` }, ctx.clock.now());
  return updated;
}
