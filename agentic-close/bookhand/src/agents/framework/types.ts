import type { z } from 'zod';
import type { Tx } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import type { Permission } from '../../security/permissions';
import type { DomainContext } from '../../shared/context';

/**
 * Domain-agnostic agent framework contracts. A "pack" (accounting is the first) supplies tools, proposal
 * handlers, skill engines and an ontology; the runtime supplies planning/acting/verifying/proposing, autonomy,
 * approvals, budgets, idempotency, resume and tracing.
 */

export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type ProposalKind = Row<'proposals'>['kind'];
export type Disposition = Row<'proposals'>['disposition'];

export const AUTONOMY_DESCRIPTIONS: Record<AutonomyLevel, { name: string; summary: string }> = {
  L0: { name: 'Suggest only', summary: 'The agent drafts suggestions. Nothing is queued for approval or applied; a person must adopt a suggestion.' },
  L1: { name: 'Propose, you approve', summary: 'Every change waits in the approval queue for a person with the right role and limit.' },
  L2: { name: 'Auto-apply routine items', summary: 'Verified, high-confidence items under the policy limit are applied automatically and sampled for review; everything else waits for approval.' },
  L3: { name: 'Auto-apply within materiality', summary: 'Verified items within the materiality budget are applied automatically and reviewed after the fact; exceptions wait for approval.' },
};

export interface EvidenceRef {
  type: string;
  id?: string | null;
  label: string;
  detail?: Record<string, unknown>;
}

export interface ProposalDraft {
  kind: ProposalKind;
  /** Stable natural key: the same finding in a later run supersedes instead of duplicating. */
  naturalKey: string;
  title: string;
  /** Plain-English rationale shown to the approver. */
  why: string;
  confidence: number;
  /** Absolute amount at stake in the reporting currency (minor units); drives limits and materiality. */
  amountMinor: number;
  currency: string;
  entityId?: string | null;
  periodId?: string | null;
  payload: Record<string, unknown>;
  evidence: EvidenceRef[];
  riskFlags?: string[];
}

export interface VerificationCheck {
  id: string;
  label: string;
  passed: boolean;
  severity: 'error' | 'warning';
  message?: string;
}

export interface Verification {
  passed: boolean;
  checks: VerificationCheck[];
}

export interface ProposeResult {
  proposalId: string;
  status: Row<'proposals'>['status'];
  disposition: Disposition;
  verification: Verification;
  duplicateOf?: string;
  skipped?: string;
}

export interface PackScope<P> {
  tx: Tx;
  ctx: DomainContext;
  pack: P;
}

export interface ToolExecContext<P> extends PackScope<P> {
  run: Row<'agent_runs'>;
  propose(draft: ProposalDraft): Promise<ProposeResult>;
}

export interface ToolDefinition<P = unknown, I = unknown, O = unknown> {
  /** snake_case, stable; what the model calls. */
  name: string;
  title: string;
  /** Model-facing description, grounded in ontology terms. */
  description: string;
  input: z.ZodType<I>;
  /** The run's requester must hold this permission (agents never exceed their requester). */
  permission: Permission;
  /** Only proposal tools mutate, and only through the proposal pipeline. */
  mutation: boolean;
  /** Ontology classes the tool reads or produces (documentation, explorer, schema grounding). */
  ontology?: string[];
  /** Output carries third-party text (bank memos, vendor/customer names, documents): treat as data. */
  untrustedOutput?: boolean;
  execute(input: I, x: ToolExecContext<P>): Promise<O>;
  summarize?(output: O): string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool<P> = ToolDefinition<P, any, any>;

export interface ApplyArgs<P> extends PackScope<P> {
  proposal: Row<'proposals'>;
  basis: 'human_approval' | 'autonomy_policy';
  approvedBy: string | null;
  runId: string | null;
}

export interface ProposalHandler<P> {
  kind: ProposalKind;
  label: string;
  payload: z.ZodType;
  /** Permission needed to decide (plus the approval limit and SoD rules). */
  permission: Permission;
  /** Whether autonomy may auto-apply this kind at all. */
  autoApplicable: boolean;
  /** Whether approval limits apply (false for kinds that never post to the ledger, e.g. reconciliation matches). */
  limitApplies?: boolean;
  verify(draft: ProposalDraft, x: PackScope<P>): Promise<VerificationCheck[]>;
  /** Side effects at creation time (e.g. a proposed rec match is shown in the workbench). */
  onCreate?(proposal: Row<'proposals'>, x: PackScope<P>): Promise<void>;
  apply(args: ApplyArgs<P>): Promise<{ effect: Record<string, unknown>; postedEntryId?: string | null }>;
  onReject?(proposal: Row<'proposals'>, x: PackScope<P>): Promise<void>;
  onSupersede?(proposal: Row<'proposals'>, x: PackScope<P>): Promise<void>;
  /** Objects whose maintainers may not approve this proposal (SoD-004). */
  sodSubjects?(proposal: Row<'proposals'>): { vendorIds?: string[] };
}

export interface ResolvedPolicy {
  id: string | null;
  version: number;
  skillKey: string;
  entityId: string | null;
  autonomy: AutonomyLevel;
  thresholds: Record<string, number | string | boolean>;
  rulesText: string;
  rules: PolicyRule[];
  createdBy: string | null;
}

/** Compiled policy rule. Generic kinds are enforced by the runtime; others by the skill. */
export type PolicyRule = { kind: string; text: string } & Record<string, unknown>;

export interface Materiality {
  overallMinor: number;
  performanceMinor: number;
  trivialMinor: number;
  source: string;
}

export interface AgentHandle {
  readonly run: Row<'agent_runs'>;
  readonly input: Record<string, unknown>;
  readonly policy: ResolvedPolicy;
  readonly materiality: Materiality;
  plan(steps: string[]): Promise<void>;
  call<T = unknown>(tool: string, input: unknown): Promise<T>;
  note(title: string, detail?: Record<string, unknown>, kind?: 'observation' | 'decision' | 'verification'): Promise<void>;
  /** Proposals created so far in this run (for summaries). */
  proposals(): Array<{ id: string; kind: ProposalKind; status: string; title: string }>;
  /** Start and await a child run (only for skills whose manifest lists it in `spawns`). */
  spawn(req: SpawnRequest): Promise<SpawnResult>;
}

export interface SpawnRequest {
  skillKey: string;
  input: Record<string, unknown>;
  closeTaskId?: string | null;
  entityId?: string | null;
  periodId?: string | null;
  label?: string;
}

export interface SpawnResult {
  runId: string;
  status: string;
  summary: string | null;
  proposals: number;
  pending: number;
  autoApplied: number;
}

export interface EvalCase {
  id: string;
  description: string;
  /** Fixture name understood by the pack's eval harness. */
  fixture: string;
  input: Record<string, unknown>;
  expect: Record<string, unknown>;
}

export interface SkillEngine {
  key: string;
  /** Deterministic offline brain: drives the same tools a live model would and returns a summary. */
  offline(agent: AgentHandle): Promise<string>;
  /** Volatile per-run brief for the live model (period, entity, policy); appended to the first user turn. */
  brief?(agent: AgentHandle): string;
}
