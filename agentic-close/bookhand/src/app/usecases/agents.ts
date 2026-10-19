import { AUTONOMY_DESCRIPTIONS, type AutonomyLevel } from '../../agents/framework/types';
import { changePolicy, currentPolicyRow, previewPolicy, resolvePolicy } from '../../agents/framework/policy';
import { toolJsonSchema } from '../../agents/framework/runtime';
import type { Where } from '../../persistence/db';
import { closeOntology } from '../../packs/accounting/ontology';
import { can, requirePermission, type Principal } from '../../security/principal';
import { DomainError } from '../../shared/errors';
import type { App, RequestMeta } from '../app';

/** Agent runs (trace viewer), the skill catalog and plain-English policy tuning. */

export async function listRuns(app: App, p: Principal, f: { skill?: string; status?: string; closeId?: string; parentRunId?: string; limit?: number }) {
  requirePermission(p, 'skill.view');
  return app.read(async (tx) => {
    const where: Where<'agent_runs'> = { tenant_id: p.tenantId };
    if (f.skill) where.skill_key = f.skill;
    if (f.status) where.status = f.status as never;
    if (f.closeId) where.close_id = f.closeId;
    if (f.parentRunId) where.parent_run_id = f.parentRunId;
    const runs = await tx.find('agent_runs', where, { orderBy: [['created_at', 'desc']], limit: Math.min(f.limit ?? 50, 200) });
    const names = new Map(app.runtime.listSkills().map((s) => [s.manifest.key, s.manifest.name]));
    return runs.map((r) => ({ id: r.id, skill: r.skill_key, skillName: names.get(r.skill_key) ?? r.skill_key, version: r.skill_version, status: r.status, phase: r.phase, mode: r.mode, model: r.model, trigger: r.trigger, requestedBy: r.requested_by_label, parentRunId: r.parent_run_id, closeTaskId: r.close_task_id, summary: r.summary, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at, steps: r.steps_used, toolCalls: r.tool_calls_used, proposals: r.proposals_count, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd_micros / 1e6, resumeCount: r.resume_count }));
  });
}

export async function runDetail(app: App, p: Principal, id: string) {
  requirePermission(p, 'skill.view');
  return app.read(async (tx) => {
    const r = await tx.get('agent_runs', id);
    if (!r || r.tenant_id !== p.tenantId) app.notFound('Run');
    const steps = await tx.find('agent_steps', { run_id: id }, { orderBy: [['seq', 'asc']] });
    const calls = await tx.find('agent_tool_calls', { run_id: id }, { orderBy: [['created_at', 'asc']] });
    const proposals = await tx.find('proposals', { run_id: id }, { orderBy: [['created_at', 'asc']] });
    const children = await tx.find('agent_runs', { parent_run_id: id }, { orderBy: [['created_at', 'asc']] });
    const skill = app.runtime.listSkills().find((s) => s.manifest.key === r.skill_key);
    const callByStep = new Map(calls.map((c) => [c.step_id, c]));
    const trim = (v: unknown) => {
      const s = JSON.stringify(v ?? null);
      return s.length > 6000 ? `${s.slice(0, 6000)}...` : s;
    };
    return {
      run: { id: r.id, skill: r.skill_key, skillName: skill?.manifest.name ?? r.skill_key, version: r.skill_version, ontologyVersion: r.ontology_version, status: r.status, phase: r.phase, mode: r.mode, provider: r.provider, model: r.model, trigger: r.trigger, requestedBy: r.requested_by_label, input: r.input, plan: r.plan, summary: r.summary, error: r.error, budget: r.budget, stepsUsed: r.steps_used, toolCallsUsed: r.tool_calls_used, tokensIn: r.tokens_in, tokensOut: r.tokens_out, cacheReadTokens: r.cache_read_tokens, costUsd: r.cost_usd_micros / 1e6, startedAt: r.started_at, finishedAt: r.finished_at, heartbeatAt: r.heartbeat_at, resumeCount: r.resume_count, parentRunId: r.parent_run_id, closeTaskId: r.close_task_id, policyId: r.policy_id, idempotencyKey: r.idempotency_key },
      steps: steps.map((s) => {
        const call = callByStep.get(s.id);
        return { seq: s.seq, phase: s.phase, kind: s.kind, title: s.title, detail: s.detail, at: s.created_at, durationMs: s.duration_ms, tokensIn: s.tokens_in, tokensOut: s.tokens_out, tool: call ? { name: call.tool_name, status: call.status, mutation: call.is_mutation, input: trim(call.input), output: trim(call.output), error: call.error, durationMs: call.duration_ms } : null };
      }),
      proposals: proposals.map((x) => ({ id: x.id, kind: x.kind, title: x.title, status: x.status, confidence: x.confidence, amount: x.amount_minor, riskFlags: x.risk_flags })),
      children: children.map((c) => ({ id: c.id, skill: c.skill_key, status: c.status, summary: c.summary, proposals: c.proposals_count })),
    };
  });
}

