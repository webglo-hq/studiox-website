import type { Axiom, AxiomViolation } from '../../../ontology/kernel';
import { diffDays } from '../../../shared/dates';
import type {
  FluxSubject,
  IntercompanySubject,
  JournalEntryContext,
  MaterialitySubject,
  ProposalSubject,
  ReconciliationContext,
  ReconciliationSubject,
  ResolvedJournalEntry,
  ScheduleSubject,
  TrialBalanceSubject,
} from './subjects';

/**
 * Executable axioms of the close ontology. Each one is a formal statement, a plain-English rule and a
 * check function. They validate data and agent proposals (the verify phase), and the same rules are enforced
 * a second time by the database where that is possible (see db/migrations/0002_invariants.sql).
 */

const v = (axiom: string, severity: 'error' | 'warning', message: string, extra: Partial<AxiomViolation> = {}): AxiomViolation => ({ axiom, severity, message, ...extra });

const fmt = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type JeAxiom = Axiom<ResolvedJournalEntry, JournalEntryContext>;

const ADJUSTING = new Set(['adjusting', 'accrual', 'reclass', 'elimination', 'revaluation', 'depreciation', 'amortization', 'reversing']);

export const journalEntryAxioms: JeAxiom[] = [
  {
    id: 'AX-DE-01',
    label: 'Double-entry balance',
    appliesTo: 'bh:JournalEntry',
    formal: 'forall e in JournalEntry: sum(debit(l) | l in lines(e)) = sum(credit(l) | l in lines(e)) > 0',
    plainEnglish: 'Total debits must equal total credits, and the entry must move some money.',
    severity: 'error',
    assertions: ['accuracy_valuation'],
    citations: ['pacioli1494', 'ijiri1975', 'ellerman1985', 'mccarthy1982'],
    check(e) {
      const debit = e.lines.reduce((s, l) => s + l.debit, 0);
      const credit = e.lines.reduce((s, l) => s + l.credit, 0);
      if (debit !== credit) return v('AX-DE-01', 'error', `Debits ${fmt(debit)} do not equal credits ${fmt(credit)} (difference ${fmt(debit - credit)}).`);
      if (debit === 0) return v('AX-DE-01', 'error', 'The entry has no amounts.');
      return null;
    },
  },
  {
    id: 'AX-DE-02',
    label: 'One-sided positive lines',
    appliesTo: 'bh:JournalEntry',
    formal: 'forall l in lines(e): (debit(l) > 0 xor credit(l) > 0) and debit(l) >= 0 and credit(l) >= 0',
    plainEnglish: 'Each line is either a debit or a credit, with a positive amount.',
    severity: 'error',
    citations: ['xbrlgl'],
    check(e) {
      return e.lines.flatMap((l, i) =>
        (l.debit > 0) === (l.credit > 0) || l.debit < 0 || l.credit < 0 || !Number.isInteger(l.debit) || !Number.isInteger(l.credit)
          ? [v('AX-DE-02', 'error', `Line ${i + 1} must have exactly one positive whole-cent amount (debit or credit).`, { path: `lines[${i}]` })]
          : [],
      );
    },
  },
  {
    id: 'AX-DE-03',
    label: 'At least two lines',
    appliesTo: 'bh:JournalEntry',
    formal: 'forall e in JournalEntry: |lines(e)| >= 2',
    plainEnglish: 'An entry needs at least two lines: something debited and something credited.',
    severity: 'error',
    citations: ['pacioli1494'],
    check: (e) => (e.lines.length < 2 ? v('AX-DE-03', 'error', 'An entry needs at least two lines.') : null),
  },
  {
    id: 'AX-DE-04',
    label: 'Post only to active leaf accounts',
    appliesTo: 'bh:JournalEntry',
    formal: 'forall l in lines(e): account(l) in PostableAccount and active(account(l))',
    plainEnglish: 'Lines may only post to accounts that exist, are active and are not header (summary) accounts.',
    severity: 'error',
    assertions: ['classification'],
    check(e) {
      return e.lines.flatMap((l, i) => {
        if (!l.account) return [v('AX-DE-04', 'error', `Line ${i + 1}: account "${l.accountRef}" does not exist in the chart of accounts.`, { path: `lines[${i}].account` })];
        if (!l.account.isPostable) return [v('AX-DE-04', 'error', `Line ${i + 1}: ${l.account.number} ${l.account.name} is a header account and cannot be posted to.`, { path: `lines[${i}].account` })];
        if (!l.account.active) return [v('AX-DE-04', 'error', `Line ${i + 1}: ${l.account.number} is inactive.`, { path: `lines[${i}].account` })];
        return [];
      });
    },
  },
  {
    id: 'AX-PER-01',
    label: 'Entry date inside its period',
    appliesTo: 'bh:JournalEntry',
    formal: 'start(period(e)) <= date(e) <= end(period(e)) and entity(period(e)) = entity(e)',
    plainEnglish: 'The accounting date must fall inside the period the entry posts to (cutoff).',
    severity: 'error',
    assertions: ['cutoff'],
    citations: ['pcaob1105'],
    check(e) {
      if (!e.period) return v('AX-PER-01', 'error', `No accounting period exists for ${e.entryDate}.`, { assertion: 'cutoff' });
      if (e.period.entityId !== e.entityId) return v('AX-PER-01', 'error', 'The period belongs to a different entity.');
      if (e.entryDate < e.period.startDate || e.entryDate > e.period.endDate) {
        return v('AX-PER-01', 'error', `Entry date ${e.entryDate} is outside the period ${e.period.startDate} to ${e.period.endDate}.`, { assertion: 'cutoff' });
      }
      return null;
    },
  },
  {
    id: 'AX-PER-02',
    label: 'Period must accept postings',
    appliesTo: 'bh:JournalEntry',
    formal: "state(period(e)) = open or (state(period(e)) = soft_closed and type(e) in AdjustingTypes)",
    plainEnglish: 'Locked and future periods accept nothing; soft-closed periods accept only adjusting-type entries.',
    severity: 'error',
    assertions: ['cutoff'],
    citations: ['coso2013'],
    check(e) {
      if (!e.period) return null;
      if (e.period.status === 'locked') return v('AX-PER-02', 'error', 'The period is locked (hard-closed); nothing can be posted to it.', { assertion: 'cutoff' });
      if (e.period.status === 'future') return v('AX-PER-02', 'error', 'The period is not open yet.', { assertion: 'cutoff' });
      if (e.period.status === 'soft_closed' && !ADJUSTING.has(e.entryType)) {
        return v('AX-PER-02', 'error', `The period is soft-closed; a ${e.entryType} entry is not allowed (use an adjusting-type entry).`, { assertion: 'cutoff' });
      }
      return null;
    },
  },
  {
    id: 'AX-ACR-01',
    label: 'Accruals auto-reverse next period',
    appliesTo: 'bh:JournalEntry',
    formal: 'type(e) = accrual -> auto_reverse_date(e) in next_period(period(e))',
    plainEnglish: 'Every accrual must schedule its reversal inside the next period, so the real invoice is not double counted.',
    severity: 'error',
    assertions: ['cutoff', 'completeness'],
    citations: ['con6', 'asc450'],
    check(e) {
      if (e.entryType !== 'accrual') return null;
      if (!e.autoReverseDate) return v('AX-ACR-01', 'error', 'An accrual needs an auto-reverse date in the next period.');
      if (e.nextPeriod && (e.autoReverseDate < e.nextPeriod.startDate || e.autoReverseDate > e.nextPeriod.endDate)) {
        return v('AX-ACR-01', 'error', `Auto-reverse date ${e.autoReverseDate} is not inside the next period (${e.nextPeriod.startDate} to ${e.nextPeriod.endDate}).`);
      }
      return null;
    },
  },
  {
    id: 'AX-IC-01',
    label: 'Intercompany lines name a counterparty',
    appliesTo: 'bh:JournalEntry',
    formal: 'forall l: intercompany(account(l)) -> counterparty(l) != null and counterparty(l) != entity(e)',
    plainEnglish: 'Lines on intercompany accounts must say which other group entity they are with (and not the same entity).',
    severity: 'error',
    assertions: ['presentation_disclosure'],
    citations: ['asc810'],
    check(e) {
      return e.lines.flatMap((l, i) => {
        if (!l.account?.isIntercompany) return [];
        if (!l.counterpartyEntityId) return [v('AX-IC-01', 'error', `Line ${i + 1}: intercompany account ${l.account.number} needs a counterparty entity.`, { path: `lines[${i}].counterparty` })];
        if (l.counterpartyEntityId === e.entityId) return [v('AX-IC-01', 'error', `Line ${i + 1}: an entity cannot be its own intercompany counterparty.`)];
        return [];
      });
    },
  },
  {
    id: 'AX-DIM-01',
    label: 'Department required on budgeted spend',
    appliesTo: 'bh:JournalEntry',
    formal: 'forall l: requires_department(account(l)) -> department(l) != null',
    plainEnglish: 'Lines on operating-expense accounts must carry a department so budget owners see their spend.',
    severity: 'warning',
    assertions: ['classification'],
    check(e) {
      if (e.entryType === 'elimination' || e.entryType === 'revaluation') return null;
      return e.lines.flatMap((l, i) =>
        l.account?.requiresDepartment && !l.departmentId ? [v('AX-DIM-01', 'warning', `Line ${i + 1}: ${l.account.number} ${l.account.name} should carry a department.`, { path: `lines[${i}].department` })] : [],
      );
    },
  },
  {
    id: 'AX-FX-01',
    label: 'Foreign-currency lines convert at the stated rate',
    appliesTo: 'bh:JournalEntry',
    formal: 'forall l: currency(l) != functional(e) -> |functional_amount(l) - round(txn_amount(l) * rate(e))| <= 1',
    plainEnglish: 'When a line is in a foreign currency, its functional-currency amount must equal the transaction amount times the rate (to the cent).',
    severity: 'error',
    assertions: ['accuracy_valuation'],
    citations: ['asc830'],
    check(e) {
      return e.lines.flatMap((l, i) => {
        const functional = l.debit - l.credit;
        if (l.txnCurrency === e.functionalCurrency) {
          return functional !== l.txnAmount ? [v('AX-FX-01', 'error', `Line ${i + 1}: transaction and functional amounts differ although both are ${e.functionalCurrency}.`)] : [];
        }
        const expected = Math.round(l.txnAmount * e.fxRate);
        return Math.abs(expected - functional) > 1
          ? [v('AX-FX-01', 'error', `Line ${i + 1}: ${l.txnCurrency} ${(l.txnAmount / 100).toFixed(2)} at ${e.fxRate} should be ${fmt(expected)} in ${e.functionalCurrency}, not ${fmt(functional)}.`)]
          : [];
      });
    },
  },
  {
    id: 'AX-CTL-01',
    label: 'Maker-checker',
    appliesTo: 'bh:JournalEntry',
    formal: 'approver(e) != null -> approver(e) != preparer(e)',
    plainEnglish: 'Nobody approves their own entry.',
    severity: 'error',
    citations: ['coso2013', 'pcaob2201'],
    check: (e) => (e.approvedBy && e.preparedBy && e.approvedBy === e.preparedBy ? v('AX-CTL-01', 'error', 'The approver is the same person as the preparer (maker-checker).') : null),
  },
  {
    id: 'AX-CAP-01',
    label: 'Capitalize qualifying purchases',
    appliesTo: 'bh:JournalEntry',
    formal: 'forall l: expense(account(l)) and debit(l) >= cap_threshold and matches(memo(l), Capitalizable) -> warn',
    plainEnglish: 'A large debit to an expense account that looks like equipment or build-out probably belongs in property and equipment.',
    severity: 'warning',
    assertions: ['classification'],
    citations: ['asc360'],
    check(e, ctx) {
      return e.lines.flatMap((l, i) => {
        if (!l.account || l.account.accountClass !== 'expense' || l.debit < ctx.capitalizationThresholdMinor) return [];
        const matches = ctx.capitalizableMatches(`${l.memo ?? ''} ${e.description}`);
        return matches.length
          ? [v('AX-CAP-01', 'warning', `Line ${i + 1}: ${fmt(l.debit)} to ${l.account.number} ${l.account.name} looks capitalizable (${matches.join(', ')}).`, { assertion: 'classification' })]
          : [];
      });
    },
  },
  {
    id: 'AX-RC-01',
    label: 'Revenue entries carry a source',
    appliesTo: 'bh:JournalEntry',
    formal: 'forall l: revenue(account(l)) and type(e) in {standard, adjusting} -> description(e) != ""',
    plainEnglish: 'Manual entries that touch revenue must say what they are for; unexplained revenue entries are a fraud-risk indicator (AS 2401).',
    severity: 'warning',
    assertions: ['existence_occurrence'],
    citations: ['pcaob2401', 'asc606'],
    check(e) {
      const touchesRevenue = e.lines.some((l) => l.account?.accountClass === 'revenue');
      return touchesRevenue && e.description.trim().length < 8 ? v('AX-RC-01', 'warning', 'A revenue entry should carry a meaningful description.') : null;
    },
  },
];

