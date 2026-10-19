import { c, check, nnd, table } from '../dsl';

const AREA = 'Agent runtime';

export const PROPOSAL_KINDS = [
  'journal_entry',
  'rec_match',
  'reconciling_item',
  'transaction_coding',
  'flux_explanation',
  'anomaly',
  'schedule',
  'task_update',
] as const;

export const PROPOSAL_STATUSES = [
  'pending',
  'suggested',
  'blocked',
  'approved',
  'auto_applied',
  'rejected',
  'failed',
  'superseded',
] as const;

export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;

export const skills = table(
  'skills',
  {
    id: c.id(),
    key: c.text().unique(),
    name: c.text(),
    description: c.text(),
    category: c.text(),
    domain: c.text().default('accounting'),
    current_version: c.text(),
    status: c.enum(['enabled', 'disabled'] as const).default('enabled'),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'Skill registry (global catalog of SKILL.md packages).', ontologyClass: 'bh:Skill' },
);

export const skillVersions = table(
  'skill_versions',
  {
    id: c.id(),
    skill_id: c.uuid().references('skills', 'cascade'),
    version: c.text(),
    manifest: c.json<Record<string, unknown>>(),
    instructions: c.text(),
    resources: c.json<Array<{ path: string; sha256: string; bytes: number }>>().default([]),
    content_hash: c.text(),
    published_at: c.timestamp().defaultNow(),
    published_by: c.text().default('system'),
    eval_summary: c.json<Record<string, unknown>>().nullable(),
  },
  { area: AREA, description: 'Immutable published version of a skill package.', appendOnly: true, uniques: [['skill_id', 'version']] },
);

export const skillPolicies = table(
  'skill_policies',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    skill_key: c.text(),
    entity_id: c.uuid().nullable().references('entities'),
    version: c.int(),
    autonomy_level: c.enum(AUTONOMY_LEVELS),
    thresholds: c.json<Record<string, number>>().default({}),
    /** Plain-English rules exactly as typed by the accountant. */
    rules_text: c.json<string[]>().default([]),
    /** Structured rules compiled from rules_text (by the offline rule compiler or the live model). */
    rules: c.json<Array<Record<string, unknown>>>().default([]),
    change_reason: c.text(),
    created_by: c.uuid().nullable().references('users', 'set null'),
    created_at: c.timestamp().defaultNow(),
    supersedes_id: c.uuid().nullable().references('skill_policies'),
  },
  {
    area: AREA,
    description: 'Versioned, append-only tenant policy for a skill: autonomy level, thresholds, plain-English rules.',
    ontologyClass: 'bh:SkillPolicy',
    appendOnly: true,
    uniques: [nnd('tenant_id', 'skill_key', 'entity_id', 'version')],
  },
);

export const agentRuns = table(
  'agent_runs',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    skill_key: c.text(),
    skill_version: c.text(),
    policy_id: c.uuid().nullable().references('skill_policies'),
    ontology_version: c.text(),
    close_id: c.uuid().nullable().references('closes'),
    close_task_id: c.uuid().nullable().references('close_tasks', 'set null'),
    entity_id: c.uuid().nullable().references('entities'),
    period_id: c.uuid().nullable().references('periods'),
    parent_run_id: c.uuid().nullable().references('agent_runs'),
    status: c.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'budget_exceeded'] as const).default('queued'),
    phase: c.enum(['plan', 'act', 'verify', 'propose', 'done'] as const).default('plan'),
    mode: c.enum(['offline', 'live', 'replay'] as const),
    provider: c.text(),
    model: c.text().nullable(),
    requested_by: c.uuid().nullable().references('users', 'set null'),
    requested_by_label: c.text(),
    trigger: c.enum(['manual', 'orchestrator', 'schedule', 'api', 'mcp'] as const).default('manual'),
    input: c.json<Record<string, unknown>>().default({}),
    plan: c.json<string[]>().nullable(),
    summary: c.text().nullable(),
    error: c.text().nullable(),
    budget: c.json<{ max_steps: number; max_tool_calls: number; max_tokens: number; max_cost_usd_micros: number }>(),
    steps_used: c.int().default(0),
    tool_calls_used: c.int().default(0),
    tokens_in: c.int().default(0),
    tokens_out: c.int().default(0),
    cache_read_tokens: c.int().default(0),
    cost_usd_micros: c.bigint().default(0),
    proposals_count: c.int().default(0),
    idempotency_key: c.text().unique(),
    heartbeat_at: c.timestamp().nullable(),
    resume_count: c.int().default(0),
    started_at: c.timestamp().nullable(),
    finished_at: c.timestamp().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'One execution of a skill: plan -> act -> observe -> verify -> propose, with budgets and cost accounting.',
    ontologyClass: 'bh:AgentRun',
    indexes: [['tenant_id', 'created_at'], ['close_task_id'], ['status']],
  },
);

