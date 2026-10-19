import { appendAudit } from '../../audit/audit';
import { formatMoney } from '../../shared/money';
import type { Tx } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import type { DomainContext } from '../../shared/context';
import { DomainError } from '../../shared/errors';
import { unitHash } from '../../shared/prng';
import { autonomyAllowed, defaultThresholds, thresholdSchema, type SkillManifest } from './manifest';
import type { AutonomyLevel, Disposition, Materiality, PolicyRule, ProposalDraft, ResolvedPolicy, Verification } from './types';

/**
 * Skill policies: autonomy level, numeric thresholds and plain-English rules, versioned per tenant (and
 * optionally per entity). Every change is a new immutable version with a reason, audited; proposals record
 * the policy version they were generated under (SoD-003 uses it).
 */

export type RuleCompiler = (lines: string[]) => PolicyRule[];

export async function currentPolicyRow(tx: Tx, tenantId: string, skillKey: string, entityId: string | null): Promise<Row<'skill_policies'> | null> {
  const rows = await tx.find('skill_policies', { tenant_id: tenantId, skill_key: skillKey }, { orderBy: [['version', 'desc']] });
  return rows.find((r) => r.entity_id === entityId) ?? rows.find((r) => r.entity_id === null) ?? null;
}

export function resolvePolicy(manifest: SkillManifest, row: Row<'skill_policies'> | null, compile: RuleCompiler): ResolvedPolicy {
  const thresholds = { ...defaultThresholds(manifest), ...((row?.thresholds as Record<string, number | boolean>) ?? {}) };
  return {
    id: row?.id ?? null,
    version: row?.version ?? 0,
    skillKey: manifest.key,
    entityId: row?.entity_id ?? null,
    autonomy: (row?.autonomy_level as AutonomyLevel) ?? manifest.autonomy.default,
    thresholds,
    rulesText: row ? ((row.rules_text as string[] | null) ?? []).join('\n') : manifest.rules.join('\n'),
    rules: row ? ((row.rules as PolicyRule[] | null) ?? []) : compile(manifest.rules).filter((r) => r.kind !== 'unparsed'),
    createdBy: row?.created_by ?? null,
  };
}

export interface PolicyChange {
  autonomy?: AutonomyLevel;
  thresholds?: Record<string, number | boolean>;
  rulesText?: string;
  reason: string;
  entityId?: string | null;
}

export interface PolicyPreview {
  rules: PolicyRule[];
  unparsed: PolicyRule[];
  thresholds: Record<string, number | boolean>;
  autonomy: AutonomyLevel;
  problems: string[];
}

export function previewPolicy(manifest: SkillManifest, current: ResolvedPolicy, change: Omit<PolicyChange, 'reason'>, compile: RuleCompiler): PolicyPreview {
  const problems: string[] = [];
  const autonomy = change.autonomy ?? current.autonomy;
  if (!autonomyAllowed(manifest, autonomy)) problems.push(`${manifest.name} allows autonomy up to ${manifest.autonomy.max}.`);
  const thresholds = { ...current.thresholds, ...(change.thresholds ?? {}) } as Record<string, number | boolean>;
  const parsed = thresholdSchema(manifest).safeParse(change.thresholds ?? {});
  if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const text = change.rulesText ?? current.rulesText;
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length > 50) problems.push('At most 50 rules per policy.');
  if (lines.some((l) => l.length > 300)) problems.push('Each rule must be under 300 characters.');
  const compiled = compile(lines);
  return { rules: compiled.filter((r) => r.kind !== 'unparsed'), unparsed: compiled.filter((r) => r.kind === 'unparsed'), thresholds, autonomy, problems };
}

/** Publish a new policy version (append-only). */
export async function changePolicy(tx: Tx, ctx: DomainContext, manifest: SkillManifest, change: PolicyChange, compile: RuleCompiler): Promise<Row<'skill_policies'>> {
  if (!change.reason || change.reason.trim().length < 5) throw new DomainError('VALIDATION', 'Say why you are changing the policy (at least 5 characters).');
  const entityId = change.entityId ?? null;
  const row = await currentPolicyRow(tx, ctx.tenantId, manifest.key, entityId);
  const current = resolvePolicy(manifest, row && row.entity_id === entityId ? row : null, compile);
  const preview = previewPolicy(manifest, current, change, compile);
  if (preview.problems.length) throw new DomainError('VALIDATION', preview.problems.join(' '), { problems: preview.problems });
  if (preview.unparsed.length) throw new DomainError('VALIDATION', `Could not understand: ${preview.unparsed.map((u) => `"${u.text}"`).join(', ')}`, { unparsed: preview.unparsed });
  const all = await tx.find('skill_policies', { tenant_id: ctx.tenantId, skill_key: manifest.key }, { orderBy: [['version', 'desc']] });
  const version = (all.filter((r) => r.entity_id === entityId)[0]?.version ?? 0) + 1;
  const created = await tx.insert('skill_policies', {
    tenant_id: ctx.tenantId,
    skill_key: manifest.key,
    entity_id: entityId,
    version,
    autonomy_level: preview.autonomy,
    thresholds: preview.thresholds as Record<string, number>,
    rules_text: (change.rulesText ?? current.rulesText).split('\n').map((l) => l.trim()).filter(Boolean),
    rules: preview.rules,
    change_reason: change.reason.trim(),
    created_by: ctx.actor.userId,
    supersedes_id: row && row.entity_id === entityId ? row.id : null,
  });
  const diff: string[] = [];
  if (preview.autonomy !== current.autonomy) diff.push(`autonomy ${current.autonomy} -> ${preview.autonomy}`);
  for (const [k, v] of Object.entries(preview.thresholds)) if (current.thresholds[k] !== v) diff.push(`${k} ${String(current.thresholds[k])} -> ${String(v)}`);
  if ((change.rulesText ?? current.rulesText) !== current.rulesText) diff.push('rules updated');
  await appendAudit(tx, ctx.tenantId, ctx.actor, {
    action: 'policy.change',
    objectType: 'skill_policy',
    objectId: created.id,
    summary: `${manifest.name} policy v${version}: ${diff.join(', ') || 'no effective change'} (${change.reason.trim()})`,
    details: { skill: manifest.key, version, autonomy: preview.autonomy, thresholds: preview.thresholds, rules: preview.rules, reason: change.reason },
  }, ctx.clock.now());
  return created;
}

