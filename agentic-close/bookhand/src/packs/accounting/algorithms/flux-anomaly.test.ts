import { describe, expect, it } from 'vitest';
import { usBusinessCalendar } from '../../../shared/dates';
import { Prng } from '../../../shared/prng';
import { BENFORD_MIN_SAMPLE, benford, detectDuplicatePayments, reviewEntries, type ReviewEntry } from './anomaly';
import { computeFlux, decomposeDrivers, draftExplanation } from './flux';

describe('flux math', () => {
  const accounts = [
    { accountId: 'a1', number: '6310', name: 'Events and conferences', accountClass: 'expense' as const, fsLine: 'IS.OPEX.MARKETING', current: 9_100_000, comparison: 1_200_000 },
    { accountId: 'a2', number: '6420', name: 'Software', accountClass: 'expense' as const, fsLine: 'IS.OPEX.SOFTWARE', current: 4_100_000, comparison: 3_900_000 },
    { accountId: 'a3', number: '4000', name: 'Subscription revenue', accountClass: 'revenue' as const, fsLine: 'IS.REV.SUBSCRIPTION', current: 200_000_000, comparison: 195_000_000 },
    { accountId: 'a4', number: '6950', name: 'New account', accountClass: 'expense' as const, fsLine: 'IS.IC', current: 3_000_000, comparison: 0 },
  ];

  it('computes variance, percent and materiality with AND thresholds', () => {
    const lines = computeFlux(accounts, { pct: 0.1, minor: 2_500_000, combine: 'and' });
    const byNo = Object.fromEntries(lines.map((l) => [l.number, l]));
    expect(byNo['6310']!.variance).toBe(7_900_000);
    expect(byNo['6310']!.variancePct).toBeCloseTo(6.583, 2);
    expect(byNo['6310']!.isMaterial).toBe(true);
    expect(byNo['6420']!.isMaterial).toBe(false); // 5% and $2K
    expect(byNo['4000']!.isMaterial).toBe(false); // $50K but 2.6%
    expect(byNo['6950']!.variancePct).toBeNull();
    expect(byNo['6950']!.isMaterial).toBe(true); // from zero
    expect(lines[0]!.number).toBe('6310'); // sorted by absolute variance (7.9M > 5M)
  });

  it('OR thresholds flag either condition', () => {
    const lines = computeFlux(accounts, { pct: 0.1, minor: 2_500_000, combine: 'or' });
    expect(lines.find((l) => l.number === '4000')!.isMaterial).toBe(true);
  });

  it('decomposes a variance into drivers covering >= 80% and drafts an explanation', () => {
    const current = [
      { key: 'v-saastr', label: 'SaaStr Annual', kind: 'vendor' as const, amount: 6_400_000, hint: 'booth' },
      { key: 'v-print', label: 'Printwell', kind: 'vendor' as const, amount: 900_000 },
      { key: 'v-swag', label: 'Swagbox', kind: 'vendor' as const, amount: 1_800_000 },
    ];
    const comparison = [
      { key: 'v-print', label: 'Printwell', kind: 'vendor' as const, amount: 800_000 },
      { key: 'v-swag', label: 'Swagbox', kind: 'vendor' as const, amount: 400_000 },
    ];
    const { drivers, coverage } = decomposeDrivers(current, comparison, 7_900_000);
    expect(drivers[0]).toMatchObject({ kind: 'one_time', amount_minor: 6_400_000 });
    expect(coverage).toBeGreaterThanOrEqual(0.8);
    const line = computeFlux([accounts[0]!], { pct: 0.1, minor: 1, combine: 'and' })[0]!;
    const { text, confidence } = draftExplanation(line, drivers, coverage, 'August 2026');
    expect(text).toMatch(/rose \$79,000 \(658%\) vs August 2026/);
    expect(text).toMatch(/SaaStr Annual \(one-time\)/);
    expect(confidence).toBeGreaterThan(0.85);
  });
});

