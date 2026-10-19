import { describe, expect, it } from 'vitest';
import { toGraph, toJsonLd, toTurtle } from '../../../ontology/export';
import { capitalizableMatches, closeOntology, FS_LINES } from './index';
import type { JournalEntryContext, ResolvedAccount, ResolvedJournalEntry, TrialBalanceSubject } from './subjects';

const acct = (over: Partial<ResolvedAccount>): ResolvedAccount => ({
  id: over.number ?? 'id',
  number: '6420',
  name: 'Software subscriptions',
  subtype: 'bh:SoftwareExpense',
  accountClass: 'expense',
  normalBalance: 'debit',
  isPostable: true,
  active: true,
  isIntercompany: false,
  requiresDepartment: false,
  isControlAccount: false,
  ...over,
});

const ctx: JournalEntryContext = {
  capitalizationThresholdMinor: 500_000,
  isA: (a, b) => closeOntology.isA(a, b),
  capitalizableMatches,
};

function je(over: Partial<ResolvedJournalEntry> = {}): ResolvedJournalEntry {
  return {
    entityId: 'e1',
    functionalCurrency: 'USD',
    period: { id: 'p9', entityId: 'e1', startDate: '2026-09-01', endDate: '2026-09-30', status: 'open' },
    nextPeriod: { id: 'p10', entityId: 'e1', startDate: '2026-10-01', endDate: '2026-10-31', status: 'future' },
    entryDate: '2026-09-30',
    entryType: 'standard',
    description: 'September software',
    currency: 'USD',
    fxRate: 1,
    autoReverseDate: null,
    preparedBy: null,
    approvedBy: null,
    reversesEntryId: null,
    lines: [
      { account: acct({}), accountRef: '6420', debit: 300_000, credit: 0, txnCurrency: 'USD', txnAmount: 300_000, departmentId: 'd1', counterpartyEntityId: null, memo: null },
      { account: acct({ number: '2000', name: 'AP', subtype: 'bh:AccountsPayable', accountClass: 'liability', normalBalance: 'credit' }), accountRef: '2000', debit: 0, credit: 300_000, txnCurrency: 'USD', txnAmount: -300_000, departmentId: null, counterpartyEntityId: null, memo: null },
    ],
    ...over,
  };
}

const ids = (vs: Array<{ axiom: string }>) => vs.map((v) => v.axiom).sort();