export async function cancelRun(app: App, p: Principal, id: string, reason: string, meta: RequestMeta = {}) {
  requirePermission(p, 'skill.run');
  return app.runtime.cancel(id, app.actorOf(p, meta), reason || 'cancelled by user');
}

export async function listSkills(app: App, p: Principal) {
  requirePermission(p, 'skill.view');
  return app.read(async (tx) => {
    const out = [];
    for (const s of app.runtime.listSkills()) {
      const m = s.manifest;
      const row = await currentPolicyRow(tx, p.tenantId, m.key, null);
      const policy = resolvePolicy(m, row, app.runtime.deps.pack.compileRules);
      const runs = await tx.find('agent_runs', { tenant_id: p.tenantId, skill_key: m.key }, { orderBy: [['created_at', 'desc']], limit: 20 });
      const version = (await tx.findOne('skills', { key: m.key })) ? await tx.findOne('skill_versions', { skill_id: (await tx.findOne('skills', { key: m.key }))!.id, version: m.version }) : null;
      out.push({ key: m.key, name: m.name, version: m.version, category: m.category, summary: m.summary, autonomy: policy.autonomy, autonomyName: AUTONOMY_DESCRIPTIONS[policy.autonomy].name, maxAutonomy: m.autonomy.max, policyVersion: policy.version, controls: m.controls, tools: m.tools.length, lastRun: runs[0] ? { id: runs[0].id, status: runs[0].status, at: runs[0].finished_at ?? runs[0].created_at } : null, runs: runs.length, evalSummary: version?.eval_summary ?? null, execution: m.execution });
    }
    return out;
  });
}

