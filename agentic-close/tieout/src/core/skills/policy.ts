/**
 * Versioned skill policies: every change creates a new immutable version (is_current flips) and
 * an audit event. Autonomy can never exceed the manifest's max; thresholds respect their bounds.
 */
import type { Actor, AutonomyLevel, EffectivePolicy } from '../agent/types';
import { audit } from '../audit/audit';
import { forbidden, notFound, validation } from '../util/errors';
import type { Clock } from '../util/time';
import type { DbTx, SkillPolicyRow } from '../../schema';
import { autonomyRank, type SkillManifest } from './manifest';
import type { PolicyMapping, PolicyRule } from './policy-types';

/** Generic thresholds every skill understands, on top of manifest-declared ones. */
export const GENERIC_THRESHOLDS = {
  autoPostMaxMinor: { label: 'Auto-post ceiling', description: 'Largest single amount an agent may post without a person (L2/L3).', unit: 'minor' as const },
  minConfidenceAuto: { label: 'Minimum confidence to auto-post', description: 'Proposals below this confidence always wait for a person.', unit: 'ratio' as const },
  sampleRatePct: { label: 'Post-hoc review sample (L2)', description: 'Share of auto-posted items queued for after-the-fact review.', unit: 'pct' as const },
};

export function defaultThresholds(m: SkillManifest, clearlyTrivialMinor: number, performanceMinor: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, spec] of Object.entries(m.thresholds)) out[k] = spec.default;
  const ap = m.materiality.autoPostMax;
  out.autoPostMaxMinor = ap === 'clearly_trivial' ? clearlyTrivialMinor : ap === 'performance' ? performanceMinor : ap === 'none' ? 0 : ap;
  out.minConfidenceAuto = m.confidence.minAuto;
  out.sampleRatePct = out.sampleRatePct ?? 20;
  return out;
}

export function toEffective(row: SkillPolicyRow): EffectivePolicy {
  return { version: row.version, autonomy: row.autonomy_level, thresholds: row.thresholds, mappings: row.mappings, rules: row.rules.filter((r) => r.status === 'active') };
}

export async function currentPolicyRow(tx: DbTx, skillId: string, entityId: string | null): Promise<SkillPolicyRow> {
  if (entityId) {
    const scoped = await tx.findOne('skill_policies', { skill_id: skillId, scope_entity_id: entityId, is_current: true });
    if (scoped) return scoped;
  }
  const global = await tx.findOne('skill_policies', { skill_id: skillId, scope_entity_id: null, is_current: true });
  if (!global) throw notFound('Skill policy', skillId);
  return global;
}

export interface PolicyChange {
  autonomy?: AutonomyLevel;
  thresholds?: Record<string, number>;
  mappings?: PolicyMapping[];
  rules?: PolicyRule[];
  enabled?: boolean;
  note: string;
}

export async function updatePolicy(tx: DbTx, actor: Actor, clock: Clock, skillId: string, manifest: SkillManifest, change: PolicyChange, scopeEntityId: string | null = null): Promise<SkillPolicyRow> {
  if (!change.note || change.note.trim().length < 4) throw validation('Describe why you are changing the policy (it is recorded in the audit log).');
  if (change.autonomy && !actor.permissions.has('skill.autonomy.set')) throw forbidden('Only a Controller or CFO can change autonomy levels.');
  if ((change.thresholds || change.mappings || change.rules) && !actor.permissions.has('skill.policy.edit')) throw forbidden('You do not have permission to edit skill policies.');
  if (change.autonomy && autonomyRank(change.autonomy) > autonomyRank(manifest.autonomy.max))
    throw validation(`This skill allows at most ${manifest.autonomy.max}; ${change.autonomy} is not permitted by its manifest.`);
  const cur = await currentPolicyRow(tx, skillId, scopeEntityId);
  const thresholds = { ...cur.thresholds, ...(change.thresholds ?? {}) };
  for (const [k, v] of Object.entries(change.thresholds ?? {})) {
    const spec = manifest.thresholds[k];
    if (!spec && !(k in GENERIC_THRESHOLDS)) throw validation(`This skill has no threshold called ${k}.`);
    if (!Number.isFinite(v)) throw validation(`Threshold ${k} must be a number`);
    if (spec?.min !== undefined && v < spec.min) throw validation(`${spec.label} must be at least ${spec.min}`);
    if (spec?.max !== undefined && v > spec.max) throw validation(`${spec.label} must be at most ${spec.max}`);
    if (k === 'minConfidenceAuto' && (v < 0.5 || v > 1)) throw validation('Minimum auto-post confidence must be between 0.5 and 1');
    if (k === 'sampleRatePct' && (v < 0 || v > 100)) throw validation('Sample rate must be 0–100%');
    if (k === 'autoPostMaxMinor' && v < 0) throw validation('Auto-post ceiling cannot be negative');
  }
  await tx.update('skill_policies', cur.id, { is_current: false });
  const next = await tx.insert('skill_policies', {
    skill_id: skillId,
    scope_entity_id: scopeEntityId,
    version: cur.version + 1,
    is_current: true,
    autonomy_level: change.autonomy ?? cur.autonomy_level,
    thresholds,
    mappings: change.mappings ?? cur.mappings,
    rules: change.rules ?? cur.rules,
    enabled: change.enabled ?? cur.enabled,
    change_note: change.note.trim(),
    changed_by: actor.id,
    created_at: clock.now().toISOString(),
  });
  const diff: Record<string, unknown> = {};
  if (change.autonomy && change.autonomy !== cur.autonomy_level) diff.autonomy = [cur.autonomy_level, change.autonomy];
  for (const [k, v] of Object.entries(change.thresholds ?? {})) if (cur.thresholds[k] !== v) diff[`threshold.${k}`] = [cur.thresholds[k] ?? null, v];
  if (change.mappings) diff.mappings = [cur.mappings.length, change.mappings.length];
  if (change.rules) diff.rules = [cur.rules.length, change.rules.length];
  await audit(tx, actor, clock, { action: 'skill.policy.update', subjectType: 'skill', subjectId: skillId, entityId: scopeEntityId, summary: `Policy v${next.version}: ${change.note.trim()}`, data: { fromVersion: cur.version, toVersion: next.version, diff } });
  return next;
}
