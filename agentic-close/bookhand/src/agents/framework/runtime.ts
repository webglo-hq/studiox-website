import { z } from 'zod';
import { appendAudit } from '../../audit/audit';
import type { Db, Tx } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import { loadPrincipal, type Principal } from '../../security/principal';
import { canonicalJson } from '../../shared/canonical-json';
import type { Actor, Clock, DomainContext } from '../../shared/context';
import { DomainError } from '../../shared/errors';
import { sha256Hex } from '../../shared/hash';
import { newId } from '../../shared/ids';
import { yieldToEventLoop } from '../../shared/yield';
import { describeApiError, usageOf, type BetaMessageParam, type BetaTextBlockParam, type BetaTool, type BetaToolResultBlockParam, type LlmClient } from '../llm/types';
import { HYGIENE_RULES, sanitizeValue, scanText, wrapToolResult } from './hygiene';
import type { SkillPackage } from './manifest';
import { currentPolicyRow, decideDisposition, resolvePolicy, type RuleCompiler } from './policy';
import type {
  AgentHandle,
  AnyTool,
  Materiality,
  PackScope,
  ProposalDraft,
  ProposalHandler,
  ProposeResult,
  ResolvedPolicy,
  SkillEngine,
  VerificationCheck,
} from './types';

/**
 * Durable agent runtime. One run = plan -> act (typed tool calls) -> observe -> verify -> propose -> (human or
 * policy) approve -> post -> audit. Every step, tool call, token and cent is recorded; tool calls are journaled
 * with idempotency keys so a crashed run resumes without repeating work; proposals are deduplicated by natural
 * key; budgets stop runaway runs; untrusted text never becomes instructions.
 */

export interface PackRuntime<P> {
  key: string;
  ontologyVersion: string;
  tools: AnyTool<P>[];
  handlers: ProposalHandler<P>[];
  engines: SkillEngine[];
  skills: SkillPackage[];
  buildScope(tx: Tx, ctx: DomainContext): Promise<P>;
  compileRules: RuleCompiler;
  ruleMatches(pattern: string, text: string): boolean;
  materiality(tx: Tx, tenantId: string, run: Row<'agent_runs'>): Promise<Materiality>;
  /** Ontology grounding for a skill's system prompt (stable per skill version: cache friendly). */
  grounding(skill: SkillPackage): string;
  onRunFinished?(scope: PackScope<P>, run: Row<'agent_runs'>): Promise<void>;
  onProposalSettled?(scope: PackScope<P>, proposal: Row<'proposals'>): Promise<void>;
}

export interface RunRequest {
  skillKey: string;
  input?: Record<string, unknown>;
  requestedBy: string | null;
  requestedByLabel: string;
  trigger?: Row<'agent_runs'>['trigger'];
  closeId?: string | null;
  closeTaskId?: string | null;
  entityId?: string | null;
  periodId?: string | null;
  parentRunId?: string | null;
  mode?: 'offline' | 'live';
  idempotencyKey?: string;
}

export class ToolCallError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    readonly status: 'error' | 'denied' = 'error',
  ) {
    super(message);
    this.name = 'ToolCallError';
  }
}

class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceeded';
  }
}

/** Thrown by fault injection in tests to simulate a process crash (never caught by the runtime). */
export class SimulatedCrash extends Error {
  constructor(message = 'simulated crash') {
    super(message);
    this.name = 'SimulatedCrash';
  }
}

export interface RuntimeDeps<P> {
  db: Db;
  pack: PackRuntime<P>;
  clock: Clock;
  llm?: LlmClient | null;
  log?: (message: string) => void;
  /** Test hook: called before each tool executes; throw SimulatedCrash to kill the run mid-flight. */
  faultInjector?: (event: { runId: string; tool: string; callNumber: number }) => void;
}

interface RunState {
  run: Row<'agent_runs'>;
  skill: SkillPackage;
  engine: SkillEngine;
  policy: ResolvedPolicy;
  materiality: Materiality;
  principal: Principal | null;
  actor: Actor;
  seq: number;
  stepKeys: Set<string>;
  occurrences: Map<string, number>;
  counters: { steps: number; toolCalls: number; tokensIn: number; tokensOut: number; cacheRead: number; costMicros: number };
  proposals: Array<{ id: string; kind: Row<'proposals'>['kind']; status: string; title: string }>;
  flaggedIds: Set<string>;
  callNumber: number;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);

export class AgentRuntime<P> {
  private readonly tools: Map<string, AnyTool<P>>;
  private readonly handlers: Map<string, ProposalHandler<P>>;
  private readonly skills: Map<string, { pkg: SkillPackage; engine: SkillEngine }>;
  private readonly proposalTools: Map<string, string>;

  constructor(readonly deps: RuntimeDeps<P>) {
    this.tools = new Map(deps.pack.tools.map((t) => [t.name, t]));
    this.handlers = new Map(deps.pack.handlers.map((h) => [h.kind, h]));
    this.skills = new Map();
    for (const pkg of deps.pack.skills) {
      const engine = deps.pack.engines.find((e) => e.key === pkg.manifest.key);
      if (!engine) throw new Error(`skill ${pkg.manifest.key} has no engine`);
      this.skills.set(pkg.manifest.key, { pkg, engine });
    }
    this.proposalTools = new Map();
  }

