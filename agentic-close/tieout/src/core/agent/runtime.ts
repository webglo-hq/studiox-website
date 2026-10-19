/**
 * Durable, observable agent runtime (domain-agnostic).
 *
 *   plan → act (typed tool call) → observe (record + injection scan) → verify (deterministic)
 *        → propose (persist, idempotent) → route (autonomy policy) → post (policy-approved only)
 *        → audit (hash-chained)            … repeated until the brain finishes
 *
 * Durability: every action is recorded as it completes. A crashed run is resumed by replaying
 * its brain against the recorded tool results (deterministic replay, Temporal-style); proposals
 * are idempotent by key, so replays never duplicate work. Live (LLM) runs persist their
 * transcript append-only and continue from the last message. A recorded result is replayed only
 * for the same call: the model's tool_use id (live) or position, tool and input (offline).
 * Servers resume runs left behind by a crashed process on their own (recoverStale).
 *
 * Least privilege: tools are limited to the skill's `allowed-tools` AND the requesting user's
 * permissions ∩ the manifest's permissions. No tool can approve, post or pay (AX-AGT-03).
 */
import { audit } from '../audit/audit';
import type { Ontology } from '../ontology/registry';
import { costMicros, ZERO_USAGE } from '../llm/pricing';
import { fromWireToolName, toWireToolName, type LlmBlock, type LlmMessage, type LlmProvider, type LlmToolSpec, type LlmUsage } from '../llm/types';
import { currentPolicyRow, toEffective } from '../skills/policy';
import type { LoadedSkill, SkillRegistry } from '../skills/skillmd';
import { DomainError, forbidden, precondition } from '../util/errors';
import { sha256Hex } from '../util/hash';
import { canonicalJson, type JsonValue } from '../util/json';
import type { Clock } from '../util/time';
import type { AgentRunRow, Db, DbTx, ProposalRow } from '../../schema';
import { decideRoute } from './autonomy';
import { scanUntrusted, UNTRUSTED_DATA_POLICY, wrapUntrusted } from './injection';
import { z } from 'zod';
import type { Actor, BrainAction, BrainResult, EffectivePolicy, InjectionFlag, Materiality, OfflineBrain, ProposalDraft, ProposeOutcome, RunBudget, RunSummary, SkillRunInput, ToolDef, VerificationResult } from './types';

export interface Assessment {
  amountMinor: number;
  currency: string | null;
  materiality: Materiality;
  assignedRole: string | null;
  autoEligible: boolean;
  flags: string[];
}

export interface RunContext {
  runId: string;
  tenantId: string;
  skillKey: string;
  skillVersion: string;
  entityId: string | null;
  periodKey: string | null;
  policy: EffectivePolicy;
  requestedBy: string;
  agent: Actor;
  mode: 'offline' | 'live';
}

export interface ApplyResult {
  refType: string;
  refId: string;
}

export interface DomainPack<Svc> {
  key: string;
  ontology: Ontology;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous tool registry
  tools: readonly ToolDef<any, any, Svc>[];
  services(tx: DbTx, actor: Actor, clock: Clock): Svc;
  verify(svc: Svc, draft: ProposalDraft, run: RunContext): Promise<VerificationResult[]>;
  assess(svc: Svc, draft: ProposalDraft, run: RunContext): Promise<Assessment>;
  apply(svc: Svc, proposal: ProposalRow, approver: { id: string; route: 'human' | 'policy'; policyRef?: string }): Promise<ApplyResult | null>;
  /** Runs in the unit of work that stores a new proposal: retire earlier proposals it replaces. */
  afterPropose?(svc: Svc, proposal: ProposalRow): Promise<void>;
  offlineBrains: Readonly<Record<string, OfflineBrain>>;
  taskPrompt(skill: LoadedSkill, input: SkillRunInput): string;
  /** Permission the agent needs to prepare a proposal of this kind (least privilege for offline brains too). */
  proposalPermission?(kind: string): string | undefined;
}

export interface RuntimeDeps<Svc> {
  db: Db;
  clock: Clock;
  pack: DomainPack<Svc>;
  skills: SkillRegistry;
  llm: LlmProvider | null;
  resolveActor(tx: DbTx, userId: string): Promise<Actor>;
  /** test hook: simulate a process crash right after action N completes */
  faults?: { crashAfterAction?: number };
  log?: (msg: string) => void;
}

export interface StartRunRequest {
  tenantId: string;
  skillKey: string;
  entityId: string | null;
  periodKey: string | null;
  requestedBy: string;
  idempotencyKey?: string;
  orchestrationId?: string | null;
  params?: Record<string, JsonValue>;
  mode?: 'offline' | 'live';
}

export class SimulatedCrash extends Error {
  constructor(at: number) {
    super(`simulated crash after action ${at}`);
    this.name = 'SimulatedCrash';
  }
}

class BudgetExceeded extends Error {}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'budget_exceeded']);

const ReadResourceInput = z.object({ path: z.string().min(1).max(200) }).strict();
const FinishInput = z.object({ headline: z.string().min(3).max(400), notes: z.array(z.string().max(400)).max(12).default([]) }).strict();

interface ExecState {
  run: AgentRunRow;
  ctx: RunContext;
  skill: LoadedSkill;
  seq: number;
  actionSeq: number;
  toolCalls: number;
  usage: LlmUsage;
  costMicros: number;
  flags: InjectionFlag[];
  flaggedIds: Set<string>;
  summary: Required<Pick<RunSummary, 'proposals' | 'autoApplied' | 'suggested' | 'pendingApproval' | 'duplicates' | 'verificationFailures' | 'injectionFlags'>> & { byKind: Record<string, number>; plan: string[]; notes: string[] };
  /** recorded results by call key (see callKey) */
  replayTools: Map<string, unknown>;
  startedAt: number;
  replaying: boolean;
}

