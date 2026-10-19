import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { OntologyModel } from '../ontology/model';
import { sha256Hex } from '../util/sha256';

/**
 * Skills follow the Agent Skills convention — a folder with SKILL.md (YAML frontmatter with
 * `name` and `description`, then Markdown instructions) plus optional resources — and add
 * a typed `evenkeel` manifest: ontology-typed inputs/outputs, least-privilege tools,
 * permissions, controls, autonomy, materiality, budgets and eval fixtures.
 *
 * Progressive disclosure:
 *   level 1 — name + description (always in the catalogue / system prompt)
 *   level 2 — SKILL.md body (loaded when the skill runs)
 *   level 3 — resources (loaded on demand through the read_skill_resource tool)
 */
export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

const Semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'semantic version x.y.z');

export const SkillManifest = z.object({
  version: Semver,
  title: z.string().min(3).max(80),
  domain: z.string().min(2).max(40),
  category: z.string().min(2).max(40),
  summary: z.string().min(10).max(300),
  ontology: z.string().regex(/^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$/, 'ontology range like ">=1.0.0 <2.0.0"'),
  inputs: z
    .array(z.object({ name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/), type: z.string(), required: z.boolean().default(true), description: z.string().max(200).default('') }))
    .max(10),
  outputs: z.array(z.string()).min(1).max(12),
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).max(30),
  permissions: z.array(z.string()).min(1).max(10),
  controls: z.object({
    preparer: z.string(),
    reviewer: z.string(),
    approvalRequired: z.array(z.string()).default([]),
    sod: z.array(z.string()).default([]),
    assertions: z.array(z.string()).default([]),
    coso: z.string().optional(),
  }),
  autonomy: z.object({
    default: z.enum(AUTONOMY_LEVELS),
    max: z.enum(AUTONOMY_LEVELS),
    autoPostBelow: z.number().int().nonnegative(),
    minConfidence: z.number().min(0).max(1),
    sampleRate: z.number().min(0).max(1),
  }),
  materiality: z.object({ basis: z.enum(['clearly_trivial', 'performance', 'overall']), note: z.string().optional() }),
  thresholds: z.record(z.string(), z.number()).default({}),
  budgets: z.object({ maxSteps: z.number().int().positive(), maxTokens: z.number().int().nonnegative(), maxCostUsd: z.number().nonnegative() }),
  model: z.enum(['fast', 'balanced', 'deep']),
  resources: z.array(z.object({ path: z.string(), description: z.string() })).default([]),
  evals: z.string().optional(),
  closeTask: z.object({ category: z.string(), workday: z.number().int() }).optional(),
});
export type SkillManifest = z.infer<typeof SkillManifest>;

export const SkillFrontmatter = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'kebab-case skill name'),
  description: z.string().min(20).max(1024),
  license: z.string().optional(),
  evenkeel: SkillManifest,
});

export interface SkillPackage {
  id: string;
  name: string;
  description: string;
  manifest: SkillManifest;
  instructions: string;
  /** relative resource path → content (level 3, loaded lazily by tools) */
  resources: Record<string, string>;
  evalCases: unknown[];
  contentHash: string;
  sourcePath: string;
}

export class SkillError extends Error {
  constructor(skill: string, message: string) {
    super(`Skill ${skill}: ${message}`);
    this.name = 'SkillError';
  }
}

