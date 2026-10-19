import { describe, expect, it } from 'vitest';
import { closeOntology } from './index';
import { toJsonLd, toTurtle } from '../../../core/ontology/export';
import type { EntryFacts } from './axioms';

const o = closeOntology();

describe('close ontology: structure', () => {
  it('loads, is acyclic and well-referenced', () => {
    const s = o.stats();
    expect(s.classes).toBeGreaterThan(150);
    expect(s.axioms).toBeGreaterThanOrEqual(35);
    expect(s.executableAxioms).toBe(s.axioms);
    expect(s.relations).toBeGreaterThan(60);
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('covers the mandated domains', () => {
    const required = [
      'tie:AssetAccount', 'tie:LiabilityAccount', 'tie:EquityAccount', 'tie:RevenueAccount', 'tie:ExpenseAccount', 'tie:ChartOfAccounts', 'tie:FinancialStatementLineItem',
      'tie:Department', 'tie:Location', 'tie:ProductClass', 'tie:Project',
      'tie:OpenPeriod', 'tie:SoftClosedPeriod', 'tie:LockedPeriod',
      'tie:StandardEntry', 'tie:AdjustingEntry', 'tie:AccrualEntry', 'tie:ReversingEntry', 'tie:RecurringEntry', 'tie:ReclassEntry', 'tie:EliminationEntry',
      'tie:APSubledger', 'tie:ARSubledger', 'tie:CashSubledger', 'tie:CardSubledger', 'tie:FixedAssetRegister', 'tie:PrepaidRegister', 'tie:PayrollRegister',
      'tie:BankReconciliation', 'tie:ReconciliationMatch', 'tie:ReconcilingItem', 'tie:Aging', 'tie:Certification',
      'tie:AccruedExpense', 'tie:Deferral', 'tie:Amortization',
      'tie:PeriodOverPeriodFlux', 'tie:BudgetVsActual', 'tie:VarianceThreshold', 'tie:VarianceDriver', 'tie:VarianceExplanation',
      'tie:IntercompanyTransaction', 'tie:Elimination', 'tie:FunctionalCurrency', 'tie:ReportingCurrency', 'tie:Remeasurement',
      'tie:MakerChecker', 'tie:SegregationOfDuties', 'tie:Evidence', 'tie:CloseCalendar', 'tie:Workday', 'tie:TaskDependency',
      'tie:ExistenceOccurrence', 'tie:Completeness', 'tie:AccuracyValuation', 'tie:Cutoff', 'tie:Classification', 'tie:RightsObligations', 'tie:PresentationDisclosure',
      'tie:OverallMateriality', 'tie:PerformanceMateriality', 'tie:ClearlyTrivialThreshold',
    ];
    for (const id of required) expect(o.hasClass(id), id).toBe(true);
  });

  it('answers subsumption queries', () => {
    expect(o.isA('tie:AccrualEntry', 'tie:JournalEntry')).toBe(true);
    expect(o.isA('tie:AccrualEntry', 'tie:EconomicEvent')).toBe(true);
    expect(o.isA('tie:AccountsPayable', 'tie:ControlAccount')).toBe(true);
    expect(o.isA('tie:Cutoff', 'tie:AuditAssertion')).toBe(true);
    expect(o.isA('tie:Vendor', 'tie:InternalAgent')).toBe(false);
    expect(o.descendants('tie:ReconcilingItem')).toContain('tie:UnexplainedDifference');
  });

  it('explains terms for non-experts, by id, label or synonym', () => {
    for (const q of ['tie:Accrual', 'accrual', 'GRNI', 'WD+n', 'flux', 'SoD', 'tie out']) {
      const e = o.explain(q);
      expect(e, q).not.toBeNull();
      expect(e!.definition.length).toBeGreaterThan(20);
      expect(e!.whyItMatters.length).toBeGreaterThan(20);
      expect(e!.example.length).toBeGreaterThan(5);
    }
    expect(o.explain('tie:JournalEntry')!.axioms.map((a) => a.id)).toContain('AX-DE-01');
  });

  it('generates JSON Schema for agent tools from class properties', () => {
    const s = o.jsonSchema('tie:JournalEntry') as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(['entityId', 'periodKey', 'postingDate', 'entryType', 'memo', 'lines']));
    expect(s.required).toContain('lines');
  });

  it('exports JSON-LD and Turtle', () => {
    const ld = toJsonLd(o) as { '@graph': unknown[] };
    expect(ld['@graph'].length).toBeGreaterThan(200);
    const ttl = toTurtle(o);
    expect(ttl).toContain('tie:JournalEntry a owl:Class');
    expect(ttl).toContain('rdfs:subClassOf tie:EconomicEvent');
  });
});

describe('close ontology: executable axioms', () => {
  const acct = (code: string, extra: Partial<{ required_dimensions: string[]; is_postable: boolean; status: string }> = {}) => ({ code, is_postable: true, status: 'active', required_dimensions: [], ...extra });
  const period = { period_key: '2026-09', status: 'open', start_date: '2026-09-01', end_date: '2026-09-30' };

  it('AX-DE-01 rejects unbalanced entries and accepts balanced ones', () => {
    const bad: EntryFacts = { lines: [{ debit_minor: 1000, credit_minor: 0 }, { debit_minor: 0, credit_minor: 999 }] };
    expect(o.check('AX-DE-01', bad).passed).toBe(false);
    const good: EntryFacts = { lines: [{ debit_minor: 1000, credit_minor: 0 }, { debit_minor: 0, credit_minor: 1000 }] };
    expect(o.check('AX-DE-01', good).passed).toBe(true);
  });

  it('AX-DE-02 rejects two-sided or zero lines', () => {
    expect(o.check('AX-DE-02', { lines: [{ debit_minor: 5, credit_minor: 5 }] }).passed).toBe(false);
    expect(o.check('AX-DE-02', { lines: [{ debit_minor: 0, credit_minor: 0 }] }).passed).toBe(false);
  });

  it('AX-PD-01 enforces period states', () => {
    const facts = (status: string, entry_type: string): EntryFacts => ({ entry_type, period: { ...period, status } });
    expect(o.check('AX-PD-01', facts('open', 'standard')).passed).toBe(true);
    expect(o.check('AX-PD-01', facts('soft_closed', 'standard')).passed).toBe(false);
    expect(o.check('AX-PD-01', facts('soft_closed', 'accrual')).passed).toBe(true);
    expect(o.check('AX-PD-01', facts('locked', 'adjusting')).passed).toBe(false);
  });

  it('AX-AC-02 requires declared dimensions', () => {
    const facts: EntryFacts = { lines: [{ debit_minor: 100, credit_minor: 0, account: acct('6500', { required_dimensions: ['department'] }) }, { debit_minor: 0, credit_minor: 100, account: acct('2110') }] };
    const r = o.check('AX-AC-02', facts);
    expect(r.passed).toBe(false);
    expect(r.messages[0]).toContain('6500');
  });

  it('AX-SOD-01 forbids self-approval', () => {
    expect(o.check('AX-SOD-01', { prepared_by: 'usr_a', approved_by: 'usr_a', approval_route: 'human' }).passed).toBe(false);
    expect(o.check('AX-SOD-01', { prepared_by: 'agent:accruals', approved_by: 'usr_a', approval_route: 'human' }).passed).toBe(true);
  });

  it('AX-ACR-01 requires next-period auto-reversal for accruals', () => {
    expect(o.check('AX-ACR-01', { entry_type: 'accrual', auto_reverse_on: null }).passed).toBe(false);
    expect(o.check('AX-ACR-01', { entry_type: 'accrual', auto_reverse_on: '2026-10-02', next_period_start: '2026-10-01' }).passed).toBe(false);
    expect(o.check('AX-ACR-01', { entry_type: 'accrual', auto_reverse_on: '2026-10-01', next_period_start: '2026-10-01' }).passed).toBe(true);
  });

  it('AX-REC-01 ties out a bank reconciliation with timing items', () => {
    // statement 1,000.00; deposit in transit +275.00; outstanding check -12.36; GL 1,265.64 minus fee 2.00 => adjusted both 1,262.64
    const facts = { externalBalanceMinor: 100000, glBalanceMinor: 126464, items: [{ side: 'external' as const, amount_minor: 27500 }, { side: 'external' as const, amount_minor: -1236 }, { side: 'ledger' as const, amount_minor: -200 }] };
    expect(o.check('AX-REC-01', facts).passed).toBe(true);
    expect(o.check('AX-REC-01', { ...facts, items: facts.items.slice(0, 2) }).passed).toBe(false);
  });

  it('AX-MAT-01 orders materiality thresholds', () => {
    expect(o.check('AX-MAT-01', { clearlyTrivialMinor: 750000, performanceMinor: 9000000, overallMinor: 15000000 }).passed).toBe(true);
    expect(o.check('AX-MAT-01', { clearlyTrivialMinor: 9000000, performanceMinor: 750000, overallMinor: 15000000 }).passed).toBe(false);
  });

  it('AX-FLX-02 requires drivers to explain the variance', () => {
    expect(o.check('AX-FLX-02', { varianceMinor: 10000000, driverMinors: [9500000] }).passed).toBe(true);
    expect(o.check('AX-FLX-02', { varianceMinor: 10000000, driverMinors: [5000000] }).passed).toBe(false);
  });

  it('AX-AGT-02 blocks auto-posting of injection-flagged proposals', () => {
    expect(o.check('AX-AGT-02', { flags: ['injection_suspected'], route: 'auto_post' }).passed).toBe(false);
    expect(o.check('AX-AGT-02', { flags: ['injection_suspected'], route: 'human_approval' }).passed).toBe(true);
  });

  it('validate() runs every applicable axiom for a class', () => {
    const facts: EntryFacts = { lines: [{ debit_minor: 500, credit_minor: 0, account: acct('6100') }, { debit_minor: 0, credit_minor: 500, account: acct('1010') }], entry_type: 'standard', period, posting_date: '2026-09-15', prepared_by: 'usr_a', approved_by: 'usr_b', approval_route: 'human' };
    const results = o.validate('tie:JournalEntry', facts);
    expect(results.length).toBeGreaterThanOrEqual(8);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });
});