export class AgentRuntime<Svc> {
  constructor(private readonly deps: RuntimeDeps<Svc>) {}

  private get db() {
    return this.deps.db;
  }

  // ----------------------------------------------------------------- create
  async createRun(req: StartRunRequest): Promise<AgentRunRow> {
    const skill = this.deps.skills.get(req.skillKey);
    const mode = req.mode ?? (this.deps.llm?.live ? 'live' : 'offline');
    if (mode === 'live' && !this.deps.llm) throw precondition('Live mode needs an Anthropic API key; the offline engine is available.');
    return this.db.tx(req.tenantId, async (tx) => {
      const key = req.idempotencyKey ?? `${req.skillKey}:${req.entityId ?? 'group'}:${req.periodKey ?? '-'}:${this.deps.clock.now().toISOString()}:${Math.random().toString(36).slice(2, 8)}`;
      const existing = await tx.findOne('agent_runs', { idempotency_key: key });
      if (existing) return existing;
      const requester = await this.deps.resolveActor(tx, req.requestedBy);
      if (!requester.permissions.has('agent.run')) throw forbidden('You do not have permission to run agents.');
      if (req.entityId && requester.entityScope && !requester.entityScope.includes(req.entityId)) throw forbidden('That entity is outside your access scope.');
      if (!req.entityId && requester.entityScope) throw forbidden('A group-wide run covers every entity, and your access is limited to some of them.');
      const skillRow = await tx.findOne('skills', { key: req.skillKey });
      if (!skillRow || !skillRow.enabled) throw precondition(`Skill ${req.skillKey} is not installed or is disabled.`);
      const policy = await currentPolicyRow(tx, skillRow.id, req.entityId);
      if (!policy.enabled) throw precondition(`${skill.manifest.title} is switched off in its policy.`);
      const m = skill.manifest;
      const budget: RunBudget = { maxSteps: m.budgets.maxSteps, maxToolCalls: m.budgets.maxToolCalls, maxInputTokens: 2_000_000, maxOutputTokens: 200_000, maxCostMicros: Math.round(m.budgets.maxCostUsd * 1_000_000), maxWallMs: 10 * 60_000 };
      const n = await tx.nextCounter('run');
      const run = await tx.insert('agent_runs', {
        ref: `R-${String(n).padStart(4, '0')}`,
        skill_key: req.skillKey,
        skill_version: skill.version,
        orchestration_id: req.orchestrationId ?? null,
        entity_id: req.entityId,
        period_key: req.periodKey,
        status: 'queued',
        mode,
        model: mode === 'live' ? m.model.live : null,
        autonomy_level: policy.autonomy_level,
        policy_version: policy.version,
        requested_by: req.requestedBy,
        idempotency_key: key,
        input: { params: req.params ?? {}, policy: toEffective(policy) as unknown as JsonValue },
        summary: {},
        budget,
        created_at: this.deps.clock.now().toISOString(),
      });
      await audit(tx, requester, this.deps.clock, { action: 'agent.run.create', subjectType: 'agent_run', subjectId: run.id, entityId: req.entityId, summary: `${run.ref} ${m.title} requested (${mode}, ${policy.autonomy_level})`, data: { skill: req.skillKey, version: skill.version, policyVersion: policy.version, orchestrationId: req.orchestrationId ?? null } });
      return run;
    });
  }

  async start(req: StartRunRequest): Promise<AgentRunRow> {
    const run = await this.createRun(req);
    return this.execute(req.tenantId, run.id);
  }

  /**
   * Resume a run someone asks to resume; safe to call repeatedly. A run that is still working (its
   * heartbeat moved in the last minute) is left alone, and the claim keeps a person's resume and the
   * server's recovery from both running it.
   */
  async resume(tenantId: string, runId: string): Promise<AgentRunRow> {
    const r = await this.db.tx(tenantId, (tx) => tx.get('agent_runs', runId));
    if (!r) throw new DomainError('not_found', `Run ${runId} not found`);
    const fresh = r.heartbeat_at && Date.parse(r.heartbeat_at) > this.deps.clock.now().getTime() - 60_000 && r.status === 'running';
    if (TERMINAL.has(r.status) || fresh) return r;
    const claimed = await this.db.tx(tenantId, (tx) => tx.updateWhere('agent_runs', { id: r.id, status: r.status, attempts: r.attempts }, { attempts: r.attempts + 1, heartbeat_at: this.deps.clock.now().toISOString() }));
    if (!claimed) return (await this.db.tx(tenantId, (tx) => tx.get('agent_runs', runId)))!;
    return this.execute(tenantId, runId, { claimed: true });
  }

  /**
   * Find runs left `running`/`queued` by a crashed process (no heartbeat for `staleMs`) and resume
   * them. Each run is claimed first by moving its attempt counter on, atomically: of two servers
   * that find the same stale run, only one resumes it.
   */
  async recoverStale(tenantId: string, staleMs = 60_000): Promise<string[]> {
    const cutoff = new Date(this.deps.clock.now().getTime() - staleMs).toISOString();
    const runs = await this.db.tx(tenantId, (tx) => tx.find('agent_runs', { status: { in: ['running', 'queued'] } }));
    const stale = runs.filter((r) => (r.heartbeat_at ?? r.created_at) < cutoff);
    const resumed: string[] = [];
    for (const r of stale) {
      const claimed = await this.db.tx(tenantId, (tx) => tx.updateWhere('agent_runs', { id: r.id, status: r.status, attempts: r.attempts }, { attempts: r.attempts + 1, heartbeat_at: this.deps.clock.now().toISOString() }));
      if (!claimed) continue;
      await this.execute(tenantId, r.id, { claimed: true });
      resumed.push(r.id);
    }
    return resumed;
  }

