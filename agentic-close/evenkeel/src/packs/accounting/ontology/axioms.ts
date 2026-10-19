import type { Axiom, AxiomFinding } from '../../../framework/ontology/types';
import { addMonths, isCalendarDate, periodEnd, periodStart } from '../../../framework/util/dates';
import { formatMoney } from '../../../framework/util/money';
import { SOFT_CLOSE_ENTRY_TYPES, type JournalEntryDraft } from './shapes';

/**
 * Executable axioms of the close ontology. Each is a pure function over a subject and a
 * context of facts looked up by the caller (accounts, period, actor…). The same axioms run
 * (a) in the posting service before anything touches the ledger, (b) in the agent runtime's
 * verify step for every proposal, (c) on imports, and (d) in tests. The database enforces
 * the most critical ones a second time with constraints and triggers.
 */

export type AccountClass = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface AccountInfo {
  id: string;
  code: string;
  name: string;
  accountClass: AccountClass;
  normalBalance: 'debit' | 'credit';
  isPostable: boolean;
  isActive: boolean;
  requiresDepartment: boolean;
  isControlAccount: boolean;
  subledger: string | null;
  isIntercompany: boolean;
  isMonetary: boolean;
  concept: string | null;
}

export interface PeriodInfo {
  key: string;
  status: 'open' | 'soft_close' | 'hard_close';
  startDate: string;
  endDate: string;
}

export interface EntityInfo {
  id: string;
  code: string;
  functionalCurrency: string;
  isElimination: boolean;
}

export interface AccountingAxiomContext {
  accounts?: ReadonlyMap<string, AccountInfo>;
  period?: PeriodInfo;
  entity?: EntityInfo;
  entities?: ReadonlyMap<string, EntityInfo>;
  /** Roles of the actor posting (for soft-close rules). */
  actorRoles?: string[];
  preparedBy?: string | null;
  approvedBy?: string | null;
  requestedBy?: string | null;
  source?: 'manual' | 'agent' | 'import' | 'system' | 'subledger';
  original?: { entityId: string; entryDate: string; status: string; reversedByEntryId: string | null; lines: { accountId: string; debit: number; credit: number }[] };
  materiality?: { overall: number; performance: number; clearlyTrivial: number };
  capitalizationThreshold?: number;
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`context is missing ${what}`);
  return v;
}

type JeAxiom = Axiom<JournalEntryDraft, AccountingAxiomContext>;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ----------------------------------------------------------------- double entry

export const AX_DE_BALANCE: JeAxiom = {
  id: 'AX-DE-01',
  name: 'Debits equal credits',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: '∀ e ∈ JournalEntry: Σ_{l ∈ lines(e)} debit(l) = Σ_{l ∈ lines(e)} credit(l)',
  plain: 'Every journal entry must balance: total debits equal total credits.',
  sources: ['pacioli1494', 'ellerman1985'],
  check: (je) => {
    const d = sum(je.lines.map((l) => l.debit ?? 0));
    const c = sum(je.lines.map((l) => l.credit ?? 0));
    return d === c ? [] : [{ message: `Debits ${formatMoney(d, je.currency)} do not equal credits ${formatMoney(c, je.currency)} (difference ${formatMoney(d - c, je.currency)}).`, data: { debit: d, credit: c } }];
  },
};

export const AX_DE_SINGLE_SIDED: JeAxiom = {
  id: 'AX-DE-02',
  name: 'Each line is one-sided and positive',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: '∀ l ∈ lines(e): (debit(l) > 0 ∧ credit(l) = 0) ∨ (credit(l) > 0 ∧ debit(l) = 0); amounts ∈ ℤ',
  plain: 'Each line is either a debit or a credit (not both, not zero), in whole cents.',
  sources: ['pacioli1494', 'xbrl-gl'],
  check: (je) => {
    const out: AxiomFinding[] = [];
    je.lines.forEach((l, idx) => {
      const d = l.debit ?? 0;
      const c = l.credit ?? 0;
      if (!Number.isInteger(d) || !Number.isInteger(c)) out.push({ message: `Line ${idx + 1} has a fractional cent amount.`, path: `lines.${idx}` });
      if ((d > 0) === (c > 0)) out.push({ message: `Line ${idx + 1} must have exactly one of debit or credit.`, path: `lines.${idx}` });
      if (d < 0 || c < 0) out.push({ message: `Line ${idx + 1} has a negative amount; use the other side instead.`, path: `lines.${idx}` });
    });
    return out;
  },
};

