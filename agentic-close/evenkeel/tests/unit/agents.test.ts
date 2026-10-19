import type Anthropic from '@anthropic-ai/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MessagesClient } from '../../src/framework/llm/anthropic-brain';
import { SimulatedCrash } from '../../src/framework/runtime/runtime';
import type { Brain } from '../../src/framework/runtime/types';
import { AgentEngine } from '../../src/packs/accounting/agents/engine';
import { delegatedActorFor } from '../../src/packs/accounting/agents/context';
import { SCENARIO } from '../../src/packs/accounting/seed/scenario';
import { loadSkillsFromDisk } from '../../src/server/skills-fs';
import { expectSingleApplication } from '../shared/decisions';
import { loadTestScenario, type Scenario } from '../shared/scenario';

async function task(s: Scenario, code: string) {
  const cycle = (await s.db.findOne('close_cycle', { tenant_id: s.info.tenantId, period_key: SCENARIO.openPeriod }))!;
  return (await s.db.findOne('close_task', { close_cycle_id: cycle.id, code }))!;
}

describe('durable agent runs', () => {
  it('resumes a crashed run by replaying recorded tool calls, without duplicating proposals', async () => {
    const clean = await loadTestScenario();
    const cleanRun = await clean.engine.runTask((await task(clean, 'T03')).id, { userId: clean.user('casey') });
    expect(cleanRun.proposals.length).toBeGreaterThan(3);

    const s = await loadTestScenario({ engine: { faults: { crashAfterToolCalls: 3 } } });
    const t = await task(s, 'T03');
    await expect(s.engine.runTask(t.id, { userId: s.user('casey') })).rejects.toBeInstanceOf(SimulatedCrash);
    const stuck = await s.db.find('agent_run', { tenant_id: s.info.tenantId, close_task_id: t.id });
    expect(stuck.map((r) => r.status)).toEqual(['running']);

    // A fresh process (no fault injection) picks the run up where it stopped.
    const restarted = new AgentEngine({ db: s.db, tenantId: s.info.tenantId, clock: s.clock, skills: loadSkillsFromDisk() });
    const resumed = await restarted.resumeInterrupted();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.replayed).toBe(true);
    expect(['completed', 'awaiting_approval']).toContain(resumed[0]!.run.status);
    expect(resumed[0]!.proposals.map((p) => p.title).sort()).toEqual(cleanRun.proposals.map((p) => p.title).sort());
    const calls = await s.db.find('tool_call', { run_id: stuck[0]!.id });
    expect(new Set(calls.map((c) => c.idempotency_key)).size).toBe(calls.length);
  }, 120_000);
});

describe('guardrails', () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await loadTestScenario();
    await s.engine.orchestrate(null, s.user('casey'));
  }, 120_000);

  it('routes instruction-like bank text to a person and never auto-posts it', async () => {
    const flagged = await s.db.find('proposal', { tenant_id: s.info.tenantId, injection_flag: true });
    expect(flagged.length).toBeGreaterThan(0);
    for (const p of flagged) expect(['pending', 'suggested']).toContain(p.status);
    // The bank-rec agent proposes an exception and a suspense entry, both held for a person.
    expect(new Set(flagged.map((p) => p.kind))).toEqual(new Set(['issue', 'journal_entry', 'reconciling_item']));
    expect(flagged.find((p) => p.kind === 'issue')!.payload).toMatchObject({ category: 'prompt_injection' });
    const gate = (flagged[0]!.verification as { gate?: { reasons: string[] } }).gate!;
    expect(gate.reasons.join(' ')).toMatch(/instruction-like/);
  });

  it('enforces maker-checker: whoever the agent worked for cannot approve its proposals', async () => {
    const t05 = await task(s, 'T05');
    const runs = await s.db.find('agent_run', { close_task_id: t05.id });
    const pending = (await s.db.find('proposal', { run_id: { in: runs.map((r) => r.id) }, status: 'pending' }))[0];
    if (pending) {
      const own = await s.engine.decide({ proposalIds: [pending.id], decision: 'approve', userId: s.user('priya') });
      expect(own.results[0]).toMatchObject({ ok: false });
      expect(own.results[0]!.error).toMatch(/SOD-0[12]/);
    }
    const anyPending = (await s.db.find('proposal', { tenant_id: s.info.tenantId, status: 'pending' }))[0]!;
    const auditor = await s.engine.decide({ proposalIds: [anyPending.id], decision: 'approve', userId: s.user('alex') });
    expect(auditor.results[0]!.ok).toBe(false);
  });

  it('holds material items for a controller or CFO', async () => {
    const material = await s.db.find('proposal', { tenant_id: s.info.tenantId, materiality: 'material' });
    expect(material.length).toBeGreaterThan(0);
    for (const p of material) expect(p.status).not.toBe('auto_applied');
  });

  it('denies tools outside the skill manifest and stops at the step budget', async () => {
    const t02 = await task(s, 'T02');
    const actor = await delegatedActorFor(s.db, s.info.tenantId, s.user('sam'), s.engine.skills.get('transaction-coding')!);
    const rogue: Brain = {
      engine: 'mock',
      model: null,
      async run(session) {
        await session.callTool('compute_depreciation', {});
      },
    };
    const denied = await s.engine.runtime.start({ skillId: 'transaction-coding', input: {}, requestedBy: s.user('sam'), actor, periodKey: SCENARIO.openPeriod, taskId: t02.id, idempotencyKey: 'test:rogue', brain: rogue });
    expect(denied.run.status).toBe('failed');
    expect(denied.run.error).toMatch(/denied/);

    const looping: Brain = {
      engine: 'mock',
      model: null,
      async run(session) {
        for (let i = 0; i < 1000; i++) await session.callTool('get_chart_of_accounts', { limit: i + 1 });
      },
    };
    const budget = await s.engine.runtime.start({ skillId: 'transaction-coding', input: {}, requestedBy: s.user('sam'), actor, periodKey: SCENARIO.openPeriod, taskId: t02.id, idempotencyKey: 'test:loop', brain: looping });
    expect(budget.run.status).toBe('budget_exceeded');
  }, 60_000);

  it('applies a proposal exactly once when two people approve it at the same moment', async () => {
    await expectSingleApplication(s);
  }, 60_000);
});

