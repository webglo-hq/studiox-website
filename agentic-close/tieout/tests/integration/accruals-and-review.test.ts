/**
 * Two close skills against the accounting they model (independent review, 2026-10-19): the payroll
 * accrual prices an unpaid day at a tenth of a biweekly run (salaried staff are paid for ten days,
 * public holidays included), and an entry its own preparer approved is reversed until someone
 * independent has reviewed its support, not merely reported.
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR } from '../../src/core/audit/audit';
import { resolveUserActor } from '../../src/core/auth/actor';
import { AgentRuntime } from '../../src/core/agent/runtime';
import { ScriptedProvider, toolUse } from '../../src/core/llm/scripted';
import { scenarioClock } from '../../src/core/util/time';
import { accountingPack } from '../../src/packs/accounting/agent/pack';
import { isBusinessDay } from '../../src/packs/accounting/close/workdays';
import { SCENARIO } from '../../src/packs/accounting/seed/company';
import { AccountingServices } from '../../src/packs/accounting/services';
import { accountingSkills } from '../../src/packs/accounting/skills/install';
import { testApp, type HttpClient, type TestApp } from '../support/app';

const P = SCENARIO.closeKey;
const clock = scenarioClock(SCENARIO.businessDate);

interface Item {
  id: string;
  ref: string;
  kind: string;
  title: string;
  status: string;
  canDecide: boolean;
  blockedBy: string[];
}

async function signIn(t: TestApp, ...keys: string[]): Promise<HttpClient[]> {
  const out: HttpClient[] = [];
  for (const k of keys) {
    const c = t.client();
    expect((await c.login(k)).status, `sign-in ${k}`).toBe(200);
    out.push(c);
  }
  return out;
}

/** The planted Sunday upload: a $62,000 bonus true-up Jordan prepared and approved himself. */
async function bonusEntry(t: TestApp) {
  return t.ctx.db.tx(t.fx.tenantId, async (tx) => (await tx.find('journal_entries', { memo: 'Q3 sales bonus accrual true-up (spreadsheet upload)' }))[0]!);
}

describe('payroll accrual', () => {
  it('TO-ACC-PAYROLL: an unpaid day costs a tenth of the biweekly run, whose ten paid days include Labor Day', async () => {
    const t = await testApp();
    const us = t.fx.entityIds.get('BWL-US')!;
    await t.ctx.db.tx(t.fx.tenantId, async (tx) => {
      const svc = new AccountingServices(tx, SYSTEM_ACTOR, clock);
      const c = (await svc.accruals.candidates(us, P)).candidates.find((x) => x.basis === 'payroll_calendar')!;
      const run = (await tx.get('payroll_runs', c.evidence[0]!.refId!))!;
      // the run the daily cost comes from paid a public holiday: 9 business days, 10 paid days
      expect(run.period_start <= '2026-09-07' && run.period_end >= '2026-09-07' && !isBusinessDay('2026-09-07', 'US')).toBe(true);
      expect(c.title).toBe(`Accrue 13 unpaid payroll days (2026-09-12 to 2026-09-30)`);
      let expected = 0;
      for (const g of Object.values(run.by_department)) {
        const share = g / run.gross_minor;
        expected += Math.round((g * 13) / 10 / 100) * 100 + Math.round((run.employer_taxes_minor * share * 13) / 10 / 100) * 100 + Math.round((run.benefits_minor * share * 13) / 10 / 100) * 100;
      }
      expect(c.amountMinor).toBe(expected);
      expect(c.amountMinor).toBe(41_318_200);
      expect(c.reasoning).toContain('for 10 paid days, public holidays included');
    });
  });
});

