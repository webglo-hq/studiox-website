/**
 * Executable axioms of the close ontology. Each has a formal statement (for humans, prompts and
 * the JSON-LD export), a plain-English reading, the classes it constrains, where it is enforced
 * (ontology check / database trigger or constraint / runtime / UI), citations — and a `check`.
 */
import type { Axiom } from '../../../core/ontology/types';
import { verifyAuditChain } from '../../../core/audit/chain';
import type { AuditRecord } from '../../../core/store/types';

export interface AccountFact {
  code: string;
  is_postable: boolean;
  status: string;
  required_dimensions: readonly string[];
  account_class?: string;
  normal_balance?: string;
  is_contra?: boolean;
  control_subledger?: string | null;
  is_intercompany?: boolean;
}

export interface LineFact {
  debit_minor: number;
  credit_minor: number;
  account?: AccountFact;
  department?: string | null;
  location?: string | null;
  product_class?: string | null;
  project?: string | null;
}

export interface EntryFacts {
  lines?: readonly LineFact[];
  entry_type?: string;
  status?: string;
  posting_date?: string;
  period?: { period_key: string; status: string; start_date: string; end_date: string };
  prepared_by?: string;
  approved_by?: string | null;
  approval_route?: string | null;
  source?: string;
  auto_reverse_on?: string | null;
  next_period_start?: string;
  reverses?: { status: string } | null;
}

