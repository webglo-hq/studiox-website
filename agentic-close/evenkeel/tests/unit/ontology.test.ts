import { describe, expect, it } from 'vitest';
import { defineOntology, OntologyIntegrityError } from '../../src/framework/ontology/model';
import { closeOntology, type AccountInfo, type AccountingAxiomContext, type JournalEntryDraft } from '../../src/packs/accounting/ontology';

const ACC = (id: string, over: Partial<AccountInfo> = {}): AccountInfo => ({
  id,
  code: id.slice(0, 4),
  name: `Account ${id.slice(0, 4)}`,
  accountClass: 'expense',
  normalBalance: 'debit',
  isPostable: true,
  isActive: true,
  requiresDepartment: false,
  isControlAccount: false,
  subledger: null,
  isIntercompany: false,
  isMonetary: false,
  concept: null,
  ...over,
});

const ids = {
  cash: '00000000-0000-4000-8000-000000000001',
  exp: '00000000-0000-4000-8000-000000000002',
  ap: '00000000-0000-4000-8000-000000000003',
  sum: '00000000-0000-4000-8000-000000000004',
  ic: '00000000-0000-4000-8000-000000000005',
  ent: '00000000-0000-4000-8000-0000000000e1',
  ent2: '00000000-0000-4000-8000-0000000000e2',
  dept: '00000000-0000-4000-8000-0000000000d1',
};

const accounts = new Map<string, AccountInfo>([
  [ids.cash, ACC(ids.cash, { accountClass: 'asset', isControlAccount: true, subledger: 'bank', isMonetary: true })],
  [ids.exp, ACC(ids.exp, { requiresDepartment: true })],
  [ids.ap, ACC(ids.ap, { accountClass: 'liability', normalBalance: 'credit', isControlAccount: true, subledger: 'ap', isMonetary: true })],
  [ids.sum, ACC(ids.sum, { isPostable: false })],
  [ids.ic, ACC(ids.ic, { accountClass: 'asset', isIntercompany: true, isMonetary: true })],
]);

const ctx: AccountingAxiomContext = {
  accounts,
  period: { key: '2026-09', status: 'open', startDate: '2026-09-01', endDate: '2026-09-30' },
  entity: { id: ids.ent, code: 'US', functionalCurrency: 'USD', isElimination: false },
};

function je(over: Partial<JournalEntryDraft> = {}): JournalEntryDraft {
  return {
    entityId: ids.ent,
    entryDate: '2026-09-30',
    periodKey: '2026-09',
    entryType: 'standard',
    memo: 'Test entry',
    currency: 'USD',
    lines: [
      { accountId: ids.exp, debit: 10_000, credit: 0, departmentId: ids.dept },
      { accountId: ids.ap, debit: 0, credit: 10_000 },
    ],
    ...over,
  };
}