export const AX_DE_MIN_LINES: JeAxiom = {
  id: 'AX-DE-03',
  name: 'At least one debit and one credit',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: '∃ l1, l2 ∈ lines(e): debit(l1) > 0 ∧ credit(l2) > 0',
  plain: 'An entry needs at least one debit line and one credit line.',
  sources: ['pacioli1494'],
  check: (je) =>
    je.lines.some((l) => (l.debit ?? 0) > 0) && je.lines.some((l) => (l.credit ?? 0) > 0) ? [] : [{ message: 'Entry needs at least one debit and one credit line.' }],
};

export const AX_DE_TXN_CURRENCY: JeAxiom = {
  id: 'AX-DE-04',
  name: 'Single-currency entries balance in transaction currency',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: 'If all lines share txnCurrency k ≠ functional: Σ txnAmount(l) = 0',
  plain: 'If every line is in the same foreign currency, the foreign amounts must also balance.',
  sources: ['asc830', 'ellerman1985'],
  check: (je) => {
    const fx = je.lines.filter((l) => l.txnCurrency && l.txnCurrency !== je.currency && l.txnAmount !== undefined);
    if (fx.length !== je.lines.length) return [];
    const ccys = new Set(fx.map((l) => l.txnCurrency));
    if (ccys.size !== 1) return [];
    const total = sum(fx.map((l) => l.txnAmount ?? 0));
    return total === 0 ? [] : [{ message: `Transaction-currency amounts do not net to zero (${total}).` }];
  },
};

// ---------------------------------------------------------------------- periods

export const AX_PER_OPEN: JeAxiom = {
  id: 'AX-PER-01',
  name: 'Posting requires an open period',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: 'state(period(e)) = Open ∨ (state = SoftClose ∧ type(e) ∈ AdjustingTypes ∧ role(actor) ≥ Senior)',
  plain: 'You can only post into an open month. In soft close, only adjusting-type entries by a senior accountant or above.',
  sources: ['isa315', 'coso2013'],
  check: (je, ctx) => {
    const p = need(ctx.period, 'period');
    if (p.key !== je.periodKey) return [{ message: `Entry period ${je.periodKey} does not match period record ${p.key}.` }];
    if (p.status === 'open') return [];
    if (p.status === 'hard_close') return [{ message: `${je.periodKey} is locked (hard close). Post a correction in an open period instead.` }];
    const senior = (ctx.actorRoles ?? []).some((r) => ['senior_accountant', 'controller', 'cfo', 'system'].includes(r));
    if (!SOFT_CLOSE_ENTRY_TYPES.includes(je.entryType)) return [{ message: `${je.periodKey} is soft-closed: only adjusting-type entries are allowed, not ${je.entryType}.` }];
    if (!senior) return [{ message: `${je.periodKey} is soft-closed: adjustments need a Senior Accountant or above.` }];
    return [];
  },
};

export const AX_PER_DATE: JeAxiom = {
  id: 'AX-PER-02',
  name: 'Entry date within its period',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: 'start(period(e)) ≤ date(e) ≤ end(period(e))',
  plain: 'The entry date must fall inside the month it is posted to (cutoff).',
  sources: ['isa315'],
  check: (je) => {
    if (!isCalendarDate(je.entryDate)) return [{ message: `Invalid entry date ${je.entryDate}.` }];
    const s = periodStart(je.periodKey);
    const e = periodEnd(je.periodKey);
    return je.entryDate >= s && je.entryDate <= e ? [] : [{ message: `Entry date ${je.entryDate} is outside ${je.periodKey} (${s} – ${e}).` }];
  },
};

// --------------------------------------------------------------------- accounts