describe('JE anomaly detection', () => {
  const cal = usBusinessCalendar();
  const base: ReviewEntry = {
    id: 'je1',
    entryNumber: 'BW-US-2609-0101',
    entityId: 'us',
    date: '2026-09-27',
    type: 'standard',
    source: 'import',
    description: 'Revenue adjustment per J. Larsen',
    total: 2_500_000,
    lines: [
      { accountNumber: '1100', accountName: 'AR', accountClass: 'asset', isControlAccount: true, debit: 2_500_000, credit: 0 },
      { accountNumber: '4000', accountName: 'Subscription revenue', accountClass: 'revenue', isControlAccount: false, debit: 0, credit: 2_500_000 },
    ],
    preparedBy: null,
    approvedBy: null,
    externalPreparedBy: 'jlarsen',
    externalApprovedBy: 'JLarsen',
    preparedByRunId: null,
  };

  it('flags the SoD-breaking weekend round-amount revenue entry as high severity', () => {
    const [f] = reviewEntries([base], { calendar: cal, roundAmountMinMinor: 1_000_000, approvalLimits: [5_000_000] });
    expect(f!.severity).toBe('high');
    expect(f!.flags).toEqual(expect.arrayContaining(['sod_break', 'weekend_posting', 'round_amount', 'control_account_manual', 'revenue_manual']));
    expect(f!.why).toMatch(/same ERP user "jlarsen"/);
  });

  it('ignores clean system entries and lone round amounts', () => {
    const clean = { ...base, id: 'je2', date: '2026-09-15', source: 'system', externalApprovedBy: null, externalPreparedBy: null };
    const round = { ...base, id: 'je3', date: '2026-09-16', externalApprovedBy: null, externalPreparedBy: null, lines: [
      { accountNumber: '6420', accountName: 'Software', accountClass: 'expense', isControlAccount: false, debit: 2_500_000, credit: 0 },
      { accountNumber: '2100', accountName: 'Accrued', accountClass: 'liability', isControlAccount: false, debit: 0, credit: 2_500_000 },
    ] };
    expect(reviewEntries([clean, round], { calendar: cal, roundAmountMinMinor: 1_000_000, approvalLimits: [] })).toEqual([]);
  });

  it('detects duplicate entries within 3 days', () => {
    const a = { ...base, id: 'd1', date: '2026-09-14', externalPreparedBy: null, externalApprovedBy: null, total: 1_234_500, lines: base.lines.map((l) => ({ ...l, debit: l.debit ? 1_234_500 : 0, credit: l.credit ? 1_234_500 : 0 })) };
    const b = { ...a, id: 'd2', entryNumber: 'BW-US-2609-0102', date: '2026-09-15' };
    const findings = reviewEntries([a, b], { calendar: cal, roundAmountMinMinor: 1_000_000, approvalLimits: [] });
    expect(findings.find((f) => f.subjectIds[0] === 'd2')?.flags).toContain('duplicate_entry');
  });

  it('detects a duplicate vendor payment via normalized invoice numbers', () => {
    const findings = detectDuplicatePayments([
      { id: 'p1', vendorId: 'v', vendorName: 'Copperline Legal LLP', date: '2026-09-10', amount: 1_840_000, reference: 'ACH-55102', bills: [{ id: 'b1', billNumber: 'INV-20931', amount: 1_840_000, billDate: '2026-08-31' }] },
      { id: 'p2', vendorId: 'v', vendorName: 'Copperline Legal LLP', date: '2026-09-18', amount: 1_840_000, reference: 'ACH-55360', bills: [{ id: 'b2', billNumber: 'INV20931', amount: 1_840_000, billDate: '2026-08-31' }] },
      { id: 'p3', vendorId: 'v', vendorName: 'Copperline Legal LLP', date: '2026-07-10', amount: 1_840_000, reference: 'ACH-50001', bills: [{ id: 'b0', billNumber: 'INV-19870', amount: 1_840_000, billDate: '2026-06-30' }] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.subjectIds).toEqual(['p1', 'p2']);
    expect(findings[0]!.score).toBe(0.95);
  });

  it('Benford: conforming data passes, fabricated data does not', () => {
    // Generate Benford-like data: 10^(U*4) * 100 cents
    const conforming: number[] = [];
    const rng = new Prng('benford');
    for (let i = 0; i < 3000; i++) conforming.push(Math.round(10 ** (1 + rng.next() * 4) * 100));
    expect(['close', 'acceptable']).toContain(benford(conforming).conformity);
    const fabricated = Array.from({ length: 500 }, (_, i) => (5000 + (i % 400)) * 100); // all start with 5
    expect(benford(fabricated).conformity).toBe('nonconformity');
    expect(benford([1, 2, 3]).conformity).toBe('insufficient');
  });

  it('ACC-2: Benford says nothing below its sample floor (a few dozen account totals are not a population)', () => {
    const rng = new Prng('benford-small');
    const small = Array.from({ length: BENFORD_MIN_SAMPLE - 1 }, () => Math.round(10 ** (1 + rng.next() * 4) * 100));
    expect(benford(small).conformity).toBe('insufficient');
    expect(benford([...small, 12_345_00]).conformity).not.toBe('insufficient');
  });
});
