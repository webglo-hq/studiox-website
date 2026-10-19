/**
 * A whole close end to end over the HTTP API (in-memory store): every item decided, reconciliations
 * certified and reviewed, variances explained, checklist signed off, package approved, period
 * locked; then what a locked period means and how it reopens.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SCENARIO } from '../../src/packs/accounting/seed/company';
import { testApp, type TestApp } from '../support/app';
import { closeTheMonth, type CloseOutcome } from '../support/full-close';

const P = SCENARIO.closeKey;
let t: TestApp;
let out: CloseOutcome;

beforeAll(async () => {
  t = await testApp();
  out = await closeTheMonth(t, { runAgents: true });
}, 300_000);

describe('closing September end to end', () => {
  it('decides every proposal and locks every entity', async () => {
    expect(out.decided).toBeGreaterThan(30);
    const view = (await out.people.casey!.get<{ periods: { status: string }[]; readiness: { ready: boolean } }>(`/api/close/${P}`)).body;
    expect(view.periods.every((p) => p.status === 'locked')).toBe(true);
  });

  it('records the explanation a person wrote, approved by someone else', async () => {
    const p = (await out.people.casey!.get<{ status: string; preparedBy: string; approvals: { by: string }[] }>(`/api/proposals/${out.writtenExplanationId}`)).body;
    expect(p.status).toBe('applied');
    expect(p.preparedBy).toBe('Sam Rivera');
    expect(p.approvals.map((a) => a.by)).toEqual(['Casey Morgan']);
  });

  it('refuses posting to the locked period', async () => {
    const me = (await out.people.casey!.get<{ entities: { id: string; code: string }[] }>('/api/auth/me')).body;
    const us = me.entities.find((e) => e.code === 'BWL-US')!;
    const je = await out.people.casey!.post('/api/journal', { entityId: us.id, postingDate: '2026-09-30', entryType: 'adjusting', memo: 'Late adjustment after the lock', lines: [{ account: '6000', debit: 10000, department: 'GA' }, { account: '2110', credit: 10000 }] });
    expect(je.status).toBeGreaterThanOrEqual(400);
    expect(je.status).toBe(422);
    expect((je.body as { error: { message: string } }).error.message).toMatch(/^AX-PD-01: period 2026-09 is locked$/);
  });

  it('reopens one entity only with a documented reason, by a Controller or CFO', async () => {
    const me = (await out.people.casey!.get<{ entities: { id: string; code: string }[] }>('/api/auth/me')).body;
    const uk = me.entities.find((e) => e.code === 'BWL-UK')!;
    expect((await out.people.sam!.post(`/api/close/${P}/reopen`, { entityId: uk.id, reason: 'Staff accountant trying to reopen' })).status).toBe(403);
    expect((await out.people.casey!.post(`/api/close/${P}/reopen`, { entityId: uk.id, reason: 'short' })).status).toBe(400);
    const r = await out.people.casey!.post<{ status: string }>(`/api/close/${P}/reopen`, { entityId: uk.id, reason: 'Auditor adjustment to the UK revenue cut-off' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('soft_closed');
    const log = await out.people.casey!.get<{ items: { action: string; summary: string }[] }>('/api/audit?action=period.');
    expect(log.body.items.map((i) => i.action)).toEqual(expect.arrayContaining(['period.lock', 'period.reopen']));
  });

  it('keeps flagged items out of bulk approval and the chain check for those allowed to run it', async () => {
    const verifyAsStaff = await out.people.sam!.post('/api/audit/verify', {});
    expect(verifyAsStaff.status).toBe(403);
    const verify = await out.people.casey!.post<{ ok: boolean }>('/api/audit/verify', {});
    expect(verify.body.ok).toBe(true);
  });
});

describe('bulk approval of flagged items', () => {
  it('refuses an item flagged for instruction-like text, even when the person could approve it alone', async () => {
    const fresh = await testApp();
    const jordan = fresh.client();
    const casey = fresh.client();
    await jordan.login('jordan');
    await casey.login('casey');
    expect((await jordan.post(`/api/close/${P}/run-agents`, {})).status).toBe(200);
    const flagged = (await casey.get<{ items: { id: string; flags: string[]; canDecide: boolean }[] }>(`/api/proposals?status=open&period=${P}`)).body.items.find((i) => i.flags.includes('injection_suspected'))!;
    expect(flagged.canDecide).toBe(true);
    const r = await casey.post<{ results: { ok: boolean; error?: string }[] }>('/api/proposals/bulk-approve', { ids: [flagged.id] });
    expect(r.body.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/instruction-like/) });
  });
});
