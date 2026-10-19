import type { Row } from '../../../framework/store/schema';
import { formatDate } from '../../../framework/util/dates';
import { AppError } from '../../../framework/util/errors';
import { workdayLabel } from '../../../framework/util/workdays';
import { blockers, satisfied, type OrchTask } from '../../../framework/runtime/orchestrator';
import { audit } from '../domain/audit';
import { canSeeEntity, hasPermission, requireEntity, requirePermission, withDb, type ServiceContext } from '../domain/context';
import { entities } from '../domain/refdata';
import { REC_TEMPLATE } from '../close/template';
import type { EkSchema } from '../store';
import { calendar, peopleMap, settings, type PersonRef } from './common';

type TaskRow = Row<EkSchema, 'close_task'>;

/**
 * Close calendar: cycles, tasks, dependencies, sign-offs. Task statuses move
 *   not_started → in_progress (agent working / waiting for approvals) → ready_for_review
 *   (prepared) → complete (reviewed by someone other than the preparer).
 * Completing a task requires its upstream tasks to be complete (AX-CLS-01) and its
 * reconciliations to be reviewed.
 */

export interface TaskView {
  id: string;
  code: string;
  title: string;
  description: string;
  category: string;
  entityCode: string | null;
  workday: number;
  workdayLabel: string;
  dueDate: string;
  dueLabel: string;
  overdue: boolean;
  status: TaskRow['status'];
  owner: PersonRef | null;
  reviewer: PersonRef | null;
  preparedBy: PersonRef | null;
  preparedAt: string | null;
  reviewedBy: PersonRef | null;
  reviewedAt: string | null;
  skillId: string | null;
  control: string | null;
  deps: string[];
  depCodes: string[];
  blockedBy: { code: string; title: string; reason: string }[];
  pendingProposals: number;
  autoApplied: number;
  lastRun: { id: string; status: string; summary: string | null; engine: string; at: string | null } | null;
  runs: number;
  recs: { id: string; title: string; status: string; unexplained: number }[];
  notes: string | null;
}

export interface CloseCalendar {
  periodKey: string;
  cycle: { id: string; status: string; startedAt: string | null; closedAt: string | null; targetWorkday: number; targetDate: string };
  today: string;
  todayWorkday: string;
  tasks: TaskView[];
  progress: { total: number; complete: number; readyForReview: number; inProgress: number; notStarted: number; blocked: number; pct: number };
  byEntity: { code: string; total: number; complete: number }[];
  byOwner: { person: PersonRef; total: number; complete: number; overdue: number }[];
  blockers: { taskCode: string; title: string; waitingOn: { code: string; title: string; reason: string }[] }[];
  pendingProposals: number;
  periodStatus: { entityCode: string; status: string }[];
}

async function cycleFor(ctx: ServiceContext, periodKey: string) {
  const c = await ctx.db.findOne('close_cycle', { tenant_id: ctx.tenantId, period_key: periodKey });
  if (!c) throw new AppError('NOT_FOUND', `No close calendar for ${periodKey}`);
  return c;
}

/** Orchestrator view of the tasks (shared with the agent engine). */
export async function orchTasks(ctx: ServiceContext, periodKey: string): Promise<(OrchTask & { row: TaskRow })[]> {
  const cycle = await cycleFor(ctx, periodKey);
  const tasks = await ctx.db.find('close_task', { close_cycle_id: cycle.id }, { orderBy: [['sort_order', 'asc']] });
  const deps = await ctx.db.find('close_task_dependency', { task_id: { in: tasks.map((t) => t.id) } });
  const runs = await ctx.db.find('agent_run', { tenant_id: ctx.tenantId, close_task_id: { in: tasks.map((t) => t.id) } });
  const proposals = runs.length ? await ctx.db.find('proposal', { run_id: { in: runs.map((r) => r.id) }, status: { in: ['pending', 'suggested'] } }) : [];
  return tasks.map((t) => {
    const tr = runs.filter((r) => r.close_task_id === t.id);
    return {
      id: t.id,
      code: t.code,
      title: t.title,
      skillId: t.skill_id,
      deps: deps.filter((d) => d.task_id === t.id).map((d) => d.depends_on_task_id),
      status: t.status,
      pendingProposals: proposals.filter((p) => tr.some((r) => r.id === p.run_id)).length,
      ran: tr.some((r) => ['queued', 'running', 'awaiting_approval', 'completed'].includes(r.status)),
      row: t,
    };
  });
}

