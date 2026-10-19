/**
 * Agent framework contracts (domain-agnostic). A domain pack (e.g. accounting) supplies tools,
 * verifiers, appliers and offline brains; the runtime supplies the durable loop:
 *
 *   plan -> act -> observe -> verify -> propose -> route (HITL / autonomy) -> post -> audit
 */
import type { ZodType } from 'zod';
import type { JsonValue } from '../util/json';
import type { PolicyMapping, PolicyRule } from '../skills/policy-types';

export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3';

export const AUTONOMY_LABELS: Record<AutonomyLevel, { name: string; description: string }> = {
  L0: { name: 'Suggest', description: 'The agent only suggests. A person prepares and a second person approves.' },
  L1: { name: 'Draft for approval', description: 'The agent prepares a draft; a person must approve before anything posts.' },
  L2: { name: 'Auto-post under threshold', description: 'Small, high-confidence items post automatically; a random sample is queued for review. Everything else waits for approval.' },
  L3: { name: 'Autonomous with post-hoc review', description: 'Items that pass every check post automatically and are all queued for after-the-fact review.' },
};

export type ProposalKind =
  | 'journal_entry'
  | 'coding'
  | 'rec_match'
  | 'reconciling_item'
  | 'flux_explanation'
  | 'finding'
  | 'schedule_update';

export type Route = 'suggestion' | 'human_approval' | 'auto_post_sampled' | 'auto_post';
export type Materiality = 'trivial' | 'below_pm' | 'material';

export interface RunBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
  maxWallMs: number;
}

export const DEFAULT_BUDGET: RunBudget = {
  maxSteps: 4000,
  maxToolCalls: 600,
  maxInputTokens: 2_000_000,
  maxOutputTokens: 200_000,
  maxCostMicros: 5_000_000, // $5.00
  maxWallMs: 10 * 60_000,
};

export interface RunSummary {
  headline?: string;
  plan?: string[];
  proposals?: number;
  byKind?: Record<string, number>;
  autoApplied?: number;
  suggested?: number;
  pendingApproval?: number;
  duplicates?: number;
  verificationFailures?: number;
  injectionFlags?: number;
  notes?: string[];
}

/** Untrusted text that looked like instructions; recorded, neutralised, never obeyed. */
export interface InjectionFlag {
  path: string;
  pattern: string;
  excerpt: string;
}

export interface EvidenceRef {
  kind: 'record' | 'source_document' | 'computation' | 'policy' | 'ontology' | 'run';
  label: string;
  refType?: string;
  refId?: string;
  detail?: string;
}

export interface VerificationResult {
  check: string;
  axiomId?: string;
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface ProposalPayload {
  [key: string]: JsonValue;
}

/** What a brain (offline or LLM) hands to the runtime. Typed by an ontology class. */
export interface ProposalDraft {
  kind: ProposalKind;
  ontologyType: string;
  title: string;
  why: string;
  confidence: number;
  entityId: string | null;
  periodKey: string | null;
  payload: ProposalPayload;
  evidence: EvidenceRef[];
  /** Stable key within (skill, entity, period) so re-runs never duplicate work. */
  dedupeKey: string;
  flags?: string[];
}

export type BrainAction =
  | { type: 'plan'; steps: string[] }
  | { type: 'tool'; name: string; input: Record<string, JsonValue> }
  | { type: 'propose'; draft: ProposalDraft }
  | { type: 'note'; text: string };

export interface ProposeOutcome {
  status: 'created' | 'duplicate' | 'rejected_by_verifier';
  proposalId?: string;
  ref?: string;
  route?: Route;
  applied?: boolean;
  verification: VerificationResult[];
}

export interface BrainResult {
  headline: string;
  notes?: string[];
}

export interface SkillRunInput {
  tenantId: string;
  runId: string;
  skillKey: string;
  entityId: string | null;
  periodKey: string | null;
  policy: EffectivePolicy;
  params: Record<string, JsonValue>;
}

/** Deterministic brain: an async generator that yields actions and receives their results. */
export type OfflineBrain = (input: SkillRunInput) => AsyncGenerator<BrainAction, BrainResult, unknown>;

export interface EffectivePolicy {
  version: number;
  autonomy: AutonomyLevel;
  thresholds: Record<string, number>;
  mappings: PolicyMapping[];
  rules: PolicyRule[];
}

export interface Actor {
  type: 'user' | 'agent' | 'system' | 'policy';
  id: string;
  label: string;
  onBehalfOf?: string | null;
  permissions: ReadonlySet<string>;
  roles: readonly string[];
  /** entity scope; null = all entities */
  entityScope: readonly string[] | null;
}

export interface ToolContext<Svc> {
  tenantId: string;
  services: Svc;
  actor: Actor;
  run: { id: string; skillKey: string; entityId: string | null; periodKey: string | null; policy: EffectivePolicy };
}

export interface ToolDef<In = unknown, Out = unknown, Svc = unknown> {
  name: string;
  title: string;
  description: string;
  effect: 'read' | 'propose';
  permission: string;
  input: ZodType<In>;
  /** Ontology class (IRI-style id) the output is typed by, e.g. `tie:BankTransaction[]`. */
  outputType: string;
  /** Paths (dot/array notation, `*` wildcard) in the output that carry external, untrusted text. */
  untrustedFields?: string[];
  handler(ctx: ToolContext<Svc>, input: In): Promise<Out>;
}