  // ---------------------------------------------------------------- execute
  /** `claimed`: recovery has already counted this attempt (recoverStale). */
  async execute(tenantId: string, runId: string, opts: { claimed?: boolean } = {}): Promise<AgentRunRow> {
    const loaded = await this.db.tx(tenantId, async (tx) => {
      const run = await tx.get('agent_runs', runId);
      if (!run) throw new DomainError('not_found', `Run ${runId} not found`);
      if (TERMINAL.has(run.status)) return { run, done: true as const };
      const requester = await this.deps.resolveActor(tx, run.requested_by);
      const steps = await tx.find('agent_steps', { run_id: runId }, { orderBy: [['seq', 'desc']], limit: 1 });
      const calls = await tx.find('agent_tool_calls', { run_id: runId, status: 'ok' });
      const now = this.deps.clock.now().toISOString();
      const attempts = opts.claimed ? run.attempts : run.attempts + 1;
      const updated = await tx.update('agent_runs', runId, { status: 'running', attempts, started_at: run.started_at ?? now, heartbeat_at: now });
      if (attempts > 1) await audit(tx, { type: 'system', id: 'system', label: 'Tieout runtime' }, this.deps.clock, { action: 'agent.run.resume', subjectType: 'agent_run', subjectId: runId, entityId: run.entity_id, summary: `${run.ref} resumed (attempt ${attempts}) after interruption`, data: { lastSeq: steps[0]?.seq ?? 0 } });
      return { run: updated, done: false as const, requester, lastSeq: steps[0]?.seq ?? 0, calls };
    });
    if (loaded.done) return loaded.run;
    const { run, requester, lastSeq, calls } = loaded;
    const skill = this.deps.skills.get(run.skill_key);
    const policy = (run.input as { policy: EffectivePolicy }).policy;
    const agent: Actor = {
      type: 'agent',
      id: `agent:${run.skill_key}`,
      label: `${skill.manifest.title} agent`,
      onBehalfOf: requester.id,
      permissions: new Set(skill.manifest.permissions.filter((p) => requester.permissions.has(p) || requester.permissions.has('*'))),
      roles: [],
      entityScope: requester.entityScope,
    };
    const st: ExecState = {
      run,
      skill,
      ctx: { runId, tenantId, skillKey: run.skill_key, skillVersion: run.skill_version, entityId: run.entity_id, periodKey: run.period_key, policy, requestedBy: run.requested_by, agent, mode: run.mode },
      seq: lastSeq,
      // the offline brain replays from its first action; a live conversation continues after its last call
      actionSeq: run.mode === 'live' ? Math.max(0, ...calls.map((c) => c.seq)) : 0,
      toolCalls: calls.length,
      usage: { inputTokens: run.input_tokens, outputTokens: run.output_tokens, cacheReadTokens: run.cache_read_tokens, cacheWriteTokens: run.cache_write_tokens },
      costMicros: run.cost_micros,
      flags: [],
      flaggedIds: new Set(),
      summary: { proposals: 0, autoApplied: 0, suggested: 0, pendingApproval: 0, duplicates: 0, verificationFailures: 0, injectionFlags: 0, byKind: {}, plan: [], notes: [] },
      replayTools: new Map(calls.map((c) => [c.call_key, c.output])),
      startedAt: Date.now(),
      replaying: lastSeq > 0,
    };
    try {
      const result = run.mode === 'live' ? await this.liveLoop(st) : await this.offlineLoop(st);
      return await this.finish(st, 'succeeded', result.headline, result.notes ?? []);
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      if (e instanceof BudgetExceeded) return this.finish(st, 'budget_exceeded', e.message, []);
      const msg = e instanceof Error ? e.message : String(e);
      await this.recordStep(st, 'summarize', 'Run failed', { error: msg }, 'failed').catch(() => undefined);
      return this.finish(st, 'failed', msg, [], msg);
    }
  }

  // ------------------------------------------------------------ offline loop
  private async offlineLoop(st: ExecState): Promise<BrainResult> {
    const brainFactory = this.deps.pack.offlineBrains[st.run.skill_key];
    if (!brainFactory) throw precondition(`No offline engine for skill ${st.run.skill_key}`);
    const input: SkillRunInput = { tenantId: st.ctx.tenantId, runId: st.ctx.runId, skillKey: st.ctx.skillKey, entityId: st.ctx.entityId, periodKey: st.ctx.periodKey, policy: st.ctx.policy, params: ((st.run.input as { params?: Record<string, JsonValue> }).params ?? {}) as Record<string, JsonValue> };
    const brain = brainFactory(input);
    let next = await brain.next(undefined);
    while (!next.done) {
      st.actionSeq++;
      this.checkBudget(st);
      const result = await this.perform(st, next.value);
      if (this.deps.faults?.crashAfterAction === st.actionSeq && st.run.attempts === 1) throw new SimulatedCrash(st.actionSeq);
      next = await brain.next(result);
    }
    return next.value;
  }

  private async perform(st: ExecState, action: BrainAction): Promise<unknown> {
    switch (action.type) {
      case 'plan':
        st.summary.plan = action.steps;
        if (!st.replaying || st.actionSeq > 1) await this.recordStep(st, 'plan', 'Plan', { actionSeq: st.actionSeq, steps: action.steps });
        return undefined;
      case 'note':
        st.summary.notes.push(action.text);
        await this.recordStep(st, 'observe', action.text.slice(0, 120), { actionSeq: st.actionSeq, note: action.text });
        return undefined;
      case 'tool':
        return this.runTool(st, action.name, action.input, `brain:${st.actionSeq}:${action.name}:${sha256Hex(canonicalJson(action.input ?? {}))}`);
      case 'propose':
        return this.propose(st, action.draft);
    }
  }