export async function skillDetail(app: App, p: Principal, key: string) {
  requirePermission(p, 'skill.view');
  const pkg = app.runtime.listSkills().find((s) => s.manifest.key === key);
  if (!pkg) app.notFound('Skill');
  const m = pkg.manifest;
  return app.read(async (tx) => {
    const row = await currentPolicyRow(tx, p.tenantId, key, null);
    const policy = resolvePolicy(m, row, app.runtime.deps.pack.compileRules);
    const history = await tx.find('skill_policies', { tenant_id: p.tenantId, skill_key: key }, { orderBy: [['version', 'desc']] });
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
    const runs = await tx.find('agent_runs', { tenant_id: p.tenantId, skill_key: key }, { orderBy: [['created_at', 'desc']], limit: 10 });
    const skillRow = await tx.findOne('skills', { key });
    const versions = skillRow ? await tx.find('skill_versions', { skill_id: skillRow.id }, { orderBy: [['published_at', 'desc']] }) : [];
    const term = (id: string) => closeOntology.term(id);
    return {
      manifest: m,
      instructions: pkg.instructions,
      contentHash: pkg.contentHash,
      inputs: Object.entries(m.inputs).map(([name, spec]) => ({ name, ...spec, label: term(spec.type)?.label ?? spec.type, definition: term(spec.type)?.definition ?? null })),
      outputs: m.outputs.map((o) => ({ ...o, label: term(o.type)?.label ?? o.type, definition: term(o.type)?.definition ?? null })),
      tools: m.tools.map((name) => {
        const t = app.runtime.tool(name)!;
        return { name, title: t.title, description: t.description, permission: t.permission, mutation: t.mutation, untrustedOutput: !!t.untrustedOutput, ontology: t.ontology ?? [], schema: toolJsonSchema(t.input) };
      }),
      thresholds: Object.entries(m.thresholds).map(([k, t]) => ({ key: k, ...t, value: policy.thresholds[k] ?? t.default })),
      policy: { id: policy.id, version: policy.version, autonomy: policy.autonomy, rulesText: policy.rulesText, rules: policy.rules, createdBy: policy.createdBy ? users.get(policy.createdBy) ?? null : 'package default' },
      autonomyLevels: (Object.keys(AUTONOMY_DESCRIPTIONS) as AutonomyLevel[]).map((l) => ({ level: l, ...AUTONOMY_DESCRIPTIONS[l], allowed: ['L0', 'L1', 'L2', 'L3'].indexOf(l) <= ['L0', 'L1', 'L2', 'L3'].indexOf(m.autonomy.max) })),
      history: history.map((h) => ({ id: h.id, version: h.version, autonomy: h.autonomy_level, thresholds: h.thresholds, rulesText: h.rules_text, reason: h.change_reason, author: h.created_by ? users.get(h.created_by) ?? null : 'package default', at: h.created_at })),
      runs: runs.map((r) => ({ id: r.id, status: r.status, summary: r.summary, at: r.finished_at ?? r.created_at, proposals: r.proposals_count, mode: r.mode })),
      versions: versions.map((v) => ({ version: v.version, contentHash: v.content_hash, publishedAt: v.published_at, evalSummary: v.eval_summary })),
      canEdit: can(p, 'policy.edit'),
      canSetAutonomy: can(p, 'autonomy.set'),
    };
  });
}

export interface PolicyChangeInput {
  autonomy?: AutonomyLevel;
  thresholds?: Record<string, number | boolean>;
  rulesText?: string;
  reason?: string;
}

export async function previewSkillPolicy(app: App, p: Principal, key: string, change: PolicyChangeInput) {
  requirePermission(p, 'skill.view');
  const pkg = app.runtime.listSkills().find((s) => s.manifest.key === key);
  if (!pkg) app.notFound('Skill');
  return app.read(async (tx) => {
    const current = resolvePolicy(pkg.manifest, await currentPolicyRow(tx, p.tenantId, key, null), app.runtime.deps.pack.compileRules);
    return previewPolicy(pkg.manifest, current, change, app.runtime.deps.pack.compileRules);
  });
}

export async function updateSkillPolicy(app: App, p: Principal, key: string, change: PolicyChangeInput, meta: RequestMeta = {}) {
  requirePermission(p, 'policy.edit', 'edit skill policies');
  const pkg = app.runtime.listSkills().find((s) => s.manifest.key === key);
  if (!pkg) app.notFound('Skill');
  return app.tx(async (tx) => {
    const current = resolvePolicy(pkg.manifest, await currentPolicyRow(tx, p.tenantId, key, null), app.runtime.deps.pack.compileRules);
    if (change.autonomy && change.autonomy !== current.autonomy && !can(p, 'autonomy.set')) throw new DomainError('FORBIDDEN', 'Your role cannot change autonomy levels.');
    return changePolicy(tx, app.ctx(p, meta), pkg.manifest, { autonomy: change.autonomy, thresholds: change.thresholds, rulesText: change.rulesText, reason: change.reason ?? '' }, app.runtime.deps.pack.compileRules);
  });
}