describe('an entry its own preparer approved', () => {
  it('TO-ACC-SELFAPPROVED: the risk review proposes reversing it pending support, and only someone independent decides', async () => {
    const t = await testApp();
    const [jordan, casey, riley] = await signIn(t, 'jordan', 'casey', 'riley');
    const us = t.fx.entityIds.get('BWL-US')!;
    const bonus = await bonusEntry(t);
    expect(bonus.prepared_by).toBe(bonus.approved_by);

    expect((await casey!.post('/api/runs', { skillKey: 'je-review', entityId: us, periodKey: P })).status).toBe(200);
    const open = (await riley!.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}&skill=je-review`)).body.items;
    expect(open.filter((i) => i.kind === 'finding')).toHaveLength(2); // the findings are still raised
    const rev = open.find((i) => i.kind === 'journal_entry')!;
    expect(rev.title).toBe(`Reverse ${bonus.je_number} until its support is reviewed: Q3 sales bonus accrual true-up (spreadsheet upload) $62,000.00`);
    const detail = (await riley!.get<{ payload: { entryType: string; reversesJeId: string; postingDate: string }; lines: { account: string; debit?: number; credit?: number; department?: string | null }[]; why: string }>(`/api/proposals/${rev.id}`)).body;
    expect(detail.payload).toMatchObject({ entryType: 'reversing', reversesJeId: bonus.id, postingDate: '2026-09-30' });
    expect(detail.lines.map((l) => [l.account, l.debit ?? 0, l.credit ?? 0, l.department ?? null])).toEqual([
      ['6000', 0, 62_000_00, 'SALES'],
      ['2120', 62_000_00, 0, null],
    ]);
    expect(detail.why).toContain('If the support holds, reject this reversal with a note and the entry stands');

    // the person who prepared and approved the entry decides neither way
    const mine = (await jordan!.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}&skill=je-review`)).body.items.find((i) => i.id === rev.id)!;
    expect(mine.canDecide).toBe(false);
    expect(mine.blockedBy).toContain(`SOD-01: You prepared or approved ${bonus.je_number}, the entry this reverses, so someone independent decides on it.`);
    expect((await jordan!.post(`/api/proposals/${rev.id}/approve`, {})).status).toBe(403);
    expect((await jordan!.post(`/api/proposals/${rev.id}/reject`, { reason: 'The bonus schedule supports it.' })).status).toBe(403);
    // whoever ran the review may acknowledge its findings, but not approve the entry it drafted (SOD-02)
    expect((await casey!.post(`/api/proposals/${rev.id}/approve`, {})).status).toBe(403);

    const ok = await riley!.post<{ applied_ref_id: string }>(`/api/proposals/${rev.id}/approve`, { note: 'No support on file; Jordan to resubmit with the bonus schedule.' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const original = (await riley!.get<{ reversal: { id: string; status: string } | null }>(`/api/journal/${bonus.id}`)).body;
    expect(original.reversal).toMatchObject({ id: ok.body.applied_ref_id, status: 'posted' });
  });

  it('TO-ACC-SELFAPPROVED: someone independent may keep the entry by rejecting the reversal with a note', async () => {
    const t = await testApp();
    const [casey, riley] = await signIn(t, 'casey', 'riley');
    const us = t.fx.entityIds.get('BWL-US')!;
    const bonus = await bonusEntry(t);
    expect((await casey!.post('/api/runs', { skillKey: 'je-review', entityId: us, periodKey: P })).status).toBe(200);
    const rev = (await riley!.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}&kind=journal_entry&skill=je-review`)).body.items[0]!;
    expect((await riley!.post(`/api/proposals/${rev.id}/reject`, { reason: 'Reviewed the Q3 bonus schedule and the CFO approval email; the true-up is supported.' })).status).toBe(200);
    expect((await riley!.get<{ entry: { status: string }; reversal: unknown }>(`/api/journal/${bonus.id}`)).body).toMatchObject({ entry: { status: 'posted' }, reversal: null });
    // and the next review does not propose it again
    expect((await casey!.post('/api/runs', { skillKey: 'je-review', entityId: us, periodKey: P })).status).toBe(200);
    expect((await riley!.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}&kind=journal_entry&skill=je-review`)).body.items).toHaveLength(0);
  });

  it('TO-ACC-SELFAPPROVED: in live mode, a reversal that does not cancel the entry exactly is refused by the verifier', async () => {
    const t = await testApp();
    const us = t.fx.entityIds.get('BWL-US')!;
    const bonus = await bonusEntry(t);
    const reversal = { entityId: us, periodKey: P, postingDate: '2026-09-30', entryType: 'reversing', memo: `Reversal of ${bonus.je_number}`, source: 'agent', reversesJeId: bonus.id, lines: [{ account: '6000', credit: 50_000_00, department: 'SALES' }, { account: '2120', debit: 50_000_00 }] };
    const llm = new ScriptedProvider([
      toolUse('tu_1', 'propose__journal_entry', { title: `Reverse ${bonus.je_number}`, why: 'Prepared and approved by the same person.', confidence: 0.9, evidence: [{ kind: 'record', label: bonus.je_number, refType: 'journal_entry', refId: bonus.id }], dedupeKey: 'live:rev', entry: reversal }),
      toolUse('tu_2', 'finish', { headline: 'Proposed a reversal', notes: [] }),
    ]);
    const rt = new AgentRuntime({ db: t.fx.db, clock, pack: accountingPack, skills: accountingSkills(), llm, resolveActor: resolveUserActor });
    const run = await rt.start({ tenantId: t.fx.tenantId, skillKey: 'je-review', entityId: us, periodKey: P, requestedBy: t.fx.userIds.get('casey')!, mode: 'live' });
    expect(run.status).toBe('succeeded');
    expect(await t.fx.db.tx(t.fx.tenantId, (tx) => tx.find('proposals', { run_id: run.id }))).toHaveLength(0);
    const reply = (llm.requests[1]!.messages.at(-1)!.content[0] as { content: string }).content;
    expect(reply).toContain(`AX-IM-02: the lines do not cancel ${bonus.je_number} exactly`);
  });
});
