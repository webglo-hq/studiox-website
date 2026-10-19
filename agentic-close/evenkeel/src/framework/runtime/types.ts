import type { z } from 'zod';
import type { AutonomyLevel, SkillPackage } from '../skills/manifest';

/** Domain-agnostic agent runtime contracts. A domain pack supplies tools, verifiers, gates and effectors. */

export type RunStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'budget_exceeded';
export type StepPhase = 'plan' | 'act' | 'observe' | 'verify' | 'propose' | 'gate' | 'post' | 'audit' | 'finish' | 'error';
export type GateDecision = 'auto_post' | 'await_approval' | 'suggest_only';
export type Materiality = 'trivial' | 'below_performance' | 'material';
export type Engine = 'offline' | 'anthropic' | 'mock';

export type RunTrigger = 'manual' | 'orchestrator' | 'schedule' | 'api';

export interface RunRecord {
  id: string;
  skillId: string;
  skillVersion: string;
  policyVersion: number;
  status: RunStatus;
  trigger: RunTrigger;
  requestedBy: string | null;
  engine: Engine;
  model: string | null;
  idempotencyKey: string;
  entityId: string | null;
  periodKey: string | null;
  taskId: string | null;
  parentRunId: string | null;
  input: Record<string, unknown>;
  maxSteps: number;
  maxTokens: number;
  maxCostMicros: number;
  stepsUsed: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  checkpoint: unknown;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StepRecord {
  runId: string;
  seq: number;
  phase: StepPhase;
  title: string;
  detail: unknown;
  status: 'started' | 'ok' | 'error' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface ToolCallRecord {
  runId: string;
  stepSeq: number;
  toolName: string;
  input: unknown;
  output: unknown;
  status: 'ok' | 'error' | 'denied';
  error: string | null;
  durationMs: number;
  idempotencyKey: string;
}

export interface EvidenceRef {
  kind: 'record' | 'calculation' | 'rule' | 'history' | 'document' | 'check' | 'note';
  label: string;
  detail?: string;
  ref?: { type: string; id: string; label?: string };
  untrusted?: boolean;
}

export interface ProposalDraft {
  /** stable key within the run (for idempotency), e.g. "accrual:vendor:123" */
  key: string;
  kind: string;
  title: string;
  why: string;
  confidence: number;
  amount?: number | null;
  currency?: string | null;
  entityId?: string | null;
  periodKey?: string | null;
  payload: Record<string, unknown>;
  evidence: EvidenceRef[];
  /** policy rule or the agent asks that this never auto-posts */
  forceReview?: boolean;
  /** text from external parties looked like instructions */
  injectionSuspected?: boolean;
}

export interface VerificationCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: 'error' | 'warning';
  detail?: string;
}

export interface VerificationReport {
  ok: boolean;
  checks: VerificationCheck[];
}

export interface Assessment {
  /** amount in reporting currency minor units (absolute) */
  amountReporting: number;
  materiality: Materiality;
  performanceMateriality: number;
  requiresRole: string | null;
}

export interface ProposalRecord {
  id: string;
  runId: string;
  skillId: string;
  kind: string;
  payloadClass: string;
  title: string;
  why: string;
  confidence: number;
  amount: number | null;
  currency: string | null;
  materiality: Materiality;
  entityId: string | null;
  periodKey: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'auto_applied' | 'applied' | 'superseded' | 'failed' | 'suggested';
  payload: Record<string, unknown>;
  evidence: EvidenceRef[];
  verification: VerificationReport & { gate?: GateExplanation };
  autonomyLevel: AutonomyLevel;
  gateDecision: GateDecision;
  requiresRole: string | null;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  appliedRef: Record<string, unknown> | null;
  reviewStatus: 'none' | 'sampled' | 'pending_review' | 'reviewed';
  reviewedBy: string | null;
  reviewedAt: string | null;
  idempotencyKey: string;
  injectionFlag: boolean;
  createdAt: string;
}

export interface GateExplanation {
  decision: GateDecision;
  reasons: string[];
  level: AutonomyLevel;
  threshold: number;
  minConfidence: number;
}

export interface SkillPolicy {
  version: number;
  autonomy: AutonomyLevel;
  enabled: boolean;
  thresholds: Record<string, number>;
  /** compiled plain-English rules (domain-defined shape) */
  rules: unknown[];
  autoPostBelow: number;
  minConfidence: number;
  sampleRate: number;
}

/** Persistence port for runs, steps, tool calls and proposals. */
export interface RuntimeStore {
  transaction<T>(fn: (s: RuntimeStore) => Promise<T>): Promise<T>;
  findRunByKey(key: string): Promise<RunRecord | null>;
  insertRun(r: Omit<RunRecord, 'id'> & { id?: string }): Promise<RunRecord>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(filter: { status?: RunStatus[]; taskId?: string; parentRunId?: string }): Promise<RunRecord[]>;
  insertStep(s: StepRecord): Promise<void>;
  updateStep(runId: string, seq: number, patch: Partial<StepRecord>): Promise<void>;
  listSteps(runId: string): Promise<StepRecord[]>;
  findToolCall(runId: string, key: string): Promise<ToolCallRecord | null>;
  insertToolCall(c: ToolCallRecord): Promise<void>;
  findProposalByKey(key: string): Promise<ProposalRecord | null>;
  insertProposal(p: Omit<ProposalRecord, 'id' | 'createdAt'>): Promise<ProposalRecord>;
  updateProposal(id: string, patch: Partial<ProposalRecord>): Promise<void>;
  getProposal(id: string): Promise<ProposalRecord | null>;
  listProposals(runId: string): Promise<ProposalRecord[]>;
  /** Append-only record of every human decision (approve / reject / post-hoc review). */
  recordDecision(d: { proposalId: string; decision: 'approve' | 'reject' | 'review'; userId: string; reason: string | null }): Promise<void>;
}

export interface ToolDef<Ctx = unknown, I = unknown, O = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** ontology class the input/output instances belong to (documentation + JSON-Schema titles) */
  inputClass?: string;
  outputClass?: string;
  /** permission required (checked against the delegated agent actor) */
  permission: string | null;
  /**
   * read = no side effects; propose = creates a proposal (never posts directly);
   * dispatch = starts child agent runs (orchestration) — each child is gated on its own.
   */
  effect: 'read' | 'propose' | 'dispatch';
  /** output fields that carry external, untrusted text */
  untrustedFields?: string[];
  handler: (ctx: Ctx, input: I) => Promise<O>;
}