  private toolDef(name: string) {
    const t = this.deps.pack.tools.find((x) => x.name === name);
    if (!t) throw precondition(`Unknown tool ${name}`);
    return t;
  }

  /** Execute a read tool, or replay the recorded result of this very call (`key`) after a crash. */
  private async runTool(st: ExecState, name: string, input: unknown, key: string): Promise<unknown> {
    if (st.replayTools.has(key)) {
      const out = st.replayTools.get(key);
      this.trackFlags(st, this.toolDef(name), out, false);
      return out;
    }
    const tool = this.toolDef(name);
    if (!st.skill.allowedTools.includes(name)) throw forbidden(`Skill ${st.skill.key} is not allowed to use ${name} (least privilege).`);
    if (tool.effect !== 'read') throw forbidden(`${name} is not a read tool`);
    if (!st.ctx.agent.permissions.has(tool.permission)) throw forbidden(`The agent lacks ${tool.permission} for ${name} (inherited from the requesting user and the skill manifest).`);
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) throw new DomainError('validation', `Tool ${name}: invalid input (${parsed.error.issues.map((i) => i.message).join('; ')})`);
    st.toolCalls++;
    this.checkBudget(st);
    const t0 = Date.now();
    const output = await this.db.tx(st.ctx.tenantId, async (tx) => {
      const svc = this.deps.pack.services(tx, st.ctx.agent, this.deps.clock);
      return tool.handler({ tenantId: st.ctx.tenantId, services: svc, actor: st.ctx.agent, run: { id: st.ctx.runId, skillKey: st.ctx.skillKey, entityId: st.ctx.entityId, periodKey: st.ctx.periodKey, policy: st.ctx.policy } }, parsed.data);
    });
    const flags = this.trackFlags(st, tool, output, true);
    await this.db.tx(st.ctx.tenantId, async (tx) => {
      const act = await this.insertStep(tx, st, 'act', tool.title, { actionSeq: st.actionSeq, tool: name, input: input as JsonValue }, 'succeeded', Date.now() - t0);
      await tx.insert('agent_tool_calls', { run_id: st.ctx.runId, step_id: act.id, seq: st.actionSeq, call_key: key, tool: name, effect: 'read', input: (input ?? {}) as Record<string, unknown>, output: output as unknown, status: 'ok', error: null, untrusted_flags: flags, duration_ms: Date.now() - t0, created_at: this.deps.clock.now().toISOString() });
      await this.insertStep(tx, st, 'observe', observationTitle(tool.outputType, output, flags), { actionSeq: st.actionSeq, outputType: tool.outputType, size: sizeOf(output), injectionFlags: flags as unknown as JsonValue }, 'succeeded', 0);
      await this.heartbeat(tx, st);
    });
    return output;
  }

  private trackFlags(st: ExecState, tool: ToolDef<unknown, unknown, Svc>, output: unknown, count: boolean): InjectionFlag[] {
    const flags = tool.untrustedFields ? scanUntrusted(output, tool.untrustedFields) : [];
    for (const f of flags) {
      const parent = f.path.split('.').slice(0, -1);
      let node: unknown = output;
      for (const p of parent) node = (node as Record<string, unknown>)?.[p];
      const id = (node as { id?: unknown })?.id;
      if (typeof id === 'string') st.flaggedIds.add(id);
    }
    if (count) {
      st.flags.push(...flags);
      st.summary.injectionFlags += flags.length;
    }
    return flags;
  }

  /** Verify → persist (idempotent) → route → apply (policy only). */
  private async propose(st: ExecState, draft: ProposalDraft): Promise<ProposeOutcome> {
    const { pack } = this.deps;
    const ctx = st.ctx;
    const idem = `${ctx.skillKey}:${ctx.entityId ?? draft.entityId ?? 'group'}:${ctx.periodKey ?? draft.periodKey ?? '-'}:${draft.dedupeKey}`;
    const flags = [...new Set([...(draft.flags ?? []), ...(draft.evidence.some((e) => e.refId && st.flaggedIds.has(e.refId)) ? ['injection_suspected'] : [])])];
    if (flags.includes('injection_suspected') && !draft.why.toLowerCase().includes('instruction')) draft = { ...draft, why: `${draft.why} Note: a source record contains instruction-like text; it was treated as data and this item needs a person.` };
    // existing proposal?
    const existing = await this.db.tx(ctx.tenantId, (tx) => tx.findOne('proposals', { idempotency_key: idem }));
    if (existing) {
      st.summary.duplicates++;
      if (existing.status === 'auto_approved' && !existing.applied_ref_id) await this.applyByPolicy(st, existing);
      await this.recordStep(st, 'propose', `Already proposed: ${existing.ref}`, { actionSeq: st.actionSeq, proposalId: existing.id, duplicate: true });
      return { status: 'duplicate', proposalId: existing.id, ref: existing.ref, route: existing.route, verification: existing.verification };
    }
    // least privilege: the agent (requester ∩ manifest) must hold the permission for this kind
    const perm = pack.proposalPermission?.(draft.kind);
    if (perm && !ctx.agent.permissions.has(perm) && !ctx.agent.permissions.has('*')) {
      const verification: VerificationResult[] = [{ check: 'Agent may prepare this', axiomId: 'AX-AGT-03', passed: false, severity: 'error', message: `The agent lacks ${perm} (inherited from the requesting user and the skill manifest).` }];
      await this.recordStep(st, 'verify', `Not permitted: ${draft.title}`, { actionSeq: st.actionSeq, checks: verification as unknown as JsonValue, dedupeKey: draft.dedupeKey }, 'failed');
      st.summary.verificationFailures++;
      return { status: 'rejected_by_verifier', verification };
    }
    // verify (deterministic): domain checks + framework checks
    const t0 = Date.now();
    const { verification, assessment } = await this.db.tx(ctx.tenantId, async (tx) => {
      const svc = pack.services(tx, ctx.agent, this.deps.clock);
      const v = await pack.verify(svc, draft, ctx);
      const core = pack.ontology.check('AX-AGT-01', { why: draft.why, confidence: draft.confidence, evidenceCount: draft.evidence.length });
      v.push({ check: 'Proposal is explained', axiomId: 'AX-AGT-01', passed: core.passed, severity: 'error', message: core.passed ? 'Why, confidence and evidence present' : core.messages.join('; ') });
      const a = await pack.assess(svc, draft, ctx);
      return { verification: v, assessment: a };
    });
    const failed = verification.filter((v) => !v.passed && v.severity === 'error');
    await this.recordStep(st, 'verify', failed.length ? `Verification failed: ${draft.title}` : `Verified: ${draft.title}`, { actionSeq: st.actionSeq, checks: verification as unknown as JsonValue, dedupeKey: draft.dedupeKey }, failed.length ? 'failed' : 'succeeded', Date.now() - t0);
    if (failed.length) {
      st.summary.verificationFailures++;
      return { status: 'rejected_by_verifier', verification };
    }
    const allFlags = [...new Set([...flags, ...assessment.flags])];
    const th = ctx.policy.thresholds;
    const decision = decideRoute({
      level: ctx.policy.autonomy,
      amountMinor: assessment.amountMinor,
      autoPostMaxMinor: th.autoPostMaxMinor ?? 0,
      confidence: draft.confidence,
      minConfidence: th.minConfidenceAuto ?? 0.95,
      flags: allFlags,
      autoEligible: assessment.autoEligible,
      materiality: assessment.materiality,
      sampleRatePct: th.sampleRatePct ?? 20,
      sampleKey: idem,
    });
    const agentCheck = pack.ontology.check('AX-AGT-02', { flags: allFlags, route: decision.route });
    if (!agentCheck.passed) throw new DomainError('invariant_violation', agentCheck.messages.join('; '));
    const proposal = await this.db.tx(ctx.tenantId, async (tx) => {
      const n = await tx.nextCounter('proposal');
      const now = this.deps.clock.now().toISOString();
      const p = await tx.insert('proposals', {
        ref: `P-${String(n).padStart(4, '0')}`,
        run_id: ctx.runId,
        skill_key: ctx.skillKey,
        kind: draft.kind,
        ontology_type: draft.ontologyType,
        entity_id: draft.entityId,
        period_key: draft.periodKey,
        title: draft.title,
        why: draft.why,
        confidence: Math.round(draft.confidence * 1000) / 1000,
        amount_minor: Math.abs(assessment.amountMinor),
        currency: assessment.currency,
        materiality: assessment.materiality,
        payload: draft.payload,
        evidence: draft.evidence,
        verification,
        flags: allFlags,
        status: decision.status,
        autonomy_level: ctx.policy.autonomy,
        route: decision.route,
        review_status: decision.reviewStatus,
        assigned_role: assessment.assignedRole,
        assigned_to: null,
        prepared_by: ctx.agent.id,
        requested_by: ctx.requestedBy,
        idempotency_key: idem,
        created_at: now,
        updated_at: now,
      });
      await this.insertStep(tx, st, 'propose', `${p.ref} ${draft.title}`, { actionSeq: st.actionSeq, proposalId: p.id, kind: draft.kind, confidence: draft.confidence, amountMinor: assessment.amountMinor }, 'succeeded', 0);
      await this.insertStep(tx, st, 'route', decision.reasons.join(' '), { actionSeq: st.actionSeq, proposalId: p.id, route: decision.route, status: decision.status, reviewStatus: decision.reviewStatus, flags: allFlags }, 'succeeded', 0);
      await audit(tx, ctx.agent, this.deps.clock, { action: 'proposal.create', subjectType: 'proposal', subjectId: p.id, entityId: draft.entityId, summary: `${p.ref} proposed: ${draft.title}`, data: { route: decision.route, confidence: draft.confidence, amountMinor: assessment.amountMinor, runId: ctx.runId } });
      if (pack.afterPropose) await pack.afterPropose(pack.services(tx, ctx.agent, this.deps.clock), p);
      await this.heartbeat(tx, st);
      return p;
    });
    st.summary.proposals++;
    st.summary.byKind[draft.kind] = (st.summary.byKind[draft.kind] ?? 0) + 1;
    if (decision.status === 'suggested') st.summary.suggested++;
    if (decision.status === 'pending_approval') st.summary.pendingApproval++;
    let applied = false;
    if (decision.status === 'auto_approved') applied = await this.applyByPolicy(st, proposal);
    return { status: 'created', proposalId: proposal.id, ref: proposal.ref, route: decision.route, applied, verification };
  }

  private async applyByPolicy(st: ExecState, proposal: ProposalRow): Promise<boolean> {
    const ctx = st.ctx;
    const policyRef = `policy:${ctx.skillKey}@v${ctx.policy.version}`;
    const policyActor: Actor = { type: 'policy', id: policyRef, label: `${st.skill.manifest.title} policy v${ctx.policy.version}`, onBehalfOf: ctx.requestedBy, permissions: ctx.agent.permissions, roles: [], entityScope: null };
    try {
      await this.db.tx(ctx.tenantId, async (tx) => {
        const svc = this.deps.pack.services(tx, policyActor, this.deps.clock);
        const res = await this.deps.pack.apply(svc, proposal, { id: policyRef, route: 'policy', policyRef });
        const now = this.deps.clock.now().toISOString();
        await tx.update('proposals', proposal.id, { status: 'applied', decided_by: policyRef, decided_at: now, decision_reason: 'Applied by policy within autonomy limits', applied_ref_type: res?.refType ?? null, applied_ref_id: res?.refId ?? null, updated_at: now });
        await tx.insert('approvals', { subject_type: 'proposal', subject_id: proposal.id, decision: 'approved', actor_type: 'policy', actor_id: policyRef, policy_ref: policyRef, reason: 'Within autonomy policy', at: now });
        await this.insertStep(tx, st, 'post', `${proposal.ref} applied by policy`, { actionSeq: st.actionSeq, proposalId: proposal.id, refType: res?.refType ?? null, refId: res?.refId ?? null }, 'succeeded', 0);
        await audit(tx, policyActor, this.deps.clock, { action: 'proposal.auto_apply', subjectType: 'proposal', subjectId: proposal.id, entityId: proposal.entity_id, summary: `${proposal.ref} applied by ${policyRef}${proposal.review_status === 'pending' ? ' (queued for review)' : ''}`, data: { refType: res?.refType ?? null, refId: res?.refId ?? null } });
      });
      st.summary.autoApplied++;
      return true;
    } catch (e) {
      // fall back to a person; never silently drop work
      await this.db.tx(ctx.tenantId, async (tx) => {
        await tx.update('proposals', proposal.id, { status: 'pending_approval', route: 'human_approval', updated_at: this.deps.clock.now().toISOString() });
        await this.insertStep(tx, st, 'post', `${proposal.ref} could not be applied automatically; routed to a person`, { actionSeq: st.actionSeq, proposalId: proposal.id, error: (e as Error).message }, 'failed', 0);
      });
      st.summary.pendingApproval++;
      return false;
    }
  }

  // ---------------------------------------------------------------- live loop
  private async liveLoop(st: ExecState): Promise<BrainResult> {
    const llm = this.deps.llm;
    if (!llm) throw precondition('Live mode requires a model provider');
    const skill = st.skill;
    const m = skill.manifest;
    const allowed = skill.allowedTools.map((n) => this.toolDef(n));
    const tools: LlmToolSpec[] = [
      ...allowed.map((t) => toolSpec(t)),
      { name: 'read_skill_resource', description: 'Read one of this skill’s resource files (progressive disclosure). Use only when the instructions point you to it.', inputSchema: { type: 'object', properties: { path: { type: 'string', enum: [...skill.resources.keys()] } }, required: ['path'], additionalProperties: false }, strict: skill.resources.size > 0 },
      { name: 'finish', description: 'Call exactly once when you are done. Summarise what you proposed in one plain-English headline.', inputSchema: { type: 'object', properties: { headline: { type: 'string' }, notes: { type: 'array', items: { type: 'string' } } }, required: ['headline', 'notes'], additionalProperties: false }, strict: true },
    ];
    const system = systemPrompt(this.deps.pack.ontology, skill, st.ctx.policy);
    const input: SkillRunInput = { tenantId: st.ctx.tenantId, runId: st.ctx.runId, skillKey: st.ctx.skillKey, entityId: st.ctx.entityId, periodKey: st.ctx.periodKey, policy: st.ctx.policy, params: {} };
    let messages = await this.loadTranscript(st);
    if (!messages.length) {
      messages = [{ role: 'user', content: [{ type: 'text', text: this.deps.pack.taskPrompt(skill, input) }] }];
      await this.appendTranscript(st, messages[0]!, 0);
    }
    let turn = 0;
    let finished: BrainResult | null = null;
    while (!finished) {
      const last = messages[messages.length - 1]!;
      if (last.role === 'user') {
        this.checkBudget(st);
        turn++;
        const t0 = Date.now();
        const resp = await llm.complete({ model: m.model.live, system, tools, messages, maxTokens: 16_000, effort: m.model.effort });
        const cost = costMicros(resp.model || m.model.live, resp.usage);
        st.usage = addUsage(st.usage, resp.usage);
        st.costMicros += cost;
        const assistant: LlmMessage = { role: 'assistant', content: resp.content };
        messages.push(assistant);
        await this.appendTranscript(st, assistant, messages.length - 1);
        const text = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join(' ');
        await this.recordStep(st, turn === 1 ? 'plan' : 'act', `Model turn ${turn}${text ? `: ${text.slice(0, 90)}` : ''}`, { turn, stopReason: resp.stopReason, model: resp.model, text: text.slice(0, 2000) }, resp.stopReason === 'refusal' ? 'failed' : 'succeeded', Date.now() - t0, resp.usage, cost);
        if (resp.stopReason === 'refusal') throw new DomainError('precondition_failed', `The model declined this task${resp.stopDetails?.category ? ` (${resp.stopDetails.category})` : ''}. Run it with the offline engine or adjust the request.`);
        if (resp.stopReason === 'max_tokens') throw new DomainError('budget_exceeded', 'The model response hit the output limit mid-turn.');
        this.checkBudget(st);
        continue;
      }
      // last is assistant: execute its tool calls (also the resume path)
      const uses = last.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use');
      if (!uses.length) {
        finished = { headline: textOf(last) || 'Finished', notes: [] };
        break;
      }
      const results: LlmBlock[] = [];
      for (const u of uses) {
        st.actionSeq++;
        const name = fromWireToolName(u.name);
        try {
          if (name === 'finish') {
            const f = FinishInput.parse(u.input);
            finished = { headline: f.headline, notes: f.notes };
            results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Recorded. The run is complete.' });
          } else if (name === 'read_skill_resource') {
            const { path } = ReadResourceInput.parse(u.input);
            const content = skill.resources.get(path);
            results.push({ type: 'tool_result', tool_use_id: u.id, content: content ?? `No resource ${path}`, ...(content ? {} : { is_error: true }) });
            await this.recordStep(st, 'observe', `Read resource ${path}`, { actionSeq: st.actionSeq, resource: path, found: !!content });
          } else {
            const tool = this.toolDef(name);
            if (!skill.allowedTools.includes(name)) throw forbidden(`${name} is not in this skill's allowed tools`);
            if (tool.effect === 'read') {
              const out = await this.runTool(st, name, u.input, `tool_use:${u.id}`);
              results.push({ type: 'tool_result', tool_use_id: u.id, content: wrapUntrusted(name, out) });
            } else {
              const parsed = tool.input.safeParse(u.input);
              if (!parsed.success) throw new DomainError('validation', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
              const draft = (await this.db.tx(st.ctx.tenantId, async (tx) => tool.handler({ tenantId: st.ctx.tenantId, services: this.deps.pack.services(tx, st.ctx.agent, this.deps.clock), actor: st.ctx.agent, run: { id: st.ctx.runId, skillKey: st.ctx.skillKey, entityId: st.ctx.entityId, periodKey: st.ctx.periodKey, policy: st.ctx.policy } }, parsed.data))) as ProposalDraft;
              const outcome = await this.propose(st, draft);
              results.push({ type: 'tool_result', tool_use_id: u.id, content: canonicalJson({ status: outcome.status, ref: outcome.ref ?? null, route: outcome.route ?? null, failedChecks: outcome.verification.filter((v) => !v.passed).map((v) => `${v.axiomId ?? v.check}: ${v.message}`) }), ...(outcome.status === 'rejected_by_verifier' ? { is_error: true } : {}) });
            }
          }
        } catch (e) {
          if (e instanceof BudgetExceeded || e instanceof SimulatedCrash) throw e;
          results.push({ type: 'tool_result', tool_use_id: u.id, content: `Error: ${(e as Error).message}`, is_error: true });
        }
      }
      const userMsg: LlmMessage = { role: 'user', content: results };
      messages.push(userMsg);
      await this.appendTranscript(st, userMsg, messages.length - 1);
      if (this.deps.faults?.crashAfterAction !== undefined && st.actionSeq >= this.deps.faults.crashAfterAction && st.run.attempts === 1) throw new SimulatedCrash(st.actionSeq);
    }
    return finished;
  }

  private async loadTranscript(st: ExecState): Promise<LlmMessage[]> {
    const rows = await this.db.tx(st.ctx.tenantId, (tx) => tx.find('agent_messages', { run_id: st.ctx.runId }, { orderBy: [['seq', 'asc']] }));
    return rows.map((r) => ({ role: r.role, content: r.content as LlmBlock[] }));
  }

  private async appendTranscript(st: ExecState, msg: LlmMessage, seq: number) {
    await this.db.tx(st.ctx.tenantId, (tx) => tx.insert('agent_messages', { run_id: st.ctx.runId, seq, role: msg.role, content: msg.content as unknown, created_at: this.deps.clock.now().toISOString() }));
  }

  // ---------------------------------------------------------------- helpers
  private checkBudget(st: ExecState) {
    const b = st.run.budget;
    if (st.seq >= b.maxSteps) throw new BudgetExceeded(`Step budget reached (${b.maxSteps} steps)`);
    if (st.toolCalls > b.maxToolCalls) throw new BudgetExceeded(`Tool-call budget reached (${b.maxToolCalls})`);
    if (st.costMicros > b.maxCostMicros) throw new BudgetExceeded(`Cost budget reached ($${(b.maxCostMicros / 1e6).toFixed(2)})`);
    if (st.usage.inputTokens > b.maxInputTokens || st.usage.outputTokens > b.maxOutputTokens) throw new BudgetExceeded('Token budget reached');
    if (Date.now() - st.startedAt > b.maxWallMs) throw new BudgetExceeded('Time budget reached');
  }

  private async insertStep(tx: DbTx, st: ExecState, phase: 'plan' | 'act' | 'observe' | 'verify' | 'propose' | 'route' | 'post' | 'audit' | 'summarize', title: string, detail: Record<string, unknown>, status: 'succeeded' | 'failed' = 'succeeded', durationMs = 0, usage: LlmUsage = ZERO_USAGE, cost = 0) {
    st.seq++;
    const now = this.deps.clock.now().toISOString();
    return tx.insert('agent_steps', { run_id: st.ctx.runId, seq: st.seq, phase, status, title: title.slice(0, 300), detail, idempotency_key: `${st.ctx.runId}:${st.seq}`, input_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, output_tokens: usage.outputTokens, cost_micros: cost, duration_ms: Math.round(durationMs), started_at: now, finished_at: now });
  }

  private async recordStep(st: ExecState, phase: Parameters<AgentRuntime<Svc>['insertStep']>[2], title: string, detail: Record<string, unknown>, status: 'succeeded' | 'failed' = 'succeeded', durationMs = 0, usage: LlmUsage = ZERO_USAGE, cost = 0) {
    await this.db.tx(st.ctx.tenantId, async (tx) => {
      await this.insertStep(tx, st, phase, title, detail, status, durationMs, usage, cost);
      await this.heartbeat(tx, st);
    });
  }

  private async heartbeat(tx: DbTx, st: ExecState) {
    await tx.update('agent_runs', st.ctx.runId, { heartbeat_at: this.deps.clock.now().toISOString(), steps_used: st.seq, input_tokens: st.usage.inputTokens, output_tokens: st.usage.outputTokens, cache_read_tokens: st.usage.cacheReadTokens, cache_write_tokens: st.usage.cacheWriteTokens, cost_micros: st.costMicros });
  }

  private async finish(st: ExecState, status: 'succeeded' | 'failed' | 'budget_exceeded', headline: string, notes: string[], error: string | null = null): Promise<AgentRunRow> {
    return this.db.tx(st.ctx.tenantId, async (tx) => {
      const summary: RunSummary = { headline, plan: st.summary.plan, proposals: st.summary.proposals, byKind: st.summary.byKind, autoApplied: st.summary.autoApplied, suggested: st.summary.suggested, pendingApproval: st.summary.pendingApproval, duplicates: st.summary.duplicates, verificationFailures: st.summary.verificationFailures, injectionFlags: st.summary.injectionFlags, notes: [...st.summary.notes, ...notes].slice(0, 30) };
      await this.insertStep(tx, st, 'summarize', headline, { summary: summary as unknown as JsonValue, status }, status === 'succeeded' ? 'succeeded' : 'failed');
      const now = this.deps.clock.now().toISOString();
      const run = await tx.update('agent_runs', st.ctx.runId, { status, summary, error, finished_at: now, heartbeat_at: now, steps_used: st.seq, input_tokens: st.usage.inputTokens, output_tokens: st.usage.outputTokens, cache_read_tokens: st.usage.cacheReadTokens, cache_write_tokens: st.usage.cacheWriteTokens, cost_micros: st.costMicros });
      await audit(tx, st.ctx.agent, this.deps.clock, { action: `agent.run.${status}`, subjectType: 'agent_run', subjectId: st.ctx.runId, entityId: st.ctx.entityId, summary: `${st.run.ref} ${st.skill.manifest.title}: ${headline}`, data: { proposals: summary.proposals, autoApplied: summary.autoApplied, costMicros: st.costMicros, mode: st.ctx.mode } });
      return run;
    });
  }
}

