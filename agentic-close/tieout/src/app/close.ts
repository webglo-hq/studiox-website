/**
 * Close management use cases: run the close agents, complete and sign off checklist tasks
 * (AX-CL-01, reviewer ≠ preparer), finalize the close package and lock the period (AX-CL-02).
 */
import { audit } from '../core/audit/audit';
import { conflict, forbidden, invariant, notFound, precondition, sodViolation, validation } from '../core/util/errors';
import { sha256Hex } from '../core/util/hash';
import { canonicalJson } from '../core/util/json';
import { runCloseAgents, type CloseRunResult } from '../packs/accounting/close/orchestrate';
import { AccountingServices } from '../packs/accounting/services';
import type { AppContext, RequestUser } from './context';
import { assertCanActOn, assertInScope, requireGroupAccess, requirePermission } from './context';

export async function startCloseAgents(ctx: AppContext, u: RequestUser, periodKey: string, opts: { only?: string[] } = {}): Promise<CloseRunResult> {
  requirePermission(u, 'agent.run');
  const gate = ctx.limiter.check(`close-agents:${u.tenantId}`, 6, 60_000);
  if (!gate.ok) throw precondition('The close agents were started very recently; wait a moment.');
  return runCloseAgents({ db: ctx.db, runtime: ctx.runtime, clock: ctx.clock }, { tenantId: u.tenantId, periodKey, requester: u.actor, only: opts.only });
}

export async function completeTask(ctx: AppContext, u: RequestUser, taskId: string, note?: string) {
  requirePermission(u, 'close.manage');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const t = await tx.get('close_tasks', taskId);
    if (!t) throw notFound('Task', taskId);
    assertCanActOn(u, t.entity_id, 'This checklist task');
    if (t.status === 'done' || t.status === 'skipped') throw conflict('This task is already finished.');
    const now = ctx.clock.now().toISOString();
    const deps = await tx.find('close_task_dependencies', { task_id: t.id });
    const open = [];
    for (const d of deps) {
      const dt = await tx.get('close_tasks', d.depends_on_task_id);
      if (dt && dt.status !== 'done' && dt.status !== 'skipped') open.push(dt.title);
    }
    const next = t.reviewer_role ? 'ready_for_review' : 'done';
    if (next === 'done' && open.length) throw invariant('AX-CL-01', `finish first: ${open.join('; ')}`);
    const updated = await tx.update('close_tasks', t.id, { status: next, completed_by: u.actor.id, completed_at: now, blocked_reason: null, notes: note ? `${t.notes ? `${t.notes} · ` : ''}${note}`.slice(0, 2000) : t.notes });
    await tx.insert('signoffs', { subject_type: 'close_task', subject_id: t.id, role: 'preparer', user_id: u.actor.id, statement: `I completed “${t.title}”.`, content_hash: null, signed_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'close.task.complete', subjectType: 'close_task', subjectId: t.id, summary: `${t.title} marked ${next === 'done' ? 'done' : 'ready for review'}`, data: { note: note ?? null } }, u.ip);
    return updated;
  });
}

export async function signOffTask(ctx: AppContext, u: RequestUser, taskId: string) {
  requirePermission(u, 'close.signoff');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const t = await tx.get('close_tasks', taskId);
    if (!t) throw notFound('Task', taskId);
    assertCanActOn(u, t.entity_id, 'This checklist task');
    if (t.status !== 'ready_for_review') throw conflict('The task is not ready for review yet.');
    if (t.completed_by === u.actor.id) throw sodViolation('You completed this task, so someone else has to sign it off (SOD-01).');
    if (t.agent_run_id) {
      const run = await tx.get('agent_runs', t.agent_run_id);
      if (run?.requested_by === u.actor.id && !t.completed_by) throw sodViolation('You ran the agents for this task, so someone else has to sign it off (SOD-02).');
    }
    const deps = await tx.find('close_task_dependencies', { task_id: t.id });
    for (const d of deps) {
      const dt = await tx.get('close_tasks', d.depends_on_task_id);
      if (dt && dt.status !== 'done' && dt.status !== 'skipped') throw invariant('AX-CL-01', `“${dt.title}” must be signed off first`);
    }
    const now = ctx.clock.now().toISOString();
    const updated = await tx.update('close_tasks', t.id, { status: 'done', reviewed_by: u.actor.id, reviewed_at: now, completed_by: t.completed_by ?? null, completed_at: t.completed_at ?? now });
    await tx.insert('signoffs', { subject_type: 'close_task', subject_id: t.id, role: 'reviewer', user_id: u.actor.id, statement: `I reviewed and signed off “${t.title}”.`, content_hash: null, signed_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'close.task.signoff', subjectType: 'close_task', subjectId: t.id, summary: `${t.title} signed off`, data: {} }, u.ip);
    return updated;
  });
}