export interface DelegatedActor {
  /** 'agent' while a skill runs on someone's behalf; 'user' for a human decision. */
  kind: 'agent' | 'user';
  userId: string | null;
  label: string;
  permissions: ReadonlySet<string>;
}

/** What the domain pack plugs into the runtime. */
export interface DomainAdapter<Ctx> {
  ontologyVersion: string;
  /** Build the tool context for a run (db handle, delegated actor, clock…). */
  toolContext(run: RunRecord, actor: DelegatedActor): Promise<Ctx>;
  payloadClass(kind: string): string;
  verify(draft: ProposalDraft, ctx: Ctx): Promise<VerificationReport>;
  assess(draft: ProposalDraft, ctx: Ctx): Promise<Assessment>;
  apply(p: ProposalRecord, ctx: Ctx, decision: { decidedBy: string | null; policyLabel: string | null }): Promise<Record<string, unknown>>;
  audit(ctx: Ctx, event: { action: string; subjectType: string; subjectId: string; data: Record<string, unknown> }): Promise<void>;
  policy(skillId: string): Promise<SkillPolicy>;
  /** Called after a proposal is decided or auto-applied (e.g. to advance the close calendar). */
  afterDecision?(p: ProposalRecord, ctx: Ctx): Promise<void>;
  /** Permission + segregation-of-duties checks for a human decision; throw to refuse. */
  authorize(p: ProposalRecord, ctx: Ctx, decision: 'approve' | 'reject' | 'review'): Promise<void>;
}

export interface BrainSession {
  readonly run: RunRecord;
  readonly skill: SkillPackage;
  readonly policy: SkillPolicy;
  readonly tools: ToolDef<unknown, unknown, unknown>[];
  readonly budget: { readonly maxSteps: number; readonly stepsUsed: number; readonly maxTokens: number; readonly tokensUsed: number };
  plan(steps: string[]): Promise<void>;
  note(title: string, detail?: unknown): Promise<void>;
  callTool<O = unknown>(name: string, input: unknown): Promise<O>;
  propose(draft: ProposalDraft): Promise<ProposalOutcome>;
  reportUsage(u: { inputTokens: number; outputTokens: number; costMicros: number; model: string }): Promise<void>;
  checkpoint(state: unknown): Promise<void>;
  readonly savedCheckpoint: unknown;
}

export interface ProposalOutcome {
  status: ProposalRecord['status'];
  proposalId: string | null;
  verification: VerificationReport;
  gate: GateExplanation | null;
}

export interface Brain {
  readonly engine: Engine;
  readonly model: string | null;
  run(session: BrainSession): Promise<void>;
}

export class BudgetExceededError extends Error {
  constructor(readonly what: 'steps' | 'tokens' | 'cost') {
    super(`Agent budget exceeded (${what})`);
    this.name = 'BudgetExceededError';
  }
}

export class ToolDeniedError extends Error {
  constructor(tool: string, reason: string) {
    super(`Tool ${tool} denied: ${reason}`);
    this.name = 'ToolDeniedError';
  }
}