  get llm(): LlmClient | null {
    return this.deps.llm ?? null;
  }

  skill(key: string): { pkg: SkillPackage; engine: SkillEngine } {
    const s = this.skills.get(key);
    if (!s) throw new DomainError('NOT_FOUND', `Unknown skill "${key}"`);
    return s;
  }

  listSkills(): SkillPackage[] {
    return [...this.skills.values()].map((s) => s.pkg);
  }

  tool(name: string): AnyTool<P> | undefined {
    return this.tools.get(name);
  }

  handler(kind: string): ProposalHandler<P> {
    const h = this.handlers.get(kind);
    if (!h) throw new DomainError('INVARIANT', `No handler for proposal kind ${kind}`);
    return h;
  }

  // ------------------------------------------------------------------ start

  async start(tenantId: string, req: RunRequest): Promise<Row<'agent_runs'>> {
    const { pkg } = this.skill(req.skillKey);
    const m = pkg.manifest;
    const input = req.input ?? {};
    for (const [name, spec] of Object.entries(m.inputs)) {
      if (spec.required && (input[name] === undefined || input[name] === null || input[name] === '')) throw new DomainError('VALIDATION', `${m.name} needs input "${name}" (${spec.description})`);
    }
    const mode = m.execution === 'deterministic' ? 'offline' : (req.mode ?? (this.llm ? 'live' : 'offline'));
    if (req.requestedBy) {
      const principal = await this.deps.db.read((tx) => loadPrincipal(tx, tenantId, req.requestedBy!));
      if (!principal.permissions.has(m.permissions.run as never)) throw new DomainError('FORBIDDEN', `${m.name} needs permission "${m.permissions.run}", which ${principal.user.display_name} does not have.`);
    }
    if (mode === 'live' && !this.llm) throw new DomainError('UNAVAILABLE', 'Live mode needs ANTHROPIC_API_KEY; running offline is always available.');
    const key = req.idempotencyKey ?? `run:${newId()}`;
    return this.deps.db.tx(async (tx) => {
      const existing = await tx.findOne('agent_runs', { idempotency_key: key });
      if (existing) return existing;
      const policyRow = await currentPolicyRow(tx, tenantId, m.key, req.entityId ?? null);
      const run = await tx.insert('agent_runs', {
        tenant_id: tenantId,
        skill_key: m.key,
        skill_version: m.version,
        policy_id: policyRow?.id ?? null,
        ontology_version: this.deps.pack.ontologyVersion,
        close_id: req.closeId ?? null,
        close_task_id: req.closeTaskId ?? null,
        entity_id: req.entityId ?? null,
        period_id: req.periodId ?? null,
        parent_run_id: req.parentRunId ?? null,
        status: 'queued',
        phase: 'plan',
        mode,
        provider: mode === 'live' ? 'anthropic' : 'offline-engine',
        model: mode === 'live' ? this.llm!.model : null,
        requested_by: req.requestedBy,
        requested_by_label: req.requestedByLabel,
        trigger: req.trigger ?? 'manual',
        input,
        budget: { max_steps: m.budgets.maxSteps, max_tool_calls: m.budgets.maxToolCalls, max_tokens: m.budgets.maxTokens, max_cost_usd_micros: Math.round(m.budgets.maxCostUsd * 1_000_000) },
        idempotency_key: key,
      });
      if (req.closeTaskId) {
        const task = await tx.get('close_tasks', req.closeTaskId);
        if (task) await tx.update('close_tasks', task.id, { last_run_id: run.id, status: task.status === 'not_started' || task.status === 'blocked' ? 'in_progress' : task.status, started_at: task.started_at ?? this.deps.clock.now(), blocked_reason: null });
      }
      await appendAudit(tx, tenantId, { type: req.requestedBy ? 'user' : 'system', userId: req.requestedBy, label: req.requestedByLabel }, {
        action: 'agent_run.start',
        objectType: 'agent_run',
        objectId: run.id,
        summary: `Started ${m.name} (${mode === 'live' ? `live, ${this.llm!.model}` : 'offline engine'})`,
        details: { skill: m.key, version: m.version, input, trigger: run.trigger },
      }, this.deps.clock.now());
      return run;
    });
  }

  // ------------------------------------------------------------------ execute / resume