export const agentSteps = table(
  'agent_steps',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    run_id: c.uuid().references('agent_runs', 'cascade'),
    seq: c.int(),
    phase: c.enum(['plan', 'act', 'observe', 'verify', 'propose', 'post', 'audit'] as const),
    kind: c.enum(['plan', 'tool_call', 'observation', 'verification', 'proposal', 'message', 'error', 'decision'] as const),
    title: c.text(),
    detail: c.json<Record<string, unknown>>().default({}),
    tokens_in: c.int().default(0),
    tokens_out: c.int().default(0),
    cost_usd_micros: c.bigint().default(0),
    duration_ms: c.int().default(0),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'Trace step of a run (append-only).', ontologyClass: 'bh:AgentStep', appendOnly: true, uniques: [['run_id', 'seq']] },
);

export const agentToolCalls = table(
  'agent_tool_calls',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    run_id: c.uuid().references('agent_runs', 'cascade'),
    step_id: c.uuid().nullable().references('agent_steps'),
    tool_name: c.text(),
    input: c.json<unknown>(),
    output: c.json<unknown>().nullable(),
    status: c.enum(['ok', 'error', 'denied'] as const),
    is_mutation: c.bool().default(false),
    /** run id + call ordinal + hash(input): replayed instead of re-executed on resume. */
    idempotency_key: c.text().unique(),
    error: c.text().nullable(),
    duration_ms: c.int().default(0),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'Typed tool call made by an agent (append-only).', ontologyClass: 'bh:ToolCall', appendOnly: true, indexes: [['run_id']] },
);

export const proposals = table(
  'proposals',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    run_id: c.uuid().nullable().references('agent_runs'),
    skill_key: c.text().nullable(),
    kind: c.enum(PROPOSAL_KINDS),
    status: c.enum(PROPOSAL_STATUSES).default('pending'),
    disposition: c.enum(['suggestion', 'needs_approval', 'auto_apply', 'blocked'] as const),
    title: c.text(),
    why: c.text(),
    confidence: c.numeric(4, 3).check('BETWEEN 0 AND 1', (v) => v >= 0 && v <= 1),
    /** Absolute impact in the entity's functional currency (minor units). */
    amount_minor: c.money().default(0),
    currency: c.currency(),
    entity_id: c.uuid().nullable().references('entities'),
    period_id: c.uuid().nullable().references('periods'),
    close_task_id: c.uuid().nullable().references('close_tasks', 'set null'),
    payload: c.json<Record<string, unknown>>(),
    evidence: c.json<Array<Record<string, unknown>>>().default([]),
    verification: c.json<Array<Record<string, unknown>>>().default([]),
    risk_flags: c.json<string[]>().default([]),
    autonomy_level: c.enum(AUTONOMY_LEVELS),
    policy_id: c.uuid().nullable().references('skill_policies'),
    required_permission: c.text(),
    maker_type: c.enum(['agent', 'user'] as const),
    maker_user_id: c.uuid().nullable().references('users', 'set null'),
    requested_by: c.uuid().nullable().references('users', 'set null'),
    decided_by: c.uuid().nullable().references('users', 'set null'),
    decided_at: c.timestamp().nullable(),
    decision_reason: c.text().nullable(),
    effect: c.json<Record<string, unknown>>().nullable(),
    posted_entry_id: c.uuid().nullable().references('journal_entries'),
    sampled_for_review: c.bool().default(false),
    post_hoc_status: c.enum(['not_required', 'pending', 'confirmed', 'reversed'] as const).default('not_required'),
    post_hoc_reviewed_by: c.uuid().nullable().references('users', 'set null'),
    post_hoc_reviewed_at: c.timestamp().nullable(),
    idempotency_key: c.text().unique(),
    created_at: c.timestamp().defaultNow(),
    updated_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'Something an agent (or a person adopting a suggestion) wants to change, with why, confidence, evidence and checks.',
    ontologyClass: 'bh:Proposal',
    indexes: [['tenant_id', 'status'], ['run_id'], ['close_task_id']],
    checks: [
      check(
        'proposal_maker_checker',
        'decided_by IS NULL OR decided_by IS DISTINCT FROM maker_user_id',
        (r) => r.decided_by == null || r.decided_by !== r.maker_user_id,
        'maker-checker: a person cannot approve a proposal they made',
      ),
    ],
  },
);

export const approvals = table(
  'approvals',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    proposal_id: c.uuid().references('proposals', 'cascade'),
    decision: c.enum(['approve', 'reject', 'adopt', 'post_hoc_confirm', 'post_hoc_reverse'] as const),
    user_id: c.uuid().references('users'),
    role_key: c.text(),
    reason: c.text().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'Append-only decision history for proposals (approve, reject, adopt, post-hoc review).', ontologyClass: 'bh:ApprovalDecision', appendOnly: true, indexes: [['proposal_id']] },
);

export const ontologyVersions = table(
  'ontology_versions',
  {
    id: c.id(),
    version: c.text().unique(),
    content_hash: c.text(),
    class_count: c.int(),
    axiom_count: c.int(),
    published_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'Published versions of the close ontology referenced by runs.', appendOnly: true },
);
