import type { SkillPackage } from '../skills/manifest';
import type { Clock } from '../util/clock';
import { stableStringify } from '../util/canonical';
import { sha256Hex } from '../util/sha256';
import { scanForInjection } from '../util/text';
import { gate, sampled } from './autonomy';
import {
  BudgetExceededError,
  ToolDeniedError,
  type Brain,
  type BrainSession,
  type DelegatedActor,
  type DomainAdapter,
  type ProposalDraft,
  type ProposalOutcome,
  type ProposalRecord,
  type RunRecord,
  type RuntimeStore,
  type SkillPolicy,
  type StepPhase,
  type ToolDef,
  type VerificationReport,
} from './types';

/**
 * Durable, observable agent loop:
 *   plan → act (typed tool calls) → observe → verify (deterministic checks) → propose →
 *   gate (autonomy + materiality + SoD-aware routing) → post (only when allowed) → audit.
 *
 * Durability: every step, tool call and proposal is persisted as it happens with an
 * idempotency key. If the process dies mid-run, `resume()` replays the brain; recorded tool
 * calls return their stored outputs and proposals de-duplicate on their keys, so side
 * effects never repeat.
 */

export interface RunRequest {
  skillId: string;
  input: Record<string, unknown>;
  requestedBy: string | null;
  actor: DelegatedActor;
  entityId?: string | null;
  periodKey?: string | null;
  taskId?: string | null;
  parentRunId?: string | null;
  idempotencyKey?: string;
  trigger?: 'manual' | 'orchestrator' | 'schedule' | 'api';
  /** override engine selection (e.g. force offline) */
  brain?: Brain;
}

export interface RunResult {
  run: RunRecord;
  proposals: ProposalRecord[];
  replayed: boolean;
}

export interface RuntimeOptions<Ctx> {
  store: RuntimeStore;
  adapter: DomainAdapter<Ctx>;
  skills: Map<string, SkillPackage>;
  tools: Map<string, ToolDef<Ctx, unknown, unknown>>;
  selectBrain: (skill: SkillPackage) => Brain;
  clock: Clock;
  /**
   * Run fn in one database transaction, with a store and adapter bound to it. Decisions and
   * auto-posts use it so the claim, the posted effect, the status change and the audit event
   * commit together or not at all. Without it they run unwrapped (single-process stores).
   */
  atomic?: <T>(fn: (scope: AtomicScope<Ctx>) => Promise<T>) => Promise<T>;
  /** test hook: throw after N tool calls to simulate a crash */
  faults?: { crashAfterToolCalls?: number };
}

export interface AtomicScope<Ctx> {
  store: RuntimeStore;
  adapter: DomainAdapter<Ctx>;
}

const OPEN_STATUSES: ProposalRecord['status'][] = ['pending', 'suggested'];

export class SimulatedCrash extends Error {
  constructor() {
    super('simulated process crash');
    this.name = 'SimulatedCrash';
  }
}

export class AgentRuntime<Ctx> {
  constructor(readonly opts: RuntimeOptions<Ctx>) {}

  /** See RuntimeOptions.atomic. */
  atomically<T>(fn: (scope: AtomicScope<Ctx>) => Promise<T>): Promise<T> {
    return this.opts.atomic ? this.opts.atomic(fn) : fn({ store: this.opts.store, adapter: this.opts.adapter });
  }

  skill(id: string): SkillPackage {
    const s = this.opts.skills.get(id);
    if (!s) throw new Error(`Unknown skill ${id}`);
    return s;
  }

  defaultKey(req: RunRequest): string {
    return `run:${req.skillId}:${sha256Hex(stableStringify({ input: req.input, period: req.periodKey ?? null, task: req.taskId ?? null, by: req.requestedBy })).slice(0, 24)}`;
  }