  async execute(runId: string): Promise<Row<'agent_runs'>> {
    const db = this.deps.db;
    let run = await db.read((tx) => tx.get('agent_runs', runId));
    if (!run) throw new DomainError('NOT_FOUND', 'run not found');
    if (TERMINAL.has(run.status)) return run;
    const resumed = run.status === 'running';
    const { pkg, engine } = this.skill(run.skill_key);
    const now = this.deps.clock.now();
    const prepared = await db.tx(async (tx) => {
      const r = await tx.update('agent_runs', runId, { status: 'running', started_at: run!.started_at ?? now, heartbeat_at: now, resume_count: resumed ? run!.resume_count + 1 : run!.resume_count });
      const policyRow = r.policy_id ? await tx.get('skill_policies', r.policy_id) : null;
      const policy = resolvePolicy(pkg.manifest, policyRow, this.deps.pack.compileRules);
      const materiality = await this.deps.pack.materiality(tx, r.tenant_id, r);
      const principal = r.requested_by ? await loadPrincipal(tx, r.tenant_id, r.requested_by) : null;
      const steps = await tx.find('agent_steps', { run_id: runId }, { orderBy: [['seq', 'asc']] });
      const proposals = await tx.find('proposals', { run_id: runId }, { orderBy: [['created_at', 'asc']] });
      return { r, policy, materiality, principal, steps, proposals };
    });
    run = prepared.r;
    const state: RunState = {
      run,
      skill: pkg,
      engine,
      policy: prepared.policy,
      materiality: prepared.materiality,
      principal: prepared.principal,
      actor: { type: 'agent', userId: null, runId: run.id, onBehalfOf: run.requested_by, label: `${pkg.manifest.name} agent` },
      seq: prepared.steps.at(-1)?.seq ?? 0,
      stepKeys: new Set(prepared.steps.map((s) => String((s.detail as Record<string, unknown>).key ?? ''))),
      occurrences: new Map(),
      counters: { steps: prepared.steps.length, toolCalls: run.tool_calls_used, tokensIn: run.tokens_in, tokensOut: run.tokens_out, cacheRead: run.cache_read_tokens, costMicros: run.cost_usd_micros },
      proposals: prepared.proposals.map((p) => ({ id: p.id, kind: p.kind, status: p.status, title: p.title })),
      flaggedIds: new Set(),
      callNumber: 0,
    };
    if (resumed) await this.step(state, 'plan', 'decision', `Resumed after interruption (attempt ${run.resume_count})`, { completed_tool_calls: run.tool_calls_used }, `resume:${run.resume_count}`);
    const handle = this.handle(state);
    try {
      const summary = run.mode === 'live' && this.llm ? await this.liveLoop(state, handle) : await engine.offline(handle);
      return await this.finish(state, 'completed', summary, null);
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      if (e instanceof BudgetExceeded) return this.finish(state, 'budget_exceeded', `Stopped: ${e.message}. Partial results are kept.`, e.message);
      const message = e instanceof ToolCallError || e instanceof DomainError ? e.message : describeApiError(e);
      this.deps.log?.(`run ${runId} failed: ${message}`);
      await this.step(state, 'act', 'error', 'Run failed', { message }, `error:${state.seq}`).catch(() => undefined);
      return this.finish(state, 'failed', null, message);
    }
  }

  /** Resume runs whose worker died (no heartbeat for staleMs). */
  async recover(staleMs = 60_000): Promise<string[]> {
    const cutoff = new Date(Date.parse(this.deps.clock.now()) - staleMs).toISOString();
    const stale = await this.deps.db.read((tx) => tx.find('agent_runs', { status: { in: ['running', 'queued'] } }));
    const ids = stale.filter((r) => !r.heartbeat_at || r.heartbeat_at < cutoff).map((r) => r.id);
    for (const id of ids) await this.execute(id);
    return ids;
  }

  async cancel(runId: string, actor: Actor, reason: string): Promise<Row<'agent_runs'>> {
    return this.deps.db.tx(async (tx) => {
      const run = await tx.get('agent_runs', runId);
      if (!run) throw new DomainError('NOT_FOUND', 'run not found');
      if (TERMINAL.has(run.status)) return run;
      const r = await tx.update('agent_runs', runId, { status: 'cancelled', phase: 'done', finished_at: this.deps.clock.now(), error: reason });
      await appendAudit(tx, run.tenant_id, actor, { action: 'agent_run.cancel', objectType: 'agent_run', objectId: runId, summary: `Cancelled ${run.skill_key}: ${reason}` }, this.deps.clock.now());
      return r;
    });
  }

  private async finish(state: RunState, status: Row<'agent_runs'>['status'], summary: string | null, error: string | null): Promise<Row<'agent_runs'>> {
    const now = this.deps.clock.now();
    if (summary) await this.step(state, 'audit', 'message', 'Summary', { summary }, `summary:${status}`);
    return this.deps.db.tx(async (tx) => {
      const run = await tx.update('agent_runs', state.run.id, {
        status,
        phase: 'done',
        summary,
        error,
        finished_at: now,
        heartbeat_at: now,
        steps_used: state.counters.steps,
        tool_calls_used: state.counters.toolCalls,
        tokens_in: state.counters.tokensIn,
        tokens_out: state.counters.tokensOut,
        cache_read_tokens: state.counters.cacheRead,
        cost_usd_micros: state.counters.costMicros,
        proposals_count: state.proposals.length,
      });
      const ctx = this.ctxFor(state);
      if (this.deps.pack.onRunFinished) await this.deps.pack.onRunFinished({ tx, ctx, pack: await this.deps.pack.buildScope(tx, ctx) }, run);
      const auto = state.proposals.filter((p) => p.status === 'auto_applied').length;
      const waiting = state.proposals.filter((p) => p.status === 'pending').length;
      await appendAudit(tx, run.tenant_id, state.actor, {
        action: `agent_run.${status}`,
        objectType: 'agent_run',
        objectId: run.id,
        summary: `${state.skill.manifest.name}: ${status.replace('_', ' ')}; ${state.proposals.length} proposal(s), ${auto} auto-applied, ${waiting} awaiting approval`,
        details: { error, tool_calls: state.counters.toolCalls, cost_usd_micros: state.counters.costMicros },
      }, now);
      return run;
    });
  }

