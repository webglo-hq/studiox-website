import type { AutonomyLevel } from '../skills/manifest';
import type { Assessment, GateExplanation, ProposalDraft, SkillPolicy, VerificationReport } from './types';

/**
 * The autonomy gate: given a verified proposal, its assessment and the skill's policy,
 * decide whether the agent may post on its own, must ask for approval, or may only suggest.
 *
 *   L0 suggest                      → suggest_only
 *   L1 draft for approval           → await_approval
 *   L2 auto-post under threshold    → auto_post if |amount| < threshold ∧ confidence ≥ floor, else await
 *                                     (threshold may be set per proposal kind)
 *   L3 auto with post-hoc review    → auto_post if confidence ≥ floor, else await
 * Hard ceilings regardless of level: never auto-post material items (≥ performance
 * materiality), failed or warning verification, policy-flagged items, suspected prompt
 * injection, or kinds the skill marks approval-required.
 */
export function gate(draft: ProposalDraft, verification: VerificationReport, assessment: Assessment, policy: SkillPolicy, approvalRequired: readonly string[]): GateExplanation {
  const level: AutonomyLevel = policy.autonomy;
  // A policy may set a per-kind threshold, e.g. thresholds["autoPostBelow:rec_match"].
  const threshold = policy.thresholds[`autoPostBelow:${draft.kind}`] ?? policy.autoPostBelow;
  const base = { level, threshold, minConfidence: policy.minConfidence };
  if (level === 'L0') return { ...base, decision: 'suggest_only', reasons: ['Autonomy L0: the agent only suggests; a person acts.'] };
  const holds: string[] = [];
  if (level === 'L1') holds.push('Autonomy L1: every item needs approval.');
  if (assessment.materiality === 'material') holds.push('At or above performance materiality — needs a material-item approver.');
  if (!verification.ok) holds.push('Verification found errors.');
  if (verification.checks.some((c) => !c.ok && c.severity === 'warning')) holds.push('Verification raised warnings a person should see.');
  if (draft.forceReview) holds.push('A policy rule or the agent asked for human review.');
  if (draft.injectionSuspected) holds.push('Source text contained instruction-like content; treated as data and routed to a person.');
  if (approvalRequired.includes(draft.kind)) holds.push(`The skill requires approval for ${draft.kind.replace(/_/g, ' ')} proposals.`);
  if (draft.confidence < policy.minConfidence) holds.push(`Confidence ${Math.round(draft.confidence * 100)}% is below the ${Math.round(policy.minConfidence * 100)}% floor.`);
  // Non-monetary items (amount 0, e.g. logging an exception) are never held by the amount test.
  if (level === 'L2' && assessment.amountReporting > 0 && assessment.amountReporting >= threshold) holds.push('Amount is at or above the L2 auto-post threshold.');
  if (holds.length) return { ...base, decision: 'await_approval', reasons: holds };
  return {
    ...base,
    decision: 'auto_post',
    reasons: [level === 'L2' ? 'Under threshold, verified and confident — posted automatically; a sample is reviewed.' : 'Verified and confident — posted automatically; reviewed after posting.'],
  };
}

/** Deterministic sampling for post-hoc review (stable per proposal key). */
export function sampled(key: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296 < rate;
}
