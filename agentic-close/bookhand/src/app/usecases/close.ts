import { appendAudit } from '../../audit/audit';
import type { Row } from '../../persistence/schema';
import { closeProgress, completeTask, reviewTask, signOffProblems, startTask, taskStates } from '../../packs/accounting/domain/close';
import { closeBlockers, lockClose, reopenPeriod } from '../../packs/accounting/services/periods';
import { certificationProblems, recTypeFor } from '../../packs/accounting/services/recon';
import { can, canOn, canSeeEntity, loadPrincipal, requireAllEntities, requirePermission, requirePermissionOn, type Principal } from '../../security/principal';
import { sha256Hex } from '../../shared/hash';
import { dateToWorkday, formatWorkday, usBusinessCalendar, workdayToDate } from '../../shared/dates';
import { DomainError } from '../../shared/errors';
import type { App, RequestMeta } from '../app';

/** Close calendar use cases: my home, the cockpit, running agents, task sign-offs, lock and reopen. */

export async function currentClose(app: App, tenantId: string): Promise<Row<'closes'> | null> {
  return app.read(async (tx) => {
    const closes = await tx.find('closes', { tenant_id: tenantId }, { orderBy: [['period_end', 'desc']] });
    return closes.find((c) => c.status === 'in_progress' || c.status === 'in_review') ?? closes[0] ?? null;
  });
}

export async function listCloses(app: App, p: Principal) {
  requirePermission(p, 'close.view');
  return app.read(async (tx) => {
    const closes = await tx.find('closes', { tenant_id: p.tenantId }, { orderBy: [['period_end', 'desc']] });
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
    const cal = usBusinessCalendar();
    return closes.map((c) => ({
      id: c.id,
      name: c.name,
      periodEnd: c.period_end,
      status: c.status,
      targetWorkday: c.target_workday,
      closedAt: c.closed_at,
      closedBy: c.closed_by ? users.get(c.closed_by) ?? null : null,
      closedOnWorkday: c.closed_at ? dateToWorkday(c.period_end, c.closed_at.slice(0, 10), cal) : null,
    }));
  });
}

