import { describe, expect, it } from 'vitest';
import { detectGrni, detectRecurringGaps, detectSubsequentBills, overlapRatio, payrollAccrual, type BillFact, type PoFact } from '../../src/packs/accounting/domain/accrual-math';
import { benfordFirstDigit, controlAccountPostings, duplicatePayments, roundAmounts, sodBreaks, thresholdAvoidance, unusualPairs, weekendPostings, type EntryFact, type PaymentFact } from '../../src/packs/accounting/domain/anomaly-math';
import { analyzeDrivers, computeVariance, fluxNarrative, isMaterialVariance } from '../../src/packs/accounting/domain/flux-math';
import { accumulatedDepreciation, depreciationForPeriod, prepaidSchedule, serviceMonths, type AssetFact } from '../../src/packs/accounting/domain/schedule-math';
import { BusinessCalendar, US_BANK_HOLIDAYS_2025_2027 } from '../../src/framework/util/workdays';

describe('flux mathematics', () => {
  const t = { abs: 2_500_000, pct: 0.1, mode: 'and' as const };
  it('computes variance and percentage against the comparison', () => {
    expect(computeVariance(150, 100)).toEqual({ current: 150, comparison: 100, variance: 50, variancePct: 0.5 });
    expect(computeVariance(50, 0).variancePct).toBeNull();
    expect(computeVariance(-50, -100).variancePct).toBe(0.5);
  });
  it('applies absolute AND relative thresholds (and new balances)', () => {
    expect(isMaterialVariance(computeVariance(16_675_873, 5_062_694), t)).toBe(true);
    expect(isMaterialVariance(computeVariance(200_000_000, 190_000_000), t)).toBe(false); // 5%
    expect(isMaterialVariance(computeVariance(3_000_000, 1_000_000), { ...t, mode: 'or' })).toBe(true);
    expect(isMaterialVariance(computeVariance(3_000_000, 0), t)).toBe(true);
    expect(isMaterialVariance(computeVariance(1_000, 0), t)).toBe(false);
  });
  it('decomposes a variance into counterparty drivers with coverage', () => {
    const a = analyzeDrivers(
      [
        { key: 'brightstage', label: 'Brightstage Events', period: 'current', amount: 9_500_000 },
        { key: 'signal', label: 'Signal Ads', period: 'current', amount: 4_531_000 },
        { key: 'signal', label: 'Signal Ads', period: 'comparison', amount: 2_500_000 },
        { key: 'misc', label: 'Misc', period: 'current', amount: 100 },
      ],
      11_531_100,
    );
    expect(a.drivers[0]!.label).toMatch(/Brightstage/);
    expect(a.drivers[0]!.amount).toBe(9_500_000);
    expect(a.coverage).toBeGreaterThan(0.99);
  });
  it('writes a plain-English narrative', () => {
    const text = fluxNarrative({ accountName: 'Marketing & Advertising', periodLabel: 'September 2026', comparisonLabel: 'August 2026', variance: computeVariance(16_675_873, 5_062_694), currency: 'USD', drivers: [{ label: 'Brightstage Events — new this period', kind: 'one_time', amount: 9_500_000, evidence: [] }], coverage: 0.82 });
    expect(text).toContain('Marketing & Advertising rose $116,132');
    expect(text).toContain('Brightstage');
    expect(text).toContain('82%');
  });
});