describe('close ontology', () => {
  const onto = closeOntology();

  it('compiles with full integrity (no dangling references, cycles or missing definitions)', () => {
    expect(onto.allClasses().length).toBeGreaterThan(100);
    expect(onto.allAxioms().length).toBeGreaterThanOrEqual(30);
    expect(onto.allRelations().length).toBeGreaterThan(40);
    expect(onto.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('covers the required close concepts', () => {
    for (const id of [
      'ek:AssetAccount', 'ek:LiabilityAccount', 'ek:EquityAccount', 'ek:RevenueAccount', 'ek:ExpenseAccount', 'ek:NormalBalance',
      'ek:FinancialStatementLineItem', 'ek:Department', 'ek:Location', 'ek:ClassDimension', 'ek:Project', 'ek:FiscalPeriod', 'ek:PeriodState',
      'ek:JournalEntry', 'ek:JournalLine', 'ek:ReversingEntry', 'ek:RecurringEntry', 'ek:EliminationEntry', 'ek:ApSubledger', 'ek:ArSubledger',
      'ek:BankSubledger', 'ek:CardSubledger', 'ek:FixedAssetSubledger', 'ek:PrepaidSubledger', 'ek:PayrollSubledger', 'ek:BankReconciliation',
      'ek:Match', 'ek:ReconcilingItem', 'ek:Certification', 'ek:Accrual', 'ek:Deferral', 'ek:PrepaidSchedule', 'ek:DepreciationSchedule',
      'ek:FluxAnalysis', 'ek:VarianceThreshold', 'ek:VarianceDriver', 'ek:VarianceExplanation', 'ek:IntercompanyBalance', 'ek:Revaluation',
      'ek:Translation', 'ek:MakerChecker', 'ek:SegregationOfDuties', 'ek:Evidence', 'ek:Assertion', 'ek:Materiality', 'ek:Workday',
      'ek:TaskDependency', 'ek:AutonomyLevel',
    ]) {
      expect(onto.hasClass(id), id).toBe(true);
    }
    expect(onto.individualsOf('ek:Assertion').map((i) => i.label)).toEqual(
      expect.arrayContaining(['Existence', 'Occurrence', 'Completeness', 'Accuracy', 'Valuation & allocation', 'Cutoff', 'Classification', 'Rights & obligations', 'Presentation & disclosure']),
    );
    expect(onto.individualsOf('ek:PeriodState')).toHaveLength(3);
    expect(onto.individualsOf('ek:AutonomyLevel').map((i) => i.id)).toEqual(['ek:L0', 'ek:L1', 'ek:L2', 'ek:L3']);
  });

  it('supports subsumption reasoning', () => {
    expect(onto.isA('ek:DepositInTransit', 'ek:ReconcilingItem')).toBe(true);
    expect(onto.isA('ek:Accrual', 'ek:JournalEntry')).toBe(true);
    expect(onto.isA('ek:Accrual', 'ek:EconomicEvent')).toBe(true);
    expect(onto.isA('ek:Vendor', 'ek:EconomicAgent')).toBe(true);
    expect(onto.isA('ek:AccumulatedDepreciationAccount', 'ek:ContraAccount')).toBe(true);
    // Axioms on JournalEntry are inherited by Accrual
    expect(onto.axiomsFor('ek:Accrual').map((a) => a.id)).toContain('AX-DE-01');
  });

  it('accepts a valid balanced entry', () => {
    const res = onto.validate('ek:JournalEntry', je(), ctx);
    expect(res.violations).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.checked).toContain('AX-DE-01');
  });

  it('rejects an unbalanced entry (AX-DE-01)', () => {
    const res = onto.validate('ek:JournalEntry', je({ lines: [{ accountId: ids.exp, debit: 10_000, credit: 0, departmentId: ids.dept }, { accountId: ids.ap, debit: 0, credit: 9_999 }] }), ctx);
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.axiomId)).toContain('AX-DE-01');
  });

  it('rejects two-sided lines, summary accounts and missing departments', () => {
    const res = onto.validate(
      'ek:JournalEntry',
      je({
        lines: [
          { accountId: ids.exp, debit: 100, credit: 100 },
          { accountId: ids.sum, debit: 0, credit: 0 },
        ],
      }),
      ctx,
    );
    const axIds = res.violations.map((v) => v.axiomId);
    expect(axIds).toEqual(expect.arrayContaining(['AX-DE-02', 'AX-ACC-01', 'AX-ACC-03']));
  });

  it('enforces period states (AX-PER-01) and cutoff (AX-PER-02)', () => {
    const locked = onto.validate('ek:JournalEntry', je(), { ...ctx, period: { ...ctx.period!, status: 'hard_close' } });
    expect(locked.violations.map((v) => v.axiomId)).toContain('AX-PER-01');
    const softStaff = onto.validate('ek:JournalEntry', je({ entryType: 'accrual', autoReverseDate: '2026-10-01' }), { ...ctx, period: { ...ctx.period!, status: 'soft_close' }, actorRoles: ['staff_accountant'] });
    expect(softStaff.ok).toBe(false);
    const softSenior = onto.validate('ek:JournalEntry', je({ entryType: 'accrual', autoReverseDate: '2026-10-01' }), { ...ctx, period: { ...ctx.period!, status: 'soft_close' }, actorRoles: ['senior_accountant'] });
    expect(softSenior.ok).toBe(true);
    const cutoff = onto.validate('ek:JournalEntry', je({ entryDate: '2026-10-01' }), ctx);
    expect(cutoff.violations.map((v) => v.axiomId)).toContain('AX-PER-02');
  });

  it('requires accruals to auto-reverse on the first day of the next period (AX-JE-03)', () => {
    const bad = onto.validate('ek:JournalEntry', je({ entryType: 'accrual' }), ctx);
    expect(bad.violations.map((v) => v.axiomId)).toContain('AX-JE-03');
    const good = onto.validate('ek:JournalEntry', je({ entryType: 'accrual', autoReverseDate: '2026-10-01' }), ctx);
    expect(good.ok).toBe(true);
  });

  it('enforces maker-checker (AX-SOD-01)', () => {
    const u = '00000000-0000-4000-8000-0000000000a1';
    expect(onto.validate('ek:JournalEntry', je(), { ...ctx, preparedBy: u, approvedBy: u }).violations.map((v) => v.axiomId)).toContain('AX-SOD-01');
    expect(onto.validate('ek:JournalEntry', je(), { ...ctx, requestedBy: u, approvedBy: u }).ok).toBe(false);
    expect(onto.validate('ek:JournalEntry', je(), { ...ctx, preparedBy: u, approvedBy: ids.dept }).ok).toBe(true);
  });

  it('flags manual control-account postings as warnings without blocking (AX-ACC-04)', () => {
    const res = onto.validate('ek:JournalEntry', je(), { ...ctx, source: 'manual' });
    expect(res.ok).toBe(true);
    expect(res.violations.find((v) => v.axiomId === 'AX-ACC-04')?.severity).toBe('warning');
  });

  it('requires intercompany counterparties and eliminations in the elimination entity', () => {
    const ic = je({ lines: [{ accountId: ids.ic, debit: 500, credit: 0 }, { accountId: ids.ap, debit: 0, credit: 500 }] });
    expect(onto.validate('ek:JournalEntry', ic, ctx).violations.map((v) => v.axiomId)).toContain('AX-IC-02');
    const icOk = je({ lines: [{ accountId: ids.ic, debit: 500, credit: 0, counterpartyEntityId: ids.ent2 }, { accountId: ids.ap, debit: 0, credit: 500 }] });
    expect(onto.validate('ek:JournalEntry', icOk, ctx).ok).toBe(true);
    expect(onto.validate('ek:JournalEntry', je({ entryType: 'elimination' }), ctx).violations.map((v) => v.axiomId)).toContain('AX-JE-04');
  });

  it('validates reversals mirror the original (AX-JE-02)', () => {
    const original = { entityId: ids.ent, entryDate: '2026-09-10', status: 'posted', reversedByEntryId: null, lines: [{ accountId: ids.exp, debit: 10_000, credit: 0 }, { accountId: ids.ap, debit: 0, credit: 10_000 }] };
    const rev = je({ entryType: 'reversing', reversesEntryId: ids.sum, lines: [{ accountId: ids.exp, debit: 0, credit: 10_000, departmentId: ids.dept }, { accountId: ids.ap, debit: 10_000, credit: 0 }] });
    expect(onto.validate('ek:JournalEntry', rev, { ...ctx, original }).ok).toBe(true);
    const wrong = je({ entryType: 'reversing', reversesEntryId: ids.sum });
    expect(onto.validate('ek:JournalEntry', wrong, { ...ctx, original }).violations.map((v) => v.axiomId)).toContain('AX-JE-02');
  });

  it('checks reconciliation, flux, intercompany, materiality and lock axioms', () => {
    const rec = { glBalance: 1000, statementBalance: 900, reconcilingTotal: 100, unexplained: 0, status: 'prepared', preparedBy: 'a', reviewedBy: 'b', evidenceCount: 1, items: [], tolerance: 0 };
    expect(onto.validate('ek:BankReconciliation', rec, {}).ok).toBe(true);
    expect(onto.validate('ek:BankReconciliation', { ...rec, unexplained: 185_000 }, {}).violations.map((v) => v.axiomId)).toContain('AX-REC-01');
    expect(onto.validate('ek:BankReconciliation', { ...rec, reviewedBy: 'a' }, {}).violations.map((v) => v.axiomId)).toContain('AX-REC-03');
    expect(onto.validate('ek:Variance', { isMaterial: true, variance: 1, explanation: null }, {}).ok).toBe(false);
    expect(onto.validate('ek:IntercompanyBalance', { entityA: 'US', entityB: 'UK', dueFromReporting: 1000, dueToReporting: 660, tolerance: 100 }, {}).ok).toBe(false);
    expect(onto.validate('ek:Materiality', { overall: 300, performance: 225, clearlyTrivial: 15 }, {}).ok).toBe(true);
    expect(onto.validate('ek:Materiality', { overall: 300, performance: 400, clearlyTrivial: 15 }, {}).ok).toBe(false);
    const lock = onto.validate('ek:FiscalPeriod', { openTasks: 1, uncertifiedRecs: 0, unexplainedMaterialFlux: 0, pendingProposals: 2, packageGenerated: false, openCriticalIssues: 0 }, {});
    expect(lock.violations).toHaveLength(3);
  });

  it('detects dependency cycles (AX-CLS-01)', () => {
    const res = onto.validate('ek:CloseCycle', { tasks: [{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', dependsOn: ['a'] }] }, {});
    expect(res.ok).toBe(false);
  });

  it('explains terms for non-experts', () => {
    const t = onto.explain('ek:Accrual')!;
    expect(t.plain).toMatch(/bill/i);
    expect(t.why!.length).toBeGreaterThan(10);
    expect(t.example!.length).toBeGreaterThan(10);
    expect(onto.search('accru').map((x) => x.id)).toContain('ek:Accrual');
    expect(onto.search('SoD').map((x) => x.id)).toContain('ek:SegregationOfDuties');
  });

  it('exports machine-readable JSON-LD and Turtle and typed JSON Schemas', () => {
    const jsonld = onto.toJsonLd() as { '@graph': { '@id': string }[] };
    expect(jsonld['@graph'].some((n) => n['@id'] === 'ek:JournalEntry')).toBe(true);
    const ttl = onto.toTurtle();
    expect(ttl).toContain('ek:JournalEntry a owl:Class');
    const schema = onto.jsonSchema('ek:JournalEntry');
    expect(JSON.stringify(schema)).toContain('lines');
  });

  it('powers the graph view', () => {
    const g = onto.graph();
    expect(g.nodes.length).toBeGreaterThan(140);
    expect(g.edges.some((e) => e.kind === 'subClassOf')).toBe(true);
  });

  it('refuses to build an inconsistent ontology', () => {
    expect(() =>
      defineOntology({
        ...onto.spec,
        classes: [...onto.spec.classes, { id: 'ek:Broken', label: 'Broken', parents: ['ek:Missing'], module: 'ledger', definition: 'x', plain: 'x', why: 'x', example: 'x' }],
      }),
    ).toThrow(OntologyIntegrityError);
  });
});