export const AX_ACC_POSTABLE: JeAxiom = {
  id: 'AX-ACC-01',
  name: 'Lines post to active, postable accounts',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: '∀ l: account(l) ∈ Accounts(tenant) ∧ postable(account(l)) ∧ active(account(l))',
  plain: 'Every line must use an existing, active, postable (non-summary) account.',
  sources: ['xbrl-gl'],
  check: (je, ctx) => {
    const accounts = need(ctx.accounts, 'accounts');
    const out: AxiomFinding[] = [];
    je.lines.forEach((l, idx) => {
      const a = accounts.get(l.accountId);
      if (!a) out.push({ message: `Line ${idx + 1}: account ${l.accountId} does not exist.`, path: `lines.${idx}.accountId` });
      else if (!a.isActive) out.push({ message: `Line ${idx + 1}: account ${a.code} ${a.name} is inactive.`, path: `lines.${idx}.accountId` });
      else if (!a.isPostable) out.push({ message: `Line ${idx + 1}: ${a.code} ${a.name} is a summary account and cannot be posted to.`, path: `lines.${idx}.accountId` });
    });
    return out;
  },
};

export const AX_ACC_DIMENSIONS: JeAxiom = {
  id: 'AX-ACC-03',
  name: 'Required dimensions present',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: '∀ l: requiresDepartment(account(l)) → department(l) ≠ ∅',
  plain: 'Operating expense lines must say which department the cost belongs to.',
  sources: ['xbrl-gl'],
  check: (je, ctx) => {
    const accounts = need(ctx.accounts, 'accounts');
    const out: AxiomFinding[] = [];
    je.lines.forEach((l, idx) => {
      const a = accounts.get(l.accountId);
      if (a?.requiresDepartment && !l.departmentId) out.push({ message: `Line ${idx + 1}: ${a.code} ${a.name} needs a department.`, path: `lines.${idx}.departmentId` });
    });
    return out;
  },
};

export const AX_ACC_CONTROL: JeAxiom = {
  id: 'AX-ACC-04',
  name: 'Control accounts are posted through their subledger',
  appliesTo: 'ek:JournalEntry',
  severity: 'warning',
  formal: 'controlAccount(account(l)) ∧ source(e) ∈ {manual, agent} → flag',
  plain: 'Manual entries straight to AP, AR or cash bypass the subledger and break tie-outs.',
  sources: ['xbrl-gl', 'pcaob-as2401'],
  check: (je, ctx) => {
    if (ctx.source !== 'manual') return [];
    const accounts = need(ctx.accounts, 'accounts');
    return je.lines
      .map((l, idx) => ({ l, idx, a: accounts.get(l.accountId) }))
      .filter((x) => x.a?.isControlAccount)
      .map((x) => ({ message: `Line ${x.idx + 1} posts manually to control account ${x.a!.code} ${x.a!.name}.`, path: `lines.${x.idx}.accountId` }));
  },
};

export const AX_FX_FUNCTIONAL: JeAxiom = {
  id: 'AX-FX-02',
  name: 'Ledger is kept in functional currency',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: 'currency(e) = functionalCurrency(entity(e))',
  plain: 'Each entity’s books are kept in its functional currency; foreign amounts are carried per line.',
  sources: ['asc830'],
  check: (je, ctx) => {
    const ent = need(ctx.entity, 'entity');
    return je.currency === ent.functionalCurrency ? [] : [{ message: `Entry currency ${je.currency} differs from ${ent.code}'s functional currency ${ent.functionalCurrency}.` }];
  },
};

// ---------------------------------------------------------------------- entries

export const AX_JE_REVERSAL: JeAxiom = {
  id: 'AX-JE-02',
  name: 'Reversals mirror the original',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: 'reverses(e, o) → posted(o) ∧ ¬reversed(o) ∧ entity(e)=entity(o) ∧ date(e) ≥ date(o) ∧ lines(e) = swap(lines(o))',
  plain: 'A reversing entry must undo a posted, not-yet-reversed entry exactly, on or after its date.',
  sources: ['pacioli1494', 'pcaob-as1105'],
  check: (je, ctx) => {
    if (!je.reversesEntryId) return [];
    const o = need(ctx.original, 'original entry');
    const out: AxiomFinding[] = [];
    if (o.status !== 'posted') out.push({ message: 'Only posted entries can be reversed.' });
    if (o.reversedByEntryId) out.push({ message: 'The original entry has already been reversed.' });
    if (o.entityId !== je.entityId) out.push({ message: 'Reversal must be in the same entity.' });
    if (je.entryDate < o.entryDate) out.push({ message: 'Reversal cannot be dated before the original.' });
    const key = (accountId: string, d: number, c: number) => `${accountId}|${d}|${c}`;
    const want = o.lines.map((l) => key(l.accountId, l.credit, l.debit)).sort();
    const got = je.lines.map((l) => key(l.accountId, l.debit ?? 0, l.credit ?? 0)).sort();
    if (want.join(',') !== got.join(',')) out.push({ message: 'Reversal lines must equal the original lines with debits and credits swapped.' });
    return out;
  },
};

