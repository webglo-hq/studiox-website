import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, SimulatedCrash } from '../../src/core/agent/runtime';
import { resolveUserActor } from '../../src/core/auth/actor';
import { ScriptedProvider, toolUse } from '../../src/core/llm/scripted';
import type { LlmProvider } from '../../src/core/llm/types';
import type { MemoryStore } from '../../src/core/store/memory';
import { scenarioClock } from '../../src/core/util/time';
import { accountingPack } from '../../src/packs/accounting/agent/pack';
import { bramblewoodFixture, type EvalFixture } from '../../src/packs/accounting/evals/harness';
import { SCENARIO } from '../../src/packs/accounting/seed/company';
import { accountingSkills } from '../../src/packs/accounting/skills/install';

let fx: EvalFixture;
const P = SCENARIO.closeKey;
const clock = scenarioClock(SCENARIO.businessDate);

beforeAll(async () => {
  fx = await bramblewoodFixture();
}, 120_000);
beforeEach(async () => {
  await (fx.db as unknown as MemoryStore<unknown>).restore(fx.snapshot);
});

function runtime(extra: { faults?: { crashAfterAction?: number }; llm?: LlmProvider | null } = {}) {
  return new AgentRuntime({ db: fx.db, clock, pack: accountingPack, skills: accountingSkills(), llm: extra.llm ?? null, resolveActor: resolveUserActor, faults: extra.faults });
}
const user = (k: string) => fx.userIds.get(k)!;
const entity = (c: string) => fx.entityIds.get(c)!;
const proposals = (runId?: string) => fx.db.tx(fx.tenantId, (tx) => tx.find('proposals', runId ? { run_id: runId } : {}));

describe('durable agent runtime', () => {
  it('runs a skill end to end: plan → act → verify → propose → route → post → audit', async () => {
    const run = await runtime().start({ tenantId: fx.tenantId, skillKey: 'bank-reconciliation', entityId: entity('BWL-US'), periodKey: P, requestedBy: user('jordan') });
    expect(run.status).toBe('succeeded');
    const steps = await fx.db.tx(fx.tenantId, (tx) => tx.find('agent_steps', { run_id: run.id }));
    const phases = new Set(steps.map((s) => s.phase));
    for (const p of ['plan', 'act', 'verify', 'propose', 'route', 'summarize']) expect(phases.has(p as never), p).toBe(true);
    const rows = await proposals(run.id);
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.every((r) => r.why.length > 10 && r.evidence.length > 0 && r.confidence > 0)).toBe(true);
    expect(rows.some((r) => r.status === 'applied' && r.route === 'auto_post_sampled')).toBe(true); // L2 policy applied small exact matches
  });

  it('is idempotent: the same request never runs or proposes twice', async () => {
    const req = { tenantId: fx.tenantId, skillKey: 'transaction-coding', entityId: entity('BWL-US'), periodKey: P, requestedBy: user('sam'), idempotencyKey: 'test:coding:once' };
    const a = await runtime().start(req);
    const before = (await proposals()).length;
    const b = await runtime().start(req);
    expect(b.id).toBe(a.id);
    expect((await proposals()).length).toBe(before);
    // a second, separately requested run re-uses each proposal's dedupe key instead of duplicating
    const c = await runtime().start({ ...req, idempotencyKey: 'test:coding:again' });
    expect(c.id).not.toBe(a.id);
    expect(c.summary.duplicates).toBeGreaterThan(0);
    expect((await proposals()).length).toBe(before);
  });

  it('resumes a crashed run from its last recorded step without duplicating work', async () => {
    const clean = await runtime().start({ tenantId: fx.tenantId, skillKey: 'accrual-detection', entityId: entity('BWL-US'), periodKey: P, requestedBy: user('jordan') });
    const cleanCount = (await proposals(clean.id)).length;
    await (fx.db as unknown as MemoryStore<unknown>).restore(fx.snapshot);

    const crashy = runtime({ faults: { crashAfterAction: 5 } }); // after the first proposals are persisted
    const created = await crashy.createRun({ tenantId: fx.tenantId, skillKey: 'accrual-detection', entityId: entity('BWL-US'), periodKey: P, requestedBy: user('jordan') });
    await expect(crashy.execute(fx.tenantId, created.id)).rejects.toBeInstanceOf(SimulatedCrash);
    const mid = await fx.db.tx(fx.tenantId, (tx) => tx.get('agent_runs', created.id));
    expect(mid?.status).toBe('running');

    const resumedIds = await runtime().recoverStale(fx.tenantId, -1);
    expect(resumedIds).toContain(created.id);
    const done = await fx.db.tx(fx.tenantId, (tx) => tx.get('agent_runs', created.id));
    expect(done?.status).toBe('succeeded');
    expect(done?.attempts).toBe(2);
    const rows = await proposals(created.id);
    expect(rows.length).toBe(cleanCount);
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(rows.length);
  });

  it('stops at its budget and says so', async () => {
    const rt = runtime();
    const run = await rt.createRun({ tenantId: fx.tenantId, skillKey: 'bank-reconciliation', entityId: entity('BWL-US'), periodKey: P, requestedBy: user('jordan') });
    await fx.db.tx(fx.tenantId, (tx) => tx.update('agent_runs', run.id, { budget: { ...run.budget, maxToolCalls: 2 } }));
    const out = await rt.execute(fx.tenantId, run.id);
    expect(out.status).toBe('budget_exceeded');
    expect(out.summary.headline).toMatch(/Tool-call budget/);
  });

  it('enforces least privilege on who may run agents', async () => {
    await expect(runtime().createRun({ tenantId: fx.tenantId, skillKey: 'bank-reconciliation', entityId: entity('BWL-US'), periodKey: P, requestedBy: user('alex') })).rejects.toThrow(/permission to run agents/);
  });

  it('routes anything with instruction-like third-party text to a person and withholds the text', async () => {
    const run = await runtime().start({ tenantId: fx.tenantId, skillKey: 'bank-reconciliation', entityId: entity('BWL-US'), periodKey: P, requestedBy: user('jordan') });
    expect(run.summary.injectionFlags).toBeGreaterThan(0);
    const flagged = (await proposals(run.id)).filter((p) => p.flags.includes('injection_suspected'));
    expect(flagged.length).toBeGreaterThan(0);
    for (const p of flagged) {
      expect(p.status).toBe('pending_approval');
      expect(`${p.title} ${p.why}`).not.toMatch(/ignore (all )?previous|auto-?approve/i);
    }
  });
});