export interface RecFacts {
  glBalanceMinor?: number;
  externalBalanceMinor?: number;
  items?: readonly { side: 'external' | 'ledger'; amount_minor: number }[];
  toleranceMinor?: number;
  externalSumMinor?: number;
  ledgerSumMinor?: number;
  itemMatchCounts?: readonly number[];
  preparerId?: string | null;
  reviewerId?: string | null;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const fmt = (minor: number) => `${minor < 0 ? '-' : ''}${(Math.abs(minor) / 100).toFixed(2)}`;
/** approval limits are set, and compared, in US dollars (at the closing rate) */
const usd = (minor: number) => `${minor < 0 ? '−' : ''}$${(Math.abs(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ADJUSTING = new Set(['adjusting', 'accrual', 'reversing', 'reclass', 'elimination', 'fx_revaluation', 'opening', 'closing']);

const A = <F>(a: Axiom<F>) => a;

export const AXIOMS = [
  // ---------------------------------------------------------------- double entry
  A<EntryFacts>({
    id: 'AX-DE-01', title: 'Entries balance', appliesTo: ['tie:JournalEntry'], severity: 'error', enforcedBy: ['ontology', 'database', 'runtime'],
    formal: '∀e ∈ JournalEntry: Σ_{l ∈ lines(e)} debit(l) = Σ_{l ∈ lines(e)} credit(l) > 0',
    plainEnglish: 'Total debits equal total credits, and the entry moves some money.',
    citations: ['pacioli1494', 'ellerman2014', 'xbrl-gl'],
    check: (f) => {
      if (!f.lines) return [];
      const dr = sum(f.lines.map((l) => l.debit_minor));
      const cr = sum(f.lines.map((l) => l.credit_minor));
      if (dr !== cr) return [`debits ${fmt(dr)} ≠ credits ${fmt(cr)} (difference ${fmt(dr - cr)})`];
      if (dr === 0) return ['entry has no amount'];
      return [];
    },
  }),
  A<EntryFacts>({
    id: 'AX-DE-02', title: 'Lines are one-sided and positive', appliesTo: ['tie:JournalLine', 'tie:JournalEntry'], severity: 'error', enforcedBy: ['ontology', 'database'],
    formal: '∀l ∈ JournalLine: (debit(l) > 0 ∧ credit(l) = 0) ∨ (credit(l) > 0 ∧ debit(l) = 0)',
    plainEnglish: 'Each line is either a debit or a credit, never both, never zero, never negative.',
    citations: ['xbrl-gl'],
    check: (f) =>
      (f.lines ?? []).flatMap((l, i) => {
        const ok = (l.debit_minor > 0 && l.credit_minor === 0) || (l.credit_minor > 0 && l.debit_minor === 0);
        return ok && Number.isInteger(l.debit_minor) && Number.isInteger(l.credit_minor) ? [] : [`line ${i + 1} must have exactly one positive integer side`];
      }),
  }),
  A<EntryFacts>({
    id: 'AX-DE-03', title: 'At least two lines', appliesTo: ['tie:JournalEntry'], severity: 'error', enforcedBy: ['ontology', 'database'],
    formal: '∀e ∈ JournalEntry: |lines(e)| ≥ 2',
    plainEnglish: 'An entry needs at least one debit line and one credit line (REA duality).',
    citations: ['mccarthy1982', 'pacioli1494'],
    check: (f) => (f.lines && f.lines.length < 2 ? [`entry has ${f.lines.length} line(s); needs at least 2`] : []),
  }),
  A<{ debits?: number; credits?: number }>({
    id: 'AX-DE-04', title: 'Trial balance balances', appliesTo: ['tie:TrialBalance'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: 'Σ_{a ∈ Accounts} debitBalance(a) = Σ_{a ∈ Accounts} creditBalance(a)',
    plainEnglish: 'Across the whole ledger, debit balances equal credit balances — so Assets = Liabilities + Equity.',
    citations: ['pacioli1494', 'conceptual-framework'],
    check: (f) => (f.debits !== undefined && f.credits !== undefined && f.debits !== f.credits ? [`trial balance out by ${fmt(f.debits - f.credits)}`] : []),
  }),
  // ---------------------------------------------------------------- statements
  A<{ statement?: string; netIncomeMinor?: number; ledgerNetIncomeMinor?: number }>({
    id: 'AX-FS-01', title: 'Income statement ties to the ledger', appliesTo: ['tie:IncomeStatement'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: '∀e, p: netIncome(IS(e, p)) = −Σ_{l ∈ lines(e, p), class(account(l)) ∈ {revenue, expense}, type(entry(l)) ≠ closing} (debit(l) − credit(l))',
    plainEnglish: 'Net income on every income statement equals the income and expenses posted in the ledger for that period (year-end closing entries excluded). Presentation may regroup amounts, never change the total.',
    citations: ['conceptual-framework', 'usgaap-taxonomy'],
    check: (f) =>
      f.netIncomeMinor !== undefined && f.ledgerNetIncomeMinor !== undefined && f.netIncomeMinor !== f.ledgerNetIncomeMinor
        ? [`${f.statement ?? 'the income statement'} shows net income ${fmt(f.netIncomeMinor)} but the ledger shows ${fmt(f.ledgerNetIncomeMinor)}`]
        : [],
  }),
  // ---------------------------------------------------------------- immutability
  A<{ before?: { status: string } ; changed?: readonly string[] }>({
    id: 'AX-IM-01', title: 'Posted entries are immutable', appliesTo: ['tie:JournalEntry'], severity: 'error', enforcedBy: ['database', 'runtime', 'ui'],
    formal: '∀e: status(e) = posted ⇒ □¬modified(e); corrections ≔ ∃r ∈ ReversingEntry: reverses(r, e)',
    plainEnglish: 'Once posted, an entry never changes. Mistakes are fixed by posting a reversing entry (and, if needed, a corrected one).',
    citations: ['asc250', 'sox404'],
    check: (f) => (f.before?.status === 'posted' && (f.changed ?? []).length > 0 ? [`posted entries cannot be modified (${(f.changed ?? []).join(', ')})`] : []),
  }),
  A<EntryFacts>({
    id: 'AX-IM-02', title: 'Reverse posted entries only, once', appliesTo: ['tie:ReversingEntry'], severity: 'error', enforcedBy: ['database', 'runtime'],
    formal: '∀r ∈ ReversingEntry: status(reversed(r)) = posted ∧ |{r′ : reverses(r′, reversed(r))}| = 1',
    plainEnglish: 'Only a posted entry can be reversed, and only one reversal may exist for it.',
    citations: ['asc250'],
    check: (f) => (f.reverses && f.reverses.status !== 'posted' ? ['only posted entries can be reversed'] : []),
  }),
  // ---------------------------------------------------------------- periods
  A<EntryFacts>({
    id: 'AX-PD-01', title: 'Post only into open periods', appliesTo: ['tie:JournalEntry'], severity: 'error', enforcedBy: ['ontology', 'database', 'runtime'],
    formal: 'post(e) ⇒ status(period(e)) = open ∨ (status(period(e)) = soft_closed ∧ type(e) ∈ AdjustingEntry)',
    plainEnglish: 'Open periods take everything; soft-closed periods take approved adjustments only; locked periods take nothing.',
    citations: ['sox404', 'coso2013'],
    check: (f) => {
      if (!f.period) return [];
      const s = f.period.status;
      if (s === 'open') return [];
      if (s === 'soft_closed' && f.entry_type && ADJUSTING.has(f.entry_type)) return [];
      return [`period ${f.period.period_key} is ${s.replace('_', '-')}${s === 'soft_closed' ? '; only adjusting entries are allowed' : ''}`];
    },
  }),
  A<EntryFacts>({
    id: 'AX-PD-02', title: 'Posting date inside its period', appliesTo: ['tie:JournalEntry'], severity: 'error', enforcedBy: ['ontology', 'database'],
    formal: 'start(period(e)) ≤ postingDate(e) ≤ end(period(e))',
    plainEnglish: 'The posting date must fall inside the period the entry posts to (cut-off).',
    citations: ['aicpa-auc315'],
    check: (f) => (f.period && f.posting_date && (f.posting_date < f.period.start_date || f.posting_date > f.period.end_date) ? [`posting date ${f.posting_date} is outside ${f.period.period_key}`] : []),
  }),
  A<{ from?: string; to?: string; reason?: string | null }>({
    id: 'AX-PD-03', title: 'Period lifecycle', appliesTo: ['tie:AccountingPeriod'], severity: 'error', enforcedBy: ['database', 'runtime'],
    formal: 'transitions ⊆ {future→open, open→soft_closed, soft_closed→open, soft_closed→locked, locked→soft_closed[reason]}',
    plainEnglish: 'Periods move future → open → soft-closed → locked. Re-opening a locked period needs a documented reason.',
    citations: ['sox404'],
    check: (f) => {
      if (!f.from || !f.to || f.from === f.to) return [];
      const ok = new Set(['future>open', 'open>soft_closed', 'soft_closed>open', 'soft_closed>locked', 'locked>soft_closed']).has(`${f.from}>${f.to}`);
      if (!ok) return [`a period cannot move from ${f.from} to ${f.to}`];
      if (f.from === 'locked' && (!f.reason || f.reason.trim().length < 10)) return ['unlocking requires a documented reason (10+ characters)'];
      return [];
    },
  }),
  // ---------------------------------------------------------------- accounts
  A<EntryFacts>({
    id: 'AX-AC-01', title: 'Post to active leaf accounts', appliesTo: ['tie:JournalLine', 'tie:JournalEntry'], severity: 'error', enforcedBy: ['ontology', 'database'],
    formal: '∀l: postsTo(l, a) ⇒ postable(a) ∧ active(a)',
    plainEnglish: 'Lines can only post to active accounts that are leaves of the chart (not summary headers).',
    citations: ['xbrl-gl'],
    check: (f) => (f.lines ?? []).flatMap((l) => (l.account && (!l.account.is_postable || l.account.status !== 'active') ? [`account ${l.account.code} is not an active postable account`] : [])),
  }),
  A<EntryFacts>({
    id: 'AX-AC-02', title: 'Required dimensions present', appliesTo: ['tie:JournalLine', 'tie:JournalEntry'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: '∀l, d: d ∈ requiredDimensions(account(l)) ⇒ ∃v: taggedWith(l, d, v)',
    plainEnglish: 'If an account requires a department (or other dimension), every line posting to it must carry one.',
    citations: ['xbrl-gl'],
    check: (f) =>
      (f.lines ?? []).flatMap((l) =>
        (l.account?.required_dimensions ?? []).filter((d) => !(l as unknown as Record<string, unknown>)[d]).map((d) => `account ${l.account!.code} requires ${d.replace('_', ' ')}`),
      ),
  }),
  A<{ account_class?: string; normal_balance?: string; is_contra?: boolean }>({
    id: 'AX-AC-03', title: 'Normal balance follows class', appliesTo: ['tie:Account'], severity: 'error', enforcedBy: ['ontology', 'database'],
    formal: 'normal(a) = debit ⇔ (class(a) ∈ {Asset, Expense}) ⊕ contra(a)',
    plainEnglish: 'Assets and expenses are debit-normal, liabilities, equity and revenue credit-normal; contra accounts flip it.',
    citations: ['pacioli1494', 'conceptual-framework'],
    check: (f) => {
      if (!f.account_class || !f.normal_balance) return [];
      const debitClass = f.account_class === 'asset' || f.account_class === 'expense';
      const expected = debitClass !== !!f.is_contra ? 'debit' : 'credit';
      return f.normal_balance === expected ? [] : [`a ${f.is_contra ? 'contra ' : ''}${f.account_class} account should be ${expected}-normal`];
    },
  }),
  A<EntryFacts>({
    id: 'AX-AC-04', title: 'Control accounts via subledger or reclass', appliesTo: ['tie:ControlAccount', 'tie:JournalEntry'], severity: 'warning', enforcedBy: ['runtime'],
    formal: 'postsTo(l, a) ∧ control(a) ∧ source(e) ∉ {subledger} ⇒ type(e) = reclass ∧ approverRole(e) ≥ Controller',
    plainEnglish: 'Manual or agent entries that touch AP, AR or other control accounts are only allowed as reclasses and escalate to a Controller.',
    citations: ['coso2013'],
    check: (f) => {
      if (!f.lines || f.source === 'subledger' || f.source === 'system' || f.source === 'import') return [];
      const touches = f.lines.filter((l) => l.account?.control_subledger && !['bank', 'intercompany'].includes(l.account.control_subledger));
      if (!touches.length) return [];
      return f.entry_type === 'reclass' || f.entry_type === 'accrual' || f.entry_type === 'elimination' || f.entry_type === 'fx_revaluation'
        ? []
        : [`manual entries to control account ${touches[0]!.account!.code} must be reclasses`];
    },
  }),
  // ---------------------------------------------------------------- SoD
  A<EntryFacts>({
    id: 'AX-SOD-01', title: 'Maker-checker', appliesTo: ['tie:JournalEntry', 'tie:Proposal'], severity: 'error', enforcedBy: ['ontology', 'database', 'runtime', 'ui'],
    formal: '∀x: approvedBy(x) ≠ preparedBy(x) ∧ approvedBy(x) ≠ editedBy(x)',
    plainEnglish: 'Nobody approves their own work — including work they edited.',
    citations: ['coso2013', 'pcaob-as2201'],
    check: (f) => (f.approved_by && f.prepared_by && f.approval_route !== 'system' && f.approved_by === f.prepared_by ? [`${f.prepared_by} cannot approve an entry they prepared`] : []),
  }),
  A<{ requestedBy?: string | null; approverId?: string; enabled?: boolean }>({
    id: 'AX-SOD-02', title: 'Agent requester is not the checker', appliesTo: ['tie:JournalEntryProposal'], severity: 'error', enforcedBy: ['runtime', 'ui'],
    formal: 'enabled(SOD-02) ∧ proposedBy(p) ∈ SoftwareAgent ⇒ approvedBy(p) ≠ onBehalfOf(run(p))',
    plainEnglish: 'Whoever asked an agent to draft entries cannot also approve them — the agent works for them, so it is their work.',
    citations: ['coso2013', 'nist-ai-rmf'],
    check: (f) => (f.enabled && f.requestedBy && f.requestedBy === f.approverId ? ['you ran the agent that drafted this entry; a different person must approve it'] : []),
  }),
  A<RecFacts>({
    id: 'AX-SOD-03', title: 'Reconciliation preparer ≠ reviewer', appliesTo: ['tie:Reconciliation'], severity: 'error', enforcedBy: ['database', 'runtime'],
    formal: '∀r ∈ Reconciliation: reviewer(r) ≠ preparer(r)',
    plainEnglish: 'The person (or the person behind the agent) who prepared a reconciliation cannot also review it.',
    citations: ['sox404', 'pcaob-as2201'],
    check: (f) => (f.preparerId && f.reviewerId && f.preparerId === f.reviewerId ? ['the reviewer must be different from the preparer'] : []),
  }),
  A<{ amountMinor?: number; limitMinor?: number | null }>({
    id: 'AX-SOD-04', title: 'Within approval limit', appliesTo: ['tie:JournalEntry', 'tie:Proposal'], severity: 'error', enforcedBy: ['runtime', 'ui'],
    formal: 'approve(u, x) ⇒ amount(x) ≤ approvalLimit(role(u))',
    plainEnglish: 'You can only approve amounts within your role’s approval limit; larger items escalate.',
    citations: ['coso2013'],
    check: (f) => (f.amountMinor !== undefined && f.limitMinor !== undefined && f.limitMinor !== null && f.amountMinor > f.limitMinor ? [`${usd(f.amountMinor)} is above your approval limit of ${usd(f.limitMinor)}`] : []),
  }),
  // ---------------------------------------------------------------- reconciliation
  A<RecFacts>({
    id: 'AX-REC-01', title: 'Reconciliation ties out', appliesTo: ['tie:Reconciliation'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: 'external(r) + Σ_{i ∈ items, side=external} amt(i) − (gl(r) + Σ_{i ∈ items, side=ledger} amt(i)) ∈ [−τ, τ]',
    plainEnglish: 'After adding the reconciling items to each side, the bank (or subledger) and the ledger agree to within tolerance.',
    citations: ['coso2013', 'sox404'],
    check: (f) => {
      if (f.glBalanceMinor === undefined || f.externalBalanceMinor === undefined) return [];
      const items = f.items ?? [];
      const adjExt = f.externalBalanceMinor + sum(items.filter((i) => i.side === 'external').map((i) => i.amount_minor));
      const adjLed = f.glBalanceMinor + sum(items.filter((i) => i.side === 'ledger').map((i) => i.amount_minor));
      const diff = adjExt - adjLed;
      return Math.abs(diff) <= (f.toleranceMinor ?? 0) ? [] : [`unreconciled difference of ${fmt(diff)}`];
    },
  }),
  A<RecFacts>({
    id: 'AX-REC-02', title: 'One match per item', appliesTo: ['tie:ReconciliationMatch'], severity: 'error', enforcedBy: ['runtime'],
    formal: '∀x: |{m ∈ confirmedMatches : x ∈ items(m)}| ≤ 1',
    plainEnglish: 'A bank line or ledger line can be matched only once.',
    citations: ['coso2013'],
    check: (f) => ((f.itemMatchCounts ?? []).some((n) => n > 1) ? ['an item is used in more than one match'] : []),
  }),
  A<RecFacts>({
    id: 'AX-REC-03', title: 'Matches net to zero', appliesTo: ['tie:ReconciliationMatch'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: '|Σ external(m) − Σ ledger(m)| ≤ τ',
    plainEnglish: 'The two sides of a match must add up to the same amount (within the policy tolerance).',
    citations: ['coso2013'],
    check: (f) => (f.externalSumMinor !== undefined && f.ledgerSumMinor !== undefined && Math.abs(f.externalSumMinor - f.ledgerSumMinor) > (f.toleranceMinor ?? 0) ? [`match sides differ by ${fmt(f.externalSumMinor - f.ledgerSumMinor)}`] : []),
  }),
  A<{ unexplainedMinor?: number; certifying?: boolean }>({
    id: 'AX-REC-04', title: 'No certification with unexplained differences', appliesTo: ['tie:Reconciliation'], severity: 'warning', enforcedBy: ['runtime', 'ui'],
    formal: 'certify(r) ⇒ Σ |unexplained(r)| = 0 ∨ justified(r)',
    plainEnglish: 'A reconciliation with an unexplained difference can only be signed off with a written justification and follow-up.',
    citations: ['sox404'],
    check: (f) => (f.certifying && (f.unexplainedMinor ?? 0) !== 0 ? [`unexplained difference ${fmt(f.unexplainedMinor!)} needs a justification`] : []),
  }),
  // ---------------------------------------------------------------- accruals & schedules
  A<EntryFacts>({
    id: 'AX-ACR-01', title: 'Accruals auto-reverse next period', appliesTo: ['tie:AccrualEntry'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: '∀e ∈ AccrualEntry: autoReverseOn(e) = start(next(period(e)))',
    plainEnglish: 'An accrual reverses on day one of the next period, so the real invoice can post without double counting.',
    citations: ['conceptual-framework'],
    check: (f) => {
      if (f.entry_type !== 'accrual') return [];
      if (!f.auto_reverse_on) return ['accrual has no auto-reversal date'];
      if (f.next_period_start && f.auto_reverse_on !== f.next_period_start) return [`auto-reversal should be ${f.next_period_start}, not ${f.auto_reverse_on}`];
      return [];
    },
  }),
  A<{ evidenceKinds?: readonly string[] }>({
    id: 'AX-ACR-02', title: 'Accruals are evidenced', appliesTo: ['tie:AccrualEntryProposal'], severity: 'error', enforcedBy: ['runtime'],
    formal: '∀p ∈ AccrualEntryProposal: ∃ev ∈ evidence(p): kind(ev) ∈ {purchase order & receipt, recurring pattern, subsequent invoice, payroll calendar}',
    plainEnglish: 'Every proposed accrual cites its basis: a received purchase order, a recurring vendor pattern, a later invoice, or the payroll calendar.',
    citations: ['pcaob-as1105', 'asc450'],
    check: (f) => (f.evidenceKinds && f.evidenceKinds.length === 0 ? ['accrual proposal has no supporting evidence'] : []),
  }),
  A<{ totalMinor?: number; scheduledMinor?: readonly number[]; periodKeys?: readonly string[] }>({
    id: 'AX-SCH-01', title: 'Schedules allocate exactly', appliesTo: ['tie:PrepaidSchedule', 'tie:DepreciationSchedule'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: 'Σ amount(lines(s)) = total(s) ∧ periods(lines(s)) distinct',
    plainEnglish: 'A schedule’s monthly amounts add up to the total, and each month appears once.',
    citations: ['asc340', 'asc360'],
    check: (f) => {
      const out: string[] = [];
      if (f.totalMinor !== undefined && f.scheduledMinor && sum(f.scheduledMinor) !== f.totalMinor) out.push(`schedule sums to ${fmt(sum(f.scheduledMinor))}, total is ${fmt(f.totalMinor)}`);
      if (f.periodKeys && new Set(f.periodKeys).size !== f.periodKeys.length) out.push('a period is scheduled twice');
      return out;
    },
  }),
  A<{ costMinor?: number; salvageMinor?: number; accumulatedMinor?: number }>({
    id: 'AX-SCH-02', title: 'Depreciation bounded by depreciable base', appliesTo: ['tie:FixedAsset'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: 'accumulatedDepreciation(a) ≤ cost(a) − salvage(a)',
    plainEnglish: 'You cannot depreciate an asset below its salvage value.',
    citations: ['asc360'],
    check: (f) => (f.costMinor !== undefined && f.accumulatedMinor !== undefined && f.accumulatedMinor > f.costMinor - (f.salvageMinor ?? 0) ? ['accumulated depreciation exceeds the depreciable base'] : []),
  }),
  A<{ amountMinor?: number; thresholdMinor?: number; usefulLifeMonths?: number; capitalized?: boolean }>({
    id: 'AX-SCH-03', title: 'Capitalization threshold', appliesTo: ['tie:PropertyPlantEquipment', 'tie:CapitalizationPolicy'], severity: 'warning', enforcedBy: ['ontology', 'runtime'],
    formal: 'cost(x) ≥ θ_cap ∧ usefulLife(x) > 12 ⇒ capitalized(x)',
    plainEnglish: 'Single purchases above the capitalization threshold with a multi-year life belong on the balance sheet, not in expense.',
    citations: ['asc360'],
    check: (f) => (f.amountMinor !== undefined && f.thresholdMinor !== undefined && f.amountMinor >= f.thresholdMinor && (f.usefulLifeMonths ?? 36) > 12 && f.capitalized === false ? [`${fmt(f.amountMinor)} is above the ${fmt(f.thresholdMinor)} capitalization threshold`] : []),
  }),
  // ---------------------------------------------------------------- intercompany & FX
  A<{ receivableReportingMinor?: number; payableReportingMinor?: number; toleranceMinor?: number }>({
    id: 'AX-IC-01', title: 'Intercompany balances agree', appliesTo: ['tie:IntercompanyBalance', 'tie:IntercompanyReconciliation'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: '|receivable(A,B) − payable(B,A)|_{reporting ccy} ≤ τ_fx',
    plainEnglish: 'What one entity says another owes it must equal what the other says it owes, after currency conversion (allowing a small FX tolerance).',
    citations: ['asc810'],
    check: (f) => (f.receivableReportingMinor !== undefined && f.payableReportingMinor !== undefined && Math.abs(f.receivableReportingMinor - f.payableReportingMinor) > (f.toleranceMinor ?? 0) ? [`intercompany mismatch of ${fmt(f.receivableReportingMinor - f.payableReportingMinor)}`] : []),
  }),
  A<EntryFacts>({
    id: 'AX-IC-02', title: 'Eliminations touch only intercompany accounts', appliesTo: ['tie:EliminationEntry'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: '∀e ∈ EliminationEntry, l ∈ lines(e): intercompany(account(l))',
    plainEnglish: 'Elimination entries only remove intercompany balances and revenue/expense — nothing else.',
    citations: ['asc810'],
    check: (f) => (f.entry_type !== 'elimination' ? [] : (f.lines ?? []).filter((l) => l.account && !l.account.is_intercompany).map((l) => `elimination line posts to non-intercompany account ${l.account!.code}`)),
  }),
  A<{ foreignMinor?: number; closingRate?: number; revaluedFunctionalMinor?: number }>({
    id: 'AX-FX-01', title: 'Monetary items at closing rate', appliesTo: ['tie:MonetaryItem', 'tie:FxRevaluationEntry'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: 'carrying_fc(m) = round(amount_tc(m) × closingRate(period))',
    plainEnglish: 'Foreign-currency cash, receivables and payables are carried at the period-end exchange rate; the change is an unrealized FX gain or loss.',
    citations: ['asc830'],
    check: (f) => {
      if (f.foreignMinor === undefined || f.closingRate === undefined || f.revaluedFunctionalMinor === undefined) return [];
      const expected = Math.round(f.foreignMinor * f.closingRate);
      return Math.abs(expected - f.revaluedFunctionalMinor) <= 1 ? [] : [`expected ${fmt(expected)} at the closing rate, got ${fmt(f.revaluedFunctionalMinor)}`];
    },
  }),
  A<{ bsRate?: string; plRate?: string; equityRate?: string }>({
    id: 'AX-FX-02', title: 'Translation rates by item', appliesTo: ['tie:Translation'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: 'translate(asset ∨ liability) @ closing; translate(revenue ∨ expense) @ average; translate(equity) @ historical; Δ → CTA',
    plainEnglish: 'Balance sheet at the closing rate, income statement at the average rate, equity at historical rates; the plug is the cumulative translation adjustment.',
    citations: ['asc830'],
    check: (f) => {
      const out: string[] = [];
      if (f.bsRate && f.bsRate !== 'closing') out.push('assets and liabilities must use the closing rate');
      if (f.plRate && f.plRate !== 'average') out.push('income and expense must use the average rate');
      if (f.equityRate && f.equityRate !== 'historical') out.push('equity must use historical rates');
      return out;
    },
  }),
  // ---------------------------------------------------------------- flux
  A<{ lines?: readonly { exceeds_threshold: boolean; status: string; account: string; stale?: boolean }[] }>({
    id: 'AX-FLX-01', title: 'Significant variances are explained', appliesTo: ['tie:VarianceAnalysis'], severity: 'error', enforcedBy: ['runtime', 'ui'],
    formal: '∀v ∈ lines(analysis): |Δ(v)| ≥ θ_abs ∧ |Δ%(v)| ≥ θ_pct ⇒ ∃x ∈ VarianceExplanation: approved(x) ∧ covers(x) = (current(v), comparative(v))',
    plainEnglish: 'Every variance over both thresholds needs an approved explanation of the variance as it stands before the period can be locked. A later posting that moves the figures puts the explanation out of date.',
    citations: ['pcaob-as2105'],
    check: (f) => (f.lines ?? []).filter((l) => l.exceeds_threshold && (l.status !== 'approved' || l.stale)).map((l) => (l.status === 'approved' ? `the explanation of ${l.account} is out of date: the ledger has moved the variance since it was approved` : `variance on ${l.account} has no approved explanation`)),
  }),
  A<{ varianceMinor?: number; driverMinors?: readonly number[] }>({
    id: 'AX-FLX-02', title: 'Drivers reconcile to the variance', appliesTo: ['tie:VarianceExplanation'], severity: 'warning', enforcedBy: ['ontology', 'runtime'],
    formal: '|Σ amount(drivers(x)) − Δ(v)| ≤ max(0.10 · |Δ(v)|, 100)',
    plainEnglish: 'The drivers cited in an explanation add up to the variance within 10%.',
    citations: ['pcaob-as2105'],
    check: (f) => {
      if (f.varianceMinor === undefined || !f.driverMinors || !f.driverMinors.length) return [];
      const gap = sum(f.driverMinors) - f.varianceMinor;
      return Math.abs(gap) <= Math.max(Math.abs(f.varianceMinor) * 0.1, 100) ? [] : [`drivers leave ${fmt(gap)} of the variance unexplained`];
    },
  }),
  // ---------------------------------------------------------------- materiality
  A<{ clearlyTrivialMinor?: number; performanceMinor?: number; overallMinor?: number }>({
    id: 'AX-MAT-01', title: 'Materiality ordering', appliesTo: ['tie:Materiality'], severity: 'error', enforcedBy: ['ontology', 'runtime'],
    formal: '0 < CT < PM < OM',
    plainEnglish: 'Clearly trivial < performance materiality < overall materiality.',
    citations: ['aicpa-auc320', 'aicpa-auc450', 'isa320'],
    check: (f) => (f.clearlyTrivialMinor !== undefined && f.performanceMinor !== undefined && f.overallMinor !== undefined && !(0 < f.clearlyTrivialMinor && f.clearlyTrivialMinor < f.performanceMinor && f.performanceMinor < f.overallMinor) ? ['materiality thresholds must satisfy 0 < CT < PM < OM'] : []),
  }),
  // ---------------------------------------------------------------- close
  A<{ status?: string; dependencyStatuses?: readonly string[] }>({
    id: 'AX-CL-01', title: 'Dependencies first', appliesTo: ['tie:CloseTask'], severity: 'error', enforcedBy: ['database', 'runtime'],
    formal: 'done(t) ⇒ ∀d: dependsOn(t, d) ⇒ done(d) ∨ skipped(d)',
    plainEnglish: 'A task can’t be signed off before the tasks it depends on (preparation can start early).',
    citations: ['apqc-close'],
    check: (f) => (f.status === 'done' && (f.dependencyStatuses ?? []).some((s) => !['done', 'skipped'].includes(s)) ? ['finish the prerequisite tasks first'] : []),
  }),
  A<{ pendingProposals?: number; openRecs?: number; unexplainedFlux?: number; openTasks?: number; finalPackage?: boolean; untiedStatements?: number; stalePackage?: boolean }>({
    id: 'AX-CL-02', title: 'Lock only a finished close', appliesTo: ['tie:LockedPeriod', 'tie:FinancialClose'], severity: 'error', enforcedBy: ['runtime', 'ui'],
    formal: 'lock(p) ⇒ pending(p) = ∅ ∧ ∀r ∈ recs(p): reviewed(r) ∧ AX-FLX-01(p) ∧ AX-FS-01(p) ∧ ∃ final ClosePackage(p) matching the ledger and the current explanations',
    plainEnglish: 'A period locks only when there are no pending proposals above clearly trivial, every reconciliation is reviewed, significant variances are explained, every income statement ties to the ledger and an approved close package still matches the books.',
    citations: ['sox404', 'coso2013'],
    check: (f) => {
      const out: string[] = [];
      const one = (n: number | undefined) => n === 1;
      if ((f.pendingProposals ?? 0) > 0) out.push(`${f.pendingProposals} ${one(f.pendingProposals) ? 'proposal still needs' : 'proposals still need'} a decision`);
      if ((f.openRecs ?? 0) > 0) out.push(`${f.openRecs} ${one(f.openRecs) ? 'reconciliation is' : 'reconciliations are'} not reviewed`);
      if ((f.unexplainedFlux ?? 0) > 0) out.push(`${f.unexplainedFlux} significant ${one(f.unexplainedFlux) ? 'variance lacks' : 'variances lack'} an approved explanation`);
      if ((f.untiedStatements ?? 0) > 0) out.push(`${f.untiedStatements} income statement${f.untiedStatements === 1 ? ' does' : 's do'} not tie to the ledger (AX-FS-01)`);
      if ((f.openTasks ?? 0) > 0) out.push(`${f.openTasks} close ${one(f.openTasks) ? 'task is' : 'tasks are'} not done`);
      if (f.finalPackage === false) out.push('generate the close package first');
      else if (f.stalePackage) out.push('the approved close package no longer matches the books; generate a new version and approve it');
      return out;
    },
  }),
  // ---------------------------------------------------------------- agents & audit
  A<{ why?: string; confidence?: number; evidenceCount?: number }>({
    id: 'AX-AGT-01', title: 'Proposals are explained', appliesTo: ['tie:Proposal'], severity: 'error', enforcedBy: ['ontology', 'database', 'runtime'],
    formal: '∀p ∈ Proposal: |why(p)| ≥ 12 ∧ 0 ≤ confidence(p) ≤ 1 ∧ |evidence(p)| ≥ 1',
    plainEnglish: 'Every agent proposal says why in plain English, carries a confidence between 0 and 1, and cites evidence.',
    citations: ['nist-ai-rmf', 'iso42001'],
    check: (f) => {
      const out: string[] = [];
      if (f.why !== undefined && f.why.trim().length < 12) out.push('the "why" is missing or too short');
      if (f.confidence !== undefined && !(f.confidence >= 0 && f.confidence <= 1)) out.push('confidence must be between 0 and 1');
      if (f.evidenceCount !== undefined && f.evidenceCount < 1) out.push('no evidence attached');
      return out;
    },
  }),
  A<{ flags?: readonly string[]; route?: string }>({
    id: 'AX-AGT-02', title: 'Untrusted text never steers agents', appliesTo: ['tie:Proposal', 'tie:PromptInjection'], severity: 'error', enforcedBy: ['runtime'],
    formal: 'derivedFrom(p, d) ∧ flaggedFor(d, PromptInjection) ⇒ route(p) ∈ {suggestion, human_approval}',
    plainEnglish: 'If a proposal is based on data containing instruction-like text, it can never auto-post; a person must look.',
    citations: ['owasp-llm'],
    check: (f) => (f.flags?.includes('injection_suspected') && (f.route === 'auto_post' || f.route === 'auto_post_sampled') ? ['proposals touching suspicious text cannot auto-post'] : []),
  }),
  A<{ toolEffects?: readonly string[] }>({
    id: 'AX-AGT-03', title: 'Agents cannot approve or post', appliesTo: ['tie:SoftwareAgent', 'tie:ToolCall'], severity: 'error', enforcedBy: ['runtime'],
    formal: '∀t ∈ tools(agent): effect(t) ∈ {read, propose}',
    plainEnglish: 'An agent’s tools can read and propose; approving, posting and paying are human (or Controller-signed policy) actions.',
    citations: ['owasp-llm', 'nist-ai-rmf'],
    check: (f) => (f.toolEffects ?? []).filter((e) => e !== 'read' && e !== 'propose').map((e) => `tool effect "${e}" is not allowed for agents`),
  }),
  A<{ records?: readonly AuditRecord[] }>({
    id: 'AX-AUD-01', title: 'Audit trail is append-only and hash-chained', appliesTo: ['tie:AuditTrail'], severity: 'error', enforcedBy: ['database', 'runtime'],
    formal: '∀n > 1: hash(n) = SHA256(hash(n−1) ‖ canon(event(n))) ∧ □¬(update ∨ delete)',
    plainEnglish: 'Audit events can only be appended; each one seals the previous, so any later edit is detectable.',
    citations: ['sox404', 'pcaob-as2201'],
    check: (f) => {
      if (!f.records) return [];
      const v = verifyAuditChain(f.records);
      return v.ok ? [] : [`audit chain broken at #${v.firstBadSeq}: ${v.reason}`];
    },
  }),
];