export const AX_JE_ACCRUAL_REVERSES: JeAxiom = {
  id: 'AX-JE-03',
  name: 'Accruals auto-reverse next period',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: 'type(e) = Accrual → autoReverseDate(e) = start(period(e) + 1)',
  plain: 'An accrual must be set to reverse on the first day of the next month, so it is not double counted when the bill arrives.',
  sources: ['con6'],
  check: (je) => {
    if (je.entryType !== 'accrual') return [];
    const expected = periodStart(addMonths(je.periodKey, 1));
    return je.autoReverseDate === expected ? [] : [{ message: `Accrual should auto-reverse on ${expected} (got ${je.autoReverseDate ?? 'none'}).` }];
  },
};

export const AX_JE_ELIMINATION: JeAxiom = {
  id: 'AX-JE-04',
  name: 'Eliminations only in the elimination entity',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: '(type(e) = Elimination → entity(e) ∈ EliminationEntity) ∧ (entity(e) ∈ EliminationEntity → type(e) ∈ {Elimination, Reversing ∘ Elimination})',
  plain: 'Elimination entries live only in the consolidation (elimination) entity, which holds nothing else apart from reversals of its own eliminations.',
  sources: ['asc810'],
  check: (je, ctx) => {
    const ent = need(ctx.entity, 'entity');
    if (je.entryType === 'elimination' && !ent.isElimination) return [{ message: 'Elimination entries must be posted to the elimination entity.' }];
    const reversalOfElimination = je.entryType === 'reversing' && !!je.reversesEntryId;
    if (je.entryType !== 'elimination' && !reversalOfElimination && ent.isElimination) return [{ message: 'The elimination entity accepts only elimination entries (and their reversals).' }];
    return [];
  },
};

export const AX_IC_COUNTERPARTY: JeAxiom = {
  id: 'AX-IC-02',
  name: 'Intercompany lines name the counterparty',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: '∀ l: intercompany(account(l)) → counterparty(l) ∈ Entities ∖ {entity(e)}',
  plain: 'Lines on intercompany accounts must say which other group company they relate to.',
  sources: ['asc810'],
  check: (je, ctx) => {
    const accounts = need(ctx.accounts, 'accounts');
    const out: AxiomFinding[] = [];
    je.lines.forEach((l, idx) => {
      const a = accounts.get(l.accountId);
      if (!a?.isIntercompany) return;
      if (!l.counterpartyEntityId) out.push({ message: `Line ${idx + 1}: intercompany account ${a.code} needs a counterparty entity.`, path: `lines.${idx}.counterpartyEntityId` });
      else if (l.counterpartyEntityId === je.entityId) out.push({ message: `Line ${idx + 1}: counterparty cannot be the entity itself.`, path: `lines.${idx}.counterpartyEntityId` });
    });
    return out;
  },
};

// ---------------------------------------------------------------------- SoD

export const AX_SOD_MAKER_CHECKER: JeAxiom = {
  id: 'AX-SOD-01',
  name: 'Preparer is not approver',
  appliesTo: 'ek:JournalEntry',
  severity: 'error',
  formal: 'approvedBy(e) ≠ ∅ → approvedBy(e) ∉ {preparedBy(e), requestedBy(e)}',
  plain: 'The person who prepared (or asked an agent to prepare) an entry cannot approve it.',
  sources: ['coso2013', 'sox404', 'pcaob-as2201'],
  check: (_je, ctx) => {
    if (!ctx.approvedBy) return [];
    if (ctx.approvedBy === ctx.preparedBy) return [{ message: 'Segregation of duties: the preparer cannot approve their own entry.' }];
    if (ctx.approvedBy === ctx.requestedBy) return [{ message: 'Segregation of duties: you started the agent run that drafted this entry, so someone else must approve it.' }];
    return [];
  },
};

