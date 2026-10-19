import type { ProposalRecord, RunRecord, RuntimeStore, StepRecord, ToolCallRecord } from '../../../framework/runtime/types';
import type { Row } from '../../../framework/store/schema';
import { ONTOLOGY_VERSION } from '../ontology';
import type { EkDb, EkSchema } from '../store';

/** RuntimeStore over the agent_run / agent_step / tool_call / proposal / approval tables. */

type RunRow = Row<EkSchema, 'agent_run'>;
type ProposalRow = Row<EkSchema, 'proposal'>;

function toRun(r: RunRow): RunRecord {
  const plan = (r.plan ?? {}) as { input?: Record<string, unknown> };
  return {
    id: r.id,
    skillId: r.skill_id,
    skillVersion: r.skill_version,
    policyVersion: r.policy_version,
    status: r.status,
    trigger: r.trigger,
    requestedBy: r.requested_by,
    engine: r.engine,
    model: r.model,
    idempotencyKey: r.idempotency_key,
    entityId: r.entity_id,
    periodKey: r.period_key,
    taskId: r.close_task_id,
    parentRunId: r.parent_run_id,
    input: plan.input ?? {},
    maxSteps: r.max_steps,
    maxTokens: r.max_tokens,
    maxCostMicros: r.max_cost_micros,
    stepsUsed: r.steps_used,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costMicros: r.cost_micros,
    checkpoint: r.checkpoint,
    summary: r.summary,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function runPatch(p: Partial<RunRecord>): Partial<RunRow> {
  const out: Partial<RunRow> = {};
  if (p.status !== undefined) out.status = p.status;
  if (p.model !== undefined) out.model = p.model;
  if (p.engine !== undefined) out.engine = p.engine;
  if (p.stepsUsed !== undefined) out.steps_used = p.stepsUsed;
  if (p.inputTokens !== undefined) out.input_tokens = p.inputTokens;
  if (p.outputTokens !== undefined) out.output_tokens = p.outputTokens;
  if (p.costMicros !== undefined) out.cost_micros = p.costMicros;
  if (p.checkpoint !== undefined) out.checkpoint = p.checkpoint as never;
  if (p.summary !== undefined) out.summary = p.summary;
  if (p.error !== undefined) out.error = p.error === null ? null : p.error.slice(0, 2000);
  if (p.startedAt !== undefined) out.started_at = p.startedAt;
  if (p.finishedAt !== undefined) out.finished_at = p.finishedAt;
  return out;
}

function toProposal(r: ProposalRow): ProposalRecord {
  return {
    id: r.id,
    runId: r.run_id,
    skillId: r.skill_id,
    kind: r.kind,
    payloadClass: r.payload_class,
    title: r.title,
    why: r.why,
    confidence: r.confidence,
    amount: r.amount,
    currency: r.currency,
    materiality: r.materiality,
    entityId: r.entity_id,
    periodKey: r.period_key,
    status: r.status,
    payload: r.payload,
    evidence: r.evidence as ProposalRecord['evidence'],
    verification: r.verification as unknown as ProposalRecord['verification'],
    autonomyLevel: r.autonomy_level,
    gateDecision: r.gate_decision,
    requiresRole: r.requires_role,
    requestedBy: r.requested_by,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionReason: r.decision_reason,
    appliedRef: r.applied_ref,
    reviewStatus: r.review_status,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    idempotencyKey: r.idempotency_key,
    injectionFlag: r.injection_flag,
    createdAt: r.created_at,
  };
}

function proposalPatch(p: Partial<ProposalRecord>): Partial<ProposalRow> {
  const out: Partial<ProposalRow> = {};
  if (p.status !== undefined) out.status = p.status;
  if (p.decidedBy !== undefined) out.decided_by = p.decidedBy;
  if (p.decidedAt !== undefined) out.decided_at = p.decidedAt;
  if (p.decisionReason !== undefined) out.decision_reason = p.decisionReason === null ? null : p.decisionReason.slice(0, 2000);
  if (p.appliedRef !== undefined) out.applied_ref = p.appliedRef;
  if (p.reviewStatus !== undefined) out.review_status = p.reviewStatus;
  if (p.reviewedBy !== undefined) out.reviewed_by = p.reviewedBy;
  if (p.reviewedAt !== undefined) out.reviewed_at = p.reviewedAt;
  if (p.verification !== undefined) out.verification = p.verification as unknown as Record<string, unknown>;
  return out;
}

export class EkRuntimeStore implements RuntimeStore {
  constructor(
    private readonly db: EkDb,
    private readonly tenantId: string,
    private readonly now: () => string,
  ) {}

  transaction<T>(fn: (s: RuntimeStore) => Promise<T>): Promise<T> {
    return this.db.tx((db) => fn(new EkRuntimeStore(db, this.tenantId, this.now)));
  }

  async findRunByKey(key: string): Promise<RunRecord | null> {
    const r = await this.db.findOne('agent_run', { tenant_id: this.tenantId, idempotency_key: key });
    return r ? toRun(r) : null;
  }

  async insertRun(r: Omit<RunRecord, 'id'> & { id?: string }): Promise<RunRecord> {
    const row = await this.db.insert('agent_run', {
      ...(r.id ? { id: r.id } : {}),
      tenant_id: this.tenantId,
      skill_id: r.skillId,
      skill_version: r.skillVersion,
      policy_version: r.policyVersion,
      entity_id: r.entityId,
      period_key: r.periodKey,
      close_task_id: r.taskId,
      parent_run_id: r.parentRunId,
      status: r.status,
      trigger: r.trigger,
      requested_by: r.requestedBy,
      engine: r.engine,
      model: r.model,
      idempotency_key: r.idempotencyKey,
      ontology_version: ONTOLOGY_VERSION,
      max_steps: r.maxSteps,
      max_tokens: r.maxTokens,
      max_cost_micros: r.maxCostMicros,
      steps_used: r.stepsUsed,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cost_micros: r.costMicros,
      started_at: r.startedAt,
      finished_at: r.finishedAt,
      heartbeat_at: this.now(),
      error: r.error,
      summary: r.summary,
      plan: { input: r.input },
      checkpoint: (r.checkpoint ?? null) as never,
      created_at: this.now(),
    });
    return toRun(row);
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    await this.db.update('agent_run', id, { ...runPatch(patch), heartbeat_at: this.now() });
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const r = await this.db.get('agent_run', id);
    return r && r.tenant_id === this.tenantId ? toRun(r) : null;
  }

  async listRuns(filter: { status?: RunRecord['status'][]; taskId?: string; parentRunId?: string }): Promise<RunRecord[]> {
    const rows = await this.db.find(
      'agent_run',
      {
        tenant_id: this.tenantId,
        ...(filter.status ? { status: { in: filter.status } } : {}),
        ...(filter.taskId ? { close_task_id: filter.taskId } : {}),
        ...(filter.parentRunId ? { parent_run_id: filter.parentRunId } : {}),
      },
      { orderBy: [['created_at', 'asc']] },
    );
    return rows.map(toRun);
  }

  async insertStep(s: StepRecord): Promise<void> {
    await this.db.insert('agent_step', {
      tenant_id: this.tenantId,
      run_id: s.runId,
      seq: s.seq,
      phase: s.phase,
      title: s.title,
      detail: (s.detail ?? null) as never,
      status: s.status,
      started_at: s.startedAt,
      finished_at: s.finishedAt,
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      cost_micros: s.costMicros,
    });
  }

  async updateStep(runId: string, seq: number, patch: Partial<StepRecord>): Promise<void> {
    const row = await this.db.findOne('agent_step', { run_id: runId, seq });
    if (!row) return;
    await this.db.update('agent_step', row.id, {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.finishedAt !== undefined ? { finished_at: patch.finishedAt } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail as never } : {}),
    });
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    const rows = await this.db.find('agent_step', { run_id: runId }, { orderBy: [['seq', 'asc']] });
    return rows.map((r) => ({ runId: r.run_id, seq: r.seq, phase: r.phase, title: r.title, detail: r.detail, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costMicros: r.cost_micros }));
  }

  async findToolCall(runId: string, key: string): Promise<ToolCallRecord | null> {
    const r = await this.db.findOne('tool_call', { run_id: runId, idempotency_key: key });
    return r ? { runId: r.run_id, stepSeq: r.step_seq, toolName: r.tool_name, input: r.input, output: r.output, status: r.status, error: r.error, durationMs: r.duration_ms, idempotencyKey: r.idempotency_key } : null;
  }

  async insertToolCall(c: ToolCallRecord): Promise<void> {
    await this.db.insert('tool_call', {
      tenant_id: this.tenantId,
      run_id: c.runId,
      step_seq: c.stepSeq,
      tool_name: c.toolName,
      input: (c.input ?? {}) as never,
      output: (c.output ?? null) as never,
      status: c.status,
      error: c.error,
      duration_ms: c.durationMs,
      idempotency_key: c.idempotencyKey,
      created_at: this.now(),
    });
  }

  async findProposalByKey(key: string): Promise<ProposalRecord | null> {
    const r = await this.db.findOne('proposal', { tenant_id: this.tenantId, idempotency_key: key });
    return r ? toProposal(r) : null;
  }

  async insertProposal(p: Omit<ProposalRecord, 'id' | 'createdAt'>): Promise<ProposalRecord> {
    const row = await this.db.insert('proposal', {
      tenant_id: this.tenantId,
      run_id: p.runId,
      skill_id: p.skillId,
      kind: p.kind as ProposalRow['kind'],
      payload_class: p.payloadClass,
      title: p.title,
      why: p.why,
      confidence: p.confidence,
      amount: p.amount,
      currency: p.currency,
      materiality: p.materiality,
      entity_id: p.entityId,
      period_key: p.periodKey,
      status: p.status,
      payload: p.payload,
      evidence: p.evidence as unknown[],
      verification: p.verification as unknown as Record<string, unknown>,
      autonomy_level: p.autonomyLevel,
      gate_decision: p.gateDecision,
      requires_role: p.requiresRole,
      requested_by: p.requestedBy,
      decided_by: p.decidedBy,
      decided_at: p.decidedAt,
      decision_reason: p.decisionReason,
      applied_ref: p.appliedRef,
      review_status: p.reviewStatus,
      reviewed_by: p.reviewedBy,
      reviewed_at: p.reviewedAt,
      idempotency_key: p.idempotencyKey,
      injection_flag: p.injectionFlag,
      created_at: this.now(),
    });
    return toProposal(row);
  }

  async updateProposal(id: string, patch: Partial<ProposalRecord>): Promise<void> {
    await this.db.update('proposal', id, proposalPatch(patch));
  }

  async getProposal(id: string): Promise<ProposalRecord | null> {
    const r = await this.db.get('proposal', id);
    return r && r.tenant_id === this.tenantId ? toProposal(r) : null;
  }

  async listProposals(runId: string): Promise<ProposalRecord[]> {
    const rows = await this.db.find('proposal', { run_id: runId }, { orderBy: [['created_at', 'asc']] });
    return rows.map(toProposal);
  }

  async recordDecision(d: { proposalId: string; decision: 'approve' | 'reject' | 'review'; userId: string; reason: string | null }): Promise<void> {
    await this.db.insert('approval', { tenant_id: this.tenantId, proposal_id: d.proposalId, decision: d.decision, user_id: d.userId, reason: d.reason, created_at: this.now() });
  }
}

export { toProposal, toRun };