  // ------------------------------------------------------------------ handle & steps

  private ctxFor(state: RunState): DomainContext {
    return { db: this.deps.db, tenantId: state.run.tenant_id, actor: state.actor, clock: this.deps.clock };
  }

  private handle(state: RunState): AgentHandle {
    return {
      run: state.run,
      input: state.run.input as Record<string, unknown>,
      policy: state.policy,
      materiality: state.materiality,
      plan: async (steps) => {
        await this.step(state, 'plan', 'plan', 'Plan', { steps }, 'plan');
        await this.deps.db.tx((tx) => tx.update('agent_runs', state.run.id, { plan: steps, phase: 'act' }));
      },
      call: <T>(tool: string, input: unknown) => this.callTool(state, tool, input) as Promise<T>,
      note: async (title, detail = {}, kind = 'observation') => {
        const occ = this.occurrence(state, `note:${title}`);
        await this.step(state, kind === 'verification' ? 'verify' : 'act', kind, title, detail, `note:${title}:${occ}`);
      },
      proposals: () => state.proposals,
      spawn: async (req) => {
        const allowed = state.skill.manifest.spawns;
        if (!allowed.includes('*') && !allowed.includes(req.skillKey)) throw new ToolCallError('spawn', `${state.skill.manifest.name} may not start ${req.skillKey}`, 'denied');
        const childManifest = this.skill(req.skillKey).pkg.manifest;
        if (state.principal && !state.principal.permissions.has(childManifest.permissions.run as never)) {
          const why = `needs permission ${childManifest.permissions.run}, which ${state.run.requested_by_label} does not have`;
          await this.step(state, 'act', 'decision', `Skipped ${childManifest.name}${req.label ? ` for ${req.label}` : ''}: ${why}`, { skill: req.skillKey }, `skip:${req.skillKey}:${req.closeTaskId ?? ''}`);
          return { runId: '', status: 'skipped', summary: why, proposals: 0, pending: 0, autoApplied: 0 };
        }
        const occ = this.occurrence(state, `spawn:${req.skillKey}:${req.closeTaskId ?? ''}`);
        const child = await this.start(state.run.tenant_id, {
          skillKey: req.skillKey,
          input: req.input,
          requestedBy: state.run.requested_by,
          requestedByLabel: state.run.requested_by_label,
          trigger: 'orchestrator',
          closeId: state.run.close_id,
          closeTaskId: req.closeTaskId ?? null,
          entityId: req.entityId ?? null,
          periodId: req.periodId ?? null,
          parentRunId: state.run.id,
          mode: state.run.mode === 'live' && this.skill(req.skillKey).pkg.manifest.execution === 'agentic' ? 'live' : 'offline',
          idempotencyKey: `child:${sha256Hex(`${state.run.id}|${req.skillKey}|${req.closeTaskId ?? ''}|${canonicalJson(req.input)}|${occ}`)}`,
        });
        await this.step(state, 'act', 'decision', `Started ${this.skill(req.skillKey).pkg.manifest.name}${req.label ? ` for ${req.label}` : ''}`, { child_run_id: child.id, skill: req.skillKey }, `spawn:${child.id}`);
        const done = await this.execute(child.id);
        const props = await this.deps.db.read((tx) => tx.find('proposals', { run_id: child.id }));
        return {
          runId: done.id,
          status: done.status,
          summary: done.summary,
          proposals: props.length,
          pending: props.filter((p) => p.status === 'pending').length,
          autoApplied: props.filter((p) => p.status === 'auto_applied').length,
        };
      },
    };
  }

  private occurrence(state: RunState, key: string): number {
    const n = (state.occurrences.get(key) ?? 0) + 1;
    state.occurrences.set(key, n);
    return n;
  }

  /** Append a trace step (idempotent by key so a resumed run does not duplicate its trace). */
  private async step(state: RunState, phase: Row<'agent_steps'>['phase'], kind: Row<'agent_steps'>['kind'], title: string, detail: Record<string, unknown>, key: string, tx?: Tx, extra: Partial<Row<'agent_steps'>> = {}): Promise<void> {
    if (state.stepKeys.has(key)) return;
    if (state.counters.steps >= state.run.budget.max_steps) throw new BudgetExceeded(`step budget of ${state.run.budget.max_steps} reached`);
    const write = async (t: Tx) => {
      state.seq += 1;
      await t.insert('agent_steps', { tenant_id: state.run.tenant_id, run_id: state.run.id, seq: state.seq, phase, kind, title: title.slice(0, 300), detail: { ...detail, key }, ...extra });
    };
    if (tx) await write(tx);
    else await this.deps.db.tx(write);
    state.stepKeys.add(key);
    state.counters.steps += 1;
  }