// ------------------------------------------------------------- non-JE subjects

export interface TrialBalanceSubject {
  rows: { accountClass: AccountClass; debit: number; credit: number }[];
}

export const AX_DE_EQUATION: Axiom<TrialBalanceSubject, AccountingAxiomContext> = {
  id: 'AX-DE-05',
  name: 'Accounting equation holds',
  appliesTo: 'ek:TrialBalance',
  severity: 'error',
  formal: 'Σ debits = Σ credits over all accounts ⇔ Assets = Liabilities + Equity + (Revenue − Expenses)',
  plain: 'The trial balance must net to zero: assets equal liabilities plus equity plus current-period profit.',
  sources: ['pacioli1494', 'ellerman1985', 'con6'],
  check: (tb) => {
    const net = sum(tb.rows.map((r) => r.debit - r.credit));
    return net === 0 ? [] : [{ message: `Trial balance is out of balance by ${formatMoney(net)}.` }];
  },
};

export interface RecSubject {
  glBalance: number;
  statementBalance: number;
  reconcilingTotal: number;
  unexplained: number;
  status: string;
  preparedBy: string | null;
  reviewedBy: string | null;
  evidenceCount: number;
  items: { itemType: string; ageDays: number; amount: number }[];
  tolerance: number;
}

export const AX_REC_TIES: Axiom<RecSubject, AccountingAxiomContext> = {
  id: 'AX-REC-01',
  name: 'Reconciliation ties out',
  appliesTo: 'ek:Reconciliation',
  severity: 'error',
  formal: 'certified(r) → |GL(r) − (Statement(r) + Σ reconcilingItems(r))| ≤ tolerance ∧ unexplained(r) = 0',
  plain: 'A reconciliation can only be certified when the ledger equals the statement after explained items, with nothing unexplained.',
  sources: ['coso2013', 'pcaob-as1105'],
  check: (r) => {
    const out: AxiomFinding[] = [];
    const diff = r.glBalance - (r.statementBalance + r.reconcilingTotal);
    if (Math.abs(diff) > r.tolerance) out.push({ message: `Ledger and adjusted statement differ by ${formatMoney(diff)}.`, data: { diff } });
    if (r.unexplained !== 0) out.push({ message: `${formatMoney(r.unexplained)} is still unexplained.`, data: { unexplained: r.unexplained } });
    return out;
  },
};

export const AX_REC_EVIDENCE: Axiom<RecSubject, AccountingAxiomContext> = {
  id: 'AX-REC-02',
  name: 'Certified reconciliations carry evidence',
  appliesTo: 'ek:Reconciliation',
  severity: 'error',
  formal: 'certified(r) → |evidence(r)| ≥ 1',
  plain: 'Attach the statement or schedule that supports the balance before certifying.',
  sources: ['pcaob-as1105'],
  check: (r) => (r.evidenceCount > 0 ? [] : [{ message: 'No supporting evidence is attached.' }]),
};

export const AX_REC_REVIEWER: Axiom<RecSubject, AccountingAxiomContext> = {
  id: 'AX-REC-03',
  name: 'Reviewer is not the preparer',
  appliesTo: 'ek:Reconciliation',
  severity: 'error',
  formal: 'reviewed(r) → reviewer(r) ≠ preparer(r)',
  plain: 'Someone other than the preparer must review a reconciliation.',
  sources: ['coso2013', 'sox404'],
  check: (r) => (r.reviewedBy && r.reviewedBy === r.preparedBy ? [{ message: 'The reviewer prepared this reconciliation.' }] : []),
};

export const AX_REC_STALE: Axiom<RecSubject, AccountingAxiomContext> = {
  id: 'AX-REC-04',
  name: 'Reconciling items are not stale',
  appliesTo: 'ek:Reconciliation',
  severity: 'warning',
  formal: '∀ i ∈ items(r): age(i) ≤ 90 days',
  plain: 'Reconciling items older than 90 days should be investigated or written off.',
  sources: ['pcaob-as1105'],
  check: (r) => r.items.filter((i) => i.ageDays > 90).map((i) => ({ message: `${i.itemType.replace(/_/g, ' ')} of ${formatMoney(i.amount)} is ${i.ageDays} days old.` })),
};

