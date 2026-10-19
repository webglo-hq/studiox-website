import type { SkillPolicy } from '../../../framework/runtime/types';
import { AUTONOMY_LEVELS, type AutonomyLevel, type SkillPackage } from '../../../framework/skills/manifest';
import { AppError } from '../../../framework/util/errors';
import { audit } from '../domain/audit';
import { canSeeEntity, requireAllEntities, requirePermission, withDb, type ServiceContext } from '../domain/context';
import { compileRules, type CompiledRule, type CompileResult, type RuleRefs } from '../domain/policy-rules';
import { accounts, dimensionValues } from '../domain/refdata';
import { person, type PersonRef } from './common';

/**
 * Skills registry and policy administration. Policies are versioned rows: every change —
 * plain-English rules, thresholds, autonomy level — creates a new version with a change note
 * and an audit event, so the policy in force for any agent run can be reproduced.
 */

export async function ruleRefs(ctx: ServiceContext): Promise<RuleRefs> {
  const accs = [...(await accounts(ctx)).values()].filter((a) => a.is_active);
  const depts = await dimensionValues(ctx, 'department');
  return { accounts: accs.map((a) => ({ id: a.id, code: a.code, name: a.name, isPostable: a.is_postable })), departments: depts.map((d) => ({ id: d.id, code: d.code, name: d.name })) };
}

function baseThresholds(s: SkillPackage): Record<string, number> {
  return { ...s.manifest.thresholds, autoPostBelow: s.manifest.autonomy.autoPostBelow, minConfidence: s.manifest.autonomy.minConfidence, sampleRate: s.manifest.autonomy.sampleRate };
}

export async function registerSkills(ctx: ServiceContext, skills: SkillPackage[], opts: { createdBy: string | null; policyText?: Record<string, string> }): Promise<void> {
  const refs = await ruleRefs(ctx);
  for (const s of skills) {
    if (!(await ctx.db.get('skill', s.id))) await ctx.db.insert('skill', { id: s.id, name: s.manifest.title, description: s.description, domain: s.manifest.domain, current_version: s.manifest.version });
    else await ctx.db.update('skill', s.id, { current_version: s.manifest.version, name: s.manifest.title, description: s.description });
    if (!(await ctx.db.findOne('skill_version', { skill_id: s.id, version: s.manifest.version }))) {
      await ctx.db.insert('skill_version', { skill_id: s.id, version: s.manifest.version, manifest: s.manifest as unknown as Record<string, unknown>, instructions: s.instructions, content_hash: s.contentHash });
    }
    if (!(await ctx.db.findOne('skill_policy', { tenant_id: ctx.tenantId, skill_id: s.id }))) {
      const text = opts.policyText?.[s.id] ?? '';
      const compiled = compileRules(text, refs);
      if (compiled.errors.length) throw new Error(`Default policy for ${s.id} does not compile: ${compiled.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`);
      await ctx.db.insert('skill_policy', { tenant_id: ctx.tenantId, skill_id: s.id, version: 1, autonomy_level: s.manifest.autonomy.default, thresholds: baseThresholds(s), mappings: {}, rules_text: text, rules: compiled.rules as unknown[], enabled: true, change_note: 'Initial policy', created_by: opts.createdBy, is_current: true });
    }
  }
}

/** The policy in force for a skill (rules can override thresholds). */
export async function currentPolicy(ctx: ServiceContext, skill: SkillPackage): Promise<SkillPolicy> {
  const row = await ctx.db.findOne('skill_policy', { tenant_id: ctx.tenantId, skill_id: skill.id, is_current: true });
  const thresholds = { ...baseThresholds(skill), ...(row?.thresholds ?? {}) };
  const rules = (row?.rules ?? []) as CompiledRule[];
  for (const r of rules) if (r.kind === 'threshold') thresholds[r.key] = r.value;
  return {
    version: row?.version ?? 0,
    autonomy: (row?.autonomy_level ?? skill.manifest.autonomy.default) as AutonomyLevel,
    enabled: row?.enabled ?? true,
    thresholds,
    rules,
    autoPostBelow: thresholds.autoPostBelow ?? skill.manifest.autonomy.autoPostBelow,
    minConfidence: thresholds.minConfidence ?? skill.manifest.autonomy.minConfidence,
    sampleRate: thresholds.sampleRate ?? skill.manifest.autonomy.sampleRate,
  };
}