export async function closeDetail(app: App, p: Principal, closeId: string) {
  requirePermission(p, 'close.view');
  return app.read(async (tx) => {
    const close = await tx.get('closes', closeId);
    if (!close || close.tenant_id !== p.tenantId) app.notFound('Close');
    const lookups = await app.lookups(tx, p.tenantId);
    // Entity scope: tasks of entities outside the person's access (and whole-organization tasks) are left out.
    const states = (await taskStates(tx, closeId)).filter((s) => canSeeEntity(p, s.task.entity_id));
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u]));
    const byId = new Map(states.map((s) => [s.task.id, s.task]));
    const proposals = await tx.find('proposals', { tenant_id: p.tenantId, status: { in: ['pending', 'blocked'] } });
    const runIds = states.map((s) => s.task.last_run_id).filter((x): x is string => !!x);
    const runs = new Map((runIds.length ? await tx.find('agent_runs', { id: { in: runIds } }) : []).map((r) => [r.id, r]));
    const cal = usBusinessCalendar();
    const businessDate = app.clock.businessDate();
    const blockers = p.entityIds === null ? await closeBlockers(tx, lookups, closeId) : [];
    const skills = new Map(app.runtime.listSkills().map((s) => [s.manifest.key, s.manifest]));
    const signOffGates = new Map<string, string[]>();
    for (const s of states.filter((x) => x.task.status === 'ready_for_review')) signOffGates.set(s.task.id, await signOffProblems(tx, s.task));
    return {
      close: { id: close.id, name: close.name, periodEnd: close.period_end, status: close.status, targetWorkday: close.target_workday, closedAt: close.closed_at, fiscalYear: close.fiscal_year, periodNumber: close.period_number },
      businessDate,
      currentWorkday: dateToWorkday(close.period_end, businessDate, cal),
      workdays: [1, 2, 3, 4, 5].map((wd) => ({ workday: wd, label: formatWorkday(wd), date: workdayToDate(close.period_end, wd, cal) })),
      progress: closeProgress(states),
      blockers,
      canRunAgents: canOn(p, 'skill.run', null) && close.status !== 'closed',
      liveModel: app.liveModel,
      tasks: states.map((s) => {
        const t = s.task;
        const run = t.last_run_id ? runs.get(t.last_run_id) : undefined;
        const owner = t.owner_id ? users.get(t.owner_id) : undefined;
        const reviewer = t.reviewer_id ? users.get(t.reviewer_id) : undefined;
        return {
          id: t.id,
          key: t.key,
          title: t.title,
          description: t.description,
          category: t.category,
          entity: t.entity_id ? lookups.entitiesById.get(t.entity_id)?.code ?? null : null,
          status: t.status,
          dueWorkday: t.due_workday,
          dueDate: t.due_date,
          overdue: !['done', 'skipped', 'ready_for_review'].includes(t.status) && t.due_date < businessDate,
          owner: owner ? { id: owner.id, name: owner.display_name, hue: owner.avatar_hue } : null,
          reviewer: reviewer ? { id: reviewer.id, name: reviewer.display_name, hue: reviewer.avatar_hue } : null,
          skillKey: t.skill_key,
          skillName: t.skill_key ? skills.get(t.skill_key)?.name ?? t.skill_key : null,
          ready: s.ready,
          blockedBy: s.blockedBy.map((b) => b.title),
          dependsOn: s.dependsOn.map((d) => byId.get(d)?.title ?? d),
          blockedReason: t.blocked_reason,
          pendingProposals: proposals.filter((x) => x.close_task_id === t.id).length,
          lastRun: run ? { id: run.id, status: run.status, summary: run.summary, finishedAt: run.finished_at, mode: run.mode } : null,
          completedAt: t.completed_at,
          completedByAgent: !!t.completed_by_run_id,
          reviewedAt: t.reviewed_at,
          reviewedBy: t.reviewed_by ? users.get(t.reviewed_by)?.display_name ?? null : null,
          canComplete: canOn(p, 'close.task.work', t.entity_id) && !['done', 'skipped', 'ready_for_review'].includes(t.status) && s.ready,
          canReview: canOn(p, 'close.task.review', t.entity_id) && t.status === 'ready_for_review' && t.completed_by !== p.user.id && !signOffGates.get(t.id)?.length,
          signOffBlockedBy: signOffGates.get(t.id) ?? [],
          canRun: !!t.skill_key && canOn(p, 'skill.run', t.entity_id) && s.ready && !['done', 'skipped'].includes(t.status),
        };
      }),
    };
  });
}

/** Start the close orchestrator (runs every ready agent task wave by wave) in the background. */
export async function runCloseAgents(app: App, p: Principal, closeId: string, opts: { mode?: 'offline' | 'live' } = {}, meta: RequestMeta = {}) {
  requirePermission(p, 'skill.run', 'run agents');
  const close = await app.read((tx) => tx.get('closes', closeId));
  if (!close || close.tenant_id !== p.tenantId) app.notFound('Close');
  // The orchestrator works every entity's tasks: the right to run agents must cover every entity.
  requirePermissionOn(p, 'skill.run', null, 'run the close agents');
  if (close.status === 'closed') throw new DomainError('CONFLICT', 'This close is locked.');
  const active = await app.read((tx) => tx.find('agent_runs', { close_id: closeId, skill_key: 'close-orchestrator', status: { in: ['queued', 'running'] } }));
  if (active.length) return { runId: active[0]!.id, alreadyRunning: true };
  const run = await app.runtime.start(p.tenantId, { skillKey: 'close-orchestrator', input: { closeId }, requestedBy: p.user.id, requestedByLabel: p.user.display_name, trigger: meta.channel === 'mcp' ? 'mcp' : meta.channel === 'api' ? 'api' : 'manual', closeId, mode: opts.mode });
  void app.queue.enqueue(run.id);
  return { runId: run.id, alreadyRunning: false };
}