export interface FluxLineSubject {
  isMaterial: boolean;
  variance: number;
  explanation: { status: string; coverage: number; authorId: string | null; approvedBy: string | null } | null;
}

export const AX_FLX_EXPLAINED: Axiom<FluxLineSubject, AccountingAxiomContext> = {
  id: 'AX-FLX-01',
  name: 'Material variances are explained',
  appliesTo: 'ek:Variance',
  severity: 'error',
  formal: 'material(v) → ∃ x ∈ VarianceExplanation: explains(x, v) ∧ approved(x)',
  plain: 'Every variance above threshold needs an approved explanation before the close is signed off.',
  sources: ['pcaob-as2201', 'isa315'],
  check: (v) => (!v.isMaterial || v.explanation?.status === 'approved' ? [] : [{ message: 'Material variance has no approved explanation yet.' }]),
};

export const AX_FLX_COVERAGE: Axiom<FluxLineSubject, AccountingAxiomContext> = {
  id: 'AX-FLX-02',
  name: 'Explanations quantify most of the variance',
  appliesTo: 'ek:Variance',
  severity: 'warning',
  formal: 'explains(x, v) → Σ drivers(x) / variance(v) ≥ 0.8',
  plain: 'A good explanation puts numbers on at least 80% of the change.',
  sources: ['pcaob-as2201'],
  check: (v) => (v.explanation && v.explanation.coverage < 0.8 ? [{ message: `Drivers explain only ${Math.round(v.explanation.coverage * 100)}% of the variance.` }] : []),
};

export const AX_FLX_APPROVER: Axiom<FluxLineSubject, AccountingAxiomContext> = {
  id: 'AX-FLX-03',
  name: 'Explanation approver is not the author',
  appliesTo: 'ek:Variance',
  severity: 'error',
  formal: 'approved(x) → approver(x) ≠ author(x)',
  plain: 'Someone other than the author approves a flux explanation.',
  sources: ['coso2013'],
  check: (v) => (v.explanation?.approvedBy && v.explanation.approvedBy === v.explanation.authorId ? [{ message: 'The author approved their own explanation.' }] : []),
};

export interface IcSubject {
  entityA: string;
  entityB: string;
  dueFromReporting: number;
  dueToReporting: number;
  tolerance: number;
}

export const AX_IC_AGREE: Axiom<IcSubject, AccountingAxiomContext> = {
  id: 'AX-IC-01',
  name: 'Intercompany balances agree',
  appliesTo: 'ek:IntercompanyBalance',
  severity: 'error',
  formal: '|dueFrom(A,B) − dueTo(B,A)|_{reporting ccy} ≤ tolerance',
  plain: 'What one group company says it is owed must equal what the other says it owes (after FX), before eliminating.',
  sources: ['asc810', 'asc830'],
  check: (s) => {
    const diff = s.dueFromReporting - s.dueToReporting;
    return Math.abs(diff) <= s.tolerance ? [] : [{ message: `Intercompany balances differ by ${formatMoney(diff)}.`, data: { diff } }];
  },
};

export interface MaterialitySubject {
  overall: number;
  performance: number;
  clearlyTrivial: number;
}

export const AX_MAT_ORDER: Axiom<MaterialitySubject, AccountingAxiomContext> = {
  id: 'AX-MAT-01',
  name: 'Materiality levels are ordered',
  appliesTo: 'ek:Materiality',
  severity: 'error',
  formal: '0 < clearlyTrivial < performance ≤ overall',
  plain: 'Clearly trivial must be smaller than performance materiality, which cannot exceed overall materiality.',
  sources: ['isa320', 'isa450', 'pcaob-as2105'],
  check: (m) => (0 < m.clearlyTrivial && m.clearlyTrivial < m.performance && m.performance <= m.overall ? [] : [{ message: 'Materiality thresholds are not ordered correctly.' }]),
};

export interface TaskGraphSubject {
  tasks: { id: string; title: string; dependsOn: string[] }[];
}

