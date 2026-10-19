/**
 * Skill administration: versioned policy changes (autonomy, thresholds, enable/disable),
 * plain-English rules (compiled and shown back before saving), runs and eval suites.
 */
import type { AutonomyLevel } from '../core/agent/types';
import { audit } from '../core/audit/audit';
import { currentPolicyRow, GENERIC_THRESHOLDS, updatePolicy } from '../core/skills/policy';
import type { EvalCaseResult } from '../core/skills/eval-types';
import type { PolicyRule } from '../core/skills/policy-types';
import { forbidden, notFound, validation } from '../core/util/errors';
import type { AgentRunRow, SkillEvalRunRow } from '../schema';
import { compileRule, type CompiledRule } from '../packs/accounting/agent/rules';
import { DIMENSIONS } from '../packs/accounting/seed/company';
import type { AppContext, RequestUser } from './context';
import { requirePermission } from './context';

async function skillRow(ctx: AppContext, u: RequestUser, key: string) {
  const row = await ctx.db.tx(u.tenantId, (tx) => tx.findOne('skills', { key }));
  if (!row || !ctx.skills.has(key)) throw notFound('Skill', key);
  return row;
}

export async function setPolicy(ctx: AppContext, u: RequestUser, key: string, change: { autonomy?: AutonomyLevel; thresholds?: Record<string, number>; enabled?: boolean; note: string; scopeEntityId?: string | null }) {
  const row = await skillRow(ctx, u, key);
  const manifest = ctx.skills.get(key).manifest;
  if (change.enabled !== undefined && !u.actor.permissions.has('skill.policy.edit')) throw forbidden('You cannot switch skills on or off.');
  return ctx.db.tx(u.tenantId, (tx) => updatePolicy(tx, u.actor, ctx.clock, row.id, manifest, { autonomy: change.autonomy, thresholds: change.thresholds, enabled: change.enabled, note: change.note }, change.scopeEntityId ?? null));
}

async function ruleContext(ctx: AppContext, u: RequestUser) {
  return ctx.db.tx(u.tenantId, async (tx) => {
    const accounts = await tx.find('accounts', { status: 'active' });
    const dim = await tx.findOne('dimensions', { key: 'department' });
    const values = dim ? await tx.find('dimension_values', { dimension_id: dim.id, status: 'active' }) : [];
    return { accounts: accounts.map((a) => ({ code: a.code, name: a.name, postable: a.is_postable })), departments: values.length ? values.map((v) => ({ code: v.code, name: v.name })) : DIMENSIONS[0]!.values.map(([code, name]) => ({ code, name })) };
  });
}

export async function previewRule(ctx: AppContext, u: RequestUser, text: string): Promise<CompiledRule> {
  requirePermission(u, 'skill.view');
  return compileRule(String(text ?? ''), await ruleContext(ctx, u));
}

export async function addRule(ctx: AppContext, u: RequestUser, key: string, text: string, scopeEntityId: string | null = null) {
  requirePermission(u, 'skill.policy.edit');
  const row = await skillRow(ctx, u, key);
  const compiled = compileRule(String(text ?? ''), await ruleContext(ctx, u));
  if (compiled.status !== 'active') throw validation(compiled.interpretation, { compiled });
  const manifest = ctx.skills.get(key).manifest;
  for (const k of Object.keys(compiled.thresholdChanges))
    if (!(k in manifest.thresholds) && !(k in GENERIC_THRESHOLDS)) throw validation(`That rule changes a setting (${k}) the ${manifest.title} skill does not use.`, { compiled });
  return ctx.db.tx(u.tenantId, async (tx) => {
    const cur = await currentPolicyRow(tx, row.id, scopeEntityId);
    const rule: PolicyRule = { id: `rule-${cur.version + 1}-${cur.rules.length + 1}`, text: text.trim(), status: 'active', compiled: compiled.compiled, interpretation: compiled.interpretation, createdBy: u.actor.id, createdAt: ctx.clock.now().toISOString() };
    return updatePolicy(tx, u.actor, ctx.clock, row.id, manifest, { rules: [...cur.rules, rule], thresholds: Object.keys(compiled.thresholdChanges).length ? compiled.thresholdChanges : undefined, note: `Rule added: “${text.trim().slice(0, 120)}”` }, scopeEntityId);
  });
}