export async function finalizePackage(ctx: AppContext, u: RequestUser, packageId: string) {
  requirePermission(u, 'close.package');
  requireGroupAccess(u, 'The close package');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const pkg = await tx.get('close_packages', packageId);
    if (!pkg) throw notFound('Close package', packageId);
    if (pkg.status === 'final') throw conflict('This package is already final.');
    const now = ctx.clock.now().toISOString();
    const hash = sha256Hex(canonicalJson(pkg.content as unknown as Record<string, unknown>));
    if (hash !== pkg.content_hash) throw invariant('AX-AUD-01', 'the package content no longer matches its hash');
    const updated = await tx.update('close_packages', pkg.id, { status: 'final' });
    await tx.insert('signoffs', { subject_type: 'close_package', subject_id: pkg.id, role: 'approver', user_id: u.actor.id, statement: `I approve the ${pkg.period_key} close package v${pkg.version}.`, content_hash: hash, signed_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'close.package.finalize', subjectType: 'close_package', subjectId: pkg.id, summary: `Close package ${pkg.period_key} v${pkg.version} finalized`, data: { contentHash: hash } }, u.ip);
    return updated;
  });
}

/** Soft-close then lock every entity's period, only when AX-CL-02 holds. */
export async function lockPeriod(ctx: AppContext, u: RequestUser, periodKey: string) {
  requirePermission(u, 'close.lock');
  requireGroupAccess(u, 'Locking the period');
  return ctx.db.tx(u.tenantId, async (tx) => {
    const svc = new AccountingServices(tx, u.actor, ctx.clock);
    const r = await svc.close.readiness(periodKey);
    if (!r.ready) throw invariant('AX-CL-02', r.messages.join('; '), { readiness: r });
    const now = ctx.clock.now().toISOString();
    for (const p of await tx.find('periods', { period_key: periodKey })) {
      if (p.status === 'open') await tx.update('periods', p.id, { status: 'soft_closed', soft_closed_at: now, soft_closed_by: u.actor.id });
      if (p.status !== 'locked') await tx.update('periods', p.id, { status: 'locked', locked_at: now, locked_by: u.actor.id });
    }
    const cp = await tx.findOne('close_periods', { period_key: periodKey });
    if (cp) await tx.update('close_periods', cp.id, { status: 'closed', closed_at: now, closed_by: u.actor.id });
    const lockTask = cp ? await tx.findOne('close_tasks', { close_period_id: cp.id, key: 'lock' }) : undefined;
    if (lockTask) await tx.update('close_tasks', lockTask.id, { status: 'done', completed_by: u.actor.id, completed_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'period.lock', subjectType: 'close_period', subjectId: cp?.id ?? periodKey, summary: `${periodKey} locked for all entities`, data: {} }, u.ip);
    return { periodKey, locked: true };
  });
}

/** Re-open a locked period: Controller/CFO, documented reason (AX-PD-03). */
export async function reopenPeriod(ctx: AppContext, u: RequestUser, periodKey: string, entityId: string, reason: string) {
  requirePermission(u, 'close.lock');
  if (!reason || reason.trim().length < 10) throw validation('Unlocking needs a documented reason (at least 10 characters).');
  assertInScope(u, entityId);
  return ctx.db.tx(u.tenantId, async (tx) => {
    const p = await tx.findOne('periods', { period_key: periodKey, entity_id: entityId });
    if (!p) throw notFound('Period', periodKey);
    if (p.status !== 'locked') throw conflict('The period is not locked.');
    if (!u.actor.roles.some((r) => r === 'controller' || r === 'cfo')) throw forbidden('Only a Controller or CFO can reopen a locked period.');
    const updated = await tx.update('periods', p.id, { status: 'soft_closed', status_reason: reason.trim(), reopen_count: p.reopen_count + 1 });
    await audit(tx, u.actor, ctx.clock, { action: 'period.reopen', subjectType: 'period', subjectId: p.id, entityId, summary: `${periodKey} reopened: ${reason.trim()}`, data: {} }, u.ip);
    return updated;
  });
}
