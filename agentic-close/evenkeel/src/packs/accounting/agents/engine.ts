import { z } from 'zod';
import { AnthropicBrain, type MessagesClient, type OntologyContext } from '../../../framework/llm/anthropic-brain';
import { modelFor } from '../../../framework/llm/models';
import { advance, eligible, type OrchestrationReport, type OrchestratorPort } from '../../../framework/runtime/orchestrator';
import { PlaybookBrain } from '../../../framework/runtime/playbook';
import { AgentRuntime, decideProposal, DecisionError, reviewProposal, type RunResult } from '../../../framework/runtime/runtime';
import type { Brain, RunRecord, ToolDef } from '../../../framework/runtime/types';
import { validateSkill, type SkillPackage } from '../../../framework/skills/manifest';
import type { Clock } from '../../../framework/util/clock';
import { AppError } from '../../../framework/util/errors';
import { hasPermission, makeContext } from '../domain/context';
import { loadActor, PERMISSIONS } from '../domain/rbac';
import { closeOntology, PROPOSAL_CLASS, PROPOSAL_KINDS, PROPOSAL_SHAPES, type ProposalKind } from '../ontology';
import { orchTasks, syncTaskFromRuns } from '../services/close';
import { currentPeriodKey, settings } from '../services/common';
import type { EkDb } from '../store';
import { createAdapter } from './adapter';
import { delegatedActorFor, humanDelegate, type AgentCtx } from './context';
import { PLAYBOOKS } from './playbooks';
import { EkRuntimeStore } from './runtime-store';
import { CASH_TOOLS } from './tools-cash';
import { REVIEW_TOOLS } from './tools-review';
import { SPEND_TOOLS } from './tools-spend';

export const ALL_TOOLS = [...SPEND_TOOLS, ...CASH_TOOLS, ...REVIEW_TOOLS];

export type EngineMode = 'auto' | 'offline' | 'live';

export interface EngineOptions {
  db: EkDb;
  tenantId: string;
  clock: Clock;
  skills: SkillPackage[];
  mode?: EngineMode;
  /** client.beta.messages from @anthropic-ai/sdk (server only) */
  messages?: MessagesClient | null;
  env?: Record<string, string | undefined>;
  faults?: { crashAfterToolCalls?: number };
  concurrency?: number;
  /** Called when background agent work fails unexpectedly (logged by the server). */
  onBackgroundError?: (e: unknown) => void;
}

