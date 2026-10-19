import type { AutonomyLevel } from '../skills/manifest';
import type { Assessment, GateExplanation, Hold, ProposalDraft, SkillPolicy, VerificationReport } from './types';

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
 * injection, or kinds the skill marks approval-required. The amount, materiality, policy-rule
 * holds and injection flag come from the domain's assessment of the payload, not from the brain.
 */
export function gate(draft: ProposalDraft, verification: VerificationReport, assessment: Assessment, policy: SkillPolicy, approvalRequired: readonly string[]): GateExplanation {
  const level: AutonomyLevel = policy.autonomy;
  // A policy may set a per-kind threshold, e.g. thresholds["autoPostBelow:rec_match"].
  const threshold = policy.thresholds[`autoPostBelow:${draft.kind}`] ?? policy.autoPostBelow;
  const base = { level, threshold, minConfidence: policy.minConfidence };
  if (level === 'L0') return { ...base, decision: 'suggest_only', reasons: ['Autonomy L0: the agent only suggests; a person acts.'] };
  const holds: Hold[] = [];
  const hold = (code: string, reason: string) => holds.push({ code, reason });
  if (level === 'L1') hold('autonomy', 'Autonomy L1: every item needs approval.');
  if (assessment.materiality === 'material') hold('material', 'At or above performance materiality — needs a material-item approver.');
  if (!verification.ok) hold('unverified', 'Verification found errors.');
  if (verification.checks.some((c) => !c.ok && c.severity === 'warning')) hold('verification_warning', 'Verification raised warnings a person should see.');
  if (draft.forceReview) hold('review_requested', 'A policy rule or the agent asked for human review.');
  if (draft.injectionSuspected || assessment.injectionSuspected) hold('untrusted_text', 'Source text contained instruction-like content; treated as data and routed to a person.');
  holds.push(...assessment.holds);
  if (approvalRequired.includes(draft.kind)) hold('approval_required', `The skill requires approval for ${draft.kind.replace(/_/g, ' ')} proposals.`);
  if (draft.confidence < policy.minConfidence) hold('low_confidence', `Confidence ${Math.round(draft.confidence * 100)}% is below the ${Math.round(policy.minConfidence * 100)}% floor.`);
  // Monetary items always face the amount test (an amount that cannot be computed is already
  // held above); non-monetary ones, such as logging an exception, never do.
  if (level === 'L2' && assessment.monetary && assessment.amountReporting >= threshold) hold('threshold', 'Amount is at or above the L2 auto-post threshold.');
  if (holds.length) return { ...base, decision: 'await_approval', reasons: holds.map((h) => h.reason), codes: [...new Set(holds.map((h) => h.code))] };
  return {
    ...base,
    decision: 'auto_post',
    reasons: [level === 'L2' ? 'Under threshold, verified and confident — posted automatically; a sample is reviewed.' : 'Verified and confident — posted automatically; reviewed after posting.'],
    codes: [],
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