export async function removeRule(ctx: AppContext, u: RequestUser, key: string, ruleId: string, scopeEntityId: string | null = null) {
  requirePermission(u, 'skill.policy.edit');
  const row = await skillRow(ctx, u, key);
  const manifest = ctx.skills.get(key).manifest;
  return ctx.db.tx(u.tenantId, async (tx) => {
    const cur = await currentPolicyRow(tx, row.id, scopeEntityId);
    const rule = cur.rules.find((r) => r.id === ruleId);
    if (!rule) throw notFound('Rule', ruleId);
    return updatePolicy(tx, u.actor, ctx.clock, row.id, manifest, { rules: cur.rules.filter((r) => r.id !== ruleId), note: `Rule removed: “${rule.text.slice(0, 120)}”` }, scopeEntityId);
  });
}

export async function startRun(ctx: AppContext, u: RequestUser, req: { skillKey: string; entityId: string | null; periodKey: string; mode?: 'offline' | 'live' }): Promise<AgentRunRow> {
  requirePermission(u, 'agent.run');
  if (!ctx.skills.has(req.skillKey)) throw notFound('Skill', req.skillKey);
  const gate = ctx.limiter.check(`run:${u.actor.id}`, 30, 60_000);
  if (!gate.ok) throw validation('Too many runs started in the last minute.');
  const run = await ctx.runtime.createRun({ tenantId: u.tenantId, skillKey: req.skillKey, entityId: req.entityId, periodKey: req.periodKey, requestedBy: u.actor.id, mode: req.mode });
  return ctx.runtime.execute(u.tenantId, run.id);
}

export async function resumeRun(ctx: AppContext, u: RequestUser, runId: string): Promise<AgentRunRow> {
  requirePermission(u, 'agent.run');
  return ctx.runtime.resume(u.tenantId, runId);
}

/**
 * Run a skill's golden evals against the fictional demo fixture (isolated in-memory copy; tenant
 * data is never touched) and record the result for the catalog.
 */
export async function runSkillEvals(ctx: AppContext, u: RequestUser, key: string): Promise<SkillEvalRunRow> {
  requirePermission(u, 'skill.eval.run');
  const row = await skillRow(ctx, u, key);
  const gate = ctx.limiter.check(`evals:${u.tenantId}`, 4, 60_000);
  if (!gate.ok) throw validation('Eval suites were run very recently; wait a minute.');
  const { bramblewoodFixture, runEvalCase } = await import('../packs/accounting/evals/harness');
  const fx = await bramblewoodFixture();
  const skill = ctx.skills.get(key);
  const results: EvalCaseResult[] = [];
  for (const c of skill.evals) {
    const r = await runEvalCase(fx, key, c);
    results.push({ caseId: r.caseId, title: r.title, passed: r.passed, expectations: r.expectations, proposals: r.proposals, durationMs: r.durationMs });
  }
  return ctx.db.tx(u.tenantId, async (tx) => {
    const ev = await tx.insert('skill_eval_runs', { skill_id: row.id, skill_version: skill.version, engine: 'offline', total: results.length, passed: results.filter((r) => r.passed).length, results, ran_by: u.actor.id, ran_at: ctx.clock.now().toISOString() });
    await audit(tx, u.actor, ctx.clock, { action: 'skill.evals.run', subjectType: 'skill', subjectId: row.id, summary: `${skill.manifest.title} evals: ${ev.passed}/${ev.total} cases passed`, data: {} }, u.ip);
    return ev;
  });
}