export function parseSkillMarkdown(text: string, sourcePath: string): { frontmatter: z.infer<typeof SkillFrontmatter>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new SkillError(sourcePath, 'SKILL.md must start with YAML frontmatter between --- lines');
  let raw: unknown;
  try {
    raw = parseYaml(m[1]!, { schema: 'core', maxAliasCount: 10 });
  } catch (e) {
    throw new SkillError(sourcePath, `invalid YAML frontmatter: ${(e as Error).message}`);
  }
  const parsed = SkillFrontmatter.safeParse(raw);
  if (!parsed.success) {
    throw new SkillError(sourcePath, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return { frontmatter: parsed.data, body: m[2]!.trim() };
}

/**
 * Build skill packages from a flat file map ("skills/<id>/SKILL.md" → text). The same
 * function serves Node (fs) and the browser bundle (import.meta.glob).
 */
export function loadSkillPackages(files: Record<string, string>): SkillPackage[] {
  const byDir = new Map<string, Record<string, string>>();
  for (const [path, content] of Object.entries(files)) {
    const norm = path.replace(/\\/g, '/');
    const m = /(?:^|\/)skills\/([a-z0-9-]+)\/(.+)$/.exec(norm);
    if (!m) continue;
    const dir = m[1]!;
    const rel = m[2]!;
    const entry = byDir.get(dir) ?? {};
    entry[rel] = content;
    byDir.set(dir, entry);
  }
  const out: SkillPackage[] = [];
  for (const [dir, entry] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const md = entry['SKILL.md'];
    if (!md) continue;
    const { frontmatter, body } = parseSkillMarkdown(md, `skills/${dir}/SKILL.md`);
    if (frontmatter.name !== dir) throw new SkillError(dir, `frontmatter name "${frontmatter.name}" must equal its folder name`);
    const resources: Record<string, string> = {};
    for (const r of frontmatter.evenkeel.resources) {
      const content = entry[r.path];
      if (content === undefined) throw new SkillError(dir, `declared resource ${r.path} is missing`);
      resources[r.path] = content;
    }
    let evalCases: unknown[] = [];
    if (frontmatter.evenkeel.evals) {
      const ev = entry[frontmatter.evenkeel.evals];
      if (ev === undefined) throw new SkillError(dir, `declared evals ${frontmatter.evenkeel.evals} are missing`);
      evalCases = (JSON.parse(ev) as { cases: unknown[] }).cases;
    }
    out.push({
      id: dir,
      name: frontmatter.name,
      description: frontmatter.description,
      manifest: frontmatter.evenkeel,
      instructions: body,
      resources,
      evalCases,
      contentHash: sha256Hex(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}\n${v}`).join('\n--\n')),
      sourcePath: `skills/${dir}`,
    });
  }
  return out;
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export function satisfiesRange(version: string, range: string): boolean {
  const m = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range);
  if (!m) return false;
  return cmpSemver(version, m[1]!) >= 0 && cmpSemver(version, m[2]!) < 0;
}

export interface SkillValidationContext {
  ontology: OntologyModel;
  toolNames: Set<string>;
  permissions: Set<string>;
  proposalKinds: Set<string>;
}

/** Cross-check a skill against the ontology, tool registry and permission catalogue. */
export function validateSkill(s: SkillPackage, ctx: SkillValidationContext): string[] {
  const problems: string[] = [];
  const m = s.manifest;
  if (!satisfiesRange(ctx.ontology.version, m.ontology)) problems.push(`requires ontology ${m.ontology}, have ${ctx.ontology.version}`);
  for (const i of m.inputs) if (!ctx.ontology.hasClass(i.type)) problems.push(`input ${i.name} has unknown ontology type ${i.type}`);
  for (const o of m.outputs) if (!ctx.ontology.hasClass(o)) problems.push(`output type ${o} is not an ontology class`);
  for (const t of m.tools) if (!ctx.toolNames.has(t)) problems.push(`tool ${t} is not registered`);
  for (const p of m.permissions) if (!ctx.permissions.has(p)) problems.push(`permission ${p} is not defined`);
  for (const k of m.controls.approvalRequired) if (!ctx.proposalKinds.has(k)) problems.push(`approvalRequired names unknown proposal kind ${k}`);
  for (const a of m.controls.assertions) if (!ctx.ontology.individualsOf('ek:Assertion').some((x) => x.id === a)) problems.push(`assertion ${a} is not an ontology assertion`);
  const order = (l: AutonomyLevel) => AUTONOMY_LEVELS.indexOf(l);
  if (order(m.autonomy.default) > order(m.autonomy.max)) problems.push('default autonomy exceeds the maximum');
  return problems;
}
