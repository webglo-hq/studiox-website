import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Ontology } from '../../ontology/kernel';
import { PROPOSAL_KINDS } from '../../persistence/schema';
import { PERMISSIONS } from '../../security/permissions';
import { sha256Hex } from '../../shared/hash';

/**
 * Skill packages: SKILL.md = YAML frontmatter (the typed manifest) + Markdown instructions for the model.
 * The manifest declares ontology-typed inputs/outputs, the only tools the skill may call, permissions, the
 * controls it operates, autonomy bounds, policy thresholds, materiality basis, budgets and eval fixtures.
 */

const AUTONOMY = z.enum(['L0', 'L1', 'L2', 'L3']);

const ThresholdSpec = z
  .object({
    type: z.enum(['integer', 'number', 'money', 'percent', 'boolean', 'days']),
    default: z.union([z.number(), z.boolean()]),
    min: z.number().optional(),
    max: z.number().optional(),
    label: z.string().min(3),
    help: z.string().optional(),
  })
  .strict();

const InputSpec = z
  .object({
    type: z.string().regex(/^bh:[A-Za-z]+$/),
    required: z.boolean().default(false),
    description: z.string().min(3),
  })
  .strict();

export const SkillManifestSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    name: z.string().min(3),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    domain: z.string().min(2),
    category: z.string().min(2),
    summary: z.string().min(10),
    inputs: z.record(z.string(), InputSpec),
    outputs: z.array(z.object({ kind: z.enum(PROPOSAL_KINDS), type: z.string().regex(/^bh:[A-Za-z]+$/) }).strict()),
    tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,63}$/)).min(1),
    permissions: z.object({ run: z.string(), approve: z.string() }).strict(),
    controls: z.array(z.object({ id: z.string().regex(/^CTL-[A-Z0-9-]+$/), name: z.string(), assertions: z.array(z.string()).min(1) }).strict()),
    autonomy: z.object({ default: AUTONOMY, max: AUTONOMY }).strict(),
    thresholds: z.record(z.string(), ThresholdSpec).default({}),
    rules: z.array(z.string()).default([]),
    materiality: z.enum(['none', 'trivial', 'performance', 'overall']),
    budgets: z
      .object({
        maxSteps: z.number().int().positive(),
        maxToolCalls: z.number().int().positive(),
        maxTokens: z.number().int().positive(),
        maxCostUsd: z.number().positive(),
      })
      .strict(),
    evals: z.string().optional(),
    /** Skills this skill may start as child runs ("*" = any); used by the close orchestrator. */
    spawns: z.array(z.string()).default([]),
    /** deterministic = never sent to a model (scheduling/assembly skills whose logic must be exact). */
    execution: z.enum(['agentic', 'deterministic']).default('agentic'),
  })
  .strict();

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export interface SkillPackage {
  manifest: SkillManifest;
  instructions: string;
  /** SHA-256 of the full SKILL.md: the published version's identity. */
  contentHash: string;
  source: string;
}

export class SkillManifestError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = 'SkillManifestError';
  }
}

export function parseSkillMd(source: string, label = 'SKILL.md'): SkillPackage {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!m) throw new SkillManifestError(`${label}: missing YAML frontmatter`, ['SKILL.md must start with --- frontmatter ---']);
  let raw: unknown;
  try {
    raw = parseYaml(m[1]!);
  } catch (e) {
    throw new SkillManifestError(`${label}: invalid YAML`, [e instanceof Error ? e.message : String(e)]);
  }
  const parsed = SkillManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new SkillManifestError(`${label}: invalid manifest`, problems);
  }
  return { manifest: parsed.data, instructions: m[2]!.trim(), contentHash: sha256Hex(source), source };
}

const ORDER = ['L0', 'L1', 'L2', 'L3'];

/** Cross-checks the manifest against the tool registry, the ontology and the permission model. */
export function validateManifest(pkg: SkillPackage, deps: { tools: ReadonlySet<string>; ontology: Ontology; proposalTools: ReadonlyMap<string, string> }): string[] {
  const { manifest } = pkg;
  const problems: string[] = [];
  for (const t of manifest.tools) if (!deps.tools.has(t)) problems.push(`tools: "${t}" is not a registered tool`);
  for (const [name, spec] of Object.entries(manifest.inputs)) {
    if (!deps.ontology.getClass(spec.type)) problems.push(`inputs.${name}: ontology class ${spec.type} does not exist`);
  }
  for (const out of manifest.outputs) {
    if (!deps.ontology.getClass(out.type)) problems.push(`outputs: ontology class ${out.type} does not exist`);
    const producer = [...deps.proposalTools.entries()].find(([, kind]) => kind === out.kind)?.[0];
    if (producer && !manifest.tools.includes(producer) && !manifest.tools.some((t) => deps.proposalTools.get(t) === out.kind)) {
      problems.push(`outputs: declares ${out.kind} proposals but no tool that proposes them`);
    }
  }
  for (const p of [manifest.permissions.run, manifest.permissions.approve]) if (!(p in PERMISSIONS)) problems.push(`permissions: unknown permission "${p}"`);
  if (ORDER.indexOf(manifest.autonomy.default) > ORDER.indexOf(manifest.autonomy.max)) problems.push('autonomy: default exceeds max');
  for (const [k, t] of Object.entries(manifest.thresholds)) {
    if (typeof t.default === 'number' && ((t.min !== undefined && t.default < t.min) || (t.max !== undefined && t.default > t.max))) problems.push(`thresholds.${k}: default outside [min, max]`);
    if (t.type === 'boolean' && typeof t.default !== 'boolean') problems.push(`thresholds.${k}: boolean threshold needs a boolean default`);
  }
  if (!pkg.instructions.includes('##')) problems.push('instructions: expected Markdown sections (## headings)');
  return problems;
}

/** zod schema for a policy's thresholds, derived from the manifest (unknown keys rejected). */
export function thresholdSchema(manifest: SkillManifest): z.ZodType<Record<string, number | boolean>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, t] of Object.entries(manifest.thresholds)) {
    if (t.type === 'boolean') shape[k] = z.boolean();
    else {
      let n = t.type === 'integer' || t.type === 'money' || t.type === 'days' ? z.number().int() : z.number();
      if (t.min !== undefined) n = n.min(t.min);
      if (t.max !== undefined) n = n.max(t.max);
      shape[k] = n;
    }
  }
  return z.object(shape).partial().strict() as unknown as z.ZodType<Record<string, number | boolean>>;
}

export function defaultThresholds(manifest: SkillManifest): Record<string, number | boolean> {
  return Object.fromEntries(Object.entries(manifest.thresholds).map(([k, t]) => [k, t.default]));
}

export function autonomyAllowed(manifest: SkillManifest, level: string): boolean {
  return ORDER.includes(level) && ORDER.indexOf(level) <= ORDER.indexOf(manifest.autonomy.max);
}