describe('accrual detection', () => {
  const bill = (id: string, vendorId: string, date: string, amount: number, extra: Partial<BillFact> = {}): BillFact => ({ id, vendorId, vendorName: `Vendor ${vendorId}`, billNumber: `B-${id}`, billDate: date, amount, serviceStart: null, serviceEnd: null, accountId: 'acct', departmentId: null, poId: null, ...extra });
  it('pro-rates service periods by days', () => {
    expect(overlapRatio('2026-09-01', '2026-09-30', '2026-09')).toBe(1);
    expect(overlapRatio('2026-09-16', '2026-10-15', '2026-09')).toBeCloseTo(15 / 30, 5);
    expect(overlapRatio('2026-10-01', '2026-10-31', '2026-09')).toBe(0);
  });
  it('accrues recurring vendors that have not billed this month, at the median', () => {
    const bills = [bill('1', 'v', '2026-06-05', 100_000), bill('2', 'v', '2026-07-05', 110_000), bill('3', 'v', '2026-08-05', 105_000), bill('4', 'w', '2026-08-05', 50_000), bill('5', 'x', '2026-06-01', 1), bill('6', 'x', '2026-07-01', 1), bill('7', 'x', '2026-08-01', 1), bill('8', 'x', '2026-09-01', 1)];
    const out = detectRecurringGaps(bills, '2026-09');
    expect(out.map((c) => c.vendorId)).toEqual(['v']);
    expect(out[0]!.amount).toBe(105_000);
    expect(out[0]!.confidence).toBeGreaterThan(0.8);
  });
  it('accrues goods received not invoiced, pro-rated to the service period', () => {
    const po: PoFact = { id: 'po', poNumber: 'PO-1042', vendorId: 'n', vendorName: 'Northgate', amount: 2_400_000, status: 'received', receivedDate: '2026-09-20', serviceStart: null, serviceEnd: null, accountId: 'acct', departmentId: null, description: 'Security audit' };
    expect(detectGrni([po], [], '2026-09')[0]!.amount).toBe(2_400_000);
    expect(detectGrni([po], [bill('b', 'n', '2026-09-25', 2_400_000, { poId: 'po' })], '2026-09')).toEqual([]);
    expect(detectGrni([{ ...po, status: 'open' }], [], '2026-09')).toEqual([]);
  });
  it('accrues the in-period share of bills received after month end, once per vendor', () => {
    const late = bill('h', 'helio', '2026-10-01', 636_080, { serviceStart: '2026-09-16', serviceEnd: '2026-10-15' });
    const out = detectSubsequentBills([late], '2026-09', new Set());
    expect(out[0]!.amount).toBe(318_040);
    expect(detectSubsequentBills([late], '2026-09', new Set(['helio']))).toEqual([]);
  });
  it('accrues payroll earned after the last pay period ended', () => {
    const cal = new BusinessCalendar(US_BANK_HOLIDAYS_2025_2027);
    const r = payrollAccrual([{ id: 'p', periodStart: '2026-09-01', periodEnd: '2026-09-15', payDate: '2026-09-18', grossWages: 50_000_000, employerTaxes: 3_800_000, benefits: 0, byDepartment: [{ departmentId: 'eng', gross: 50_000_000, taxes: 3_800_000 }] }], '2026-09', cal);
    expect(r).not.toBeNull();
    expect(r!.days).toBe(11);
    expect(r!.amountWages).toBeGreaterThan(40_000_000);
    expect(r!.byDepartment[0]!.amount).toBe(Math.round((53_800_000 * r!.days) / Math.max(1, cal.businessDaysBetween('2026-08-31', '2026-09-15'))));
  });
});