/** A scripted stand-in for client.beta.messages that records every request. */
class ScriptedMessages implements MessagesClient {
  readonly requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  constructor(private readonly script: ((req: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) => Partial<Anthropic.Beta.Messages.BetaMessage>)[]) {}
  async create(params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.Messages.BetaMessage> {
    this.requests.push(structuredClone(params));
    const next = this.script.shift();
    if (!next) throw new Error('script exhausted');
    return { id: `msg_${this.requests.length}`, type: 'message', role: 'assistant', model: params.model, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 150, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }, content: [], stop_reason: 'end_turn', ...next(params) } as Anthropic.Beta.Messages.BetaMessage;
  }
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use' as const, id, name, input, caller: undefined });

describe('live engine (Claude) with a scripted client', () => {
  it('drives typed tools, submits proposals through verification and records usage', async () => {
    const mock = new ScriptedMessages([
      () => ({ stop_reason: 'tool_use', content: [toolUse('tu1', 'get_close_context', {}), toolUse('tu2', 'list_foreign_currency_balances', {})] as never }),
      () => ({ stop_reason: 'tool_use', content: [toolUse('tu3', 'submit_proposal', { kind: 'journal_entry', key: 'bad', title: 'Revalue nothing', why: 'Testing that verification rejects malformed entries.', confidence: 0.5, payload: { lines: [] }, evidence: [{ kind: 'note', label: 'test' }] })] as never }),
      () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Checked the foreign-currency balances; nothing valid to post.', citations: null }] as never }),
    ]);
    const s = await loadTestScenario({ engine: { mode: 'live', messages: mock } });
    expect(s.engine.mode).toBe('live');
    const r = await s.engine.runTask((await task(s, 'T13')).id, { userId: s.user('casey') });
    expect(r.run.status).toBe('completed');
    expect(r.run.summary).toContain('Checked the foreign-currency balances');

    const first = mock.requests[0]!;
    expect(first.model).toMatch(/^claude-/);
    expect((first.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(first).not.toHaveProperty('thinking');
    expect(first.output_config?.effort).toBeDefined();
    const toolNames = (first.tools ?? []).map((t) => ('name' in t ? t.name : ''));
    expect(toolNames).toContain('submit_proposal');
    expect(toolNames).not.toContain('dispatch_ready_tasks');

    // Both tool results go back in one user message, wrapped as trusted/untrusted data.
    const second = mock.requests[1]!;
    const last = second.messages[second.messages.length - 1]!;
    expect(last.role).toBe('user');
    const blocks = last.content as { type: string; content: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'tool_result']);
    expect(blocks[0]!.content).toMatch(/^<tool_output tool="get_close_context" trust="(system|untrusted)">/);

    // The malformed proposal was rejected by deterministic verification, not posted.
    const third = mock.requests[2]!;
    const verdict = (third.messages[third.messages.length - 1]!.content as { content: string }[])[0]!.content;
    expect(verdict).toMatch(/"status":"failed"/);
    const run = (await s.db.get('agent_run', r.run.id))!;
    expect(run.engine).toBe('anthropic');
    expect(run.input_tokens).toBeGreaterThan(0);
    expect(run.cost_micros).toBeGreaterThan(0);
  }, 120_000);

  it('stops safely when the model declines', async () => {
    const mock = new ScriptedMessages([() => ({ stop_reason: 'refusal', content: [] })]);
    const s = await loadTestScenario({ engine: { mode: 'live', messages: mock } });
    const r = await s.engine.runTask((await task(s, 'T13')).id, { userId: s.user('casey') });
    expect(r.run.status).toBe('failed');
    expect(r.run.error).toMatch(/declined/);
    expect(r.proposals).toEqual([]);
  }, 120_000);
});