// ------------------------------------------------------------------ disposition

export interface DispositionResult {
  disposition: Disposition;
  status: Row<'proposals'>['status'];
  reasons: string[];
  sampledForReview: boolean;
}

function ruleText(draft: ProposalDraft): string {
  return `${draft.title} ${JSON.stringify(draft.payload)}`.toLowerCase();
}

/**
 * Decide what happens to a verified proposal under the skill's autonomy policy and materiality.
 * Order: failed verification blocks; L0 suggests; L1 queues; L2/L3 auto-apply only when every gate passes.
 */
export function decideDisposition(args: {
  draft: ProposalDraft;
  verification: Verification;
  policy: ResolvedPolicy;
  materiality: Materiality;
  autoApplicable: boolean;
  matches: (pattern: string, text: string) => boolean;
  idForSampling: string;
}): DispositionResult {
  const { draft, verification, policy, materiality } = args;
  const reasons: string[] = [];
  if (!verification.passed) {
    return { disposition: 'blocked', status: 'blocked', reasons: verification.checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.message ?? c.label), sampledForReview: false };
  }
  if (policy.autonomy === 'L0') return { disposition: 'suggestion', status: 'suggested', reasons: ['Autonomy L0: suggestions only'], sampledForReview: false };
  const queue = (why: string): DispositionResult => ({ disposition: 'needs_approval', status: 'pending', reasons: [...reasons, why], sampledForReview: false });
  if (policy.autonomy === 'L1') return queue('Autonomy L1: every change needs approval');
  if (!args.autoApplicable) return queue('This kind of change always needs a person');
  if (draft.riskFlags?.length) return queue(`Risk flags: ${draft.riskFlags.join(', ')}`);
  const text = ruleText(draft);
  for (const r of policy.rules) {
    if (r.kind === 'require_review' && typeof r.match === 'string' && args.matches(r.match, text)) return queue(`Policy rule: "${r.text}"`);
  }
  const minConfidence = Number(policy.rules.find((r) => r.kind === 'min_confidence')?.value ?? policy.thresholds.minConfidence ?? 0.9);
  if (draft.confidence < minConfidence) return queue(`Confidence ${(draft.confidence * 100).toFixed(0)}% is below the ${(minConfidence * 100).toFixed(0)}% auto-apply floor`);
  const hardCap = Number(policy.rules.find((r) => r.kind === 'max_auto_amount')?.amountMinor ?? Number.POSITIVE_INFINITY);
  let limit: number;
  if (policy.autonomy === 'L2') {
    const ruleLimit = policy.rules.find((r) => r.kind === 'auto_post_under')?.amountMinor;
    limit = Number(ruleLimit ?? policy.thresholds.autoApplyLimitMinor ?? materiality.trivialMinor);
  } else {
    const share = Number(policy.thresholds.materialityShare ?? 0.1);
    limit = Math.round(materiality.performanceMinor * share);
  }
  limit = Math.min(limit, hardCap);
  const money = (minor: number) => formatMoney(minor, { currency: draft.currency });
  if (draft.amountMinor > limit) return queue(`${money(draft.amountMinor)} is above the auto-apply limit of ${money(limit)}`);
  const sampleRate = Number(policy.rules.find((r) => r.kind === 'sample_rate')?.value ?? policy.thresholds.sampleRate ?? (policy.autonomy === 'L3' ? 0.25 : 0.1));
  const sampled = unitHash(args.idForSampling) < sampleRate || (policy.autonomy === 'L3' && draft.amountMinor > materiality.trivialMinor);
  return { disposition: 'auto_apply', status: 'auto_applied', reasons: [`Within ${policy.autonomy} policy (limit ${money(limit)}, confidence ${(draft.confidence * 100).toFixed(0)}%)`], sampledForReview: sampled };
}
