import { beforeAll, describe, expect, it } from 'vitest';
import type { ApiKernel } from '../../src/api/kernel';
import type { App } from '../../src/app/app';
import { BENFORD_MIN_SAMPLE } from '../../src/packs/accounting/algorithms/anomaly';
import { normalizeDocNumber } from '../../src/packs/accounting/algorithms/text';
import type { SeedResult } from '../../src/packs/accounting/seed/loader';
import type { Row } from '../../src/persistence/schema';
import { configurePasswordHashing, DEMO_SCRYPT } from '../../src/security/passwords';
import { Client, errorOf, seededKernel } from './api-client';

configurePasswordHashing({ params: DEMO_SCRYPT });

/** The accounting reviewer's findings, after Maya runs the close agents on the seeded September. */
describe('accounting review fixes (ACC-1, ACC-2, ACC-3, B-4, B-8)', () => {
  let app: App;
  let kernel: ApiKernel;
  let seed: SeedResult;
  let email: (key: string) => string;
  let maya: Client;
  let daniel: Client;
  let fluxRunId: string;
  const userId = async (key: string) => (await app.read((tx) => tx.findOne('users', { email: email(key) })))!.id;

  beforeAll(async () => {
    ({ app, kernel, seed, email } = await seededKernel());
    maya = new Client(kernel, '10.6.0.1');
    await maya.login(email('maya'));
    daniel = new Client(kernel, '10.6.0.2');
    await daniel.login(email('daniel'));
    expect((await maya.call('POST', `/api/closes/${seed.closeId}/run`, {})).status).toBe(202);
    await app.queue.idle();
    // The flux agent drafts variance explanations (ACC-3, B-8).
    const flux = await app.runtime.start(seed.tenantId, { skillKey: 'flux-analysis', input: { closeId: seed.closeId, period: '2026-09' }, requestedBy: await userId('maya'), requestedByLabel: 'Maya Chen' });
    await app.runtime.execute(flux.id);
    fluxRunId = flux.id;
  }, 240_000);

  it('ACC-1: the recurring accrual for Copperline leaves out the duplicate bill', async () => {
    const accrual = (await app.read((tx) => tx.find('proposals', { tenant_id: seed.tenantId, kind: 'journal_entry' }))).find((p) => /^Accrue Copperline Legal LLP/.test(p.title))!;
    expect(accrual).toBeTruthy();
    // The three service months before September, each bill counted once (INV-20931 was entered again as INV20931).
    const vendor = (await app.read((tx) => tx.findOne('vendors', { name: 'Copperline Legal LLP' })))!;
    const bills = await app.read((tx) => tx.find('bills', { vendor_id: vendor.id }));
    const months = ['2026-06', '2026-07', '2026-08'];
    const once = new Map<string, Row<'bills'>>();
    for (const b of bills.filter((x) => x.status !== 'void' && months.includes((x.service_start ?? x.bill_date).slice(0, 7)))) once.set(normalizeDocNumber(b.bill_number), b);
    expect(once.size).toBe(3);
    const expected = Math.round([...once.values()].reduce((s, b) => s + b.amount_minor, 0) / 3);
    expect(accrual.amount_minor).toBe(expected);
    expect(accrual.amount_minor).not.toBe(2_190_600);
    expect(accrual.why).toMatch(/Left out INV20931 \(\$18,400\.00\), a duplicate of INV-20931/);
  });

  it('ACC-2: Benford runs on twelve months of posted line amounts, with a sample-size floor', async () => {
    const run = await app.runtime.start(seed.tenantId, { skillKey: 'je-review', input: { closeId: seed.closeId, period: '2026-09' }, requestedBy: await userId('maya'), requestedByLabel: 'Maya Chen' });
    await app.runtime.execute(run.id);
    const step = (await app.read((tx) => tx.find('agent_steps', { run_id: run.id }))).find((s) => s.title.startsWith('Benford first-digit test'))!;
    const result = (step.detail as { benford: { n: number; conformity: string; population: string } }).benford;
    expect(result.population).toBe('posted journal lines, trailing 12 months');
    expect(result.n).toBeGreaterThanOrEqual(BENFORD_MIN_SAMPLE);
    expect(result.conformity).not.toBe('insufficient');
  });

  it('ACC-3: the trial-balance axioms run on the report and the package; flux drivers use their own axioms', async () => {
    const us = await maya.ok<{ checks: Array<{ axiom: string; severity: string }> | null }>('GET', '/api/reports/trial-balance?entity=BW-US');
    expect(us.checks).not.toBeNull();
    expect(us.checks!.filter((c) => c.severity === 'error')).toEqual([]);
    const consolidated = await maya.ok<{ checks: Array<{ axiom: string; severity: string }> | null }>('GET', '/api/reports/trial-balance');
    expect(consolidated.checks!.filter((c) => c.axiom.startsWith('AX-TB'))).toEqual([]);

    const explanation = (await app.read((tx) => tx.find('proposals', { run_id: fluxRunId, kind: 'flux_explanation' })))[0]!;
    const ids = (explanation.verification as Array<{ id: string; label: string }>).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['AX-FLX-04', 'AX-FLX-05']));
    expect(ids).not.toContain('AX-FLX-02');
    expect(ids).not.toContain('AX-FLX-03');
  });

  it('B-4: a reconciliation with an unexplained item certifies only with a note explaining it', async () => {
    const item = (await app.read((tx) => tx.find('proposals', { tenant_id: seed.tenantId, kind: 'reconciling_item', status: 'pending' }))).find((p) => /Investigate unexplained bank debit \$1,250\.00/.test(p.title))!;
    await daniel.ok('POST', `/api/proposals/${item.id}/approve`, {});
    const recId = (await app.read((tx) => tx.get('proposals', item.id)))!.effect!.reconciliationId as string;
    const rec = (await app.read((tx) => tx.get('reconciliations', recId)))!;
    // Clear what else is waiting on this reconciliation (as an independent reviewer would).
    for (const p of await app.read((tx) => tx.find('proposals', { tenant_id: seed.tenantId, status: 'pending', entity_id: rec.entity_id, period_id: rec.period_id, kind: { in: ['rec_match', 'reconciling_item'] } }))) {
      if ((await daniel.call('POST', `/api/proposals/${p.id}/approve`, {})).status !== 200) await daniel.ok('POST', `/api/proposals/${p.id}/reject`, { reason: 'Not this month' });
    }
    const detail = await maya.ok<{ rec: { difference: number; unexplained: number }; certification: { problems: string[]; needsNote: boolean; canPrepare: boolean } }>('GET', `/api/recs/${recId}`);
    expect(detail.rec.difference).toBe(0);
    expect(Math.abs(detail.rec.unexplained)).toBe(125_000);
    expect(detail.certification).toMatchObject({ problems: [], needsNote: true, canPrepare: true });
    const bare = await maya.call('POST', `/api/recs/${recId}/sign`, { role: 'preparer' });
    expect(bare.status).toBe(409);
    expect(errorOf(bare).message).toMatch(/Unexplained difference of -?\$1,250\.00 needs a note/);
    const note = 'ACH debit from an unknown originator; the bank is tracing it (case 4471). Below clearly trivial.';
    expect((await maya.call('POST', `/api/recs/${recId}/sign`, { role: 'preparer', comment: note })).status).toBe(200);
    expect(await app.read((tx) => tx.get('reconciliations', recId))).toMatchObject({ status: 'prepared', notes: note });
  });

  it('B-8: amounts are formatted, and in the entity\'s currency', async () => {
    const briar = (await app.read((tx) => tx.find('proposals', { tenant_id: seed.tenantId, kind: 'rec_match' }))).find((p) => /BRIAR STUDIOS/.test(p.title))!;
    const routing = (briar.verification as Array<{ id: string; label: string }>).find((c) => c.id === 'DISPOSITION')!.label;
    expect(routing).toContain('$254,760.00 is above the auto-apply limit of $250,000.00');
    // A variance explanation shows the variance it covers, not "$0.00".
    const explanations = (await daniel.ok<{ items: Array<{ kind: string; amount: number; display: { kind: string; minor: number | null } }> }>('GET', '/api/proposals?view=all&kind=flux_explanation&limit=50')).items;
    expect(explanations.length).toBeGreaterThan(0);
    for (const x of explanations) {
      expect(x.display.kind).toBe('variance');
      expect(x.display.minor).not.toBe(0);
    }
    const uk = (await app.read(async (tx) => {
      const e = (await tx.findOne('entities', { tenant_id: seed.tenantId, code: 'BW-UK' }))!;
      return tx.find('proposals', { tenant_id: seed.tenantId, entity_id: e.id, kind: 'rec_match' });
    })).filter((p) => /\d/.test(p.why));
    expect(uk.length).toBeGreaterThan(0);
    for (const p of uk) {
      expect(p.why).toMatch(/£/);
      expect(p.why).not.toMatch(/\$\d/);
    }
  });
});