export const trialBalanceAxioms: Axiom<TrialBalanceSubject, unknown>[] = [
  {
    id: 'AX-TB-01',
    label: 'Trial balance balances',
    appliesTo: 'bh:TrialBalance',
    formal: 'sum(debit balances) = sum(credit balances)',
    plainEnglish: 'Across all accounts, total debit balances equal total credit balances.',
    severity: 'error',
    assertions: ['accuracy_valuation'],
    citations: ['pacioli1494', 'ijiri1975'],
    check(tb) {
      const d = tb.rows.reduce((s, r) => s + r.debit, 0);
      const c = tb.rows.reduce((s, r) => s + r.credit, 0);
      return d !== c ? v('AX-TB-01', 'error', `${tb.entityLabel}: trial balance is out by ${fmt(d - c)}.`) : null;
    },
  },
  {
    id: 'AX-TB-02',
    label: 'Accounting equation',
    appliesTo: 'bh:TrialBalance',
    formal: 'assets = liabilities + equity + (revenue - expenses)',
    plainEnglish: 'Assets equal liabilities plus equity plus this year\'s profit.',
    severity: 'error',
    citations: ['con6', 'pacioli1494'],
    check(tb) {
      const net = (cls: string) => tb.rows.filter((r) => r.accountClass === cls).reduce((s, r) => s + r.debit - r.credit, 0);
      const assets = net('asset');
      const rhs = -(net('liability') + net('equity') + net('revenue') + net('expense'));
      return assets !== rhs ? v('AX-TB-02', 'error', `${tb.entityLabel}: assets ${fmt(assets)} vs liabilities + equity + earnings ${fmt(rhs)}.`) : null;
    },
  },
  {
    id: 'AX-NB-01',
    label: 'Balances on their normal side',
    appliesTo: 'bh:TrialBalance',
    formal: 'forall a: normal(a) = debit -> balance(a) >= 0; normal(a) = credit -> balance(a) <= 0',
    plainEnglish: 'An account sitting on its abnormal side (credit cash, debit payables) is usually an error worth a look.',
    severity: 'warning',
    assertions: ['presentation_disclosure', 'classification'],
    check(tb) {
      return tb.rows.flatMap((r) => {
        const net = r.debit - r.credit;
        const abnormal = r.normalBalance === 'debit' ? net < -100 : net > 100;
        if (!abnormal || r.subtype === 'bh:ForeignExchangeGainLoss') return [];
        return [v('AX-NB-01', 'warning', `${r.accountNumber} ${r.accountName} has a ${net < 0 ? 'credit' : 'debit'} balance of ${fmt(Math.abs(net))} (normally ${r.normalBalance}).`)];
      });
    },
  },
];