describe('live mode (Claude tool use), with a scripted provider', () => {
  it('drives the same tools, wraps tool output as untrusted data, verifies proposals and meters cost', async () => {
    const llm = new ScriptedProvider([
      toolUse('tu_1', 'close__status', { periodKey: P }),
      toolUse('tu_2', 'propose__finding', {
        title: 'Duplicate rent payment needs review',
        why: 'Two payments with the same amount and reference went to the landlord in September.',
        confidence: 0.8,
        evidence: [{ kind: 'computation', label: 'Same amount and reference on two payments' }],
        dedupeKey: 'live-test:dup-rent',
        finding: { entityId: entity('BWL-US'), periodKey: P, category: 'duplicate_payment', severity: 'high', recommendation: 'Confirm with AP and request a refund if it is a duplicate.', subjects: [{ type: 'vendor', id: 'v-test', label: 'Landlord' }] },
      }),
      toolUse('tu_3', 'finish', { headline: 'Reviewed the close status and raised one finding', notes: [] }),
    ]);
    const run = await runtime({ llm }).start({ tenantId: fx.tenantId, skillKey: 'bank-reconciliation', entityId: entity('BWL-US'), periodKey: P, requestedBy: user('jordan'), mode: 'live' });
    expect(run.status).toBe('succeeded');
    expect(run.mode).toBe('live');
    expect(run.model).toBe('claude-sonnet-5-5');
    expect(run.cost_micros).toBeGreaterThan(0);
    expect(run.summary.headline).toBe('Reviewed the close status and raised one finding');

    const first = llm.requests[0]!;
    expect(first.system).toContain('untrusted_data');
    expect(first.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['close__status', 'propose__finding', 'finish']));
    expect(first.tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(['approve', 'post']));
    const toolResult = llm.requests[1]!.messages.at(-1)!.content[0] as { type: string; content: string };
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.content.startsWith('<untrusted_data source="close.status">')).toBe(true);

    const rows = await proposals(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'finding', status: 'pending_approval' });
    const transcript = await fx.db.tx(fx.tenantId, (tx) => tx.find('agent_messages', { run_id: run.id }));
    expect(transcript.length).toBe(7); // task + 3 assistant turns + 3 tool results
  });

  it('turns a model refusal into a clear, failed run', async () => {
    const llm = new ScriptedProvider([{ content: [{ type: 'text', text: 'I cannot help with that.' }], stopReason: 'refusal', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'claude-sonnet-5-5' }]);
    const run = await runtime({ llm }).start({ tenantId: fx.tenantId, skillKey: 'flux-analysis', entityId: entity('BWL-US'), periodKey: P, requestedBy: user('jordan'), mode: 'live' });
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/declined/);
  });
});