export async function closeCalendar(ctx: ServiceContext, periodKey: string): Promise<CloseCalendar> {
  requirePermission(ctx, 'close.view');
  const cycle = await cycleFor(ctx, periodKey);
  const s = await settings(ctx);
  const cal = await calendar(ctx);
  const people = await peopleMap(ctx);
  const ents = await entities(ctx);
  const ot = await orchTasks(ctx, periodKey);
  const byId = new Map(ot.map((t) => [t.id, t]));
  const runs = await ctx.db.find('agent_run', { tenant_id: ctx.tenantId, close_task_id: { in: ot.map((t) => t.id) } }, { orderBy: [['created_at', 'desc']] });
  const autoCounts = runs.length ? await ctx.db.find('proposal', { run_id: { in: runs.map((r) => r.id) }, status: 'auto_applied' }) : [];
  const recs = await ctx.db.find('reconciliation', { tenant_id: ctx.tenantId, period_key: periodKey });
  const accts = new Map((await ctx.db.find('account', { tenant_id: ctx.tenantId })).map((a) => [a.id, a]));
  const today = ctx.clock.today(s.timezone);
  const p = (id: string | null) => (id ? (people.get(id) ?? null) : null);
  const bl = blockers(ot);
  const tasks: TaskView[] = ot.map((t) => {
    const r = t.row;
    const tr = runs.filter((x) => x.close_task_id === t.id);
    const last = tr[0];
    // The calendar is shared; what a run found, and other entities' reconciliations, are not.
    const visible = canSeeEntity(ctx, r.entity_id);
    const taskRecs = recs.filter((rc) => canSeeEntity(ctx, rc.entity_id) && REC_TEMPLATE.some((tpl) => tpl.task === r.code && tpl.account === accts.get(rc.account_id)?.code && ents.get(rc.entity_id)?.code === tpl.entity && tpl.type === rc.rec_type));
    const depRows = t.deps.map((d) => byId.get(d)).filter((x): x is NonNullable<typeof x> => !!x);
    return {
      id: r.id,
      code: r.code,
      title: r.title,
      description: r.description,
      category: r.category,
      entityCode: r.entity_id ? (ents.get(r.entity_id)?.code ?? null) : null,
      workday: r.workday,
      workdayLabel: workdayLabel(r.workday),
      dueDate: r.due_date,
      dueLabel: formatDate(r.due_date, 'short'),
      overdue: r.status !== 'complete' && r.due_date < today,
      status: r.status,
      owner: p(r.owner_id),
      reviewer: p(r.reviewer_id),
      preparedBy: p(r.prepared_by),
      preparedAt: r.prepared_at,
      reviewedBy: p(r.reviewed_by),
      reviewedAt: r.reviewed_at,
      skillId: r.skill_id,
      control: r.control_ref,
      deps: t.deps,
      depCodes: depRows.map((d) => d.code),
      blockedBy: (bl.find((b) => b.taskId === t.id)?.waitingOn ?? []).map((w) => ({ code: byId.get(w.taskId)?.code ?? '', title: w.title, reason: w.reason })),
      pendingProposals: t.pendingProposals,
      autoApplied: autoCounts.filter((a) => tr.some((x) => x.id === a.run_id)).length,
      lastRun: last ? { id: last.id, status: last.status, summary: visible ? last.summary : null, engine: last.engine, at: last.finished_at ?? last.started_at } : null,
      runs: tr.length,
      recs: taskRecs.map((rc) => ({ id: rc.id, title: rc.notes ?? '', status: rc.status, unexplained: rc.unexplained })),
      notes: r.notes,
    };
  });
  const count = (st: string) => tasks.filter((t) => t.status === st).length;
  const byOwner = new Map<string, { person: PersonRef; total: number; complete: number; overdue: number }>();
  for (const t of tasks) {
    if (!t.owner) continue;
    const o = byOwner.get(t.owner.id) ?? { person: t.owner, total: 0, complete: 0, overdue: 0 };
    o.total++;
    if (t.status === 'complete') o.complete++;
    if (t.overdue) o.overdue++;
    byOwner.set(t.owner.id, o);
  }
  const entityCodes = [...ents.values()].filter((e) => !e.is_elimination).map((e) => e.code);
  const periods = await ctx.db.find('fiscal_period', { tenant_id: ctx.tenantId, period_key: periodKey });
  const targetDate = cal.dateOf(periodKey, cycle.target_workday);
  return {
    periodKey,
    cycle: { id: cycle.id, status: cycle.status, startedAt: cycle.started_at, closedAt: cycle.closed_at, targetWorkday: cycle.target_workday, targetDate },
    today,
    todayWorkday: workdayLabel(cal.offsetOf(periodKey, today)),
    tasks,
    progress: { total: tasks.length, complete: count('complete'), readyForReview: count('ready_for_review'), inProgress: count('in_progress'), notStarted: count('not_started'), blocked: count('blocked'), pct: tasks.length ? Math.round((count('complete') / tasks.length) * 100) : 0 },
    byEntity: [...entityCodes, 'All'].map((code) => {
      const ts = tasks.filter((t) => (code === 'All' ? t.entityCode === null : t.entityCode === code));
      return { code, total: ts.length, complete: ts.filter((t) => t.status === 'complete').length };
    }),
    byOwner: [...byOwner.values()].sort((a, b) => a.person.name.localeCompare(b.person.name)),
    blockers: bl.map((b) => ({ taskCode: byId.get(b.taskId)?.code ?? '', title: b.title, waitingOn: b.waitingOn.map((w) => ({ code: byId.get(w.taskId)?.code ?? '', title: w.title, reason: w.reason })) })),
    pendingProposals: ot.reduce((s, t) => s + t.pendingProposals, 0),
    periodStatus: periods.map((x) => ({ entityCode: ents.get(x.entity_id)?.code ?? '', status: x.status })),
  };
}