/**
 * Keep the close moving after people act. When approvals or sign-offs unblock checklist tasks that no agent
 * has run yet, start the orchestrator again on behalf of whoever started the close agents (trigger
 * "orchestrator"), limited to skills that person may run. Idempotent per set of newly ready tasks, so
 * repeated triggers never start duplicate runs. Returns the run id when it started (or found) one.
 */
export async function continueClose(app: App, tenantId: string, closeId?: string | null): Promise<string | null> {
  const close = closeId ? await app.read((tx) => tx.get('closes', closeId)) : await currentClose(app, tenantId);
  if (!close || close.tenant_id !== tenantId || close.status === 'closed') return null;
  const plan = await app.read(async (tx) => {
    const runs = await tx.find('agent_runs', { close_id: close.id, skill_key: 'close-orchestrator' }, { orderBy: [['created_at', 'desc']], limit: 25 });
    if (!runs.length || runs.some((r) => r.status === 'queued' || r.status === 'running')) return null;
    const starter = runs.find((r) => r.trigger !== 'orchestrator' && r.requested_by) ?? runs.find((r) => r.requested_by);
    if (!starter?.requested_by) return null;
    const principal = await loadPrincipal(tx, tenantId, starter.requested_by);
    if (principal.user.status !== 'active' || principal.readOnly || !can(principal, 'skill.run')) return null;
    const states = await taskStates(tx, close.id);
    const fresh = states.filter((s) => {
      const t = s.task;
      if (!t.skill_key || !s.ready || t.last_run_id || ['done', 'skipped', 'ready_for_review'].includes(t.status)) return false;
      const manifest = app.runtime.listSkills().find((k) => k.manifest.key === t.skill_key)?.manifest;
      return !!manifest && can(principal, manifest.permissions.run as never);
    });
    return fresh.length ? { principal, taskIds: fresh.map((s) => s.task.id).sort() } : null;
  });
  if (!plan) return null;
  const run = await app.runtime.start(tenantId, {
    skillKey: 'close-orchestrator',
    input: { closeId: close.id },
    requestedBy: plan.principal.user.id,
    requestedByLabel: plan.principal.user.display_name,
    trigger: 'orchestrator',
    closeId: close.id,
    idempotencyKey: `continue:${close.id}:${sha256Hex(plan.taskIds.join(','))}`,
  });
  if (run.status === 'queued') void app.queue.enqueue(run.id);
  return run.id;
}

export async function runTask(app: App, p: Principal, taskId: string, opts: { mode?: 'offline' | 'live' } = {}) {
  requirePermission(p, 'skill.run', 'run agents');
  const { task, close, input } = await app.read(async (tx) => {
    const task = await tx.get('close_tasks', taskId);
    if (!task || task.tenant_id !== p.tenantId || !canSeeEntity(p, task.entity_id)) app.notFound('Task');
    requirePermissionOn(p, 'skill.run', task.entity_id, 'run agents');
    if (!task.skill_key) throw new DomainError('VALIDATION', 'This task is done by people; it has no agent.');
    const close = (await tx.get('closes', task.close_id))!;
    const entity = task.entity_id ? await tx.get('entities', task.entity_id) : null;
    const period = `${close.fiscal_year}-${String(close.period_number).padStart(2, '0')}`;
    const extra = task.key === 'ap-tieout' ? { ledger: 'ap' } : task.key === 'ar-tieout' ? { ledger: 'ar' } : task.key === 'flux' ? { comparison: 'prior_month' } : {};
    return { task, close, input: { closeId: close.id, closeTaskId: task.id, entity: entity?.code ?? null, period, ...extra } };
  });
  const states = await app.read((tx) => taskStates(tx, close.id));
  const st = states.find((s) => s.task.id === taskId)!;
  if (!st.ready) throw new DomainError('CONFLICT', `Waiting on: ${st.blockedBy.map((b) => b.title).join(', ')}`);
  const period = task.entity_id ? (await app.read(async (tx) => (await app.lookups(tx, p.tenantId)).period(task.entity_id!, close.fiscal_year, close.period_number)))?.id ?? null : null;
  const run = await app.runtime.start(p.tenantId, { skillKey: task.skill_key!, input, requestedBy: p.user.id, requestedByLabel: p.user.display_name, closeId: close.id, closeTaskId: task.id, entityId: task.entity_id, periodId: period, mode: opts.mode });
  void app.queue.enqueue(run.id);
  return { runId: run.id };
}