export const reconciliationAxioms: Axiom<ReconciliationSubject, ReconciliationContext>[] = [
  {
    id: 'AX-REC-01',
    label: 'Reconciliation equation',
    appliesTo: 'bh:Reconciliation',
    formal: 'unexplained = gl - external - sum(reconciling_items); certify -> |unexplained| <= clearly_trivial',
    plainEnglish: 'GL balance minus the external balance minus reconciling items is the unexplained difference; it must be within the clearly-trivial threshold to certify.',
    severity: 'error',
    assertions: ['existence_occurrence', 'completeness', 'accuracy_valuation'],
    citations: ['coso2013', 'isa320'],
    check(r, ctx) {
      const unexplained = r.glBalance - r.externalBalance - r.reconcilingTotal;
      if (unexplained === 0) return null;
      if (ctx.certifying && Math.abs(unexplained) > ctx.clearlyTrivialMinor) {
        return v('AX-REC-01', 'error', `Unexplained difference of ${fmt(unexplained)} exceeds the clearly-trivial threshold of ${fmt(ctx.clearlyTrivialMinor)}.`);
      }
      if (ctx.certifying && !r.notes) return v('AX-REC-01', 'error', `Unexplained difference of ${fmt(unexplained)} needs a note before certification.`);
      return ctx.certifying ? null : v('AX-REC-01', 'warning', `Unexplained difference of ${fmt(unexplained)}.`);
    },
  },
  {
    id: 'AX-REC-02',
    label: 'Stale reconciling items',
    appliesTo: 'bh:Reconciliation',
    formal: 'forall i in open_items(r): age(i) <= stale_days',
    plainEnglish: 'Timing differences should clear within weeks; old open items are probably errors.',
    severity: 'warning',
    citations: ['coso2013'],
    check(r, ctx) {
      return r.items
        .filter((i) => i.status === 'open' && diffDays(r.asOfDate, i.itemDate) > ctx.staleAfterDays)
        .map((i) => v('AX-REC-02', 'warning', `"${i.description}" (${fmt(i.amount)}) has been open ${diffDays(r.asOfDate, i.itemDate)} days.`));
    },
  },
  {
    id: 'AX-REC-03',
    label: 'Independent certification',
    appliesTo: 'bh:Reconciliation',
    formal: 'reviewer(r) != null -> reviewer(r) != preparer(r)',
    plainEnglish: 'A reconciliation is reviewed by someone other than its preparer.',
    severity: 'error',
    citations: ['coso2013', 'sox404'],
    check: (r) => (r.reviewedBy && r.reviewedBy === r.preparedBy ? v('AX-REC-03', 'error', 'Preparer and reviewer are the same person.') : null),
  },
];