export interface SkillCard {
  id: string;
  title: string;
  description: string;
  summary: string;
  category: string;
  version: string;
  model: string;
  autonomy: AutonomyLevel;
  maxAutonomy: AutonomyLevel;
  enabled: boolean;
  autoPostBelow: number;
  minConfidence: number;
  sampleRate: number;
  policyVersion: number;
  outputs: string[];
  tools: string[];
  permissions: string[];
  controls: SkillPackage['manifest']['controls'];
  runs: number;
  lastRun: { id: string; status: string; at: string | null } | null;
  proposals: { total: number; auto: number; approved: number; rejected: number; pending: number };
  evals: { passed: number; total: number; at: string; engine: string } | null;
}

export async function listSkills(ctx: ServiceContext, skills: SkillPackage[]): Promise<SkillCard[]> {
  requirePermission(ctx, 'close.view');
  const runs = (await ctx.db.find('agent_run', { tenant_id: ctx.tenantId }, { orderBy: [['created_at', 'desc']] })).filter((r) => canSeeEntity(ctx, r.entity_id));
  const proposals = (await ctx.db.find('proposal', { tenant_id: ctx.tenantId })).filter((p) => canSeeEntity(ctx, p.entity_id));
  const out: SkillCard[] = [];
  for (const s of skills) {
    const p = await currentPolicy(ctx, s);
    const rs = runs.filter((r) => r.skill_id === s.id);
    const ps = proposals.filter((x) => x.skill_id === s.id);
    const ev = (await ctx.db.find('eval_run', { skill_id: s.id }, { orderBy: [['created_at', 'desc']], limit: 1 }))[0];
    out.push({
      id: s.id,
      title: s.manifest.title,
      description: s.description,
      summary: s.manifest.summary,
      category: s.manifest.category,
      version: s.manifest.version,
      model: s.manifest.model,
      autonomy: p.autonomy,
      maxAutonomy: s.manifest.autonomy.max,
      enabled: p.enabled,
      autoPostBelow: p.autoPostBelow,
      minConfidence: p.minConfidence,
      sampleRate: p.sampleRate,
      policyVersion: p.version,
      outputs: s.manifest.outputs,
      tools: s.manifest.tools,
      permissions: s.manifest.permissions,
      controls: s.manifest.controls,
      runs: rs.length,
      lastRun: rs[0] ? { id: rs[0].id, status: rs[0].status, at: rs[0].finished_at ?? rs[0].started_at } : null,
      proposals: {
        total: ps.length,
        auto: ps.filter((x) => x.status === 'auto_applied').length,
        approved: ps.filter((x) => x.status === 'applied' || x.status === 'approved').length,
        rejected: ps.filter((x) => x.status === 'rejected').length,
        pending: ps.filter((x) => x.status === 'pending' || x.status === 'suggested').length,
      },
      evals: ev ? { passed: ev.passed, total: ev.total, at: ev.created_at, engine: ev.engine } : null,
    });
  }
  return out;
}

export interface PolicyVersion {
  version: number;
  autonomy: AutonomyLevel;
  enabled: boolean;
  thresholds: Record<string, number>;
  rulesText: string;
  rules: { line: number; source: string; explanation: string; kind: string }[];
  changeNote: string | null;
  createdBy: PersonRef | null;
  createdAt: string;
  current: boolean;
}

export async function skillDetail(ctx: ServiceContext, skills: SkillPackage[], id: string) {
  requirePermission(ctx, 'close.view');
  const s = skills.find((x) => x.id === id);
  if (!s) throw new AppError('NOT_FOUND', 'Skill not found');
  const rows = await ctx.db.find('skill_policy', { tenant_id: ctx.tenantId, skill_id: id }, { orderBy: [['version', 'desc']] });
  const versions: PolicyVersion[] = [];
  for (const r of rows) {
    versions.push({
      version: r.version,
      autonomy: r.autonomy_level,
      enabled: r.enabled,
      thresholds: r.thresholds,
      rulesText: r.rules_text,
      rules: ((r.rules ?? []) as CompiledRule[]).map((x) => ({ line: x.line, source: x.source, explanation: x.explanation, kind: x.kind })),
      changeNote: r.change_note,
      createdBy: await person(ctx, r.created_by),
      createdAt: r.created_at,
      current: r.is_current,
    });
  }
  const evals = await ctx.db.find('eval_run', { skill_id: id }, { orderBy: [['created_at', 'desc']], limit: 5 });
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    manifest: s.manifest,
    instructions: s.instructions,
    resources: s.manifest.resources.map((r) => ({ path: r.path, description: r.description, content: s.resources[r.path] ?? '' })),
    evalCases: (s.evalCases as { id?: string; description?: string }[]).map((c) => ({ id: c.id ?? '', description: c.description ?? '' })),
    evalRuns: evals.map((e) => ({ at: e.created_at, engine: e.engine, passed: e.passed, total: e.total, results: e.results })),
    contentHash: s.contentHash,
    policy: await currentPolicy(ctx, s),
    versions,
  };
}