  async start(req: RunRequest): Promise<RunResult> {
    const skill = this.skill(req.skillId);
    const policy = await this.opts.adapter.policy(skill.id);
    if (!policy.enabled) throw new Error(`The ${skill.manifest.title} skill is disabled by policy.`);
    const key = req.idempotencyKey ?? this.defaultKey(req);
    const existing = await this.opts.store.findRunByKey(key);
    if (existing && ['completed', 'awaiting_approval', 'failed', 'cancelled', 'budget_exceeded'].includes(existing.status)) {
      return { run: existing, proposals: await this.opts.store.listProposals(existing.id), replayed: true };
    }
    const brain = req.brain ?? this.opts.selectBrain(skill);
    const now = this.opts.clock.nowIso();
    const run =
      existing ??
      (await this.opts.store.insertRun({
        skillId: skill.id,
        skillVersion: skill.manifest.version,
        policyVersion: policy.version,
        status: 'queued',
        trigger: req.trigger ?? 'manual',
        requestedBy: req.requestedBy,
        engine: brain.engine,
        model: brain.model,
        idempotencyKey: key,
        entityId: req.entityId ?? null,
        periodKey: req.periodKey ?? null,
        taskId: req.taskId ?? null,
        parentRunId: req.parentRunId ?? null,
        input: req.input,
        maxSteps: skill.manifest.budgets.maxSteps,
        maxTokens: skill.manifest.budgets.maxTokens,
        maxCostMicros: Math.round(skill.manifest.budgets.maxCostUsd * 1_000_000),
        stepsUsed: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        checkpoint: null,
        summary: null,
        error: null,
        startedAt: now,
        finishedAt: null,
      }));
    return this.execute(run, skill, policy, brain, req.actor, !!existing);
  }

  /** Resume a run left in queued/running state (e.g. after a crash). */
  async resume(runId: string, actor: DelegatedActor, brain?: Brain): Promise<RunResult> {
    const run = await this.opts.store.getRun(runId);
    if (!run) throw new Error('run not found');
    if (!['queued', 'running'].includes(run.status)) return { run, proposals: await this.opts.store.listProposals(run.id), replayed: true };
    const skill = this.skill(run.skillId);
    const policy = await this.opts.adapter.policy(skill.id);
    return this.execute(run, skill, policy, brain ?? this.opts.selectBrain(skill), actor, true);
  }

  async resumeAll(actorFor: (run: RunRecord) => Promise<DelegatedActor>): Promise<RunResult[]> {
    const stale = await this.opts.store.listRuns({ status: ['queued', 'running'] });
    const out: RunResult[] = [];
    for (const r of stale) out.push(await this.resume(r.id, await actorFor(r)));
    return out;
  }