export const AX_CLS_ACYCLIC: Axiom<TaskGraphSubject, AccountingAxiomContext> = {
  id: 'AX-CLS-01',
  name: 'Task dependencies are acyclic',
  appliesTo: 'ek:CloseCycle',
  severity: 'error',
  formal: 'dependsOn⁺ is irreflexive',
  plain: 'Close tasks cannot depend on themselves, directly or through a chain.',
  sources: ['coso2013'],
  check: (g) => {
    const deps = new Map(g.tasks.map((t) => [t.id, t.dependsOn]));
    const state = new Map<string, 1 | 2>();
    const cycles: AxiomFinding[] = [];
    const visit = (id: string, path: string[]): void => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) {
        cycles.push({ message: `Dependency cycle: ${[...path, id].map((x) => g.tasks.find((t) => t.id === x)?.title ?? x).join(' → ')}` });
        return;
      }
      state.set(id, 1);
      for (const d of deps.get(id) ?? []) visit(d, [...path, id]);
      state.set(id, 2);
    };
    for (const t of g.tasks) visit(t.id, []);
    return cycles.slice(0, 3);
  },
};

export interface LockSubject {
  openTasks: number;
  uncertifiedRecs: number;
  unexplainedMaterialFlux: number;
  pendingProposals: number;
  packageGenerated: boolean;
  openCriticalIssues: number;
}

export const AX_CLS_LOCK: Axiom<LockSubject, AccountingAxiomContext> = {
  id: 'AX-CLS-02',
  name: 'Lock only a finished close',
  appliesTo: 'ek:FiscalPeriod',
  severity: 'error',
  formal: 'lock(p) → tasks(p) complete ∧ recs(p) reviewed ∧ materialFlux(p) explained ∧ pendingProposals(p) = ∅ ∧ package(p) generated',
  plain: 'A month can be locked only when every task is done, every reconciliation is reviewed, material variances are explained, nothing awaits approval and the close package exists.',
  sources: ['coso2013', 'sox404'],
  check: (s) => {
    const out: AxiomFinding[] = [];
    if (s.openTasks) out.push({ message: `${s.openTasks} close task(s) are not complete.` });
    if (s.uncertifiedRecs) out.push({ message: `${s.uncertifiedRecs} reconciliation(s) are not reviewed.` });
    if (s.unexplainedMaterialFlux) out.push({ message: `${s.unexplainedMaterialFlux} material variance(s) lack an approved explanation.` });
    if (s.pendingProposals) out.push({ message: `${s.pendingProposals} agent proposal(s) still await a decision.` });
    if (s.openCriticalIssues) out.push({ message: `${s.openCriticalIssues} high-severity exception(s) are unresolved.` });
    if (!s.packageGenerated) out.push({ message: 'The close package has not been generated.' });
    return out;
  },
};

export interface ProposalSubject {
  kind: string;
  rationale: string;
  evidenceCount: number;
  confidence: number;
}

export const AX_PRP_EVIDENCE: Axiom<ProposalSubject, AccountingAxiomContext> = {
  id: 'AX-PRP-01',
  name: 'Proposals explain themselves',
  appliesTo: 'ek:Proposal',
  severity: 'error',
  formal: '∀ p ∈ Proposal: |why(p)| > 0 ∧ |evidence(p)| ≥ 1 ∧ confidence(p) ∈ [0,1]',
  plain: 'Every agent proposal says why in plain English, shows its evidence and states a confidence.',
  sources: ['iso42001', 'pcaob-as1105'],
  check: (p) => {
    const out: AxiomFinding[] = [];
    if (!p.rationale || p.rationale.trim().length < 10) out.push({ message: 'Proposal is missing a plain-English rationale.' });
    if (p.evidenceCount < 1) out.push({ message: 'Proposal has no evidence.' });
    if (!(p.confidence >= 0 && p.confidence <= 1)) out.push({ message: 'Confidence must be between 0 and 1.' });
    return out;
  },
};

export interface AutonomySubject {
  level: 'L0' | 'L1' | 'L2' | 'L3';
  amount: number;
  confidence: number;
  autoPostBelow: number;
  minConfidence: number;
  performanceMateriality: number;
  decision: 'auto_post' | 'await_approval' | 'suggest_only';
}

