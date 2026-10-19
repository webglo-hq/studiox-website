/**
 * SKILL.md loader (Agent Skills format: YAML frontmatter + Markdown instructions + resources),
 * with progressive disclosure:
 *   level 1  name + description          → always visible (catalog, orchestrator context)
 *   level 2  SKILL.md body               → loaded when the skill runs
 *   level 3  resources/*                 → loaded on demand via the read_skill_resource tool
 */
import { parse as parseYaml } from 'yaml';
import { sha256Hex } from '../util/hash';
import { SkillFrontmatterSchema, type SkillFrontmatter, type SkillManifest } from './manifest';
import type { EvalCase } from './eval-types';

export interface SkillBundleFile {
  path: string;
  content: string;
}

export interface LoadedSkill {
  key: string;
  version: string;
  frontmatter: SkillFrontmatter;
  manifest: SkillManifest;
  /** level-2 instructions */
  body: string;
  allowedTools: string[];
  resources: Map<string, string>;
  evals: EvalCase[];
  skillMd: string;
  contentHash: string;
}

export function splitFrontmatter(md: string): { yaml: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) throw new Error('SKILL.md must start with YAML frontmatter delimited by ---');
  return { yaml: m[1]!, body: m[2]!.trim() };
}

export function loadSkill(key: string, files: readonly SkillBundleFile[]): LoadedSkill {
  const skillMd = files.find((f) => f.path === 'SKILL.md');
  if (!skillMd) throw new Error(`skill ${key}: SKILL.md not found`);
  const { yaml, body } = splitFrontmatter(skillMd.content);
  const raw = parseYaml(yaml) as unknown;
  const parsed = SkillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`skill ${key}: invalid frontmatter: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const fm = parsed.data;
  if (fm.name !== key) throw new Error(`skill ${key}: frontmatter name "${fm.name}" must match its folder`);
  const manifest = fm.metadata.tieout;
  const resources = new Map<string, string>();
  for (const f of files) if (f.path.startsWith('resources/')) resources.set(f.path, f.content);
  for (const r of manifest.resources) if (!resources.has(r)) throw new Error(`skill ${key}: manifest lists missing resource ${r}`);
  const evals: EvalCase[] = [];
  for (const e of manifest.evals) {
    const f = files.find((x) => x.path === e);
    if (!f) throw new Error(`skill ${key}: eval file ${e} not found`);
    const cases = JSON.parse(f.content) as EvalCase[];
    if (!Array.isArray(cases) || !cases.length) throw new Error(`skill ${key}: eval file ${e} has no cases`);
    evals.push(...cases);
  }
  const allowedTools = fm['allowed-tools'].split(/[\s,]+/).filter(Boolean);
  return {
    key,
    version: manifest.version,
    frontmatter: fm,
    manifest,
    body,
    allowedTools,
    resources,
    evals,
    skillMd: skillMd.content,
    contentHash: sha256Hex(files.map((f) => `${f.path}\n${f.content}`).sort().join('\n\u0000')),
  };
}

export class SkillRegistry {
  private readonly skills = new Map<string, LoadedSkill>();

  constructor(bundles: readonly { key: string; files: readonly SkillBundleFile[] }[]) {
    for (const b of bundles) this.skills.set(b.key, loadSkill(b.key, b.files));
  }

  get(key: string): LoadedSkill {
    const s = this.skills.get(key);
    if (!s) throw new Error(`unknown skill ${key}`);
    return s;
  }

  has(key: string): boolean {
    return this.skills.has(key);
  }

  all(): LoadedSkill[] {
    return [...this.skills.values()];
  }

  /** Level-1 disclosure: what an orchestrating agent sees about every skill. */
  catalog(): { key: string; description: string }[] {
    return this.all().map((s) => ({ key: s.key, description: s.frontmatter.description }));
  }
}