async function bsRecsGate(app: App, task: Row<'close_tasks'>): Promise<string[]> {
  if (task.key !== 'bs-recs' || !task.entity_id) return [];
  return app.read(async (tx) => {
    const close = (await tx.get('closes', task.close_id))!;
    const lookups = await app.lookups(tx, task.tenant_id);
    const period = lookups.period(task.entity_id!, close.fiscal_year, close.period_number)!;
    const recs = await tx.find('reconciliations', { period_id: period.id });
    const problems: string[] = [];
    for (const a of lookups.accountsById.values()) {
      const type = recTypeFor(a);
      if (!type || !['bank', 'subledger_ap', 'subledger_ar'].includes(type)) continue;
      const used = (await tx.sumLines({ tenantId: task.tenant_id, entityIds: [task.entity_id!], accountIds: [a.id], dateTo: period.end_date, groupBy: ['account_id'] })).some((s) => s.line_count > 0);
      if (!used) continue;
      const r = recs.filter((x) => x.account_id === a.id);
      if (!r.length) problems.push(`${a.number} ${a.name} has no reconciliation yet`);
      for (const x of r) {
        if (x.status !== 'reviewed') problems.push(`${a.number} ${a.name} is ${x.status.replace('_', ' ')}`);
        else problems.push(...(await certificationProblems(tx, x)).map((m) => `${a.number}: ${m}`));
      }
    }
    return problems;
  });
}

export async function completeCloseTask(app: App, p: Principal, taskId: string, note: string | undefined, meta: RequestMeta = {}) {
  requirePermission(p, 'close.task.work', 'complete close tasks');
  const task = await app.read((tx) => tx.get('close_tasks', taskId));
  if (!task || task.tenant_id !== p.tenantId || !canSeeEntity(p, task.entity_id)) app.notFound('Task');
  requirePermissionOn(p, 'close.task.work', task.entity_id, 'complete close tasks');
  if (task.key === 'lock') throw new DomainError('VALIDATION', 'Lock the period from the close page; locking completes this task.');
  const gate = await bsRecsGate(app, task);
  if (gate.length) throw new DomainError('CONFLICT', `Not every required reconciliation is certified: ${gate.slice(0, 4).join('; ')}`, { problems: gate });
  const pending = await app.read((tx) => tx.count('proposals', { close_task_id: taskId, status: { in: ['pending', 'blocked'] } }));
  if (pending) throw new DomainError('CONFLICT', `${pending} proposal(s) for this task still need a decision.`);
  const done = await app.tx(async (tx) => {
    const ctx = app.ctx(p, meta);
    if (task.status === 'not_started' || task.status === 'blocked') await startTask(tx, ctx, taskId);
    return completeTask(tx, ctx, taskId, { note });
  });
  await continueClose(app, p.tenantId, task.close_id);
  return done;
}

export async function reviewCloseTask(app: App, p: Principal, taskId: string, decision: 'approve' | 'send_back', note: string | undefined, meta: RequestMeta = {}) {
  requirePermission(p, 'close.task.review', 'sign off close tasks');
  const reviewed = await app.tx(async (tx) => {
    const task = await tx.get('close_tasks', taskId);
    if (!task || task.tenant_id !== p.tenantId || !canSeeEntity(p, task.entity_id)) app.notFound('Task');
    requirePermissionOn(p, 'close.task.review', task.entity_id, 'sign off close tasks');
    return reviewTask(tx, app.ctx(p, meta), taskId, decision, note);
  });
  await continueClose(app, p.tenantId, reviewed.close_id);
  return reviewed;
}

