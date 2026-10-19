/**
 * "Run close agents": the close checklist is the plan. Tasks bound to a skill become graph nodes
 * (dependencies from the checklist), each node fans out to one run per legal entity (or one group
 * run), and close tasks move to in progress / ready for review as their runs finish.
 */
import { audit } from '../../../core/audit/audit';
import { runWaves, topoWaves, type OrchestrationEvent } from '../../../core/agent/orchestrator';
import type { AgentRuntime } from '../../../core/agent/runtime';
import type { Actor } from '../../../core/agent/types';
import { newId } from '../../../core/util/random';
import type { Clock } from '../../../core/util/time';
import type { AgentRunRow, Db } from '../../../schema';
import type { AccountingServices } from '../services';

/** Skills that run once for the group rather than once per legal entity. */
export const GROUP_SKILLS = new Set(['intercompany-matching', 'close-package']);
/** Skills left out of the default "run close agents" batch (run on demand). */
export const ON_DEMAND_SKILLS = new Set(['close-package']);

export interface CloseRunResult {
  orchestrationId: string;
  waves: string[][];
  /** `title` is the checklist task's name, for people; `key` is for machines */
  tasks: { key: string; title: string; skillKey: string; outcome: string; runs: { ref: string; id: string; entityId: string | null; status: string; headline: string; proposals: number; autoApplied: number; pendingApproval: number }[] }[];
}

export async function runCloseAgents(
  deps: { db: Db; runtime: AgentRuntime<AccountingServices>; clock: Clock },
  req: { tenantId: string; periodKey: string; requester: Actor; only?: string[]; includeOnDemand?: boolean; onEvent?: (e: OrchestrationEvent) => void },
): Promise<CloseRunResult> {
  const { db, runtime, clock } = deps;
  const orchestrationId = newId('orch');
  const { tasks, entities } = await db.tx(req.tenantId, async (tx) => {
    const cp = await tx.findOne('close_periods', { period_key: req.periodKey });
    if (!cp) throw new Error(`No close period ${req.periodKey}`);
    const rows = await tx.find('close_tasks', { close_period_id: cp.id }, { orderBy: [['sort_order', 'asc']] });
    const links = await tx.find('close_task_dependencies', { task_id: { in: rows.map((r) => r.id) } });
    const ents = (await tx.find('entities', { kind: 'legal' }, { orderBy: [['sort_order', 'asc']] })).filter((e) => !req.requester.entityScope || req.requester.entityScope.includes(e.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ts = rows
      .filter((r) => r.skill_key && r.status !== 'done' && r.status !== 'skipped')
      // group-wide skills need group access; a requester scoped to some entities runs the rest
      .filter((r) => !req.requester.entityScope || !GROUP_SKILLS.has(r.skill_key!))
      .filter((r) => (req.only?.length ? req.only.includes(r.key) || req.only.includes(r.skill_key!) : req.includeOnDemand || !ON_DEMAND_SKILLS.has(r.skill_key!)))
      .map((r) => ({ id: r.id, key: r.key, title: r.title, skillKey: r.skill_key!, deps: links.filter((l) => l.task_id === r.id).map((l) => byId.get(l.depends_on_task_id)!.key) }));
    await audit(tx, req.requester, clock, { action: 'close.orchestration.start', subjectType: 'close_period', subjectId: cp.id, summary: `Close agents started for ${req.periodKey}: ${ts.map((t) => t.key).join(', ')}`, data: { orchestrationId } });
    return { tasks: ts, entities: ents };
  });
  const nodes = tasks.map((t) => ({ id: t.key, deps: t.deps }));
  const waves = topoWaves(nodes);
  const result: CloseRunResult = { orchestrationId, waves, tasks: [] };
  const outcomes = await runWaves(
    nodes,
    async (key) => {
      const t = tasks.find((x) => x.key === key)!;
      const targets: (string | null)[] = GROUP_SKILLS.has(t.skillKey) ? [null] : entities.map((e) => e.id);
      const runs: CloseRunResult['tasks'][number]['runs'] = [];
      let lastRun: AgentRunRow | null = null;
      for (const entityId of targets) {
        const run = await runtime.createRun({ tenantId: req.tenantId, skillKey: t.skillKey, entityId, periodKey: req.periodKey, requestedBy: req.requester.id, orchestrationId, idempotencyKey: `${orchestrationId}:${t.key}:${entityId ?? 'group'}` });
        await db.tx(req.tenantId, (tx) => tx.update('close_tasks', t.id, { status: 'in_progress', agent_run_id: run.id }));
        const done = await runtime.execute(req.tenantId, run.id);
        lastRun = done;
        runs.push({ ref: done.ref, id: done.id, entityId, status: done.status, headline: done.summary.headline ?? '', proposals: done.summary.proposals ?? 0, autoApplied: done.summary.autoApplied ?? 0, pendingApproval: (done.summary.pendingApproval ?? 0) + (done.summary.suggested ?? 0) });
      }
      const ok = runs.every((r) => r.status === 'succeeded');
      const waiting = runs.reduce((s, r) => s + r.pendingApproval, 0);
      await db.tx(req.tenantId, async (tx) => {
        // what the runs did; how many of their items still wait is read live (closeView), never frozen here
        const notes = runs.map((r) => `${r.ref}: ${r.headline}`).join(' · ').slice(0, 2000);
        await tx.update('close_tasks', t.id, { status: ok && waiting === 0 ? 'ready_for_review' : ok ? 'in_progress' : 'blocked', blocked_reason: ok ? null : 'An agent run failed; see the run trace.', agent_run_id: lastRun?.id ?? null, notes });
      });
      result.tasks.push({ key: t.key, title: t.title, skillKey: t.skillKey, outcome: ok ? 'succeeded' : 'failed', runs });
      return ok ? 'succeeded' : 'failed';
    },
    { concurrency: 1, onEvent: req.onEvent },
  );
  for (const [key, o] of outcomes) {
    const t = tasks.find((x) => x.key === key)!;
    if (o === 'skipped') result.tasks.push({ key, title: t.title, skillKey: t.skillKey, outcome: 'skipped', runs: [] });
  }
  await db.tx(req.tenantId, async (tx) => {
    const cp = await tx.findOne('close_periods', { period_key: req.periodKey });
    await audit(tx, req.requester, clock, { action: 'close.orchestration.finish', subjectType: 'close_period', subjectId: cp!.id, summary: `Close agents finished for ${req.periodKey}: ${result.tasks.filter((t) => t.outcome === 'succeeded').length}/${result.tasks.length} tasks succeeded`, data: { orchestrationId, waves } });
  });
  return result;
}