describe('close ontology', () => {
  it('is internally consistent (lint) and large enough to cover the close', () => {
    expect(closeOntology.lint()).toEqual([]);
    expect(closeOntology.classes().length).toBeGreaterThan(150);
    expect(closeOntology.axioms().length).toBeGreaterThanOrEqual(25);
    expect(closeOntology.spec.relations.length).toBeGreaterThan(60);
  });

  it('covers every required concept area', () => {
    const required = [
      'bh:EconomicResource', 'bh:EconomicEvent', 'bh:EconomicAgent', 'bh:NormalBalance', 'bh:ChartOfAccounts', 'bh:FinancialStatementLine',
      'bh:Department', 'bh:Location', 'bh:BusinessClass', 'bh:Project', 'bh:AccountingPeriod', 'bh:PeriodState', 'bh:JournalEntry',
      'bh:JournalLine', 'bh:Accrual', 'bh:Reversal', 'bh:RecurringEntry', 'bh:ReclassEntry', 'bh:Elimination', 'bh:AccountsPayableSubledger',
      'bh:AccountsReceivableSubledger', 'bh:BankSubledger', 'bh:CardSubledger', 'bh:FixedAssetRegister', 'bh:PrepaidSchedule',
      'bh:PayrollRegister', 'bh:Reconciliation', 'bh:ReconciliationMatch', 'bh:ReconcilingItem', 'bh:Aging', 'bh:Certification',
      'bh:Deferral', 'bh:Amortization', 'bh:Depreciation', 'bh:PeriodOverPeriod', 'bh:BudgetVsActual', 'bh:FluxThreshold',
      'bh:VarianceDriver', 'bh:FluxExplanation', 'bh:IntercompanyTransaction', 'bh:FunctionalCurrency', 'bh:ReportingCurrency',
      'bh:Remeasurement', 'bh:Translation', 'bh:MakerChecker', 'bh:SegregationOfDutiesRule', 'bh:Evidence', 'bh:AuditAssertion',
      'bh:Materiality', 'bh:CloseCalendar', 'bh:Workday', 'bh:TaskDependency', 'bh:AutonomyLevel', 'bh:UntrustedText',
    ];
    for (const id of required) expect(closeOntology.getClass(id), id).toBeDefined();
    expect(closeOntology.individualsOf('bh:AuditAssertion').map((i) => i.label)).toHaveLength(7);
    expect(closeOntology.individualsOf('bh:Materiality').map((i) => i.id)).toEqual(['bh:OverallMateriality', 'bh:PerformanceMateriality', 'bh:ClearlyTrivial']);
    expect(closeOntology.individualsOf('bh:AutonomyLevel').map((i) => i.id)).toEqual(['bh:L0', 'bh:L1', 'bh:L2', 'bh:L3']);
  });

  it('reasons over the class hierarchy (subsumption)', () => {
    expect(closeOntology.isA('bh:PrepaidSoftware', 'bh:CurrentAsset')).toBe(true);
    expect(closeOntology.isA('bh:PrepaidSoftware', 'bh:AssetAccount')).toBe(true);
    expect(closeOntology.isA('bh:Accrual', 'bh:JournalEntry')).toBe(true);
    expect(closeOntology.isA('bh:DepositInTransit', 'bh:ReconcilingItem')).toBe(true);
    expect(closeOntology.isA('bh:LegalFees', 'bh:AssetAccount')).toBe(false);
    expect(closeOntology.descendants('bh:ProfessionalFees')).toEqual(expect.arrayContaining(['bh:LegalFees', 'bh:AuditFees', 'bh:ConsultingFees']));
  });

  it('every account type declares normal balance, class and a statement line that exists', () => {
    const lines = new Set(FS_LINES.map((l) => l.key));
    const accountTypes = closeOntology.classes().filter((c) => c.module === 'accounts' && c.fsLine);
    expect(accountTypes.length).toBeGreaterThan(45);
    for (const c of accountTypes) {
      expect(c.normalBalance, c.id).toBeDefined();
      expect(c.accountClass, c.id).toBeDefined();
      expect(lines.has(c.fsLine!), `${c.id} -> ${c.fsLine}`).toBe(true);
    }
  });

  it('resolves plain words to terms for hover definitions', () => {
    expect(closeOntology.lookup('accruals')).toBe('bh:Accrual');
    expect(closeOntology.lookup('JE')).toBe('bh:JournalEntry');
    expect(closeOntology.lookup('flux')).toBe('bh:FluxAnalysis');
    expect(closeOntology.lookup('WD')).toBe('bh:Workday');
    expect(closeOntology.lookup('clearly trivial')).toBe('bh:ClearlyTrivial');
    const t = closeOntology.term('bh:Accrual')!;
    expect(t.definition).toMatch(/incurred/);
    expect(t.whyItMatters.length).toBeGreaterThan(20);
    expect(t.example.length).toBeGreaterThan(10);
  });

  it('axioms: a clean entry passes', () => {
    expect(closeOntology.evaluate('bh:JournalEntry', je(), ctx)).toEqual([]);
  });

  it('axioms: unbalanced, one-sided, header-account and unknown-account entries fail', () => {
    const unbalanced = je();
    unbalanced.lines[1] = { ...unbalanced.lines[1]!, credit: 299_000, txnAmount: -299_000 };
    expect(ids(closeOntology.evaluate('bh:JournalEntry', unbalanced, ctx))).toContain('AX-DE-01');

    const bothSides = je();
    bothSides.lines[0] = { ...bothSides.lines[0]!, credit: 5 };
    expect(ids(closeOntology.evaluate('bh:JournalEntry', bothSides, ctx))).toContain('AX-DE-02');

    const header = je();
    header.lines[0] = { ...header.lines[0]!, account: acct({ isPostable: false, number: '6400', name: 'Software & hosting' }) };
    expect(ids(closeOntology.evaluate('bh:JournalEntry', header, ctx))).toContain('AX-DE-04');

    const unknown = je();
    unknown.lines[0] = { ...unknown.lines[0]!, account: null, accountRef: '9999' };
    expect(closeOntology.evaluate('bh:JournalEntry', unknown, ctx).find((x) => x.axiom === 'AX-DE-04')?.message).toMatch(/9999/);
  });

  it('axioms: cutoff, locked periods and soft close', () => {
    expect(ids(closeOntology.evaluate('bh:JournalEntry', je({ entryDate: '2026-10-01' }), ctx))).toContain('AX-PER-01');
    const locked = je();
    locked.period = { ...locked.period!, status: 'locked' };
    expect(ids(closeOntology.evaluate('bh:JournalEntry', locked, ctx))).toContain('AX-PER-02');
    const soft = je();
    soft.period = { ...soft.period!, status: 'soft_closed' };
    expect(ids(closeOntology.evaluate('bh:JournalEntry', soft, ctx))).toContain('AX-PER-02');
    expect(ids(closeOntology.evaluate('bh:JournalEntry', { ...soft, entryType: 'adjusting' }, ctx))).not.toContain('AX-PER-02');
  });

  it('axioms: accruals must auto-reverse in the next period', () => {
    expect(ids(closeOntology.evaluate('bh:JournalEntry', je({ entryType: 'accrual' }), ctx))).toContain('AX-ACR-01');
    expect(ids(closeOntology.evaluate('bh:JournalEntry', je({ entryType: 'accrual', autoReverseDate: '2026-11-02' }), ctx))).toContain('AX-ACR-01');
    expect(closeOntology.evaluate('bh:JournalEntry', je({ entryType: 'accrual', autoReverseDate: '2026-10-01' }), ctx)).toEqual([]);
  });

  it('axioms: intercompany counterparty, FX conversion, maker-checker, departments', () => {
    const ic = je();
    ic.lines[0] = { ...ic.lines[0]!, account: acct({ number: '1300', isIntercompany: true, accountClass: 'asset', subtype: 'bh:IntercompanyReceivable' }) };
    expect(ids(closeOntology.evaluate('bh:JournalEntry', ic, ctx))).toContain('AX-IC-01');

    const fx = je({ functionalCurrency: 'GBP', fxRate: 0.78 });
    fx.lines = fx.lines.map((l) => ({ ...l, txnCurrency: 'USD' }));
    // 300,000 USD cents * 0.78 = 234,000 GBP pence, but functional amounts are still 300,000 -> violation
    expect(ids(closeOntology.evaluate('bh:JournalEntry', fx, ctx))).toContain('AX-FX-01');

    expect(ids(closeOntology.evaluate('bh:JournalEntry', je({ preparedBy: 'u1', approvedBy: 'u1' }), ctx))).toContain('AX-CTL-01');

    const dept = je();
    dept.lines[0] = { ...dept.lines[0]!, account: acct({ requiresDepartment: true }), departmentId: null };
    const warn = closeOntology.evaluate('bh:JournalEntry', dept, ctx).find((x) => x.axiom === 'AX-DIM-01');
    expect(warn?.severity).toBe('warning');
  });

  it('axioms: capitalizable purchases coded to expense are flagged (classification)', () => {
    const laptops = je({ description: '8x MacBook Pro laptops for new hires' });
    laptops.lines = [
      { ...laptops.lines[0]!, account: acct({ number: '6600', name: 'Office supplies', subtype: 'bh:OfficeSupplies' }), debit: 1_480_000, txnAmount: 1_480_000 },
      { ...laptops.lines[1]!, credit: 1_480_000, txnAmount: -1_480_000 },
    ];
    const v = closeOntology.evaluate('bh:JournalEntry', laptops, ctx).find((x) => x.axiom === 'AX-CAP-01');
    expect(v?.message).toMatch(/Computer equipment/);
  });

  it('axioms: trial balance balances and the accounting equation holds', () => {
    const tb: TrialBalanceSubject = {
      entityLabel: 'BW-US',
      rows: [
        { accountNumber: '1000', accountName: 'Cash', accountClass: 'asset', normalBalance: 'debit', subtype: 'bh:Cash', debit: 1000, credit: 0 },
        { accountNumber: '2000', accountName: 'AP', accountClass: 'liability', normalBalance: 'credit', subtype: 'bh:AccountsPayable', debit: 0, credit: 400 },
        { accountNumber: '4000', accountName: 'Revenue', accountClass: 'revenue', normalBalance: 'credit', subtype: 'bh:SubscriptionRevenue', debit: 0, credit: 600 },
      ],
    };
    expect(closeOntology.evaluate('bh:TrialBalance', tb, {})).toEqual([]);
    const broken = { ...tb, rows: [...tb.rows, { accountNumber: '6000', accountName: 'Wages', accountClass: 'expense' as const, normalBalance: 'debit' as const, subtype: 'bh:SalariesAndWages', debit: 50, credit: 0 }] };
    expect(ids(closeOntology.evaluate('bh:TrialBalance', broken, {}))).toEqual(expect.arrayContaining(['AX-TB-01', 'AX-TB-02']));
  });

  it('exports machine-readable Turtle and JSON-LD with a stable content hash', () => {
    const ttl = toTurtle(closeOntology);
    expect(ttl).toContain('@prefix bh: <https://bookhand.dev/ontology/close#>');
    expect(ttl).toContain('bh:Accrual a owl:Class');
    expect(ttl).toContain('rdfs:subClassOf bh:AdjustingEntry');
    const jsonld = toJsonLd(closeOntology);
    expect((jsonld['@graph'] as unknown[]).length).toBeGreaterThan(250);
    expect(closeOntology.hash).toMatch(/^[0-9a-f]{64}$/);
    const g = toGraph(closeOntology);
    expect(g.nodes.length).toBe(closeOntology.classes().length);
    expect(g.edges.filter((e) => e.kind === 'subClassOf').length).toBeGreaterThan(140);
  });
});
