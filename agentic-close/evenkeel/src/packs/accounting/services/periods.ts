import { addMonths } from '../../../framework/util/dates';
import { AppError } from '../../../framework/util/errors';
import { audit } from '../domain/audit';
import { requirePermission, withDb, type ServiceContext } from '../domain/context';
import { entities } from '../domain/refdata';
import { closeOntology } from '../ontology';
import { contentHash, buildPackageContent, type PackageContent } from './package';

/**
 * Period state machine: open → soft_close → hard_close (locked), enforced by the database.
 * Locking checks the ontology's period-close axiom (AX-CLS-02) with facts gathered here:
 * every task complete, every reconciliation reviewed, every material variance explained and
 * approved, no proposals awaiting a decision, no unposted entries, exceptions dispositioned
 * and a final close package whose numbers still match the ledger.
 */

export interface LockCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  link?: string;
}

export interface LockReadiness {
  periodKey: string;
  ok: boolean;
  checks: LockCheck[];
  periodStatus: { entityCode: string; status: string }[];
}

export async function lockReadiness(ctx: ServiceContext, periodKey: string): Promise<LockReadiness> {
  requirePermission(ctx, 'close.view');
  const cycle = await ctx.db.findOne('close_cycle', { tenant_id: ctx.tenantId, period_key: periodKey });
  const tasks = cycle ? await ctx.db.find('close_task', { close_cycle_id: cycle.id }) : [];
  const recs = await ctx.db.find('reconciliation', { tenant_id: ctx.tenantId, period_key: periodKey });
  const proposals = await ctx.db.find('proposal', { tenant_id: ctx.tenantId, period_key: periodKey, status: { in: ['pending', 'suggested'] } });
  const drafts = await ctx.db.find('journal_entry', { tenant_id: ctx.tenantId, period_key: periodKey, status: { in: ['draft', 'pending_approval'] } });
  const issues = await ctx.db.find('issue', { tenant_id: ctx.tenantId, period_key: periodKey, status: 'open' });
  const analyses = await ctx.db.find('flux_analysis', { tenant_id: ctx.tenantId, period_key: periodKey });
  const fluxLines = analyses.length ? await ctx.db.find('flux_line', { flux_analysis_id: { in: analyses.map((a) => a.id) }, is_material: true }) : [];
  const pkgs = await ctx.db.find('close_package', { tenant_id: ctx.tenantId, period_key: periodKey }, { orderBy: [['version', 'desc']] });
  const finalPkg = pkgs.find((p) => p.status === 'final');
  let pkgCurrent = false;
  if (finalPkg) {
    const fresh = await buildPackageContent(ctx, periodKey, (finalPkg.content as unknown as PackageContent).commentary ?? null);
    pkgCurrent = contentHash(fresh) === finalPkg.content_hash;
  }
  const notComplete = tasks.filter((t) => t.status !== 'complete');
  const notReviewed = recs.filter((r) => r.status !== 'reviewed');
  const unexplainedFlux = fluxLines.filter((l) => l.status !== 'approved');
  const blockingIssues = issues.filter((i) => i.severity === 'high' || i.severity === 'critical');
  const checks: LockCheck[] = [
    { id: 'tasks', label: 'Every close task is complete', ok: tasks.length > 0 && notComplete.length === 0, detail: notComplete.length ? `${notComplete.length} open: ${notComplete.map((t) => t.code).join(', ')}` : `${tasks.length} of ${tasks.length} complete`, link: '#/cockpit' },
    { id: 'recs', label: 'Every reconciliation is reviewed', ok: recs.length > 0 && notReviewed.length === 0, detail: notReviewed.length ? `${notReviewed.length} not reviewed` : `${recs.length} reviewed`, link: '#/recs' },
    { id: 'flux', label: 'Material variances are explained and approved', ok: analyses.length > 0 && unexplainedFlux.length === 0, detail: !analyses.length ? 'Flux analysis has not run' : unexplainedFlux.length ? `${unexplainedFlux.length} material variance(s) not approved` : `${fluxLines.length} material variance(s) approved`, link: '#/flux' },
    { id: 'proposals', label: 'No agent proposals await a decision', ok: proposals.length === 0, detail: proposals.length ? `${proposals.length} waiting in the inbox` : 'Inbox is clear', link: '#/inbox' },
    { id: 'entries', label: 'No draft or unapproved journal entries', ok: drafts.length === 0, detail: drafts.length ? `${drafts.length} entr${drafts.length === 1 ? 'y' : 'ies'} not posted` : 'None', link: '#/journals' },
    { id: 'issues', label: 'High-severity exceptions are dispositioned', ok: blockingIssues.length === 0, detail: blockingIssues.length ? `${blockingIssues.length} high/critical exception(s) still open` : issues.length ? `${issues.length} lower-severity exception(s) open — will carry forward` : 'All dispositioned', link: '#/issues' },
    { id: 'package', label: 'Final close package matches the ledger', ok: !!finalPkg && pkgCurrent, detail: !finalPkg ? (pkgs.length ? 'Package is a draft awaiting CFO approval' : 'No package yet') : pkgCurrent ? `Version ${finalPkg.version} approved` : 'Numbers changed after approval — regenerate', link: '#/package' },
  ];
  // The ontology's period-close axiom (AX-CLS-02) is the authority; the checks above are its facts.
  const axiom = closeOntology().validate(
    'ek:FiscalPeriod',
    { openTasks: notComplete.length, uncertifiedRecs: notReviewed.length, unexplainedMaterialFlux: analyses.length ? unexplainedFlux.length : 1, pendingProposals: proposals.length, packageGenerated: !!finalPkg && pkgCurrent, openCriticalIssues: blockingIssues.length },
    {},
    { only: ['AX-CLS-02'] },
  );
  if (!axiom.ok && checks.every((c) => c.ok)) checks.push({ id: 'axiom', label: 'Ontology axiom AX-CLS-02', ok: false, detail: axiom.violations.map((v) => v.message).join(' ') });
  const ents = await entities(ctx);
  const periods = await ctx.db.find('fiscal_period', { tenant_id: ctx.tenantId, period_key: periodKey });
  return { periodKey, ok: checks.every((c) => c.ok) && axiom.ok, checks, periodStatus: periods.map((p) => ({ entityCode: ents.get(p.entity_id)?.code ?? '', status: p.status })) };
}