/** Sign off every task waiting for this reviewer (bulk). */
export async function reviewAllReady(app: App, p: Principal, closeId: string, meta: RequestMeta = {}) {
  requirePermission(p, 'close.task.review', 'sign off close tasks');
  const tasks = (await app.read((tx) => tx.find('close_tasks', { tenant_id: p.tenantId, close_id: closeId, status: 'ready_for_review' }))).filter((t) => canOn(p, 'close.task.review', t.entity_id));
  const results: Array<{ id: string; title: string; ok: boolean; error?: string }> = [];
  for (const t of tasks) {
    try {
      await app.tx((tx) => reviewTask(tx, app.ctx(p, meta), t.id, 'approve'));
      results.push({ id: t.id, title: t.title, ok: true });
    } catch (e) {
      results.push({ id: t.id, title: t.title, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (results.some((r) => r.ok)) await continueClose(app, p.tenantId, closeId);
  return { reviewed: results.filter((r) => r.ok).length, results };
}

export async function lockPeriod(app: App, p: Principal, closeId: string, comment: string | undefined, meta: RequestMeta = {}) {
  return app.tx(async (tx) => lockClose(tx, app.ctx(p, meta), await app.lookups(tx, p.tenantId), p, closeId, comment));
}

export async function reopenClose(app: App, p: Principal, closeId: string, reason: string, meta: RequestMeta = {}) {
  return app.tx(async (tx) => reopenPeriod(tx, app.ctx(p, meta), await app.lookups(tx, p.tenantId), p, closeId, reason));
}

export async function closePackage(app: App, p: Principal, closeId: string) {
  requirePermission(p, 'reports.view');
  return app.read(async (tx) => {
    const close = await tx.get('closes', closeId);
    if (!close || close.tenant_id !== p.tenantId) app.notFound('Close');
    requireAllEntities(p, 'The close package');
    const packages = await tx.find('close_packages', { close_id: closeId }, { orderBy: [['version', 'desc']] });
    const proposal = (await tx.find('proposals', { tenant_id: p.tenantId, kind: 'task_update', status: { in: ['pending', 'approved'] } }, { orderBy: [['created_at', 'desc']] })).find((x) => (x.payload as { closeId?: string }).closeId === closeId);
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
    const latest = packages[0];
    return {
      close: { id: close.id, name: close.name, status: close.status, periodEnd: close.period_end },
      latest: latest ? { id: latest.id, version: latest.version, status: latest.status, generatedAt: latest.generated_at, contentHash: latest.content_hash, approvedBy: latest.approved_by ? users.get(latest.approved_by) ?? null : null, approvedAt: latest.approved_at, content: latest.content } : null,
      versions: packages.map((x) => ({ id: x.id, version: x.version, status: x.status, generatedAt: x.generated_at, contentHash: x.content_hash })),
      pendingProposal: proposal && proposal.status === 'pending' ? { id: proposal.id, title: proposal.title, why: proposal.why } : null,
      canGenerate: canOn(p, 'package.generate', null) && close.status !== 'closed',
      canApprove: canOn(p, 'package.approve', null),
    };
  });
}

/** Generate (or regenerate) the close package now: runs the close-package skill for its task. */
export async function generatePackage(app: App, p: Principal, closeId: string) {
  requirePermissionOn(p, 'package.generate', null, 'generate the close package');
  const task = (await app.read((tx) => tx.find('close_tasks', { tenant_id: p.tenantId, close_id: closeId, key: 'close-package' })))[0];
  if (!task) app.notFound('Close package task');
  const close = (await app.read((tx) => tx.get('closes', closeId)))!;
  const run = await app.runtime.start(p.tenantId, { skillKey: 'close-package', input: { closeId, closeTaskId: task.id, period: `${close.fiscal_year}-${String(close.period_number).padStart(2, '0')}` }, requestedBy: p.user.id, requestedByLabel: p.user.display_name, closeId, closeTaskId: task.id, mode: 'offline' });
  await app.queue.enqueue(run.id);
  await app.tx(async (tx) => appendAudit(tx, p.tenantId, app.actorOf(p), { action: 'close_package.generate', objectType: 'close', objectId: closeId, summary: `Requested close package for ${close.name}` }, app.clock.now()));
  return { runId: run.id };
}