function toolSpec<Svc>(t: ToolDef<unknown, unknown, Svc>): LlmToolSpec {
  const schema = z.toJSONSchema(t.input as z.ZodType, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete schema.$schema;
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const req = (schema.required ?? []) as string[];
  const strict = schema.additionalProperties === false && Object.keys(props).every((k) => req.includes(k));
  return { name: toWireToolName(t.name), description: `${t.description} Returns ${t.outputType}.`, inputSchema: schema, strict };
}

/** Stable system prompt (cache-friendly: no timestamps, run ids or volatile data). */
export function systemPrompt(ontology: Ontology, skill: LoadedSkill, policy: EffectivePolicy): string {
  const m = skill.manifest;
  const types = [...m.inputs.map((i) => i.type), ...m.outputs.map((o) => o.type)];
  const policyText = [
    `Autonomy: ${policy.autonomy}.`,
    `Thresholds: ${Object.entries(policy.thresholds).map(([k, v]) => `${k}=${v}`).join(', ')}.`,
    policy.mappings.length ? `Mappings: ${policy.mappings.map((mp) => `${JSON.stringify(mp.match)} → ${JSON.stringify(mp.set)}`).join('; ')}.` : 'Mappings: none.',
    policy.rules.length ? `Rules (as interpreted): ${policy.rules.map((r) => `"${r.text}" ⇒ ${r.interpretation}`).join(' | ')}` : 'Rules: none.',
  ].join('\n');
  return [
    `You are the ${m.title} agent in Tieout, an agentic month-end close platform. You prepare work for accountants; people approve it.`,
    '',
    '## Operating rules',
    UNTRUSTED_DATA_POLICY,
    '- Use tools to gather facts; never invent amounts, ids or dates. Cite record ids from tool results as evidence.',
    '- Every proposal needs: a plain-English "why" a non-accountant can follow, a calibrated confidence between 0 and 1, and evidence.',
    '- The runtime re-verifies every proposal against the ontology axioms (double entry, period state, dimensions, SoD, thresholds) and rejects failures; fix and retry if a proposal is rejected.',
    '- When finished, call `finish` exactly once.',
    '',
    `## Skill instructions (${skill.key} v${skill.version})`,
    skill.body,
    '',
    '## Ontology (definitions and axioms you must respect)',
    ontology.slice(types),
    '',
    '## Customer policy (data set by the Controller; you cannot change it)',
    policyText,
    '',
    skill.resources.size ? `## Resources (read with read_skill_resource)\n${[...skill.resources.keys()].map((k) => `- ${k}`).join('\n')}` : '',
  ].join('\n');
}

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens };
}

function textOf(m: LlmMessage): string {
  return m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join(' ').trim();
}

function sizeOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') {
    for (const k of ['items', 'rows', 'lines', 'transactions', 'matches', 'candidates', 'entries']) {
      const x = (v as Record<string, unknown>)[k];
      if (Array.isArray(x)) return x.length;
    }
    return Object.keys(v).length;
  }
  return 1;
}

function observationTitle(outputType: string, output: unknown, flags: InjectionFlag[]): string {
  const n = sizeOf(output);
  const label = outputType.replace(/^tie:/, '').replace(/\[\]$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return `Observed ${n} ${label}${n === 1 ? '' : ' records'}${flags.length ? ` · ${flags.length} untrusted instruction-like text${flags.length === 1 ? '' : 's'} neutralised` : ''}`;
}