export function previewRules(refs: RuleRefs, text: string): CompileResult {
  return compileRules(text, refs);
}

async function newPolicyVersion(ctx: ServiceContext, skill: SkillPackage, patch: { autonomy?: AutonomyLevel; enabled?: boolean; thresholds?: Record<string, number>; rulesText?: string; rules?: CompiledRule[] }, note: string, action: string, data: Record<string, unknown>) {
  if (!note || note.trim().length < 5) throw new AppError('VALIDATION', 'Add a change note (at least 5 characters) so reviewers know why.');
  const cur = await ctx.db.findOne('skill_policy', { tenant_id: ctx.tenantId, skill_id: skill.id, is_current: true });
  await ctx.db.tx(async (db) => {
    if (cur) await db.update('skill_policy', cur.id, { is_current: false });
    const row = await db.insert('skill_policy', {
      tenant_id: ctx.tenantId,
      skill_id: skill.id,
      version: (cur?.version ?? 0) + 1,
      autonomy_level: patch.autonomy ?? cur?.autonomy_level ?? skill.manifest.autonomy.default,
      thresholds: patch.thresholds ?? cur?.thresholds ?? baseThresholds(skill),
      mappings: cur?.mappings ?? {},
      rules_text: patch.rulesText ?? cur?.rules_text ?? '',
      rules: (patch.rules ?? cur?.rules ?? []) as unknown[],
      enabled: patch.enabled ?? cur?.enabled ?? true,
      change_note: note.trim().slice(0, 500),
      created_by: ctx.actor.userId,
      created_at: ctx.clock.nowIso(),
      is_current: true,
    });
    await audit(withDb(ctx, db), { action, subjectType: 'skill', subjectId: skill.id, data: { ...data, version: row.version, note: note.trim() } });
  });
}

export async function updatePolicy(ctx: ServiceContext, skills: SkillPackage[], input: { skillId: string; rulesText?: string; thresholds?: Record<string, number>; enabled?: boolean; note: string }) {
  requirePermission(ctx, 'skill.policy.edit');
  requireAllEntities(ctx, 'A skill policy');
  const s = skills.find((x) => x.id === input.skillId);
  if (!s) throw new AppError('NOT_FOUND', 'Skill not found');
  if (input.enabled === false) requirePermission(ctx, 'skill.autonomy.set');
  let compiled: CompileResult | undefined;
  if (input.rulesText !== undefined) {
    if (input.rulesText.length > 20_000) throw new AppError('VALIDATION', 'Policies are limited to 20,000 characters.');
    compiled = compileRules(input.rulesText, await ruleRefs(ctx));
    if (compiled.errors.length) throw new AppError('VALIDATION', 'Some rules could not be understood.', { errors: compiled.errors });
  }
  if (input.thresholds) {
    for (const [k, v] of Object.entries(input.thresholds)) if (!Number.isFinite(v) || v < 0) throw new AppError('VALIDATION', `Threshold ${k} must be a non-negative number.`);
    if (input.thresholds.minConfidence !== undefined && input.thresholds.minConfidence > 1) throw new AppError('VALIDATION', 'Minimum confidence is between 0 and 1.');
  }
  const before = await currentPolicy(ctx, s);
  await newPolicyVersion(ctx, s, { rulesText: input.rulesText, rules: compiled?.rules, thresholds: input.thresholds ? { ...before.thresholds, ...input.thresholds } : undefined, enabled: input.enabled }, input.note, 'skill.policy.updated', {
    rulesChanged: input.rulesText !== undefined,
    rules: compiled?.rules.length ?? null,
    thresholds: input.thresholds ?? null,
    enabled: input.enabled ?? null,
  });
  return skillDetail(ctx, skills, s.id);
}

export async function setAutonomy(ctx: ServiceContext, skills: SkillPackage[], input: { skillId: string; level: AutonomyLevel; note: string }) {
  requirePermission(ctx, 'skill.autonomy.set');
  requireAllEntities(ctx, 'Agent autonomy');
  const s = skills.find((x) => x.id === input.skillId);
  if (!s) throw new AppError('NOT_FOUND', 'Skill not found');
  if (AUTONOMY_LEVELS.indexOf(input.level) > AUTONOMY_LEVELS.indexOf(s.manifest.autonomy.max)) throw new AppError('VALIDATION', `${s.manifest.title} allows at most ${s.manifest.autonomy.max}.`);
  const before = await currentPolicy(ctx, s);
  await newPolicyVersion(ctx, s, { autonomy: input.level }, input.note, 'skill.autonomy.changed', { from: before.autonomy, to: input.level });
  return skillDetail(ctx, skills, s.id);
}