  // ------------------------------------------------------------------ tools

  private toolAllowed(state: RunState, name: string): AnyTool<P> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolCallError(name, `Unknown tool "${name}".`, 'denied');
    if (!state.skill.manifest.tools.includes(name)) throw new ToolCallError(name, `Tool "${name}" is not allowed for ${state.skill.manifest.name}.`, 'denied');
    if (state.principal && !state.principal.permissions.has(tool.permission)) {
      throw new ToolCallError(name, `${state.run.requested_by_label} lacks permission ${tool.permission} required by ${name}.`, 'denied');
    }
    return tool;
  }

  private async recordFailure(state: RunState, name: string, input: unknown, status: 'error' | 'denied', message: string): Promise<void> {
    await this.deps.db.tx(async (tx) => {
      state.seq += 1;
      state.counters.steps += 1;
      const step = await tx.insert('agent_steps', { tenant_id: state.run.tenant_id, run_id: state.run.id, seq: state.seq, phase: 'act', kind: 'error', title: `${name}: ${status}`, detail: { message, key: `fail:${state.seq}` } });
      await tx.insert('agent_tool_calls', { tenant_id: state.run.tenant_id, run_id: state.run.id, step_id: step.id, tool_name: name, input: sanitizeValue(input ?? null), status, is_mutation: false, idempotency_key: `${state.run.id}:fail:${newId()}`, error: message });
    });
  }

  private async callTool(state: RunState, name: string, rawInput: unknown): Promise<unknown> {
    await yieldToEventLoop();
    let tool: AnyTool<P>;
    try {
      tool = this.toolAllowed(state, name);
    } catch (e) {
      await this.recordFailure(state, name, rawInput, 'denied', (e as Error).message);
      throw e;
    }
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const message = `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`;
      await this.recordFailure(state, name, rawInput, 'error', message);
      throw new ToolCallError(name, message);
    }
    const input = parsed.data;
    const canonical = canonicalJson(input);
    const occ = this.occurrence(state, `${name}|${canonical}`);
    const key = sha256Hex(`${state.run.id}|${name}|${canonical}|${occ}`);
    const journaled = await this.deps.db.read((tx) => tx.findOne('agent_tool_calls', { idempotency_key: key }));
    if (journaled && journaled.status === 'ok') {
      this.scanOutput(state, tool, journaled.output);
      return journaled.output;
    }
    if (state.counters.toolCalls >= state.run.budget.max_tool_calls) throw new BudgetExceeded(`tool-call budget of ${state.run.budget.max_tool_calls} reached`);
    state.callNumber += 1;
    this.deps.faultInjector?.({ runId: state.run.id, tool: name, callNumber: state.callNumber });
    const started = Date.now();
    const ctx = this.ctxFor(state);
    try {
      return await this.deps.db.tx(async (tx) => {
        const scope: PackScope<P> = { tx, ctx, pack: await this.deps.pack.buildScope(tx, ctx) };
        const output = await tool.execute(input, { ...scope, run: state.run, propose: (draft) => this.propose(state, scope, draft) });
        const safe = sanitizeValue(output === undefined ? null : output);
        const findings = this.scanOutput(state, tool, safe);
        state.seq += 1;
        state.counters.steps += 1;
        state.counters.toolCalls += 1;
        const summary = tool.summarize ? tool.summarize(output) : undefined;
        const step = await tx.insert('agent_steps', {
          tenant_id: state.run.tenant_id,
          run_id: state.run.id,
          seq: state.seq,
          phase: tool.mutation ? 'propose' : 'act',
          kind: tool.mutation ? 'proposal' : 'tool_call',
          title: summary ? `${tool.title}: ${summary}` : tool.title,
          detail: { key: `tool:${key}`, tool: name, input, ...(findings.length ? { injection_findings: findings } : {}) },
          duration_ms: Date.now() - started,
        });
        await tx.insert('agent_tool_calls', { tenant_id: state.run.tenant_id, run_id: state.run.id, step_id: step.id, tool_name: name, input, output: safe, status: 'ok', is_mutation: tool.mutation, idempotency_key: key, duration_ms: Date.now() - started });
        if (findings.length) {
          state.seq += 1;
          state.counters.steps += 1;
          await tx.insert('agent_steps', {
            tenant_id: state.run.tenant_id,
            run_id: state.run.id,
            seq: state.seq,
            phase: 'observe',
            kind: 'decision',
            title: `Treated instruction-like text in ${tool.title.toLowerCase()} as data (${findings.length} item${findings.length === 1 ? '' : 's'})`,
            detail: { key: `inj:${key}`, findings },
          });
        }
        await tx.update('agent_runs', state.run.id, { heartbeat_at: this.deps.clock.now(), steps_used: state.counters.steps, tool_calls_used: state.counters.toolCalls, phase: tool.mutation ? 'propose' : 'act', proposals_count: state.proposals.length });
        state.stepKeys.add(`tool:${key}`);
        return safe;
      });
    } catch (e) {
      if (e instanceof SimulatedCrash || e instanceof BudgetExceeded) throw e;
      const message = e instanceof Error ? e.message : String(e);
      await this.recordFailure(state, name, input, 'error', message);
      throw new ToolCallError(name, message);
    }
  }

  /** Scan untrusted tool output; remember ids of rows whose text looks like instructions. */
  private scanOutput(state: RunState, tool: AnyTool<P>, output: unknown): Array<{ id: string | null; field: string; excerpt: string; patterns: string[] }> {
    if (!tool.untrustedOutput) return [];
    const findings: Array<{ id: string | null; field: string; excerpt: string; patterns: string[] }> = [];
    const walk = (v: unknown, nearestId: string | null, field: string, depth: number) => {
      if (depth > 8 || findings.length > 25) return;
      if (typeof v === 'string') {
        const patterns = scanText(v);
        if (patterns.length) {
          findings.push({ id: nearestId, field, excerpt: v.length > 160 ? `${v.slice(0, 157)}...` : v, patterns });
          if (nearestId) state.flaggedIds.add(nearestId);
        }
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, nearestId, `${field}[${i}]`, depth + 1));
      else if (v && typeof v === 'object') {
        const obj = v as Record<string, unknown>;
        const id = typeof obj.id === 'string' ? obj.id : nearestId;
        for (const [k, x] of Object.entries(obj)) walk(x, id, field ? `${field}.${k}` : k, depth + 1);
      }
    };
    walk(output, null, '', 0);
    return findings;
  }

  // ------------------------------------------------------------------ proposals

  private async propose(state: RunState, scope: PackScope<P>, draft: ProposalDraft): Promise<ProposeResult> {
    const { tx } = scope;
    const handler = this.handler(draft.kind);
    const payload = handler.payload.safeParse(draft.payload);
    if (!payload.success) throw new DomainError('VALIDATION', `Invalid ${draft.kind} payload: ${payload.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const naturalKey = draft.naturalKey.replace(/\|/g, '/').slice(0, 300);
    const riskFlags = new Set(draft.riskFlags ?? []);
    const evidenceIds = [...draft.evidence.map((e) => e.id).filter((x): x is string => !!x), ...Object.values(draft.payload).filter((x): x is string => typeof x === 'string')];
    if (evidenceIds.some((id) => state.flaggedIds.has(id)) || scanText(`${draft.title} ${draft.why}`).length) riskFlags.add('instruction_like_text');

    const generic: VerificationCheck[] = [
      { id: 'GEN-CONF', label: 'Confidence is a probability', passed: draft.confidence >= 0 && draft.confidence <= 1, severity: 'error', message: 'confidence must be between 0 and 1' },
      { id: 'GEN-WHY', label: 'Explains why in plain English', passed: draft.why.trim().length >= 20, severity: 'error', message: 'the rationale is too short to review' },
      { id: 'GEN-EVID', label: 'Cites evidence', passed: draft.evidence.length > 0, severity: 'error', message: 'no evidence cited' },
      { id: 'GEN-AMT', label: 'Amount is non-negative', passed: Number.isSafeInteger(draft.amountMinor) && draft.amountMinor >= 0, severity: 'error', message: 'amount must be a non-negative integer in minor units' },
    ];
    const checks = [...generic, ...(await handler.verify({ ...draft, payload: payload.data as Record<string, unknown> }, scope))];
    const verification = { passed: checks.every((c) => c.passed || c.severity !== 'error'), checks };

    const prefix = `${state.run.tenant_id}|${naturalKey}|v`;
    const previous = await tx.find('proposals', { tenant_id: state.run.tenant_id, idempotency_key: { contains: prefix } }, { orderBy: [['created_at', 'desc']] });
    const exact = previous.filter((p) => p.idempotency_key.startsWith(prefix));
    const latest = exact[0];
    if (latest && (latest.status === 'approved' || latest.status === 'auto_applied')) {
      return { proposalId: latest.id, status: latest.status, disposition: latest.disposition, verification, duplicateOf: latest.id, skipped: 'already applied' };
    }
    if (latest && latest.status === 'rejected' && canonicalJson(latest.payload) === canonicalJson(payload.data)) {
      return { proposalId: latest.id, status: latest.status, disposition: latest.disposition, verification, duplicateOf: latest.id, skipped: 'previously rejected by a person; not re-proposed unchanged' };
    }
    if (latest && latest.run_id === state.run.id && ['pending', 'suggested', 'blocked'].includes(latest.status) && canonicalJson(latest.payload) === canonicalJson(payload.data)) {
      return { proposalId: latest.id, status: latest.status, disposition: latest.disposition, verification, duplicateOf: latest.id, skipped: 'already proposed in this run' };
    }
    for (const p of exact.filter((x) => ['pending', 'suggested', 'blocked'].includes(x.status))) {
      await tx.update('proposals', p.id, { status: 'superseded', updated_at: this.deps.clock.now() });
      await handler.onSupersede?.(p, scope);
    }

    const id = newId();
    const decision = decideDisposition({
      draft: { ...draft, riskFlags: [...riskFlags] },
      verification,
      policy: state.policy,
      materiality: state.materiality,
      autoApplicable: handler.autoApplicable,
      matches: this.deps.pack.ruleMatches,
      idForSampling: `${naturalKey}`,
    });
    const now = this.deps.clock.now();
    let proposal = await tx.insert('proposals', {
      id,
      tenant_id: state.run.tenant_id,
      run_id: state.run.id,
      skill_key: state.run.skill_key,
      kind: draft.kind,
      status: decision.status === 'auto_applied' ? 'pending' : decision.status,
      disposition: decision.disposition,
      title: draft.title.slice(0, 300),
      why: draft.why,
      confidence: Math.round(draft.confidence * 1000) / 1000,
      amount_minor: draft.amountMinor,
      currency: draft.currency,
      entity_id: draft.entityId ?? state.run.entity_id ?? null,
      period_id: draft.periodId ?? state.run.period_id ?? null,
      close_task_id: state.run.close_task_id,
      payload: payload.data as Record<string, unknown>,
      evidence: draft.evidence as unknown as Array<Record<string, unknown>>,
      verification: [...checks, { id: 'DISPOSITION', label: decision.reasons.join('; '), passed: true, severity: 'warning' }] as unknown as Array<Record<string, unknown>>,
      risk_flags: [...riskFlags],
      autonomy_level: state.policy.autonomy,
      policy_id: state.policy.id,
      required_permission: handler.permission,
      maker_type: 'agent',
      requested_by: state.run.requested_by,
      sampled_for_review: decision.sampledForReview,
      idempotency_key: `${prefix}${exact.length + 1}`,
      created_at: now,
      updated_at: now,
    });
    await handler.onCreate?.(proposal, scope);
    await appendAudit(tx, state.run.tenant_id, state.actor, {
      action: 'proposal.create',
      objectType: 'proposal',
      objectId: id,
      summary: `${handler.label}: ${proposal.title} (${decision.disposition.replace('_', ' ')})`,
      details: { kind: draft.kind, amount_minor: draft.amountMinor, confidence: proposal.confidence, disposition: decision.disposition, reasons: decision.reasons, risk_flags: [...riskFlags], policy_version: state.policy.version },
    }, now);

    if (decision.disposition === 'auto_apply') {
      const result = await handler.apply({ ...scope, proposal, basis: 'autonomy_policy', approvedBy: null, runId: state.run.id });
      proposal = await tx.update('proposals', id, {
        status: 'auto_applied',
        decided_at: now,
        decision_reason: decision.reasons.join('; '),
        effect: result.effect,
        posted_entry_id: result.postedEntryId ?? null,
        post_hoc_status: decision.sampledForReview ? 'pending' : 'not_required',
        updated_at: now,
      });
      await appendAudit(tx, state.run.tenant_id, state.actor, {
        action: 'proposal.auto_apply',
        objectType: 'proposal',
        objectId: id,
        summary: `Auto-applied under ${state.policy.autonomy} policy v${state.policy.version}: ${proposal.title}${decision.sampledForReview ? ' (sampled for post-hoc review)' : ''}`,
        details: { effect: result.effect, posted_entry_id: result.postedEntryId ?? null },
      }, now);
      if (this.deps.pack.onProposalSettled) await this.deps.pack.onProposalSettled(scope, proposal);
    }
    state.proposals.push({ id, kind: proposal.kind, status: proposal.status, title: proposal.title });
    return { proposalId: id, status: proposal.status, disposition: proposal.disposition, verification };
  }

  // ------------------------------------------------------------------ live (Claude) loop

  anthropicTools(skill: SkillPackage): BetaTool[] {
    return skill.manifest.tools
      .map((name) => this.tools.get(name)!)
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.description, input_schema: toolJsonSchema(t.input) as BetaTool['input_schema'] }));
  }

  systemPrompt(skill: SkillPackage): string {
    const m = skill.manifest;
    return [
      `You are the ${m.name} agent inside Bookhand, a month-end close platform. You work for an accounting team under their controls: you analyse, then propose changes that a person (or a bounded autonomy policy) approves. You never post directly.`,
      `## Skill instructions (${m.key} v${m.version})`,
      skill.instructions,
      `## Controls you operate`,
      m.controls.map((c) => `- ${c.id} ${c.name} (assertions: ${c.assertions.join(', ')})`).join('\n'),
      `## Ontology grounding`,
      this.deps.pack.grounding(skill),
      HYGIENE_RULES,
      `## Output\nWork through the task with tools. Every proposal needs a plain-English "why", a calibrated confidence (0-1) and evidence references taken from tool results. When finished, reply with a short summary for the accountant: what you checked, what you proposed, and what needs their attention.`,
    ].join('\n\n');
  }

  private async liveLoop(state: RunState, handle: AgentHandle): Promise<string> {
    const llm = this.llm!;
    const skill = state.skill;
    const system = [{ type: 'text' as const, text: this.systemPrompt(skill), cache_control: { type: 'ephemeral' as const } }];
    const tools = this.anthropicTools(skill);
    const brief = state.engine.brief?.(handle) ?? '';
    const messages: BetaMessageParam[] = [
      { role: 'user', content: `${brief}\n\nRun input (JSON): ${JSON.stringify(state.run.input)}\nPolicy: autonomy ${state.policy.autonomy}, thresholds ${JSON.stringify(state.policy.thresholds)}, rules: ${state.policy.rules.map((r) => r.text).join(' | ') || 'none'}.\nMateriality (reporting currency, minor units): performance ${state.materiality.performanceMinor}, clearly trivial ${state.materiality.trivialMinor}.` },
    ];
    let lastText = '';
    for (let turn = 0; turn < state.run.budget.max_steps; turn++) {
      if (state.counters.tokensIn + state.counters.tokensOut >= state.run.budget.max_tokens) throw new BudgetExceeded(`token budget of ${state.run.budget.max_tokens} reached`);
      if (state.counters.costMicros >= state.run.budget.max_cost_usd_micros) throw new BudgetExceeded(`cost budget of $${(state.run.budget.max_cost_usd_micros / 1e6).toFixed(2)} reached`);
      const started = Date.now();
      const response = await llm.turn({ system, tools, messages });
      const usage = usageOf(llm.model, response.usage);
      state.counters.tokensIn += usage.inputTokens + usage.cacheWriteTokens;
      state.counters.tokensOut += usage.outputTokens;
      state.counters.cacheRead += usage.cacheReadTokens;
      state.counters.costMicros += usage.costUsdMicros;
      const text = response.content.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
      const thinking = response.content.filter((b): b is Extract<typeof b, { type: 'thinking' }> => b.type === 'thinking').map((b) => b.thinking).join('\n').trim();
      if (text) lastText = text;
      const fallback = response.content.some((b) => b.type === 'fallback');
      await this.step(state, turn === 0 ? 'plan' : 'act', 'message', text ? text.slice(0, 280) : `Model turn ${turn + 1} (${response.stop_reason})`, {
        stop_reason: response.stop_reason,
        model: response.model,
        fallback_served: fallback,
        usage: { input: usage.inputTokens, output: usage.outputTokens, cache_read: usage.cacheReadTokens, cache_write: usage.cacheWriteTokens },
        text: text.slice(0, 4000),
        ...(thinking ? { thinking_summary: thinking.slice(0, 4000) } : {}),
      }, `turn:${turn}:${response.id}`, undefined, { tokens_in: usage.inputTokens, tokens_out: usage.outputTokens, cost_usd_micros: usage.costUsdMicros, duration_ms: Date.now() - started });
      await this.deps.db.tx((tx) => tx.update('agent_runs', state.run.id, { tokens_in: state.counters.tokensIn, tokens_out: state.counters.tokensOut, cache_read_tokens: state.counters.cacheRead, cost_usd_micros: state.counters.costMicros, heartbeat_at: this.deps.clock.now() }));
      if (response.stop_reason === 'refusal') {
        const details = (response as unknown as { stop_details?: { category?: string; explanation?: string } }).stop_details;
        throw new DomainError('UNAVAILABLE', `The model declined this task${details?.category ? ` (${details.category})` : ''}. Run it offline or adjust the request.`);
      }
      // The history is append-only: assistant turns (thinking blocks included) go back exactly as received.
      messages.push({ role: 'assistant', content: response.content as BetaMessageParam['content'] });
      if (response.stop_reason === 'pause_turn') continue;
      const uses = response.content.filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use');
      if (response.stop_reason === 'max_tokens') {
        // Answer any tool call that was cut off with an error result, then ask for a shorter continuation.
        const content: Array<BetaToolResultBlockParam | BetaTextBlockParam> = uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Your reply hit the output limit before this tool call was complete; it was not run. Call it again.' }));
        content.push({ type: 'text', text: 'Your last reply hit the output limit. Continue with fewer words: call the next tool or give the final summary.' });
        messages.push({ role: 'user', content });
        continue;
      }
      if (response.stop_reason !== 'tool_use' || !uses.length) return lastText || 'Done.';
      const results: BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        try {
          const output = await this.callTool(state, use.name, use.input);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: wrapToolResult(use.name, output, !!this.tools.get(use.name)?.untrustedOutput) });
        } catch (e) {
          if (e instanceof SimulatedCrash || e instanceof BudgetExceeded) throw e;
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: e instanceof Error ? e.message : String(e) });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    throw new BudgetExceeded(`turn budget of ${state.run.budget.max_steps} reached`);
  }
}

/** JSON Schema for a tool input (draft 2020-12 subset accepted by the Messages API); objects are closed. */
export function toolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  const close = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'object' && n.properties && n.additionalProperties === undefined) n.additionalProperties = false;
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(close);
      else if (v && typeof v === 'object') close(v);
    }
  };
  close(json);
  delete json.$schema;
  if (json.type !== 'object') return { type: 'object', properties: {}, additionalProperties: false };
  return json;
}
