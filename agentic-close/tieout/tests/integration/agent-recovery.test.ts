/**
 * The agent runtime under failure and in live mode (independent review, 2026-10-19): the server
 * resumes runs a crash left behind on its own; a resumed live run hands the model the result of the
 * call it actually made; and in live mode a card charge's amount and the Controller's never-auto
 * rules come from the record, never from what the model says. Live mode runs through the
 * ScriptedProvider seam (no network).
 */
import { describe, expect, it } from 'vitest';
import { startRunRecovery } from '../../src/app/recovery';
import { AgentRuntime, SimulatedCrash } from '../../src/core/agent/runtime';
import { resolveUserActor } from '../../src/core/auth/actor';
import { ScriptedProvider, toolUse } from '../../src/core/llm/scripted';
import type { LlmProvider } from '../../src/core/llm/types';
import { scenarioClock } from '../../src/core/util/time';
import { accountingPack } from '../../src/packs/accounting/agent/pack';
import { SCENARIO } from '../../src/packs/accounting/seed/company';
import { accountingSkills } from '../../src/packs/accounting/skills/install';
import { boot } from '../../src/server/bootstrap';
import { testApp, TEST_KEY, type TestApp } from '../support/app';

const P = SCENARIO.closeKey;
const clock = scenarioClock(SCENARIO.businessDate);

function runtime(t: TestApp, extra: { llm?: LlmProvider | null; faults?: { crashAfterAction?: number } } = {}) {
  return new AgentRuntime({ db: t.fx.db, clock, pack: accountingPack, skills: accountingSkills(), llm: extra.llm ?? null, resolveActor: resolveUserActor, faults: extra.faults });
}
const run = (t: TestApp, id: string) => t.fx.db.tx(t.fx.tenantId, async (tx) => (await tx.get('agent_runs', id))!);