describe('schedules', () => {
  it('spreads a prepaid exactly over its months', () => {
    const s = prepaidSchedule(1_440_000, '2026-09', 12);
    expect(s).toHaveLength(12);
    expect(s[0]).toEqual({ periodKey: '2026-09', amount: 120_000 });
    expect(s.reduce((a, x) => a + x.amount, 0)).toBe(1_440_000);
    expect(prepaidSchedule(100, '2026-01', 3).map((x) => x.amount).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it('depreciates straight-line from the in-service month and stops at cost − salvage', () => {
    const a: AssetFact = { id: 'a', tag: 'FA-1', name: 'Laptops', cost: 3_600_000, salvage: 0, usefulLifeMonths: 36, inServiceDate: '2026-09-18', departmentId: null, status: 'in_service' };
    expect(depreciationForPeriod(a, '2026-08')).toBe(0);
    expect(depreciationForPeriod(a, '2026-09')).toBe(100_000);
    expect(depreciationForPeriod(a, '2029-09')).toBe(0);
    expect(accumulatedDepreciation(a, '2029-12')).toBe(3_600_000);
    expect(depreciationForPeriod({ ...a, status: 'disposed' }, '2026-10')).toBe(0);
  });
  it('reads service months from dates or annual wording', () => {
    expect(serviceMonths({ subjectType: 'bill', id: 'x', label: 'Ledgerlight', amount: 1, serviceStart: '2026-09-01', serviceEnd: '2027-08-31', memo: '' })).toBe(12);
    expect(serviceMonths({ subjectType: 'bill', id: 'x', label: 'Annual licence', amount: 1, serviceStart: null, serviceEnd: null, memo: '' })).toBe(12);
    expect(serviceMonths({ subjectType: 'bill', id: 'x', label: 'Catering', amount: 1, serviceStart: null, serviceEnd: null, memo: 'one-off' })).toBeNull();
  });
});

describe('journal-entry tests and Benford', () => {
  const entry = (over: Partial<EntryFact>): EntryFact => ({ id: 'e', entryNumber: 'JE-1', entryDate: '2026-09-16', entryType: 'standard', source: 'manual', memo: '', amount: 100_000, preparedBy: 'u1', approvedBy: 'u2', externalPreparer: null, externalApprover: null, postedAt: '2026-09-16T17:00:00Z', externalPostedAt: null, accountsDebited: ['6000'], accountsCredited: ['1000'], controlAccountsTouched: [], revenueTouched: false, ...over });
  it('finds duplicate payments of the same invoice', () => {
    const p = (id: string, date: string, ref: string): PaymentFact => ({ id, vendorId: 'sp', vendorName: 'Sparrow', billId: 'bill', billNumber: 'SP-2291', amount: 648_000, paymentDate: date, method: 'ach', reference: ref });
    const f = duplicatePayments([p('a', '2026-09-03', 'ACH1'), p('b', '2026-09-17', 'ACH2')]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ test: 'duplicate_payment', severity: 'high', amount: 648_000 });
    expect(duplicatePayments([p('a', '2026-09-03', 'ACH1'), { ...p('b', '2026-09-17', 'ACH2'), billId: 'other', billNumber: 'SP-9' }])).toEqual([]);
  });
  it('flags preparer = approver, round amounts, weekend postings, control accounts, threshold avoidance and unusual pairs', () => {
    expect(sodBreaks([entry({ externalPreparer: 'jdoe', externalApprover: 'jdoe', preparedBy: null, approvedBy: null })])).toHaveLength(1);
    expect(sodBreaks([entry({})])).toHaveLength(0);
    expect(roundAmounts([entry({ amount: 4_800_000 })])).toHaveLength(1);
    expect(roundAmounts([entry({ amount: 4_812_345 })])).toHaveLength(0);
    expect(weekendPostings([entry({ entryDate: '2026-09-19' })], () => 12)[0]!.test).toBe('weekend_posting');
    expect(weekendPostings([entry({})], () => 23)[0]!.test).toBe('after_hours');
    expect(controlAccountPostings([entry({ controlAccountsTouched: ['2000 Accounts Payable'] })])).toHaveLength(1);
    expect(thresholdAvoidance([entry({ amount: 2_450_000 })], 2_500_000)).toHaveLength(1);
    expect(unusualPairs([entry({ revenueTouched: true, accountsDebited: ['1100'], accountsCredited: ['4000'] })], new Set(['1100>4100']))).toHaveLength(1);
  });
  it('measures Benford conformity with Nigrini bands', () => {
    const benford: number[] = [];
    for (let d = 1; d <= 9; d++) {
      const n = Math.round(2000 * Math.log10(1 + 1 / d));
      for (let i = 0; i < n; i++) benford.push((d * 100 + (i % 97)) * 100);
    }
    expect(benfordFirstDigit(benford).conformity).toBe('close');
    const uniform = Array.from({ length: 900 }, (_, i) => ((i % 9) + 1) * 10_000);
    const u = benfordFirstDigit(uniform);
    expect(u.conformity).toBe('nonconformity');
    expect(u.spikes.length).toBeGreaterThan(0);
    expect(benfordFirstDigit([12_300, 45_600]).conformity).toBe('insufficient_data');
  });
});