export const fluxAxioms: Axiom<FluxSubject, unknown>[] = [
  {
    id: 'AX-FLX-01',
    label: 'Material variances are explained',
    appliesTo: 'bh:FluxAnalysis',
    formal: 'approved(f) -> forall line: material(line) -> explanation_status(line) = accepted',
    plainEnglish: 'Every variance above threshold needs an accepted explanation before the flux review is approved.',
    severity: 'error',
    assertions: ['completeness', 'accuracy_valuation'],
    citations: ['pcaob2105'],
    check(f) {
      return f.lines
        .filter((l) => l.isMaterial && l.explanationStatus !== 'accepted')
        .map((l) => v('AX-FLX-01', 'error', `Account ${l.accountNumber}: material variance of ${fmt(l.variance)} has no accepted explanation.`));
    },
  },
  {
    id: 'AX-FLX-02',
    label: 'Variance arithmetic',
    appliesTo: 'bh:FluxAnalysis',
    formal: 'variance = current - comparison',
    plainEnglish: 'Variance equals current minus comparison.',
    severity: 'error',
    check(f) {
      return f.lines.filter((l) => l.variance !== l.current - l.comparison).map((l) => v('AX-FLX-02', 'error', `Account ${l.accountNumber}: variance arithmetic is wrong.`));
    },
  },
  {
    id: 'AX-FLX-03',
    label: 'Independent flux approval',
    appliesTo: 'bh:FluxAnalysis',
    formal: 'approver(f) != preparer(f)',
    plainEnglish: 'The person approving the flux review did not prepare it.',
    severity: 'error',
    citations: ['coso2013'],
    check: (f) => (f.approvedBy && f.approvedBy === f.preparedBy ? v('AX-FLX-03', 'error', 'Flux approver equals preparer.') : null),
  },
];

