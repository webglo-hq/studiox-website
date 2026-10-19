/**
 * Autonomy routing: decides, deterministically and explainably, whether a verified proposal is
 * a suggestion, waits for a person, or may be applied by policy (with sampled or full review).
 */
import { hashString } from '../util/random';
import type { AutonomyLevel, Materiality, Route } from './types';

export const BLOCKING_FLAGS = new Set(['injection_suspected', 'control_account', 'sod_conflict', 'unexplained', 'requires_capitalization', 'depends_on_pending', 'policy_never_auto']);

export interface RoutingInput {
  level: AutonomyLevel;
  amountMinor: number;
  autoPostMaxMinor: number;
  confidence: number;
  minConfidence: number;
  flags: readonly string[];
  /** the pack says this kind of proposal may be applied without a person at all */
  autoEligible: boolean;
  materiality: Materiality;
  sampleRatePct: number;
  sampleKey: string;
}

export interface RoutingDecision {
  route: Route;
  status: 'suggested' | 'pending_approval' | 'auto_approved';
  reviewStatus: 'none' | 'pending';
  reasons: string[];
}

export function decideRoute(i: RoutingInput): RoutingDecision {
  const reasons: string[] = [];
  if (i.level === 'L0') return { route: 'suggestion', status: 'suggested', reviewStatus: 'none', reasons: ['Autonomy L0: the agent only suggests; a person prepares and another approves.'] };
  if (i.level === 'L1') return { route: 'human_approval', status: 'pending_approval', reviewStatus: 'none', reasons: ['Autonomy L1: every draft waits for approval.'] };
  const blockers: string[] = [];
  if (!i.autoEligible) blockers.push('this kind of item always needs a person');
  if (i.materiality === 'material') blockers.push('amount is above performance materiality');
  if (i.confidence < i.minConfidence) blockers.push(`confidence ${(i.confidence * 100).toFixed(0)}% is below the ${(i.minConfidence * 100).toFixed(0)}% auto-post floor`);
  const flagged = i.flags.filter((f) => BLOCKING_FLAGS.has(f));
  if (flagged.length) blockers.push(`flagged: ${flagged.join(', ').replace(/_/g, ' ')}`);
  if (i.level === 'L2' && i.amountMinor > i.autoPostMaxMinor) blockers.push(`amount exceeds the ${formatMinor(i.autoPostMaxMinor)} auto-post ceiling`);
  if (blockers.length) return { route: 'human_approval', status: 'pending_approval', reviewStatus: 'none', reasons: [`Autonomy ${i.level}, but ${blockers.join('; ')}.`] };
  if (i.level === 'L3') {
    reasons.push('Autonomy L3: passed every check; applied by policy and queued for post-hoc review.');
    return { route: 'auto_post', status: 'auto_approved', reviewStatus: 'pending', reasons };
  }
  const sampled = hashString(i.sampleKey) % 100 < i.sampleRatePct;
  reasons.push(`Autonomy L2: within the ${formatMinor(i.autoPostMaxMinor)} ceiling at ${(i.confidence * 100).toFixed(0)}% confidence; applied by policy${sampled ? ' and sampled for review' : ''}.`);
  return { route: 'auto_post_sampled', status: 'auto_approved', reviewStatus: sampled ? 'pending' : 'none', reasons };
}

function formatMinor(m: number): string {
  return `$${(m / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