  private async execute(run: RunRecord, skill: SkillPackage, policy: SkillPolicy, brain: Brain, actor: DelegatedActor, resumed: boolean): Promise<RunResult> {
    const store = this.opts.store;
    const ctx = await this.opts.adapter.toolContext(run, actor);
    const steps = await store.listSteps(run.id);
    let seq = steps.reduce((m, s) => Math.max(m, s.seq), 0);
    let toolCallIndex = 0;
    let stepsUsed = run.stepsUsed;
    let inputTokens = run.inputTokens;
    let outputTokens = run.outputTokens;
    let costMicros = run.costMicros;
    let checkpoint = run.checkpoint;
    let customSummary: string | null = null;
    const clock = this.opts.clock;
    const allowed = new Set(skill.manifest.tools);
    const tools = skill.manifest.tools.map((t) => this.opts.tools.get(t)).filter((t): t is ToolDef<Ctx, unknown, unknown> => !!t);
    const faults = this.opts.faults;

    await store.updateRun(run.id, { status: 'running', startedAt: run.startedAt ?? clock.nowIso() });
    const step = async (phase: StepPhase, title: string, detail: unknown, status: 'ok' | 'error' | 'skipped' = 'ok', usage?: { inputTokens: number; outputTokens: number; costMicros: number }) => {
      seq += 1;
      const at = clock.nowIso();
      await store.insertStep({ runId: run.id, seq, phase, title: title.slice(0, 300), detail, status, startedAt: at, finishedAt: at, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, costMicros: usage?.costMicros ?? 0 });
      return seq;
    };
    if (resumed) await step('plan', 'Resumed after interruption — replaying recorded steps', { previousSteps: steps.length });

    const adapter = this.opts.adapter;
    const atomically = <T,>(fn: (scope: AtomicScope<Ctx>) => Promise<T>): Promise<T> => this.atomically(fn);
    const self = this;
    const session: BrainSession = {
      run,
      skill,
      policy,
      tools: tools as ToolDef<unknown, unknown, unknown>[],
      get budget() {
        return { maxSteps: run.maxSteps, stepsUsed, maxTokens: run.maxTokens, tokensUsed: inputTokens + outputTokens };
      },
      get savedCheckpoint() {
        return checkpoint;
      },
      async plan(items: string[]) {
        await step('plan', `Plan: ${items.length} step${items.length === 1 ? '' : 's'}`, { steps: items });
      },
      async note(title: string, detail?: unknown) {
        await step('observe', title, detail ?? null);
      },
      async checkpoint(state: unknown) {
        checkpoint = state;
        await store.updateRun(run.id, { checkpoint: state });
      },
      setSummary(text: string) {
        const t = text.replace(/\s+/g, ' ').trim();
        customSummary = t ? t.slice(0, 400) : null;
      },
      async reportUsage(u) {
        inputTokens += u.inputTokens;
        outputTokens += u.outputTokens;
        costMicros += u.costMicros;
        await store.updateRun(run.id, { inputTokens, outputTokens, costMicros, model: u.model });
        if (run.maxTokens > 0 && inputTokens + outputTokens > run.maxTokens) throw new BudgetExceededError('tokens');
        if (run.maxCostMicros > 0 && costMicros > run.maxCostMicros) throw new BudgetExceededError('cost');
      },
      async callTool<O>(name: string, input: unknown): Promise<O> {
        toolCallIndex += 1;
        const key = `${toolCallIndex}:${name}:${sha256Hex(stableStringify(input ?? null)).slice(0, 16)}`;
        const recorded = await store.findToolCall(run.id, key);
        if (recorded) {
          if (recorded.status !== 'ok') throw new Error(recorded.error ?? 'tool failed');
          return recorded.output as O;
        }
        const tool = self.opts.tools.get(name);
        if (!tool || !allowed.has(name)) {
          const s = await step('act', `Denied tool ${name}`, { reason: 'not in the skill manifest (least privilege)' }, 'error');
          await store.insertToolCall({ runId: run.id, stepSeq: s, toolName: name, input, output: null, status: 'denied', error: 'not allowed for this skill', durationMs: 0, idempotencyKey: key });
          throw new ToolDeniedError(name, 'not allowed for this skill');
        }
        if (tool.permission && !actor.permissions.has(tool.permission) && !actor.permissions.has('*')) {
          const s = await step('act', `Denied tool ${name}`, { reason: `delegated actor lacks ${tool.permission}` }, 'error');
          await store.insertToolCall({ runId: run.id, stepSeq: s, toolName: name, input, output: null, status: 'denied', error: `missing permission ${tool.permission}`, durationMs: 0, idempotencyKey: key });
          throw new ToolDeniedError(name, `missing permission ${tool.permission}`);
        }
        if (stepsUsed >= run.maxSteps) throw new BudgetExceededError('steps');
        stepsUsed += 1;
        await store.updateRun(run.id, { stepsUsed });
        const parsed = tool.input.safeParse(input);
        if (!parsed.success) {
          const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          const s = await step('act', `Call ${name} — invalid input`, { input, error: msg }, 'error');
          await store.insertToolCall({ runId: run.id, stepSeq: s, toolName: name, input, output: null, status: 'error', error: msg, durationMs: 0, idempotencyKey: key });
          throw new Error(`Invalid input for ${name}: ${msg}`);
        }
        const t0 = Date.now();
        const s = await step('act', `Call ${name}`, { input: parsed.data });
        try {
          const output = await tool.handler(ctx, parsed.data);
          const flags = tool.untrustedFields?.length ? findUntrusted(output, tool.untrustedFields) : [];
          await store.insertToolCall({ runId: run.id, stepSeq: s, toolName: name, input: parsed.data, output, status: 'ok', error: null, durationMs: Date.now() - t0, idempotencyKey: key });
          await step('observe', `${name} returned ${summarize(output)}`, flags.length ? { untrustedContentFlags: flags } : null);
          if (faults?.crashAfterToolCalls !== undefined && toolCallIndex >= faults.crashAfterToolCalls) throw new SimulatedCrash();
          return output as O;
        } catch (e) {
          if (e instanceof SimulatedCrash) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          await store.insertToolCall({ runId: run.id, stepSeq: s, toolName: name, input: parsed.data, output: null, status: 'error', error: msg, durationMs: Date.now() - t0, idempotencyKey: key });
          await step('observe', `${name} failed: ${msg}`, null, 'error');
          throw e;
        }
      },
      async propose(draft: ProposalDraft): Promise<ProposalOutcome> {
        const idem = `${run.id}:${draft.key}`;
        const existingP = await store.findProposalByKey(idem);
        if (existingP) return { status: existingP.status, proposalId: existingP.id, verification: existingP.verification, gate: existingP.verification.gate ?? null };
        // Framework-level check (ontology AX-PRP-01): every proposal explains itself.
        const base: VerificationReport = { ok: true, checks: [] };
        if (!draft.why || draft.why.trim().length < 10) base.checks.push({ id: 'AX-PRP-01', label: 'Has a plain-English rationale', ok: false, severity: 'error' });
        if (!draft.evidence?.length) base.checks.push({ id: 'AX-PRP-01', label: 'Has evidence', ok: false, severity: 'error' });
        if (!(draft.confidence >= 0 && draft.confidence <= 1)) base.checks.push({ id: 'AX-PRP-01', label: 'Confidence within [0, 1]', ok: false, severity: 'error' });
        const injection = draft.evidence.filter((e) => e.untrusted).some((e) => scanForInjection(`${e.label} ${e.detail ?? ''}`).suspicious) || !!draft.injectionSuspected;
        const domain = base.checks.some((c) => !c.ok) ? { ok: false, checks: [] } : await adapter.verify(draft, ctx);
        const verification: VerificationReport = { ok: base.checks.every((c) => c.ok) && domain.ok, checks: [...base.checks, ...domain.checks] };
        await step('verify', `Verify: ${draft.title}`, { checks: verification.checks }, verification.ok ? 'ok' : 'error');
        const assessment = await adapter.assess(draft, ctx);
        const g = gate({ ...draft, injectionSuspected: injection }, verification, assessment, policy, skill.manifest.controls.approvalRequired);
        await step('gate', `Gate: ${g.decision.replace('_', ' ')} — ${draft.title}`, g);
        const status: ProposalRecord['status'] = !verification.ok ? 'failed' : g.decision === 'suggest_only' ? 'suggested' : 'pending';
        let rec = await store.insertProposal({
          runId: run.id,
          skillId: skill.id,
          kind: draft.kind,
          payloadClass: adapter.payloadClass(draft.kind),
          title: draft.title.slice(0, 200),
          why: draft.why,
          confidence: Math.round(draft.confidence * 10_000) / 10_000,
          amount: draft.amount ?? null,
          currency: draft.currency ?? null,
          materiality: assessment.materiality,
          entityId: draft.entityId ?? run.entityId,
          periodKey: draft.periodKey ?? run.periodKey,
          status,
          payload: draft.payload,
          evidence: draft.evidence,
          verification: { ...verification, gate: g },
          autonomyLevel: policy.autonomy,
          gateDecision: g.decision,
          requiresRole: assessment.requiresRole,
          requestedBy: run.requestedBy,
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
          appliedRef: null,
          reviewStatus: 'none',
          reviewedBy: null,
          reviewedAt: null,
          idempotencyKey: idem,
          injectionFlag: injection,
        });
        await step('propose', `Proposed: ${draft.title}`, { proposalId: rec.id, kind: draft.kind, confidence: draft.confidence, status });
        let autoFailed: string | null = null;
        if (verification.ok && g.decision === 'auto_post') {
          const review: ProposalRecord['reviewStatus'] = policy.autonomy === 'L3' ? 'pending_review' : sampled(idem, policy.sampleRate) ? 'sampled' : 'none';
          const proposed = rec;
          try {
            // One transaction: the posted effect, the proposal's new status and the audit event
            // commit together, so a crash can never leave an effect without its record.
            rec = await atomically(async (tx) => {
              const c = tx.adapter === adapter ? ctx : await tx.adapter.toolContext(run, actor);
              const applied = await tx.adapter.apply(proposed, c, { decidedBy: null, policyLabel: `policy:${skill.id}@v${policy.version} ${policy.autonomy}` });
              const patch = { status: 'auto_applied' as const, appliedRef: applied, reviewStatus: review, decidedAt: clock.nowIso(), decisionReason: g.reasons.join(' ') };
              if (!(await tx.store.claimProposal(proposed.id, { status: OPEN_STATUSES }, patch))) throw new Error('the proposal was decided by someone else first');
              const done: ProposalRecord = { ...proposed, ...patch };
              await tx.adapter.audit(c, { action: 'agent.proposal.auto_applied', subjectType: 'proposal', subjectId: proposed.id, data: { skill: skill.id, kind: draft.kind, amount: draft.amount ?? null, policy: `${policy.autonomy}@v${policy.version}`, review } });
              if (tx.adapter.afterDecision) await tx.adapter.afterDecision(done, c);
              return done;
            });
            await step('post', `Posted automatically: ${draft.title}`, { applied: rec.appliedRef, review });
          } catch (e) {
            // Everything rolled back; leave the proposal for a person with the reason.
            autoFailed = e instanceof Error ? e.message : String(e);
            await step('post', `Auto-post refused: ${autoFailed}`.slice(0, 300), { proposalId: rec.id }, 'error');
          }
        }
        if (rec.status !== 'auto_applied') {
          await adapter.audit(ctx, { action: 'agent.proposal.created', subjectType: 'proposal', subjectId: rec.id, data: { skill: skill.id, kind: draft.kind, amount: draft.amount ?? null, status, gate: g.decision, ...(autoFailed ? { autoPostRefused: autoFailed } : {}) } });
        }
        return { status: rec.status, proposalId: rec.id, verification, gate: g };
      },
    };

    try {
      await brain.run(session);
      const proposals = await store.listProposals(run.id);
      const pending = proposals.filter((p) => p.status === 'pending' || p.status === 'suggested');
      const auto = proposals.filter((p) => p.status === 'auto_applied');
      const failed = proposals.filter((p) => p.status === 'failed');
      const counts = `${proposals.length} proposal${proposals.length === 1 ? '' : 's'}: ${auto.length} posted automatically, ${pending.length} waiting for a person${failed.length ? `, ${failed.length} rejected by verification` : ''}.`;
      const summary = customSummary ? (proposals.length ? `${customSummary} (${counts})` : customSummary) : counts;
      await step('finish', summary, { tokens: inputTokens + outputTokens, costMicros, stepsUsed });
      const status = pending.length ? 'awaiting_approval' : 'completed';
      await store.updateRun(run.id, { status, summary, finishedAt: clock.nowIso(), stepsUsed });
      await adapter.audit(ctx, { action: 'agent.run.finished', subjectType: 'agent_run', subjectId: run.id, data: { skill: skill.id, status, proposals: proposals.length, auto: auto.length, pending: pending.length, engine: brain.engine } });
      return { run: { ...run, status, summary, stepsUsed, inputTokens, outputTokens, costMicros }, proposals, replayed: resumed };
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e; // leave the run "running" — like a dead process
      const msg = e instanceof Error ? e.message : String(e);
      const status = e instanceof BudgetExceededError ? 'budget_exceeded' : 'failed';
      await step('error', status === 'budget_exceeded' ? `Stopped: ${msg}` : `Run failed: ${msg}`, null, 'error');
      await store.updateRun(run.id, { status, error: msg, finishedAt: clock.nowIso(), stepsUsed });
      await adapter.audit(ctx, { action: `agent.run.${status}`, subjectType: 'agent_run', subjectId: run.id, data: { skill: skill.id, error: msg } });
      return { run: { ...run, status, error: msg }, proposals: await store.listProposals(run.id), replayed: resumed };
    }
  }
}