/** Recompute an agent task's status from its runs and proposals (called after runs/decisions). */
export async function syncTaskFromRuns(ctx: ServiceContext, taskId: string): Promise<void> {
  const t = await ctx.db.get('close_task', taskId);
  if (!t || t.status === 'complete') return;
  const runs = await ctx.db.find('agent_run', { close_task_id: taskId });
  if (!runs.length) return;
  const live = runs.filter((r) => ['queued', 'running', 'awaiting_approval', 'completed'].includes(r.status));
  const pending = live.length ? await ctx.db.count('proposal', { run_id: { in: live.map((r) => r.id) }, status: { in: ['pending', 'suggested'] } }) : 0;
  const running = live.some((r) => r.status === 'queued' || r.status === 'running');
  const done = live.some((r) => r.status === 'completed' || r.status === 'awaiting_approval');
  const failed = !live.length && runs.some((r) => r.status === 'failed' || r.status === 'budget_exceeded');
  const now = ctx.clock.nowIso();
  if (failed) {
    if (t.status !== 'blocked') await ctx.db.update('close_task', t.id, { status: 'blocked', blocked_reason: runs[runs.length - 1]!.error?.slice(0, 300) ?? 'The agent run failed.' });
    return;
  }
  if (running || pending > 0) {
    if (t.status !== 'in_progress') await ctx.db.update('close_task', t.id, { status: 'in_progress', blocked_reason: null });
    return;
  }
  if (done && t.status !== 'ready_for_review') {
    await ctx.db.update('close_task', t.id, { status: 'ready_for_review', prepared_by: t.owner_id, prepared_at: now, blocked_reason: null });
    const signed = await ctx.db.findOne('signoff', { subject_type: 'close_task', subject_id: t.id, role: 'preparer' });
    if (!signed && t.owner_id) await ctx.db.insert('signoff', { tenant_id: ctx.tenantId, subject_type: 'close_task', subject_id: t.id, role: 'preparer', user_id: t.owner_id, signed_at: now, statement: 'Prepared by the agent on my behalf; all proposals decided.', content_hash: null });
  }
}

async function recsForTask(ctx: ServiceContext, task: TaskRow) {
  const cycle = (await ctx.db.get('close_cycle', task.close_cycle_id))!;
  const ents = await entities(ctx);
  const accts = new Map((await ctx.db.find('account', { tenant_id: ctx.tenantId })).map((a) => [a.id, a]));
  const recs = await ctx.db.find('reconciliation', { tenant_id: ctx.tenantId, period_key: cycle.period_key });
  return recs.filter((rc) => REC_TEMPLATE.some((tpl) => tpl.task === task.code && tpl.account === accts.get(rc.account_id)?.code && ents.get(rc.entity_id)?.code === tpl.entity && tpl.type === rc.rec_type));
}

