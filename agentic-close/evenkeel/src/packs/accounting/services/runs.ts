import { AppError } from '../../../framework/util/errors';
import { canSeeEntity, requireEntity, requirePermission, type ServiceContext } from '../domain/context';
import { peopleMap, type PersonRef } from './common';

/** Agent run history and full traces (steps, tool calls, proposals, cost). */

export interface RunSummary {
  id: string;
  skillId: string;
  skillVersion: string;
  policyVersion: number;
  status: string;
  trigger: string;
  engine: string;
  model: string | null;
  periodKey: string | null;
  task: { id: string; code: string; title: string } | null;
  parentRunId: string | null;
  requestedBy: PersonRef | null;
  summary: string | null;
  error: string | null;
  stepsUsed: number;
  maxSteps: number;
  tokens: number;
  costUsd: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  proposals: { total: number; auto: number; pending: number; applied: number; rejected: number; failed: number };
}

export async function listRuns(ctx: ServiceContext, f: { id?: string; periodKey?: string; skillId?: string; status?: string; parentRunId?: string; limit?: number }): Promise<RunSummary[]> {
  requirePermission(ctx, 'close.view');
  const where: Record<string, unknown> = { tenant_id: ctx.tenantId };
  if (f.id) where.id = f.id;
  if (f.periodKey) where.period_key = f.periodKey;
  if (f.skillId) where.skill_id = f.skillId;
  if (f.status) where.status = f.status;
  if (f.parentRunId) where.parent_run_id = f.parentRunId;
  // Runs for one entity's task are that entity's; cross-entity runs are for tenant-wide roles.
  const runs = (await ctx.db.find('agent_run', where as never, { orderBy: [['created_at', 'desc']], limit: Math.min(500, f.limit ?? 100) })).filter((r) => canSeeEntity(ctx, r.entity_id));
  const tasks = new Map((await ctx.db.find('close_task', { id: { in: runs.map((r) => r.close_task_id).filter((x): x is string => !!x) } })).map((t) => [t.id, t]));
  const props = runs.length ? await ctx.db.find('proposal', { run_id: { in: runs.map((r) => r.id) } }) : [];
  const people = await peopleMap(ctx);
  return runs.map((r) => {
    const ps = props.filter((p) => p.run_id === r.id);
    const t = r.close_task_id ? tasks.get(r.close_task_id) : undefined;
    return {
      id: r.id,
      skillId: r.skill_id,
      skillVersion: r.skill_version,
      policyVersion: r.policy_version,
      status: r.status,
      trigger: r.trigger,
      engine: r.engine,
      model: r.model,
      periodKey: r.period_key,
      task: t ? { id: t.id, code: t.code, title: t.title } : null,
      parentRunId: r.parent_run_id,
      requestedBy: r.requested_by ? (people.get(r.requested_by) ?? null) : null,
      summary: r.summary,
      error: r.error,
      stepsUsed: r.steps_used,
      maxSteps: r.max_steps,
      tokens: r.input_tokens + r.output_tokens,
      costUsd: Math.round(r.cost_micros / 10_000) / 100,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.started_at && r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null,
      proposals: {
        total: ps.length,
        auto: ps.filter((p) => p.status === 'auto_applied').length,
        pending: ps.filter((p) => p.status === 'pending' || p.status === 'suggested').length,
        applied: ps.filter((p) => p.status === 'applied' || p.status === 'approved').length,
        rejected: ps.filter((p) => p.status === 'rejected').length,
        failed: ps.filter((p) => p.status === 'failed').length,
      },
    };
  });
}

function clip(v: unknown, max = 6000): unknown {
  const s = JSON.stringify(v ?? null);
  if (s.length <= max) return v;
  return { truncated: true, preview: `${s.slice(0, max)}…`, bytes: s.length };
}

export async function runTrace(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'close.view');
  const run = await ctx.db.get('agent_run', id);
  if (!run || run.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Run not found');
  requireEntity(ctx, run.entity_id);
  const [summary] = await listRuns(ctx, { id, limit: 1 });
  const steps = await ctx.db.find('agent_step', { run_id: id }, { orderBy: [['seq', 'asc']] });
  const calls = await ctx.db.find('tool_call', { run_id: id }, { orderBy: [['created_at', 'asc']] });
  const proposals = await ctx.db.find('proposal', { run_id: id }, { orderBy: [['created_at', 'asc']] });
  const children = await listRuns(ctx, { parentRunId: id, limit: 100 });
  const parent = run.parent_run_id ? await ctx.db.get('agent_run', run.parent_run_id) : null;
  return {
    run: summary ?? null,
    input: (run.plan as { input?: unknown } | null)?.input ?? null,
    ontologyVersion: run.ontology_version,
    parent: parent ? { id: parent.id, skillId: parent.skill_id } : null,
    steps: steps.map((s) => ({ seq: s.seq, phase: s.phase, title: s.title, status: s.status, at: s.started_at, detail: clip(s.detail, 4000), tokens: s.input_tokens + s.output_tokens, costMicros: s.cost_micros })),
    toolCalls: calls.map((c) => ({ stepSeq: c.step_seq, tool: c.tool_name, status: c.status, error: c.error, durationMs: c.duration_ms, input: clip(c.input, 2000), output: clip(c.output, 6000), idempotencyKey: c.idempotency_key })),
    proposals: proposals.map((p) => ({ id: p.id, kind: p.kind, title: p.title, status: p.status, confidence: p.confidence, amount: p.amount, currency: p.currency, gate: (p.verification as { gate?: { decision: string } }).gate?.decision ?? null })),
    children,
  };
}