export interface DecisionInput {
  proposalId: string;
  decision: 'approve' | 'reject';
  reason?: string | null;
  actor: DelegatedActor;
}

export interface DecisionResult {
  proposal: ProposalRecord;
  run: RunRecord;
}

export class DecisionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION',
    message: string,
  ) {
    super(message);
    this.name = 'DecisionError';
  }
}

/**
 * Human decisions on proposals (maker-checker). Authorisation and SoD are delegated to the
 * domain adapter; approval re-verifies against current state before applying, so stale
 * proposals (e.g. the period was locked meanwhile) fail safely.
 */
export async function decideProposal<Ctx>(rt: AgentRuntime<Ctx>, input: DecisionInput): Promise<DecisionResult> {
  const { clock } = rt.opts;
  // One transaction per decision. The first write is a compare-and-set claim on the proposal,
  // so a second, concurrent decision waits for this one and then finds it already decided;
  // if applying fails, the claim rolls back with everything else and the item stays open.
  return rt.atomically(async ({ store, adapter }) => {
    const p = await store.getProposal(input.proposalId);
    if (!p) throw new DecisionError('NOT_FOUND', 'Proposal not found');
    if (!OPEN_STATUSES.includes(p.status)) throw new DecisionError('CONFLICT', `This proposal is already ${p.status.replace('_', ' ')}.`);
    const run = (await store.getRun(p.runId))!;
    const ctx = await adapter.toolContext(run, input.actor);
    await adapter.authorize(p, ctx, input.decision);
    const now = clock.nowIso();
    const claim = async (patch: Partial<ProposalRecord>) => {
      if (!(await store.claimProposal(p.id, { status: OPEN_STATUSES }, patch))) throw new DecisionError('CONFLICT', 'Someone else decided this item a moment ago. Refresh to see the outcome.');
    };
    if (input.decision === 'reject') {
      const reason = (input.reason ?? '').trim();
      if (reason.length < 3) throw new DecisionError('VALIDATION', 'Say briefly why you are rejecting this (at least 3 characters).');
      await claim({ status: 'rejected', decidedBy: input.actor.userId, decidedAt: now, decisionReason: reason });
      if (input.actor.userId) await store.recordDecision({ proposalId: p.id, decision: 'reject', userId: input.actor.userId, reason });
      await adapter.audit(ctx, { action: 'agent.proposal.rejected', subjectType: 'proposal', subjectId: p.id, data: { reason, kind: p.kind, amount: p.amount } });
    } else {
      const verification = await adapter.verify(
        { key: p.idempotencyKey, kind: p.kind, title: p.title, why: p.why, confidence: p.confidence, amount: p.amount, currency: p.currency, entityId: p.entityId, periodKey: p.periodKey, payload: p.payload, evidence: p.evidence },
        ctx,
      );
      if (!verification.ok) {
        const msg = verification.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => c.detail ?? c.label).join(' ');
        throw new DecisionError('CONFLICT', `This proposal no longer passes verification: ${msg}`);
      }
      await claim({ status: 'approved', decidedBy: input.actor.userId, decidedAt: now, decisionReason: input.reason ?? null });
      const applied = await adapter.apply(p, ctx, { decidedBy: input.actor.userId, policyLabel: null });
      await store.updateProposal(p.id, { status: 'applied', appliedRef: applied });
      if (input.actor.userId) await store.recordDecision({ proposalId: p.id, decision: 'approve', userId: input.actor.userId, reason: input.reason ?? null });
      await adapter.audit(ctx, { action: 'agent.proposal.approved', subjectType: 'proposal', subjectId: p.id, data: { kind: p.kind, amount: p.amount, applied } });
    }
    const updated = (await store.getProposal(p.id))!;
    if (adapter.afterDecision) await adapter.afterDecision(updated, ctx);
    const all = await store.listProposals(run.id);
    if (run.status === 'awaiting_approval' && !all.some((x) => OPEN_STATUSES.includes(x.status))) {
      await store.updateRun(run.id, { status: 'completed', finishedAt: now });
    }
    return { proposal: updated, run: (await store.getRun(run.id))! };
  });
}

