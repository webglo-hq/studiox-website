/**
 * Typed skill manifest. Lives under `metadata.tieout` in SKILL.md frontmatter so the file stays a
 * valid Agent Skill (name + description + optional allowed-tools/metadata per the open spec),
 * while Tieout gets a machine-checked contract: ontology-typed I/O, least-privilege tools,
 * permissions, controls, autonomy bounds, materiality, budgets, live model, eval fixtures.
 */
import { z } from 'zod';

const AutonomyLevel = z.enum(['L0', 'L1', 'L2', 'L3']);
const ontologyRef = z.string().regex(/^tie:[A-Z][A-Za-z]+(\[\])?$/, 'must be an ontology class id like tie:JournalEntry');

export const ThresholdSpec = z.object({
  label: z.string(),
  description: z.string(),
  default: z.number(),
  unit: z.enum(['minor', 'pct', 'days', 'ratio', 'count']),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const SkillManifestSchema = z.object({
  title: z.string().min(3),
  summary: z.string().min(10),
  category: z.enum(['coding', 'reconciliation', 'tie_out', 'accruals', 'schedules', 'flux', 'intercompany', 'review', 'fx', 'orchestration', 'reporting']),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  inputs: z.array(z.object({ name: z.string(), type: ontologyRef, optional: z.boolean().optional(), description: z.string().optional() })),
  outputs: z.array(z.object({ type: ontologyRef, kind: z.enum(['journal_entry', 'coding', 'rec_match', 'reconciling_item', 'flux_explanation', 'finding', 'schedule_update', 'report']), description: z.string().optional() })),
  permissions: z.array(z.string()).min(1),
  controls: z.object({
    approverRoles: z.array(z.string()).min(1),
    makerChecker: z.boolean(),
    requesterMayApprove: z.boolean(),
    evidenceRequired: z.boolean(),
  }),
  autonomy: z.object({ default: AutonomyLevel, max: AutonomyLevel }),
  materiality: z.object({
    autoPostMax: z.union([z.enum(['clearly_trivial', 'performance', 'none']), z.number().nonnegative()]),
    escalateAbove: z.enum(['clearly_trivial', 'performance', 'overall']),
  }),
  confidence: z.object({ minAuto: z.number().min(0).max(1) }),
  thresholds: z.record(z.string(), ThresholdSpec).default({}),
  budgets: z.object({ maxSteps: z.number().int().positive(), maxToolCalls: z.number().int().positive(), maxCostUsd: z.number().positive() }),
  model: z.object({ live: z.enum(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']), effort: z.enum(['low', 'medium', 'high']) }),
  dependsOn: z.array(z.string()).default([]),
  evals: z.array(z.string()).min(1),
  resources: z.array(z.string()).default([]),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type ThresholdSpec = z.infer<typeof ThresholdSpec>;

export const SkillFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,64}$/, 'name: lowercase letters, digits and hyphens (max 64)'),
  description: z.string().min(20).max(1024),
  license: z.string().optional(),
  'allowed-tools': z.string().min(1),
  metadata: z.object({ tieout: SkillManifestSchema }).passthrough(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

const ORDER = ['L0', 'L1', 'L2', 'L3'] as const;
export function autonomyRank(level: string): number {
  return ORDER.indexOf(level as (typeof ORDER)[number]);
}
