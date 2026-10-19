import { describe, expect, it } from 'vitest';
import { closeOntology } from '../ontology';
import { detectCutoffBills, detectGrni, detectRecurringGaps, mergeCandidates, type VendorHistory } from './accruals';
import { buildHistory, merchantKey, suggestCoding, type CodingContext } from './coding';
import { matchIntercompany, remeasure } from './intercompany';
import { compileRule, compileRules, ruleMatches } from './rules';
import { depreciationPlan, findMissedLines, monthsCovered, straightLine } from './schedules';

describe('accrual detection', () => {
  const history: VendorHistory[] = [
    {
      vendorId: 'nimbus',
      vendorName: 'Nimbus Cloud Services',
      bills: ['03', '04', '05', '06', '07', '08'].map((m, i) => ({
        billId: `b${m}`,
        billNumber: `NC-2026-${m}`,
        billDate: `2026-${m}-28`,
        receivedDate: `2026-${m}-28`,
        serviceStart: `2026-${m}-01`,
        serviceEnd: `2026-${m}-28`,
        amount: 3_100_000 + i * 20_000,
        accountNumber: '5000',
        departmentCode: 'ENG',
      })),
    },
    {
      vendorId: 'once',
      vendorName: 'One-off Studio',
      bills: [{ billId: 'x', billNumber: 'OS-1', billDate: '2026-05-10', receivedDate: '2026-05-10', serviceStart: null, serviceEnd: null, amount: 500_000, accountNumber: '6530', departmentCode: null }],
    },
  ];

  it('finds a missing recurring bill and accrues the recent average', () => {
    const c = detectRecurringGaps(history, 2026, 9);
    expect(c).toHaveLength(1);
    expect(c[0]!.vendorName).toBe('Nimbus Cloud Services');
    expect(c[0]!.amount).toBe(Math.round((3_200_000 + 3_180_000 + 3_160_000) / 3));
    expect(c[0]!.confidence).toBeGreaterThan(0.9);
    expect(c[0]!.evidence.length).toBe(3);
  });

  it('ACC-1: a bill entered twice counts once in the run rate (and the why says so)', () => {
    const copper: VendorHistory = {
      vendorId: 'copper',
      vendorName: 'Copperline Legal LLP',
      bills: ['04', '05', '06', '07', '08'].map((m) => ({ billId: `c${m}`, billNumber: `INV-${m}`, billDate: `2026-${m}-28`, receivedDate: `2026-${m}-28`, serviceStart: `2026-${m}-01`, serviceEnd: `2026-${m}-30`, amount: 1_500_000, accountNumber: '6510', departmentCode: 'GA' })),
    };
    // August's invoice keyed in a second time by the AP inbox (INV-08 as INV08), received later.
    copper.bills.push({ ...copper.bills[4]!, billId: 'dup', billNumber: 'INV08', receivedDate: '2026-09-15' });
    const [c] = detectRecurringGaps([copper], 2026, 9);
    expect(c!.amount).toBe(1_500_000);
    expect(c!.why).toMatch(/Left out INV08 \(\$15,000\.00\), a duplicate of INV-08/);
    expect(c!.evidence.map((e) => e.id)).not.toContain('dup');
  });

  it('B-8: accrual amounts are quoted in the entity currency', () => {
    const [c] = detectRecurringGaps(history, 2026, 9, { currency: 'GBP' });
    expect(c!.why).toMatch(/£/);
    expect(c!.why).not.toMatch(/\$/);
  });

  it('does not accrue when the bill exists for the month', () => {
    const withSep = [{ ...history[0]!, bills: [...history[0]!.bills, { ...history[0]!.bills[0]!, billId: 'b09', serviceStart: '2026-09-01', billDate: '2026-09-28' }] }];
    expect(detectRecurringGaps(withSep, 2026, 9)).toEqual([]);
  });

  it('finds goods received not invoiced', () => {
    const c = detectGrni(
      [{ poId: 'po', poNumber: 'PO-1042', poLineId: 'l', vendorId: 'v', vendorName: 'Fieldnote Research', description: 'User research study', accountNumber: '6530', departmentCode: 'PRD', receipts: [{ id: 'r', date: '2026-09-24', amount: 2_400_000 }], billedAmount: 0 }],
      '2026-09-30',
    );
    expect(c[0]).toMatchObject({ signal: 'grni', amount: 2_400_000 });
  });

  it('prorates late bills by service days in the period (cutoff)', () => {
    const c = detectCutoffBills(
      [{ vendorId: 'v', vendorName: 'Brightline Facilities', billId: 'b', billNumber: 'BF-778', billDate: '2026-10-02', receivedDate: '2026-10-03', serviceStart: '2026-09-16', serviceEnd: '2026-10-15', amount: 3_000_000, accountNumber: '6100', departmentCode: 'GA', postedInPeriod: false }],
      2026,
      9,
    );
    expect(c[0]!.amount).toBe(1_500_000); // 15 of 30 days
  });

  it('merges signals preferring the strongest evidence', () => {
    const merged = mergeCandidates([
      { signal: 'recurring_gap', vendorId: 'v', vendorName: 'V', amount: 1, accountNumber: '5000', departmentCode: null, confidence: 0.9, why: '', evidence: [], memo: '' },
      { signal: 'cutoff', vendorId: 'v', vendorName: 'V', amount: 2, accountNumber: '5000', departmentCode: null, confidence: 0.97, why: '', evidence: [], memo: '' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.signal).toBe('cutoff');
  });
});

describe('schedules', () => {
  it('straight-line schedules sum exactly to the basis', () => {
    const s = straightLine(3_600_000, 12, 2026, 3);
    expect(s).toHaveLength(12);
    expect(s.reduce((t, l) => t + l.amount, 0)).toBe(3_600_000);
    expect(s[0]!.periodEnd).toBe('2026-03-31');
    expect(s[11]!.periodEnd).toBe('2027-02-28');
    const odd = straightLine(1_000_001, 3, 2026, 1);
    expect(odd.map((l) => l.amount)).toEqual([333_333, 333_333, 333_335]);
  });

  it('depreciation starts the month after in-service and never exceeds cost less salvage', () => {
    const plan = depreciationPlan(1_480_000, 0, 36, '2026-09-14');
    expect(plan[0]!.periodEnd).toBe('2026-10-31');
    expect(plan.at(-1)!.accumulated).toBe(1_480_000);
    expect(monthsCovered('2026-03-01', '2027-02-28')).toBe(12);
  });

  it('finds missed (unposted) lines up to the current period', () => {
    const missed = findMissedLines(
      [
        { scheduleId: 's', label: 'Design license', periodKey: '2026-08', amount: 300_000, status: 'posted', lineId: 'a' },
        { scheduleId: 's', label: 'Design license', periodKey: '2026-09', amount: 300_000, status: 'scheduled', lineId: 'b' },
        { scheduleId: 's', label: 'Design license', periodKey: '2026-10', amount: 300_000, status: 'scheduled', lineId: 'c' },
      ],
      '2026-09',
    );
    expect(missed.map((m) => m.lineId)).toEqual(['b']);
  });
});

describe('transaction coding (bucketing)', () => {
  const accounts = [
    { id: '1', number: '6420', name: 'Software subscriptions', subtype: 'bh:SoftwareExpense', accountClass: 'expense' },
    { id: '2', number: '6200', name: 'Travel', subtype: 'bh:TravelExpense', accountClass: 'expense' },
    { id: '3', number: '6210', name: 'Meals', subtype: 'bh:MealsEntertainment', accountClass: 'expense' },
    { id: '4', number: '1500', name: 'Computer equipment', subtype: 'bh:ComputerEquipment', accountClass: 'asset' },
    { id: '5', number: '6600', name: 'Office supplies', subtype: 'bh:OfficeSupplies', accountClass: 'expense' },
    { id: '6', number: '6610', name: 'Small equipment', subtype: 'bh:SmallEquipment', accountClass: 'expense' },
  ];
  const classes = closeOntology.classes().filter((c) => c.bucketing).map((c) => ({ id: c.id, label: c.label, bucketing: c.bucketing! }));
  const ctx = (over: Partial<CodingContext> = {}): CodingContext => ({ accounts, classes, history: new Map(), rules: () => null, capitalizationThresholdMinor: 500_000, ...over });

  it('uses ontology semantics (keywords, MCC) when there is no history', () => {
    const s = suggestCoding({ merchant: 'FIGMA INC', memo: 'subscription', mcc: '5734', amount: 4_500 }, ctx())!;
    expect(s.accountNumber).toBe('6420');
    expect(s.why).toMatch(/Software subscriptions/);
    const t = suggestCoding({ merchant: 'DELTA AIR LINES', mcc: '4511', amount: 61_200 }, ctx())!;
    expect(t.accountNumber).toBe('6200');
  });

  it('capitalizes laptops above the threshold, expenses accessories below it', () => {
    expect(suggestCoding({ merchant: 'Apple Store', memo: '8x MacBook Pro laptops for new hires', mcc: '5732', amount: 1_480_000 }, ctx())!.accountNumber).toBe('1500');
    expect(suggestCoding({ merchant: 'Apple Store', memo: 'USB-C adapter and keyboard', mcc: '5732', amount: 12_900 }, ctx())!.accountNumber).toBe('6610');
  });

  it('history beats semantics and raises confidence', () => {
    const history = buildHistory(Array.from({ length: 9 }, () => ({ merchant: 'Blue Bottle Coffee #23', accountNumber: '6210', source: 'agent' })));
    const s = suggestCoding({ merchant: 'BLUE BOTTLE COFFEE 4471', amount: 2_800 }, ctx({ history }))!;
    expect(s.accountNumber).toBe('6210');
    expect(s.confidence).toBeGreaterThan(0.85);
    expect(merchantKey('BLUE BOTTLE COFFEE 4471')).toBe(merchantKey('Blue Bottle Coffee #23'));
  });

  it('policy rules win outright', () => {
    const rules = (i: { merchant: string }) => (ruleMatches('uber', i.merchant) ? { accountNumber: '6200', departmentCode: 'SALES', ruleText: 'Code Uber to 6200 for Sales' } : null);
    const s = suggestCoding({ merchant: 'UBER *TRIP', amount: 3_400 }, ctx({ rules }))!;
    expect(s).toMatchObject({ accountNumber: '6200', departmentCode: 'SALES', confidence: 0.98 });
  });
});

describe('intercompany & FX', () => {
  it('pairs IC transactions by reference and reports mismatches', () => {
    const r = matchIntercompany([
      { entityCode: 'BW-US', counterpartyCode: 'BW-UK', reference: 'IC-2026-09-MGMT', date: '2026-09-30', side: 'receivable', amountTxn: 9_250_000, txnCurrency: 'USD', journalEntryId: 'a', description: 'Mgmt fee + recharge' },
      { entityCode: 'BW-UK', counterpartyCode: 'BW-US', reference: 'IC-2026-09-MGMT', date: '2026-09-30', side: 'payable', amountTxn: 8_500_000, txnCurrency: 'USD', journalEntryId: 'b', description: 'Mgmt fee' },
      { entityCode: 'BW-US', counterpartyCode: 'BW-UK', reference: 'IC-2026-08-MGMT', date: '2026-08-31', side: 'receivable', amountTxn: 8_500_000, txnCurrency: 'USD', journalEntryId: 'c', description: '' },
      { entityCode: 'BW-UK', counterpartyCode: 'BW-US', reference: 'ic-2026-08-mgmt', date: '2026-08-31', side: 'payable', amountTxn: 8_500_000, txnCurrency: 'USD', journalEntryId: 'd', description: '' },
    ]);
    expect(r.map((p) => [p.reference, p.status, p.difference])).toEqual([
      ['IC-2026-08-MGMT', 'matched', 0],
      ['IC-2026-09-MGMT', 'amount_mismatch', 750_000],
    ]);
  });

  it('remeasures foreign monetary balances at the closing rate', () => {
    // UK (GBP) owes USD 85,000 carried at 1/1.2701 = GBP 66,924.65; closing GBP/USD 1.2788 -> 1 USD = 0.78198 GBP
    const lines = remeasure([{ accountNumber: '2400', accountName: 'IC payable', txnBalance: -8_500_000, txnCurrency: 'USD', functionalBalance: -6_692_465 }], 1 / 1.2788);
    expect(lines[0]!.remeasured).toBe(-6_646_856);
    expect(lines[0]!.adjustment).toBe(45_609); // liability shrank in GBP: FX gain
  });
});

describe('plain-English policy rules', () => {
  it('compiles the supported sentence shapes', () => {
    const rules = compileRules([
      'Always code Figma to 6420',
      'Code Uber to 6200 for Sales',
      'Never auto-post anything over $5,000',
      'Auto-post under $500',
      'Only auto-post when confidence is at least 90%',
      'Require approval for Copperline Legal',
      'Capitalize purchases over $5k',
      'Ignore differences under $25',
      'Explain variances over 10% and $25,000',
      'Sample 10% of auto-posted items',
      'Make it nice',
    ]);
    expect(rules.map((r) => r.kind)).toEqual([
      'merchant_account', 'merchant_account', 'max_auto_amount', 'auto_post_under', 'min_confidence', 'require_review', 'capitalize_over', 'tolerance', 'flux_threshold', 'sample_rate', 'unparsed',
    ]);
    expect(rules[1]).toMatchObject({ match: 'Uber', accountNumber: '6200', departmentCode: 'Sales' });
    expect(rules[2]).toMatchObject({ amountMinor: 500_000 });
    expect(rules[6]).toMatchObject({ amountMinor: 500_000 });
    expect(rules[8]).toMatchObject({ pct: 0.1, amountMinor: 2_500_000 });
    expect(compileRule('Map AWS to account 5000')).toMatchObject({ kind: 'merchant_account', match: 'AWS', accountNumber: '5000' });
  });
});