/** Post-hoc review of an auto-applied proposal (L2 samples, all L3 items). */
export async function reviewProposal<Ctx>(rt: AgentRuntime<Ctx>, input: { proposalId: string; actor: DelegatedActor; note?: string | null }): Promise<ProposalRecord> {
  const { clock } = rt.opts;
  return rt.atomically(async ({ store, adapter }) => {
    const p = await store.getProposal(input.proposalId);
    if (!p) throw new DecisionError('NOT_FOUND', 'Proposal not found');
    if (p.status !== 'auto_applied' || !['sampled', 'pending_review'].includes(p.reviewStatus)) throw new DecisionError('CONFLICT', 'This item is not waiting for a post-hoc review.');
    const run = (await store.getRun(p.runId))!;
    const ctx = await adapter.toolContext(run, input.actor);
    await adapter.authorize(p, ctx, 'review');
    const at = clock.nowIso();
    const claimed = await store.claimProposal(p.id, { status: ['auto_applied'], reviewStatus: ['sampled', 'pending_review'] }, { reviewStatus: 'reviewed', reviewedBy: input.actor.userId, reviewedAt: at });
    if (!claimed) throw new DecisionError('CONFLICT', 'Someone else reviewed this item a moment ago.');
    if (input.actor.userId) await store.recordDecision({ proposalId: p.id, decision: 'review', userId: input.actor.userId, reason: input.note ?? null });
    await adapter.audit(ctx, { action: 'agent.proposal.reviewed', subjectType: 'proposal', subjectId: p.id, data: { note: input.note ?? null, reviewedAt: at } });
    return (await store.getProposal(p.id))!;
  });
}

