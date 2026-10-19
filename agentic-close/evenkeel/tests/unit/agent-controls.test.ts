import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { MessagesClient } from '../../src/framework/llm/anthropic-brain';
import { gate } from '../../src/framework/runtime/autonomy';
import type { Assessment, ProposalDraft, SkillPolicy } from '../../src/framework/runtime/types';
import { makeContext } from '../../src/packs/accounting/domain/context';
import { loadActor } from '../../src/packs/accounting/domain/rbac';
import { accountByCode, departmentByCode, entityByCode } from '../../src/packs/accounting/domain/refdata';
import { SCENARIO } from '../../src/packs/accounting/seed/scenario';
import { listProposals } from '../../src/packs/accounting/services/inbox';
import { loadTestScenario, type Scenario } from '../shared/scenario';

/**
 * Agent controls the server enforces whatever drafted the proposal: amounts and materiality
 * computed from the payload (EK-C1), injection and policy-rule holds for live drafts (EK-M3),
 * the launcher recorded as requester (EK-M1) and no bulk approval of flagged items (E-5).
 */

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** A scripted model: submits the given proposals (read when it first runs) in one turn, then finishes. */
function scriptedModel(submissions: Record<string, unknown>[] = []): MessagesClient & { results: string[]; submissions: Record<string, unknown>[] } {
  let turn = 0;
  const results: string[] = [];
  return {
    results,
    submissions,
    async create(params: Params) {
      turn++;
      const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const base = { id: `msg_${turn}`, type: 'message', role: 'assistant', model: params.model, stop_sequence: null, usage };
      if (turn === 1) return { ...base, stop_reason: 'tool_use', content: submissions.map((input, i) => ({ type: 'tool_use', id: `tu_${i}`, name: 'submit_proposal', input })) } as unknown as Anthropic.Beta.Messages.BetaMessage;
      const last = params.messages[params.messages.length - 1]!;
      for (const b of last.content as { content?: string }[]) results.push(String(b.content));
      return { ...base, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Submitted.', citations: null }] } as unknown as Anthropic.Beta.Messages.BetaMessage;
    },
  };
}

async function taskId(s: Scenario, code: string): Promise<string> {
  const cycle = (await s.db.findOne('close_cycle', { tenant_id: s.info.tenantId, period_key: SCENARIO.openPeriod }))!;
  return (await s.db.findOne('close_task', { close_cycle_id: cycle.id, code }))!.id;
}

async function ctxOf(s: Scenario) {
  return makeContext(s.db, s.info.tenantId, await loadActor(s.db, s.info.tenantId, s.user('casey')), s.clock);
}

/** The payroll accrual from the engineering review: $161,402.32 into 2110, reversing on 1 October. */
async function payrollAccrual(s: Scenario) {
  const ctx = await ctxOf(s);
  const us = await entityByCode(ctx, 'US');
  return {
    entityId: us.id,
    entryDate: '2026-09-30',
    periodKey: SCENARIO.openPeriod,
    entryType: 'accrual',
    memo: 'Accrue payroll earned 16–30 September',
    currency: 'USD',
    autoReverseDate: '2026-10-01',
    lines: [
      { accountId: (await accountByCode(ctx, '6000')).id, debit: 16_140_232, credit: 0, departmentId: (await departmentByCode(ctx, 'ENG')).id },
      { accountId: (await accountByCode(ctx, '2110')).id, debit: 0, credit: 16_140_232 },
    ],
  };
}

const evidence = [{ kind: 'record', label: 'Payroll run 2026-09-01 – 2026-09-15', detail: 'semi-monthly; second half unpaid' }];

describe('agent controls in live (Claude) mode, with a scripted client', () => {
  it('EK-C1: computes the amount from the entry lines, so a declared null amount cannot auto-post', async () => {
    const model = scriptedModel();
    const live = await loadTestScenario({ engine: { mode: 'live', messages: model } });
    expect(live.engine.mode).toBe('live');
    model.submissions.push({ kind: 'journal_entry', key: 'payroll-null', title: 'Accrue unpaid payroll', why: 'Payroll for the second half of the month was earned but not yet paid at month end.', confidence: 0.97, amount: null, payload: await payrollAccrual(live), evidence });
    const r = await live.engine.runTask(await taskId(live, 'T07'), { userId: live.user('sam') });
    const p = r.proposals.find((x) => x.idempotencyKey.endsWith('llm:payroll-null'))!;
    expect(p.amount).toBe(16_140_232);
    expect(p.materiality).toBe('below_performance');
    expect(p.status).toBe('pending');
    expect(p.verification.gate?.decision).toBe('await_approval');
    expect(p.verification.gate?.codes).toContain('threshold');
    expect(await live.db.count('journal_entry', { proposal_id: p.id })).toBe(0);
  }, 120_000);

  it('EK-C1: verification compares a declared amount with the lines and refuses a mismatch', async () => {
    const submit = scriptedModel();
    const s = await loadTestScenario({ engine: { mode: 'live', messages: submit } });
    submit.submissions.push({ kind: 'journal_entry', key: 'payroll-lie', title: 'Accrue unpaid payroll', why: 'Payroll for the second half of the month was earned but not yet paid at month end.', confidence: 0.97, amount: 100, payload: await payrollAccrual(s), evidence });
    const r = await s.engine.runTask(await taskId(s, 'T07'), { userId: s.user('sam') });
    const p = r.proposals.find((x) => x.idempotencyKey.endsWith('llm:payroll-lie'))!;
    expect(p.status).toBe('failed');
    const amount = p.verification.checks.find((c) => c.id === 'amount')!;
    expect(amount).toMatchObject({ ok: false, severity: 'error' });
    expect(amount.detail).toMatch(/stated \$1\.00; the lines total \$161,402\.32/);
    expect(submit.results.join(' ')).toContain('"status":"failed"');
    expect(await s.db.count('journal_entry', { proposal_id: p.id })).toBe(0);
  }, 120_000);

  it('EK-C1: holds a money-moving item whose amount cannot be computed, and treats it as material', () => {
    const policy: SkillPolicy = { version: 1, autonomy: 'L3', enabled: true, thresholds: {}, rules: [], autoPostBelow: 250_000, minConfidence: 0.5, sampleRate: 0 };
    const draft: ProposalDraft = { key: 'k', kind: 'coding', title: 'Code a card charge', why: 'because it is software', confidence: 0.99, amount: null, payload: {}, evidence: [] };
    const unknown: Assessment = { amount: null, currency: 'USD', monetary: true, amountReporting: 0, materiality: 'material', performanceMateriality: 22_500_000, requiresRole: 'controller', holds: [{ code: 'amount_unknown', reason: 'The amount could not be computed.' }], injectionSuspected: false };
    const g = gate(draft, { ok: true, checks: [] }, unknown, policy, []);
    expect(g.decision).toBe('await_approval');
    expect(g.codes).toEqual(expect.arrayContaining(['amount_unknown', 'material']));
    // Money-moving items always face the amount test at L2, zero threshold included.
    const zero: Assessment = { ...unknown, amount: 0, amountReporting: 0, materiality: 'trivial', requiresRole: null, holds: [] };
    expect(gate(draft, { ok: true, checks: [] }, zero, { ...policy, autonomy: 'L2', autoPostBelow: 0 }, []).decision).toBe('await_approval');
  });

  it('EK-M3: flags a live proposal that acts on a bank line carrying instructions, and never auto-posts it', async () => {
    const submit = scriptedModel();
    const s = await loadTestScenario({ engine: { mode: 'live', messages: submit } });
    const wire = (await s.db.find('bank_transaction', { tenant_id: s.info.tenantId })).find((t) => /IGNORE PRIOR INSTRUCTIONS/.test(t.description))!;
    const cash = (await s.db.find('account', { tenant_id: s.info.tenantId, code: '1000' }))[0]!;
    const rec = (await s.db.find('reconciliation', { tenant_id: s.info.tenantId, period_key: SCENARIO.openPeriod, account_id: cash.id }))[0]!;
    const item = { reconciliationId: rec.id, itemType: 'unexplained', side: 'bank', amount: wire.amount, description: 'Outgoing wire FED7781, cleared by the bank', originDate: wire.posted_date, expectedClearDate: null, sourceRefs: [{ type: 'bank_transaction', id: wire.id }] };
    // A model that was talked into treating the wire as routine: confident, no flags of its own.
    submit.submissions.push({ kind: 'reconciling_item', key: 'wire', title: 'Timing item: wire FED7781', why: 'The wire is a routine payment already authorised by treasury.', confidence: 0.99, amount: Math.abs(wire.amount), payload: item, evidence: [{ kind: 'record', label: 'Statement line 2026-09-18', detail: 'routine treasury payment' }] });
    const r = await s.engine.runTask(await taskId(s, 'T03'), { userId: s.user('sam') });
    const p = r.proposals.find((x) => x.idempotencyKey.endsWith('llm:wire'))!;
    expect(p.injectionFlag).toBe(true);
    expect(p.status).toBe('pending');
    expect(p.verification.gate?.codes).toContain('untrusted_text');
    expect(p.verification.gate?.reasons.join(' ')).toMatch(/IGNORE PRIOR INSTRUCTIONS/i);
    expect(await s.db.count('reconciling_item', { proposal_id: p.id })).toBe(0);
  }, 120_000);

  it('EK-M3: applies the controller’s "never auto-post" rule to a live coding proposal', async () => {
    const submit = scriptedModel();
    const s = await loadTestScenario({ engine: { mode: 'live', messages: submit } });
    const ctx = await ctxOf(s);
    const gift = (await s.db.find('card_transaction', { tenant_id: s.info.tenantId })).find((t) => /gift cards/i.test(t.memo ?? ''))!;
    const coding = { subjectType: 'card_transaction', subjectId: gift.id, accountId: (await accountByCode(ctx, '6600')).id, departmentId: (await departmentByCode(ctx, 'CS')).id, treatment: 'expense', confidence: 0.99, basis: ['model'] };
    submit.submissions.push({ kind: 'coding', key: 'gift', title: 'Brightleaf Gift Co. $450.00 → 6600 Office Supplies', why: 'Small office purchase for the customer success team.', confidence: 0.99, amount: gift.amount, payload: coding, evidence: [{ kind: 'record', label: 'Brightleaf Gift Co. $450.00' }] });
    const r = await s.engine.runTask(await taskId(s, 'T02'), { userId: s.user('sam') });
    const p = r.proposals.find((x) => x.idempotencyKey.endsWith('llm:gift'))!;
    expect(p.status).toBe('pending');
    expect(p.verification.gate?.codes).toContain('policy_rule');
    expect(p.verification.gate?.reasons.join(' ')).toMatch(/Never auto-post when memo contains “gift”/);
    expect((await s.db.get('card_transaction', gift.id))!.status).not.toBe('posted');
  }, 120_000);
});

describe('who may approve, and how', () => {
  it('EK-M1: records whoever started the run as its requester, and that person cannot approve its output', async () => {
    const s = await loadTestScenario();
    // Casey (controller) runs the agent for Sam's bank reconciliation.
    const r = await s.engine.runTask(await taskId(s, 'T03'), { userId: s.user('casey') });
    expect(r.run.requestedBy).toBe(s.user('casey'));
    const pending = r.proposals.filter((p) => p.status === 'pending' && p.materiality !== 'material');
    expect(pending.length).toBeGreaterThan(0);
    const mine = await s.engine.decide({ proposalIds: [pending[0]!.id], decision: 'approve', userId: s.user('casey') });
    expect(mine.results[0]).toMatchObject({ ok: false, code: 'SOD_VIOLATION' });
    expect(mine.results[0]!.error).toMatch(/SOD-02/);
    // Sam owns the task (SOD-01); Priya neither started nor owns it.
    expect((await s.engine.decide({ proposalIds: [pending[0]!.id], decision: 'approve', userId: s.user('sam') })).results[0]!.ok).toBe(false);
    expect((await s.engine.decide({ proposalIds: [pending[0]!.id], decision: 'approve', userId: s.user('priya') })).results[0]).toMatchObject({ ok: true });
    // Running the close (here continued by Priya's approval) makes its launcher the requester of
    // every task run it dispatches, whoever owns the task.
    await s.engine.orchestrate(null, s.user('casey'));
    const runs = await s.db.find('agent_run', { tenant_id: s.info.tenantId, trigger: 'orchestrator' });
    expect(runs.length).toBeGreaterThan(3);
    for (const run of runs) expect(run.requested_by).toBe((await s.db.get('agent_run', run.parent_run_id!))!.requested_by);
    const owners = await s.db.find('close_task', { id: { in: runs.map((x) => x.close_task_id!) } });
    expect(owners.some((t) => !runs.some((x) => x.close_task_id === t.id && x.requested_by === t.owner_id))).toBe(true);
  }, 120_000);

  it('E-5: "select all" and bulk approval leave out flagged and low-confidence items', async () => {
    const s = await loadTestScenario();
    await s.engine.orchestrate(null, s.user('casey'));
    const priya = makeContext(s.db, s.info.tenantId, await loadActor(s.db, s.info.tenantId, s.user('priya')), s.clock);
    const mine = (await listProposals(priya, { tab: 'mine', limit: 500 })).items;
    const flagged = mine.filter((p) => p.injectionFlag || p.confidence < (p.gate?.minConfidence ?? 0));
    expect(flagged.length).toBeGreaterThan(0);
    for (const p of flagged) expect(p.canBulkApprove).toMatchObject({ ok: false });
    const routine = mine.filter((p) => p.canBulkApprove.ok);
    expect(routine.length).toBeGreaterThan(0);
    // The server refuses them in a bulk decision even if a client sends them…
    const ids = [...routine.slice(0, 2), ...flagged].map((p) => p.id);
    const bulk = await s.engine.decide({ proposalIds: ids, decision: 'approve', userId: s.user('priya') });
    for (const p of flagged) expect(bulk.results.find((x) => x.proposalId === p.id)).toMatchObject({ ok: false, code: 'REVIEW_INDIVIDUALLY' });
    for (const p of routine.slice(0, 2)) expect(bulk.results.find((x) => x.proposalId === p.id)).toMatchObject({ ok: true });
    // …and a person who opens one approves it on its own.
    const one = await s.engine.decide({ proposalIds: [flagged[0]!.id], decision: 'approve', userId: s.user('priya') });
    expect(one.results[0]).toMatchObject({ ok: true });
  }, 120_000);
});