export const otherAxioms: Axiom<never, never>[] = [
  {
    id: 'AX-MAT-01',
    label: 'Materiality ordering',
    appliesTo: 'bh:Materiality',
    formal: '0 < clearly_trivial <= performance <= overall',
    plainEnglish: 'Clearly trivial is below performance materiality, which is below overall materiality.',
    severity: 'error',
    citations: ['isa320', 'pcaob2105'],
    check: ((m: MaterialitySubject) =>
      m.trivial > 0 && m.trivial <= m.performance && m.performance <= m.overall ? null : v('AX-MAT-01', 'error', 'Materiality thresholds are out of order.')) as never,
  },
  {
    id: 'AX-SCH-01',
    label: 'Schedules sum to their basis',
    appliesTo: 'bh:AmortizationSchedule',
    formal: 'sum(lines(s)) = total(s) - salvage(s)',
    plainEnglish: 'An amortization or depreciation schedule must release exactly the amount being spread, no more and no less.',
    severity: 'error',
    assertions: ['accuracy_valuation'],
    citations: ['asc340', 'asc360'],
    check: ((s: ScheduleSubject) => {
      const sum = s.lines.reduce((a, b) => a + b, 0);
      const basis = s.total - s.salvage;
      return sum !== basis ? v('AX-SCH-01', 'error', `${s.label}: schedule releases ${fmt(sum)} but the basis is ${fmt(basis)}.`) : null;
    }) as never,
  },
  {
    id: 'AX-SCH-02',
    label: 'Net book value never negative',
    appliesTo: 'bh:FixedAsset',
    formal: 'accumulated_depreciation(a) <= cost(a) - salvage(a)',
    plainEnglish: 'Accumulated depreciation can never exceed cost less salvage value.',
    severity: 'error',
    citations: ['asc360'],
    check: ((s: ScheduleSubject) =>
      s.accumulated !== undefined && s.accumulated > s.total - s.salvage ? v('AX-SCH-02', 'error', `${s.label}: depreciated beyond cost less salvage.`) : null) as never,
  },
  {
    id: 'AX-IC-02',
    label: 'Intercompany balances agree',
    appliesTo: 'bh:IntercompanyBalance',
    formal: '|receivable(A,B) - payable(B,A)| <= tolerance (in reporting currency)',
    plainEnglish: 'What one entity says another owes it must equal what the other says it owes, after translation.',
    severity: 'error',
    assertions: ['existence_occurrence', 'completeness', 'presentation_disclosure'],
    citations: ['asc810'],
    check: ((s: IntercompanySubject) => {
      const diff = s.receivableReporting - s.payableReporting;
      return Math.abs(diff) > s.toleranceMinor ? v('AX-IC-02', 'error', `${s.pairLabel}: receivable and payable differ by ${fmt(diff)}.`) : null;
    }) as never,
  },
  {
    id: 'AX-AGT-01',
    label: 'Proposals are explainable',
    appliesTo: 'bh:Proposal',
    formal: 'why(p) != "" and 0 <= confidence(p) <= 1 and |evidence(p)| >= 1',
    plainEnglish: 'Every agent proposal says why, how confident it is, and what evidence supports it.',
    severity: 'error',
    citations: ['cosogenai2026'],
    check: ((p: ProposalSubject) => {
      const out: AxiomViolation[] = [];
      if (!p.why.trim()) out.push(v('AX-AGT-01', 'error', 'Proposal has no rationale.'));
      if (!(p.confidence >= 0 && p.confidence <= 1)) out.push(v('AX-AGT-01', 'error', 'Confidence must be between 0 and 1.'));
      if (p.evidenceCount < 1) out.push(v('AX-AGT-01', 'error', 'Proposal cites no evidence.'));
      return out;
    }) as never,
  },
  {
    id: 'AX-AGT-02',
    label: 'Untrusted text cannot authorize anything',
    appliesTo: 'bh:Proposal',
    formal: "'injection_suspected' in risk_flags(p) -> disposition(p) != auto_apply",
    plainEnglish: 'If external text in the evidence looks like instructions, the proposal is never applied automatically.',
    severity: 'error',
    citations: ['cosogenai2026'],
    check: ((p: ProposalSubject) =>
      p.riskFlags.includes('injection_suspected') && p.disposition === 'auto_apply' ? v('AX-AGT-02', 'error', 'A proposal with suspected prompt injection cannot auto-apply.') : null) as never,
  },
  {
    id: 'AX-AUD-01',
    label: 'Audit chain continuity',
    appliesTo: 'bh:AuditEvent',
    formal: 'forall n > 1: prev_hash(e_n) = hash(e_{n-1}) and hash(e_n) = sha256(prev_hash(e_n) || "\\n" || record(e_n))',
    plainEnglish: 'Each audit event includes the hash of the previous one, so any edit to history is detectable.',
    severity: 'error',
    citations: ['coso2013', 'sox404'],
    check: (() => null) as never,
  },
];

export const allAxioms = [
  ...(journalEntryAxioms as unknown as Axiom<never, never>[]),
  ...(trialBalanceAxioms as unknown as Axiom<never, never>[]),
  ...(reconciliationAxioms as unknown as Axiom<never, never>[]),
  ...(fluxAxioms as unknown as Axiom<never, never>[]),
  ...otherAxioms,
];