function summarize(output: unknown): string {
  if (Array.isArray(output)) return `${output.length} item${output.length === 1 ? '' : 's'}`;
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    for (const k of ['items', 'rows', 'lines', 'matches', 'candidates', 'transactions', 'findings']) {
      if (Array.isArray(o[k])) return `${(o[k] as unknown[]).length} ${k}`;
    }
    return `${Object.keys(o).length} fields`;
  }
  return String(output).slice(0, 60);
}

/** Walk dotted paths (with [] for arrays) and scan untrusted strings for instruction-like text. */
export function findUntrusted(output: unknown, fields: string[]): { path: string; matches: string[] }[] {
  const found: { path: string; matches: string[] }[] = [];
  const visit = (node: unknown, parts: string[], path: string) => {
    if (node === null || node === undefined) return;
    if (!parts.length) {
      if (typeof node === 'string') {
        const s = scanForInjection(node);
        if (s.suspicious) found.push({ path, matches: s.matches });
      }
      return;
    }
    const [head, ...rest] = parts;
    if (head === '[]') {
      if (Array.isArray(node)) node.forEach((n, i) => visit(n, rest, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') visit((node as Record<string, unknown>)[head!], rest, path ? `${path}.${head}` : head!);
  };
  for (const f of fields) visit(output, f.split('.').flatMap((p) => (p.endsWith('[]') ? [p.slice(0, -2), '[]'] : [p])), '');
  return found;
}