async function waitFor(check: () => Promise<boolean>, ms = 20_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Start a run and kill it mid-way, as a crashed process would leave it. */
async function crashed(t: TestApp, skillKey: string, opts: { llm?: LlmProvider; mode?: 'live' | 'offline'; as?: string; afterAction?: number } = {}) {
  const rt = runtime(t, { llm: opts.llm, faults: { crashAfterAction: opts.afterAction ?? 5 } });
  const r = await rt.createRun({ tenantId: t.fx.tenantId, skillKey, entityId: t.fx.entityIds.get('BWL-US')!, periodKey: P, requestedBy: t.fx.userIds.get(opts.as ?? 'jordan')!, mode: opts.mode });
  await expect(rt.execute(t.fx.tenantId, r.id)).rejects.toBeInstanceOf(SimulatedCrash);
  expect((await run(t, r.id)).status).toBe('running');
  return r.id;
}

describe('crash recovery', () => {
  it('TO-M2: the server resumes runs a crash left behind, when it starts and then on its timer', async () => {
    const t = await testApp();
    const first = await crashed(t, 'accrual-detection');
    const recovery = startRunRecovery(t.ctx, { intervalMs: 50, staleMs: -1 });
    try {
      // the pass at start-up
      await waitFor(async () => (await run(t, first)).status === 'succeeded');
      // a run that crashes later is picked up by a later pass, with nobody asking
      const second = await crashed(t, 'schedule-rollforward');
      await waitFor(async () => (await run(t, second)).status === 'succeeded');
      expect((await run(t, first)).attempts).toBe(2);
      expect((await run(t, second)).attempts).toBe(2);
      // and a run already resumed is not resumed again
      expect(await recovery.pass()).toEqual([]);
    } finally {
      recovery.stop();
    }
  });

  it('TO-M2: two servers (and a person pressing Resume) that find the same abandoned run resume it once', async () => {
    const t = await testApp();
    const id = await crashed(t, 'accrual-detection');
    const [a, b] = await Promise.all([runtime(t).recoverStale(t.fx.tenantId, -1), runtime(t).recoverStale(t.fx.tenantId, -1), runtime(t).resume(t.fx.tenantId, id)]);
    expect([...a, ...b].length).toBeLessThanOrEqual(1);
    expect(await run(t, id)).toMatchObject({ attempts: 2, status: 'succeeded' });
    const resumes = await t.fx.db.tx(t.fx.tenantId, (tx) => tx.count('audit_log', { action: 'agent.run.resume', subject_id: id }));
    expect(resumes).toBe(1);
  });

  it('TO-M2: the server boots with run recovery switched on', async () => {
    const booted = await boot({ env: { STORE: 'memory', SEED_DEMO: 'false', APP_ENCRYPTION_KEY: TEST_KEY }, log: () => undefined, recoverRuns: { intervalMs: 60_000 } });
    try {
      expect(booted.recovery).not.toBeNull();
      expect(await booted.recovery!.pass()).toEqual([]);
    } finally {
      await booted.close();
    }
  });
});

describe('live mode, through the scripted provider', () => {
  it('TO-M3: a resumed live run hands the model the result of the call it made, and replays a call it already made', async () => {
    const t = await testApp();
    const us = t.fx.entityIds.get('BWL-US')!;
    // attempt 1: the model reads the close status; the process dies right after that result is saved
    const id = await crashed(t, 'transaction-coding', { mode: 'live', as: 'sam', afterAction: 1, llm: new ScriptedProvider([toolUse('tu_1', 'close__status', { periodKey: P })]) });
    // attempt 2 (resumed by recovery): the model now asks for the uncoded card charges
    const llm = new ScriptedProvider([toolUse('tu_2', 'card__uncoded', { entityId: us, periodKey: P }), toolUse('tu_f', 'finish', { headline: 'Read the charges', notes: [] })]);
    expect(await runtime(t, { llm }).recoverStale(t.fx.tenantId, -1)).toEqual([id]);
    const handed = llm.requests[1]!.messages.at(-1)!.content[0] as { tool_use_id: string; content: string };
    expect(handed.tool_use_id).toBe('tu_2');
    expect(handed.content.startsWith('<untrusted_data source="card.uncoded">')).toBe(true);
    expect(handed.content).toContain('"merchant');
    const calls = await t.fx.db.tx(t.fx.tenantId, (tx) => tx.find('agent_tool_calls', { run_id: id }, { orderBy: [['seq', 'asc']] }));
    expect(calls.map((c) => [c.seq, c.tool, c.call_key])).toEqual([
      [1, 'close.status', 'tool_use:tu_1'],
      [2, 'card.uncoded', 'tool_use:tu_2'],
    ]);

    // a crash after a tool ran but before its result reached the transcript: resuming replays that
    // very call's recorded result instead of running it again
    const id2 = await crashed(t, 'transaction-coding', { mode: 'live', as: 'sam', afterAction: 1, llm: new ScriptedProvider([toolUse('tu_9', 'card__uncoded', { entityId: us, periodKey: P })]) });
    await t.fx.db.tx(t.fx.tenantId, async (tx) => {
      const last = (await tx.find('agent_messages', { run_id: id2 }, { orderBy: [['seq', 'desc']], limit: 1 }))[0]!;
      await tx.delete('agent_messages', last.id);
    });
    const llm2 = new ScriptedProvider([toolUse('tu_f', 'finish', { headline: 'Done', notes: [] })]);
    expect(await runtime(t, { llm: llm2 }).recoverStale(t.fx.tenantId, -1)).toEqual([id2]);
    const replayed = llm2.requests[0]!.messages.at(-1)!.content[0] as { tool_use_id: string; content: string };
    expect(replayed.tool_use_id).toBe('tu_9');
    expect(replayed.content).toContain('"merchant');
    expect(await t.fx.db.tx(t.fx.tenantId, (tx) => tx.count('agent_tool_calls', { run_id: id2 }))).toBe(1);
  });

  it("TO-M4: a card charge's amount and the Controller's never-auto rules come from the record, not the model", async () => {
    const t = await testApp();
    const us = t.fx.entityIds.get('BWL-US')!;
    const casey = t.client();
    expect((await casey.login('casey')).status).toBe(200);
    const pending = (await t.fx.db.tx(t.fx.tenantId, (tx) => tx.find('card_transactions', { status: 'pending_coding', entity_id: us }))).sort((a, b) => Math.abs(b.amount_minor) - Math.abs(a.amount_minor));
    const big = pending.find((x) => Math.abs(x.amount_minor) > 50_000)!; // above the $500 auto-post ceiling
    const small = pending.find((x) => x.amount_minor > 0 && x.amount_minor < 50_000 && /^[A-Za-z]{4,}/.test(x.merchant_name))!;
    const word = small.merchant_name.split(/\s+/)[0]!;
    const rule = await casey.post<{ interpretation?: string }>('/api/skills/transaction-coding/rules', { text: `Never auto-post ${word}` });
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);

    const coding = (id: string, txn: typeof big, amountMinor: number) =>
      toolUse(id, 'propose__coding', { title: `Code ${txn.merchant_name}`, why: 'Merchant history points to this account.', confidence: 0.95, evidence: [{ kind: 'record', label: `Card charge ${txn.merchant_name}`, refType: 'card_transaction', refId: txn.id }], dedupeKey: `live:${id}`, coding: { target: { kind: 'card_transaction', id: txn.id }, entityId: us, periodKey: P, accountCode: '6400', department: 'GA', amountMinor, merchant: txn.merchant_name, source: 'history' } });
    const llm = new ScriptedProvider([
      coding('tu_1', big, 100), // says the charge is $1.00
      coding('tu_2', big, big.amount_minor), // says it as it is: above the ceiling
      coding('tu_3', small, small.amount_minor), // within the ceiling, and leaves out the Controller's rule
      toolUse('tu_f', 'finish', { headline: 'Coded two charges', notes: [] }),
    ]);
    const r = await runtime(t, { llm }).start({ tenantId: t.fx.tenantId, skillKey: 'transaction-coding', entityId: us, periodKey: P, requestedBy: t.fx.userIds.get('sam')!, mode: 'live' });
    expect(r.status).toBe('succeeded');
    const refused = (llm.requests[1]!.messages.at(-1)!.content[0] as { content: string }).content;
    expect(refused).toContain('rejected_by_verifier');
    expect(refused).toContain('Amount matches the card charge: the charge is $');

    const rows = await t.fx.db.tx(t.fx.tenantId, (tx) => tx.find('proposals', { run_id: r.id }));
    expect(rows).toHaveLength(2);
    const forBig = rows.find((x) => (x.payload as { target: { id: string } }).target.id === big.id)!;
    const forSmall = rows.find((x) => (x.payload as { target: { id: string } }).target.id === small.id)!;
    expect(forBig).toMatchObject({ status: 'pending_approval', route: 'human_approval', amount_minor: Math.abs(big.amount_minor) });
    expect(forSmall).toMatchObject({ status: 'pending_approval', route: 'human_approval' });
    expect(forSmall.flags).toContain('policy_never_auto');
    expect(rows.every((x) => !x.applied_ref_id)).toBe(true);
    const still = await t.fx.db.tx(t.fx.tenantId, (tx) => tx.find('card_transactions', { id: { in: [big.id, small.id] } }));
    expect(still.every((x) => x.status === 'pending_coding')).toBe(true);
  });
});