export async function completionReadiness(ctx: ServiceContext, taskId: string): Promise<{ ok: boolean; reasons: string[] }> {
  const t = await ctx.db.get('close_task', taskId);
  if (!t || t.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Task not found');
  const reasons: string[] = [];
  if (t.status === 'complete') reasons.push('Already complete.');
  const deps = await ctx.db.find('close_task_dependency', { task_id: t.id });
  if (deps.length) {
    const up = await ctx.db.find('close_task', { id: { in: deps.map((d) => d.depends_on_task_id) } });
    const open = up.filter((u) => u.status !== 'complete');
    if (open.length) reasons.push(`Finish ${open.map((u) => u.code).join(', ')} first (dependencies).`);
  }
  const runs = await ctx.db.find('agent_run', { close_task_id: t.id });
  if (runs.length) {
    const pending = await ctx.db.count('proposal', { run_id: { in: runs.map((r) => r.id) }, status: { in: ['pending', 'suggested'] } });
    if (pending) reasons.push(`${pending} agent proposal${pending === 1 ? '' : 's'} still need a decision.`);
  }
  for (const rc of await recsForTask(ctx, t)) if (rc.status !== 'reviewed') reasons.push(`Reconciliation “${rc.notes}” is ${rc.status.replace('_', ' ')}, not reviewed.`);
  const preparer = t.prepared_by ?? t.owner_id;
  if (preparer && preparer === ctx.actor.userId) reasons.push('You prepared this task, so someone else must review and complete it.');
  if (!hasPermission(ctx.actor, 'close.task.review')) reasons.push('Your role cannot complete tasks.');
  return { ok: reasons.length === 0, reasons };
}

/** Owner actions: start, block (with reason), mark prepared. Reviewer action: complete. */
export async function updateTask(ctx: ServiceContext, input: { taskId: string; action: 'start' | 'block' | 'prepare' | 'complete' | 'reopen'; note?: string }): Promise<void> {
  const t = await ctx.db.get('close_task', input.taskId);
  if (!t || t.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Task not found');
  requireEntity(ctx, t.entity_id);
  const cycle = (await ctx.db.get('close_cycle', t.close_cycle_id))!;
  if (cycle.status === 'closed') throw new AppError('PERIOD_LOCKED', 'This close is finished; tasks cannot change.');
  const now = ctx.clock.nowIso();
  const me = ctx.actor.userId;
  const note = input.note?.trim() || null;
  await ctx.db.tx(async (db) => {
    const tctx = withDb(ctx, db);
    switch (input.action) {
      case 'start':
        requirePermission(ctx, 'close.task.update');
        await db.update('close_task', t.id, { status: 'in_progress', blocked_reason: null });
        break;
      case 'block':
        requirePermission(ctx, 'close.task.update');
        if (!note || note.length < 3) throw new AppError('VALIDATION', 'Say what is blocking the task.');
        await db.update('close_task', t.id, { status: 'blocked', blocked_reason: note });
        break;
      case 'prepare':
        requirePermission(ctx, 'close.task.update');
        if (t.owner_id !== me && !hasPermission(ctx.actor, 'close.task.assign')) throw new AppError('FORBIDDEN', 'Only the task owner can mark it prepared.');
        await db.update('close_task', t.id, { status: 'ready_for_review', prepared_by: me, prepared_at: now, blocked_reason: null, notes: note ?? t.notes });
        await db.insert('signoff', { tenant_id: ctx.tenantId, subject_type: 'close_task', subject_id: t.id, role: 'preparer', user_id: me!, signed_at: now, statement: note ?? 'Prepared.', content_hash: null });
        break;
      case 'complete': {
        const ready = await completionReadiness(tctx, t.id);
        if (!ready.ok) throw new AppError(ready.reasons.some((r) => r.includes('someone else')) ? 'SOD_VIOLATION' : 'CONFLICT', ready.reasons.join(' '));
        if (!t.prepared_by) await db.update('close_task', t.id, { prepared_by: t.owner_id, prepared_at: now });
        await db.update('close_task', t.id, { status: 'complete', reviewed_by: me, reviewed_at: now, completed_at: now });
        await db.insert('signoff', { tenant_id: ctx.tenantId, subject_type: 'close_task', subject_id: t.id, role: 'reviewer', user_id: me!, signed_at: now, statement: note ?? 'Reviewed and complete.', content_hash: null });
        break;
      }
      case 'reopen':
        requirePermission(ctx, 'close.task.review');
        if (!note || note.length < 5) throw new AppError('VALIDATION', 'Give a reason to reopen the task.');
        await db.update('close_task', t.id, { status: 'in_progress', reviewed_by: null, reviewed_at: null, completed_at: null, notes: note });
        break;
    }
    await audit(tctx, { action: `task.${input.action}`, subjectType: 'close_task', subjectId: t.id, data: { code: t.code, note } });
  });
}

export async function assignTask(ctx: ServiceContext, input: { taskId: string; ownerId?: string; reviewerId?: string }): Promise<void> {
  requirePermission(ctx, 'close.task.assign');
  const t = await ctx.db.get('close_task', input.taskId);
  if (!t || t.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Task not found');
  requireEntity(ctx, t.entity_id);
  const owner = input.ownerId ?? t.owner_id;
  const reviewer = input.reviewerId ?? t.reviewer_id;
  if (owner && reviewer && owner === reviewer) throw new AppError('SOD_VIOLATION', 'The owner and the reviewer must be different people.');
  await ctx.db.update('close_task', t.id, { owner_id: owner, reviewer_id: reviewer });
  await audit(ctx, { action: 'task.assigned', subjectType: 'close_task', subjectId: t.id, data: { code: t.code, owner, reviewer } });
}

export { satisfied };