export const AX_PRP_AUTONOMY: Axiom<AutonomySubject, AccountingAxiomContext> = {
  id: 'AX-PRP-02',
  name: 'Autonomy ceiling',
  appliesTo: 'ek:AutonomyLevel',
  severity: 'error',
  formal: 'autoPost(p) → level ∈ {L2,L3} ∧ |amount| < performanceMateriality ∧ (level = L3 ∨ (|amount| < threshold ∧ confidence ≥ floor))',
  plain: 'Agents may only post on their own at L2/L3, never above performance materiality, and at L2 only under the threshold and above the confidence floor.',
  sources: ['iso42001', 'isa320', 'coso2013'],
  check: (s) => {
    if (s.decision !== 'auto_post') return [];
    const out: AxiomFinding[] = [];
    if (s.level === 'L0' || s.level === 'L1') out.push({ message: `Autonomy ${s.level} does not allow auto-posting.` });
    if (Math.abs(s.amount) >= s.performanceMateriality) out.push({ message: 'Amount is at or above performance materiality.' });
    if (s.level === 'L2' && (Math.abs(s.amount) >= s.autoPostBelow || s.confidence < s.minConfidence)) out.push({ message: 'Outside the L2 threshold or below the confidence floor.' });
    return out;
  },
};

export interface CodingSubject {
  treatment: 'expense' | 'prepaid' | 'capitalize' | 'balance_sheet';
  unitAmount: number;
  concept: string | null;
  servicePeriodMonths: number | null;
  amount: number;
}

export const AX_CAP_THRESHOLD: Axiom<CodingSubject, AccountingAxiomContext> = {
  id: 'AX-CAP-01',
  name: 'Equipment above threshold is capitalised',
  appliesTo: 'ek:CodingDecision',
  severity: 'warning',
  formal: 'concept(t) ⊑ ComputerEquipment ∧ unitCost(t) ≥ capThreshold → treatment(t) = capitalize',
  plain: 'Equipment that costs more than the capitalisation threshold per unit should be recorded as a fixed asset, not an expense.',
  sources: ['asc360'],
  check: (s, ctx) => {
    const threshold = need(ctx.capitalizationThreshold, 'capitalization threshold');
    if (s.concept === 'ek:ComputerEquipment' && s.unitAmount >= threshold && s.treatment !== 'capitalize') {
      return [{ message: `Unit cost ${formatMoney(s.unitAmount)} is at or above the ${formatMoney(threshold)} capitalisation threshold.` }];
    }
    return [];
  },
};

export const AX_PPD_SERVICE: Axiom<CodingSubject, AccountingAxiomContext> = {
  id: 'AX-PPD-01',
  name: 'Multi-month prepayments are deferred',
  appliesTo: 'ek:CodingDecision',
  severity: 'warning',
  formal: 'servicePeriodMonths(t) > 1 ∧ amount(t) ≥ prepaidThreshold → treatment(t) = prepaid',
  plain: 'A payment that covers several future months should be recorded as a prepaid and spread over those months.',
  sources: ['asc340'],
  check: (s) => (s.servicePeriodMonths && s.servicePeriodMonths > 1 && s.amount >= 500_000 && s.treatment === 'expense' ? [{ message: `Covers ${s.servicePeriodMonths} months but is fully expensed.` }] : []),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AXIOMS: Axiom<any, any>[] = [
  AX_DE_BALANCE,
  AX_DE_SINGLE_SIDED,
  AX_DE_MIN_LINES,
  AX_DE_TXN_CURRENCY,
  AX_DE_EQUATION,
  AX_PER_OPEN,
  AX_PER_DATE,
  AX_ACC_POSTABLE,
  AX_ACC_DIMENSIONS,
  AX_ACC_CONTROL,
  AX_FX_FUNCTIONAL,
  AX_JE_REVERSAL,
  AX_JE_ACCRUAL_REVERSES,
  AX_JE_ELIMINATION,
  AX_IC_COUNTERPARTY,
  AX_SOD_MAKER_CHECKER,
  AX_REC_TIES,
  AX_REC_EVIDENCE,
  AX_REC_REVIEWER,
  AX_REC_STALE,
  AX_FLX_EXPLAINED,
  AX_FLX_COVERAGE,
  AX_FLX_APPROVER,
  AX_IC_AGREE,
  AX_MAT_ORDER,
  AX_CLS_ACYCLIC,
  AX_CLS_LOCK,
  AX_PRP_EVIDENCE,
  AX_PRP_AUTONOMY,
  AX_CAP_THRESHOLD,
  AX_PPD_SERVICE,
];