/** Grounding for the live model: definitions and payload schemas come from the ontology. */
export function accountingOntologyContext(): OntologyContext {
  const o = closeOntology();
  return {
    glossary(ids) {
      return [...new Set(ids)]
        .filter((id) => o.hasClass(id))
        .map((id) => {
          const c = o.cls(id);
          return `- ${id} (${c.label}): ${c.definition} Why it matters: ${c.why}`;
        })
        .join('\n');
    },
    payloadSchema(kind) {
      const shape = PROPOSAL_SHAPES[kind as ProposalKind];
      return shape ? (z.toJSONSchema(shape, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>) : {};
    },
    proposalKinds(outputs) {
      return PROPOSAL_KINDS.filter((k) => outputs.some((out) => o.hasClass(out) && (out === PROPOSAL_CLASS[k] || o.isA(out, PROPOSAL_CLASS[k]))));
    },
  };
}

/** Validate every skill against the ontology, tool registry and permission catalogue. */
export function validateSkills(skills: SkillPackage[]): string[] {
  const ctx = { ontology: closeOntology(), toolNames: new Set(ALL_TOOLS.map((t) => t.name)), permissions: new Set(Object.keys(PERMISSIONS)), proposalKinds: new Set<string>(PROPOSAL_KINDS) };
  return skills.flatMap((s) => validateSkill(s, ctx).map((p) => `${s.id}: ${p}`));
}

interface BackgroundRun {
  startedAt: string;
  startedBy: string;
  again: string | null;
  promise: Promise<void>;
}

/** What the close agents are doing right now (polled by the UI while they run in the background). */
export interface AgentActivity {
  running: boolean;
  startedAt: string | null;
  startedBy: string | null;
  last: { finishedAt: string; status: string; summary: string | null; runId: string | null; error: string | null } | null;
}

export interface DecisionOutcome {
  proposalId: string;
  ok: boolean;
  status?: string;
  error?: string;
  code?: string;
}

/**
 * The accounting pack's agent engine: wires skills, tools, the domain adapter and a brain
 * (offline playbooks or Claude) into the durable runtime, and runs the close calendar.
 */
export class AgentEngine {
  readonly runtime: AgentRuntime<AgentCtx>;
  readonly skills: Map<string, SkillPackage>;
  private readonly offline = new PlaybookBrain(PLAYBOOKS);
  private readonly ontologyCtx = accountingOntologyContext();
  private orchestrating = new Set<string>();
  private readonly background = new Map<string, BackgroundRun>();
  private readonly lastBackground = new Map<string, AgentActivity['last']>();

  constructor(private readonly opts: EngineOptions) {
    const problems = validateSkills(opts.skills);
    if (problems.length) throw new Error(`Invalid skills:\n${problems.join('\n')}`);
    this.skills = new Map(opts.skills.map((s) => [s.id, s]));
    const adapter = createAdapter({ db: opts.db, tenantId: opts.tenantId, clock: opts.clock, skills: this.skills, dispatch: (run) => this.dispatchWave(run) });
    const tools = new Map(ALL_TOOLS.map((t) => [t.name, t as ToolDef<AgentCtx, unknown, unknown>]));
    this.runtime = new AgentRuntime<AgentCtx>({
      store: new EkRuntimeStore(opts.db, opts.tenantId, () => opts.clock.nowIso()),
      adapter,
      skills: this.skills,
      tools,
      selectBrain: (skill) => this.brainFor(skill),
      clock: opts.clock,
      faults: opts.faults,
    });
  }

  get liveAvailable(): boolean {
    return !!this.opts.messages;
  }

  get mode(): 'offline' | 'live' {
    const m = this.opts.mode ?? 'auto';
    if (m === 'offline') return 'offline';
    return this.opts.messages ? 'live' : 'offline';
  }

  brainFor(skill: SkillPackage): Brain {
    if (this.mode === 'live' && this.opts.messages) return new AnthropicBrain(this.opts.messages, modelFor(skill.manifest.model, this.opts.env ?? {}), this.ontologyCtx);
    return this.offline;
  }

  private ctx(actor: Awaited<ReturnType<typeof loadActor>> | null) {
    return makeContext(this.opts.db, this.opts.tenantId, actor ?? { type: 'system', userId: null, label: 'Evenkeel', roles: [], permissions: new Set(['*']), entityScope: 'all' }, this.opts.clock);
  }

  /** Run the agent for one close task on behalf of its owner. */
  async runTask(taskId: string, by: { userId: string | null; parentRunId?: string | null; trigger?: 'manual' | 'orchestrator'; brain?: Brain }): Promise<RunResult> {
    const { db, tenantId } = this.opts;
    const task = await db.get('close_task', taskId);
    if (!task || task.tenant_id !== tenantId) throw new AppError('NOT_FOUND', 'Task not found');
    if (!task.skill_id) throw new AppError('VALIDATION', `${task.code} is a manual task; no agent prepares it.`);
    const skill = this.skills.get(task.skill_id);
    if (!skill) throw new AppError('NOT_FOUND', `Skill ${task.skill_id} is not installed`);
    const cycle = (await db.get('close_cycle', task.close_cycle_id))!;
    if (cycle.status === 'closed') throw new AppError('PERIOD_LOCKED', `${cycle.period_key} is closed.`);
    if (by.trigger !== 'orchestrator') {
      if (!by.userId) throw new AppError('UNAUTHENTICATED', 'Sign in to run agents.');
      const actor = await loadActor(db, tenantId, by.userId);
      if (!hasPermission(actor, 'agent.run')) throw new AppError('FORBIDDEN', 'Your role cannot run agents.');
      if (task.owner_id !== by.userId && !hasPermission(actor, 'agent.orchestrate')) throw new AppError('FORBIDDEN', 'Only the task owner (or a close lead) can run this agent.');
    }
    const previous = await db.count('agent_run', { tenant_id: tenantId, close_task_id: task.id });
    const owner = task.owner_id;
    const delegated = await delegatedActorFor(db, tenantId, owner, skill);
    if (task.status === 'not_started' || task.status === 'blocked') await db.update('close_task', task.id, { status: 'in_progress', blocked_reason: null });
    const result = await this.runtime.start({
      skillId: skill.id,
      input: (task.skill_input ?? {}) as Record<string, unknown>,
      requestedBy: owner,
      actor: delegated,
      entityId: task.entity_id,
      periodKey: cycle.period_key,
      taskId: task.id,
      parentRunId: by.parentRunId ?? null,
      idempotencyKey: `task:${task.id}:${previous + 1}`,
      trigger: by.trigger ?? 'manual',
      brain: by.brain,
    });
    await syncTaskFromRuns(this.ctx(null), task.id);
    return result;
  }

  /** One orchestration wave: start every task whose dependencies are satisfied. */
  async dispatchWave(parentRun: RunRecord): Promise<OrchestrationReport> {
    const periodKey = parentRun.periodKey ?? (await currentPeriodKey(this.ctx(null)));
    const port: OrchestratorPort = {
      loadTasks: () => orchTasks(this.ctx(null), periodKey),
      runTask: async (t) => {
        const r = await this.runTask(t.id, { userId: parentRun.requestedBy, parentRunId: parentRun.id, trigger: 'orchestrator' });
        return { status: r.run.status, pending: r.proposals.filter((p) => p.status === 'pending' || p.status === 'suggested').length, summary: r.run.summary ?? r.run.error };
      },
    };
    return advance(port, { concurrency: this.opts.concurrency ?? 3, maxWaves: 1 });
  }

  /** Run (or continue) the whole close calendar via the close-orchestrator skill. */
  async orchestrate(periodKey: string | null, userId: string): Promise<RunResult> {
    const { db, tenantId } = this.opts;
    const actor = await loadActor(db, tenantId, userId);
    if (!hasPermission(actor, 'agent.orchestrate')) throw new AppError('FORBIDDEN', 'Your role cannot run the whole close; run the agents for your own tasks instead.');
    const period = periodKey ?? (await currentPeriodKey(this.ctx(actor)));
    const cycle = await db.findOne('close_cycle', { tenant_id: tenantId, period_key: period });
    if (!cycle) throw new AppError('NOT_FOUND', `No close calendar for ${period}`);
    if (cycle.status === 'closed') throw new AppError('PERIOD_LOCKED', `${period} is closed.`);
    if (this.orchestrating.has(period)) throw new AppError('CONFLICT', 'The close agents are already running for this period.');
    this.orchestrating.add(period);
    try {
      const skill = this.skills.get('close-orchestrator')!;
      const n = await db.count('agent_run', { tenant_id: tenantId, skill_id: skill.id, period_key: period });
      if (cycle.status === 'not_started') await db.update('close_cycle', cycle.id, { status: 'in_progress', started_at: this.opts.clock.nowIso() });
      return await this.runtime.start({
        skillId: skill.id,
        input: { periodKey: period },
        requestedBy: userId,
        actor: await delegatedActorFor(db, tenantId, userId, skill),
        periodKey: period,
        idempotencyKey: `orchestrate:${period}:${n + 1}`,
        trigger: 'manual',
        brain: this.offline,
      });
    } finally {
      this.orchestrating.delete(period);
    }
  }

  /** True when at least one agent task is ready to run (used to continue after approvals). */
  async hasReadyTasks(periodKey: string): Promise<boolean> {
    return eligible(await orchTasks(this.ctx(null), periodKey)).length > 0;
  }

  /** Approve or reject one or more proposals; each is decided independently. */
  async decide(input: { proposalIds: string[]; decision: 'approve' | 'reject'; reason?: string | null; userId: string; background?: boolean }): Promise<{ results: DecisionOutcome[]; continued: RunResult | null; continuing: boolean }> {
    const actor = await humanDelegate(this.opts.db, this.opts.tenantId, input.userId);
    const results: DecisionOutcome[] = [];
    for (const id of input.proposalIds) {
      try {
        const r = await decideProposal(this.runtime, { proposalId: id, decision: input.decision, reason: input.reason ?? null, actor });
        results.push({ proposalId: id, ok: true, status: r.proposal.status });
      } catch (e) {
        const code = e instanceof AppError ? e.code : e instanceof DecisionError ? e.code : 'INTERNAL';
        results.push({ proposalId: id, ok: false, error: e instanceof Error ? e.message : String(e), code });
      }
    }
    let continued: RunResult | null = null;
    let continuing = false;
    if (results.some((r) => r.ok)) {
      const ctx = this.ctx(null);
      const s = await settings(ctx);
      const period = await currentPeriodKey(ctx);
      const user = await loadActor(this.opts.db, this.opts.tenantId, input.userId);
      if (s.autoContinue && hasPermission(user, 'agent.orchestrate')) {
        if (input.background) {
          // Continue in the background; a run already in progress re-checks when it finishes.
          if (this.background.has(period) || (await this.hasReadyTasks(period))) continuing = (await this.startOrchestration(period, input.userId).catch(() => null)) !== null;
        } else if (await this.hasReadyTasks(period)) {
          continued = await this.orchestrate(period, input.userId).catch(() => null);
        }
      }
    }
    return { results, continued, continuing };
  }

  /**
   * Start the close agents without waiting for them (the server UI polls activity()).
   * Checks permissions and the period first, so errors still reach the caller. If agents are
   * already running for the period, the request is remembered and they run again afterwards.
   */
  async startOrchestration(periodKey: string | null, userId: string): Promise<{ started: boolean; queued: boolean; periodKey: string }> {
    const { db, tenantId } = this.opts;
    const actor = await loadActor(db, tenantId, userId);
    if (!hasPermission(actor, 'agent.orchestrate')) throw new AppError('FORBIDDEN', 'Your role cannot run the whole close; run the agents for your own tasks instead.');
    const period = periodKey ?? (await currentPeriodKey(this.ctx(actor)));
    const cycle = await db.findOne('close_cycle', { tenant_id: tenantId, period_key: period });
    if (!cycle) throw new AppError('NOT_FOUND', `No close calendar for ${period}`);
    if (cycle.status === 'closed') throw new AppError('PERIOD_LOCKED', `${period} is closed.`);
    const running = this.background.get(period);
    if (running) {
      running.again = userId;
      return { started: false, queued: true, periodKey: period };
    }
    const entry: BackgroundRun = { startedAt: this.opts.clock.nowIso(), startedBy: userId, again: null, promise: Promise.resolve() };
    this.background.set(period, entry);
    entry.promise = (async () => {
      let by: string | null = userId;
      try {
        while (by) {
          entry.again = null;
          const r: RunResult = await this.orchestrate(period, by);
          this.lastBackground.set(period, { finishedAt: this.opts.clock.nowIso(), status: r.run.status, summary: r.run.summary ?? null, runId: r.run.id, error: r.run.error ?? null });
          const next: string | null = entry.again;
          by = next && (await this.hasReadyTasks(period)) ? next : null;
        }
      } catch (e) {
        this.lastBackground.set(period, { finishedAt: this.opts.clock.nowIso(), status: 'failed', summary: null, runId: null, error: e instanceof Error ? e.message : String(e) });
        this.opts.onBackgroundError?.(e);
      } finally {
        this.background.delete(period);
      }
    })();
    return { started: true, queued: false, periodKey: period };
  }

  activity(periodKey: string): AgentActivity {
    const bg = this.background.get(periodKey);
    return { running: !!bg || this.orchestrating.has(periodKey), startedAt: bg?.startedAt ?? null, startedBy: bg?.startedBy ?? null, last: this.lastBackground.get(periodKey) ?? null };
  }

  /** Resolves when no background agent work is in flight (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background.values()].map((b) => b.promise));
  }

  async review(proposalId: string, userId: string, note?: string | null) {
    return reviewProposal(this.runtime, { proposalId, actor: await humanDelegate(this.opts.db, this.opts.tenantId, userId), note: note ?? null });
  }

  /** Resume runs interrupted by a crash or restart (idempotent: recorded tool calls replay). */
  async resumeInterrupted(): Promise<RunResult[]> {
    return this.runtime.resumeAll(async (run) => delegatedActorFor(this.opts.db, this.opts.tenantId, run.requestedBy, this.skills.get(run.skillId)!));
  }
}