export async function softClose(ctx: ServiceContext, periodKey: string): Promise<void> {
  requirePermission(ctx, 'period.soft_close');
  const periods = await ctx.db.find('fiscal_period', { tenant_id: ctx.tenantId, period_key: periodKey, status: 'open' });
  if (!periods.length) throw new AppError('CONFLICT', `${periodKey} is not open.`);
  const now = ctx.clock.nowIso();
  await ctx.db.tx(async (db) => {
    for (const p of periods) await db.update('fiscal_period', p.id, { status: 'soft_close', soft_closed_at: now, soft_closed_by: ctx.actor.userId });
    await audit(withDb(ctx, db), { action: 'period.soft_closed', subjectType: 'fiscal_period', subjectId: periodKey, data: { entities: periods.length } });
  });
}

/** Lock (hard-close) the period for every entity. Soft-closes first if needed. */
export async function lockPeriod(ctx: ServiceContext, periodKey: string, statement?: string): Promise<LockReadiness> {
  requirePermission(ctx, 'period.lock');
  const ready = await lockReadiness(ctx, periodKey);
  if (!ready.ok) throw new AppError('CONFLICT', `Not ready to lock: ${ready.checks.filter((c) => !c.ok).map((c) => `${c.label} (${c.detail})`).join('; ')}`, { checks: ready.checks });
  const now = ctx.clock.nowIso();
  await ctx.db.tx(async (db) => {
    const periods = await db.find('fiscal_period', { tenant_id: ctx.tenantId, period_key: periodKey });
    for (const p of periods) {
      if (p.status === 'open') await db.update('fiscal_period', p.id, { status: 'soft_close', soft_closed_at: now, soft_closed_by: ctx.actor.userId });
      if (p.status !== 'hard_close') await db.update('fiscal_period', p.id, { status: 'hard_close', hard_closed_at: now, hard_closed_by: ctx.actor.userId });
    }
    const cycle = await db.findOne('close_cycle', { tenant_id: ctx.tenantId, period_key: periodKey });
    if (cycle) {
      await db.update('close_cycle', cycle.id, { status: 'closed', closed_at: now });
      await db.insert('signoff', { tenant_id: ctx.tenantId, subject_type: 'close_cycle', subject_id: cycle.id, role: 'approver', user_id: ctx.actor.userId!, signed_at: now, statement: statement?.trim() || `I confirm the ${periodKey} close is complete and lock the period.`, content_hash: null });
    }
    const next = addMonths(periodKey, 1);
    const nextCycle = await db.findOne('close_cycle', { tenant_id: ctx.tenantId, period_key: next });
    if (!nextCycle) await db.insert('close_cycle', { tenant_id: ctx.tenantId, period_key: next, status: 'not_started', target_workday: cycle?.target_workday ?? 5, created_at: now });
    await audit(withDb(ctx, db), { action: 'period.locked', subjectType: 'fiscal_period', subjectId: periodKey, data: { checks: ready.checks.map((c) => c.id) } });
  });
  return lockReadiness(ctx, periodKey);
}

export async function reopenPeriod(ctx: ServiceContext, periodKey: string, reason: string): Promise<void> {
  requirePermission(ctx, 'period.reopen');
  if (!reason || reason.trim().length < 10) throw new AppError('VALIDATION', 'Reopening a locked period needs a documented reason (at least 10 characters).');
  const periods = await ctx.db.find('fiscal_period', { tenant_id: ctx.tenantId, period_key: periodKey, status: 'hard_close' });
  if (!periods.length) throw new AppError('CONFLICT', `${periodKey} is not locked.`);
  const now = ctx.clock.nowIso();
  await ctx.db.tx(async (db) => {
    for (const p of periods) await db.update('fiscal_period', p.id, { status: 'soft_close', reopened_at: now, reopen_reason: reason.trim() });
    const cycle = await db.findOne('close_cycle', { tenant_id: ctx.tenantId, period_key: periodKey });
    if (cycle) await db.update('close_cycle', cycle.id, { status: 'in_review', closed_at: null });
    await audit(withDb(ctx, db), { action: 'period.reopened', subjectType: 'fiscal_period', subjectId: periodKey, data: { reason: reason.trim() } });
  });
}

export async function periodsOverview(ctx: ServiceContext) {
  requirePermission(ctx, 'close.view');
  const ents = await entities(ctx);
  const periods = await ctx.db.find('fiscal_period', { tenant_id: ctx.tenantId }, { orderBy: [['period_key', 'asc']] });
  const cycles = await ctx.db.find('close_cycle', { tenant_id: ctx.tenantId });
  const keys = [...new Set(periods.map((p) => p.period_key))];
  return keys.map((k) => ({
    periodKey: k,
    cycle: cycles.find((c) => c.period_key === k)?.status ?? null,
    entities: periods.filter((p) => p.period_key === k).map((p) => ({ code: ents.get(p.entity_id)?.code ?? '', status: p.status, hardClosedAt: p.hard_closed_at })),
  }));
}
