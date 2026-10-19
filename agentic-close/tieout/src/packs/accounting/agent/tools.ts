/**
 * The accounting pack's agent tools. Every tool is typed (zod input, ontology-typed output),
 * permissioned, and either `read` or `propose` (AX-AGT-03: nothing approves, posts or pays).
 * Fields carrying third-party text are declared `untrustedFields` so the runtime scans,
 * flags and neutralises instruction-like content before a model sees it.
 */
import { z } from 'zod';
import type { ProposalDraft, ToolDef } from '../../../core/agent/types';
import { periodEnd } from '../../../core/util/time';
import { balancesAsOf, trialBalanceRows } from '../ledger/balances';
import { closeOntology } from '../ontology';
import type { AccountingServices } from '../services';
import { codingDraft, findingDraft, fluxDraft, jeDraft, recMatchDraft, reconcilingItemDraft, reportDraft, CodingPayloadSchema, FindingPayloadSchema, FluxPayloadSchema, JePayloadSchema, RecMatchPayloadSchema, ReconcilingItemPayloadSchema, ReportPayloadSchema } from './payloads';

const pk = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).describe('Period key YYYY-MM');
const entityId = z.string().min(3).describe('Entity id (from close.status or the run context)');
const idStr = z.string().min(3).max(64);

type Svc = AccountingServices;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
type AnyTool = ToolDef<any, any, Svc>;

function tool<I, O>(t: ToolDef<I, O, Svc>): AnyTool {
  return t as AnyTool;
}

const Evidence = z.array(z.object({ kind: z.enum(['record', 'source_document', 'computation', 'policy', 'ontology', 'run']), label: z.string().max(200), refType: z.string().max(40).optional(), refId: z.string().max(64).optional(), detail: z.string().max(300).optional() }).strict()).min(1).max(20);
const Common = { title: z.string().min(5).max(200), why: z.string().min(12).max(2000).describe('Plain-English reason a non-accountant can follow'), confidence: z.number().min(0).max(1), evidence: Evidence, dedupeKey: z.string().min(3).max(120).describe('Stable key so re-runs never duplicate this proposal') };

// ------------------------------------------------------------------ read tools
export const READ_TOOLS: AnyTool[] = [
  tool({
    name: 'close.status',
    title: 'Read close status',
    description: 'The close checklist for a period: tasks, owners, workday due dates, dependencies and readiness to lock (AX-CL-02).',
    effect: 'read',
    permission: 'close.view',
    input: z.object({ periodKey: pk }).strict(),
    outputType: 'tie:FinancialClose',
    async handler({ services }, { periodKey }) {
      const t = await services.close.tasks(periodKey);
      const entities = (await services.ctx.legalEntities()).map((e) => ({ id: e.id, code: e.code, currency: e.functional_currency }));
      return { periodKey, businessDate: t.businessDate, workday: t.workday, entities, tasks: t.tasks.map((x) => ({ key: x.key, title: x.title, status: x.status, due: x.dueLabel, owner: x.ownerName, skill: x.skill_key, openDependencies: x.openDependencies })) };
    },
  }),
  tool({
    name: 'ledger.trial_balance',
    title: 'Read trial balance',
    description: 'Posted trial balance for an entity at a period end (debit/credit columns, natural balances).',
    effect: 'read',
    permission: 'ledger.read',
    input: z.object({ entityId, periodKey: pk }).strict(),
    outputType: 'tie:TrialBalance',
    async handler({ services }, { entityId: e, periodKey }) {
      services.ctx.assertEntityInScope(e);
      const chart = await services.ctx.chart();
      const tb = trialBalanceRows(chart, await balancesAsOf(services.tx, [e], periodEnd(periodKey)));
      return { entityId: e, asOf: periodEnd(periodKey), rows: tb.rows.map((r) => ({ code: r.code, name: r.name, debitMinor: r.debitMinor, creditMinor: r.creditMinor })), totalDebitMinor: tb.totalDebitMinor, totalCreditMinor: tb.totalCreditMinor };
    },
  }),
  tool({
    name: 'ledger.account_activity',
    title: 'Read account activity',
    description: 'Posted journal lines on one account in a period, with entry numbers and memos.',
    effect: 'read',
    permission: 'ledger.read',
    input: z.object({ entityId, accountCode: z.string().min(3).max(12), periodKey: pk, limit: z.number().int().min(1).max(200).optional() }).strict(),
    outputType: 'tie:JournalLine[]',
    untrustedFields: ['lines.*.memo', 'lines.*.lineMemo'],
    async handler({ services }, { entityId: e, accountCode, periodKey, limit }) {
      services.ctx.assertEntityInScope(e);
      const chart = await services.ctx.chart();
      const acct = chart.account(accountCode);
      const headers = await services.tx.find('journal_entries', { entity_id: e, status: 'posted', posting_date: { gte: `${periodKey}-01`, lte: periodEnd(periodKey) } });
      const byId = new Map(headers.map((h) => [h.id, h]));
      const lines = headers.length ? (await services.tx.find('journal_lines', { account_id: acct.id, journal_entry_id: { in: headers.map((h) => h.id) } })).slice(0, limit ?? 100) : [];
      return { account: `${acct.code} ${acct.name}`, lines: lines.map((l) => ({ id: l.id, entry: byId.get(l.journal_entry_id)!.je_number, date: byId.get(l.journal_entry_id)!.posting_date, debitMinor: l.debit_minor, creditMinor: l.credit_minor, department: l.department, memo: byId.get(l.journal_entry_id)!.memo, lineMemo: l.memo })) };
    },
  }),
  tool({
    name: 'coa.accounts',
    title: 'Read chart of accounts',
    description: 'Active postable accounts with class, ontology class, required dimensions and control flags.',
    effect: 'read',
    permission: 'ledger.read',
    input: z.object({}).strict(),
    outputType: 'tie:Account[]',
    async handler({ services }) {
      const chart = await services.ctx.chart();
      return { accounts: chart.accounts.filter((a) => a.is_postable && a.status === 'active').map((a) => ({ code: a.code, name: a.name, class: a.account_class, ontologyClass: a.ontology_class, requiredDimensions: a.required_dimensions, control: a.control_subledger })) };
    },
  }),
  tool({
    name: 'bank.accounts',
    title: 'List bank accounts',
    description: 'Bank accounts for an entity with their GL cash account and statement format.',
    effect: 'read',
    permission: 'subledger.read',
    input: z.object({ entityId }).strict(),
    outputType: 'tie:BankAccount[]',
    async handler({ services }, { entityId: e }) {
      const chart = await services.ctx.chart();
      return { items: (await services.bank.accounts(e)).map((b) => ({ id: b.id, name: b.name, bank: b.bank_name, last4: b.account_last4, currency: b.currency, glAccount: chart.account(b.gl_account_id).code, format: b.statement_format })) };
    },
  }),
  tool({
    name: 'bank.statement',
    title: 'Read bank statement',
    description: 'Statement balances and lines for a bank account and period, plus early next-period lines (subsequent clearing evidence). Descriptions are third-party text.',
    effect: 'read',
    permission: 'subledger.read',
    input: z.object({ bankAccountId: idStr, periodKey: pk }).strict(),
    outputType: 'tie:BankTransaction[]',
    untrustedFields: ['lines.*.description', 'lines.*.counterparty', 'lines.*.reference', 'subsequent.*.description', 'subsequent.*.counterparty'],
    async handler({ services }, { bankAccountId, periodKey }) {
      const s = await services.bank.statement(bankAccountId, periodKey);
      return { opening: s.statement?.opening_balance_minor ?? null, closing: s.statement?.closing_balance_minor ?? null, sourceDocumentId: s.statement?.source_document_id ?? null, lines: s.lines.map(slim), subsequent: s.subsequent.map(slim) };
    },
  }),
  tool({
    name: 'recon.suggest_matches',
    title: 'Suggest reconciliation matches',
    description: 'Deterministic matching engine: exact, many-to-one, one-to-many and fuzzy matches of bank lines to ledger cash lines, plus unmatched bank-only and book-only items with classifications.',
    effect: 'read',
    permission: 'subledger.read',
    input: z.object({ bankAccountId: idStr, periodKey: pk }).strict(),
    outputType: 'tie:ReconciliationMatch[]',
    untrustedFields: ['matches.*.external.*.description', 'matches.*.external.*.counterparty', 'bankOnly.*.line.description', 'timing.*.clearedBy.description'],
    async handler({ services }, { bankAccountId, periodKey }) {
      const r = await services.bank.suggest(bankAccountId, periodKey);
      return {
        counts: r.counts,
        matches: r.matches.map((m) => ({ type: m.type, confidence: m.confidence, differenceMinor: m.differenceMinor, signals: m.signals, explanation: m.explanation, external: m.external.map((e) => ({ id: e.id, date: e.date, amountMinor: e.amountMinor, description: e.description, counterparty: e.counterparty, reference: e.reference })), ledger: m.ledger.map((l) => ({ id: l.id, date: l.date, amountMinor: l.amountMinor, entry: l.entryRef, entryId: l.entryId, memo: l.memo })) })),
        bankOnly: r.bankOnly.map((b) => ({ kind: b.kind, confidence: b.confidence, reason: b.reason, possibleCounterparties: b.possibleCounterparties, line: { id: b.line.id, date: b.line.date, amountMinor: b.line.amountMinor, description: b.line.description, sourceDocumentId: b.line.sourceDocumentId } })),
        timing: r.timing.map((t) => ({ kind: t.kind, confidence: t.confidence, reason: t.reason, ledger: { id: t.ledger.id, date: t.ledger.date, amountMinor: t.ledger.amountMinor, entry: t.ledger.entryRef, entryId: t.ledger.entryId, memo: t.ledger.memo }, clearedBy: t.clearedBy ? { id: t.clearedBy.id, date: t.clearedBy.date, description: t.clearedBy.description } : null })),
      };
    },
  }),
  tool({
    name: 'recon.state',
    title: 'Read reconciliation state',
    description: 'Live reconciliation: GL vs statement balance, open reconciling items and the unreconciled difference (AX-REC-01).',
    effect: 'read',
    permission: 'subledger.read',
    input: z.object({ bankAccountId: idStr, periodKey: pk }).strict(),
    outputType: 'tie:BankReconciliation',
    async handler({ services }, { bankAccountId, periodKey }) {
      const s = await services.bank.state(bankAccountId, periodKey);
      return { glBalanceMinor: s.glBalanceMinor, statementBalanceMinor: s.externalBalanceMinor, unreconciledMinor: s.unreconciledMinor, tiesOut: s.tiesOut, matched: s.matchedCount, unmatchedBank: s.unmatchedBank, unmatchedLedger: s.unmatchedLedger, openItems: s.items.filter((i) => i.status === 'open').map((i) => ({ kind: i.kind, side: i.side, amountMinor: i.amount_minor, description: i.description })) };
    },
  }),
  tool({
    name: 'card.uncoded',
    title: 'List uncoded card charges',
    description: 'Card transactions waiting for an account and department. Merchant names and memos are third-party text.',
    effect: 'read',
    permission: 'subledger.read',
    input: z.object({ entityId, periodKey: pk }).strict(),
    outputType: 'tie:CardTransaction[]',
    untrustedFields: ['items.*.merchant', 'items.*.memo'],
    async handler({ services }, { entityId: e, periodKey }) {
      const rows = await services.coding.uncodedCards(e, periodKey);
      return { items: rows.map((r) => ({ id: r.id, date: r.txn_date, merchant: r.merchant_name, mcc: r.mcc, amountMinor: r.amount_minor, currency: r.currency, cardholder: r.cardholder, cardholderDepartment: r.cardDepartment, receipt: r.receipt_status, memo: r.memo })) };
    },
  }),
  tool({
    name: 'coding.classify',
    title: 'Classify a transaction',
    description: 'Bucketing classifier for one card charge: human mappings > plain-English rules > history > vendor master > ontology MCC/keyword signals, with capitalization check (AX-SCH-03).',
    effect: 'read',
    permission: 'subledger.read',
    input: z.object({ cardTransactionId: idStr }).strict(),
    outputType: 'tie:CodingProposal',
    async handler({ services, run }, { cardTransactionId }) {
      const t = await services.tx.get('card_transactions', cardTransactionId);
      if (!t) throw new Error(`card transaction ${cardTransactionId} not found`);
      const card = await services.tx.get('cards', t.card_id);
      const s = await services.coding.classify(services.coding.subjectFromCard(t, card?.department ?? null), run.policy);
      return { id: t.id, merchant: t.merchant_name, amountMinor: t.amount_minor, ...s };
    },
  }),
  tool({
    name: 'coding.review_posted',
    title: 'Review posted coding',
    description: 'Re-classifies posted card charges and bill lines in the period and returns items whose coded account disagrees strongly with the evidence (misclassification and capitalization candidates).',
    effect: 'read',
    permission: 'subledger.read',
    input: z.object({ entityId, periodKey: pk, minConfidence: z.number().min(0.5).max(1).optional() }).strict(),
    outputType: 'tie:ReclassProposal[]',
    untrustedFields: ['items.*.merchant', 'items.*.description'],
    async handler({ services, run }, { entityId: e, periodKey, minConfidence }) {
      const items = await services.coding.postedForReview(e, periodKey);
      const out = [];
      for (const it of items as (typeof items[number] & { codedAccount: string; codedDepartment: string | null })[]) {
        const s = await services.coding.classify(it, run.policy, { excludeId: it.id });
        if (s.accountCode !== it.codedAccount && s.confidence >= (minConfidence ?? 0.85)) out.push({ kind: it.kind, id: it.id, date: it.date, merchant: it.merchant, description: it.description, amountMinor: it.amountMinor, codedAccount: it.codedAccount, codedDepartment: it.codedDepartment, vendorId: it.vendorId, suggestion: s });
      }
      return { reviewed: items.length, items: out };
    },
  }),
  tool({
    name: 'subledger.tieout',
    title: 'Tie out a subledger',
    description: 'Rebuild the AP or AR aging from documents and compare it with the GL control account; lists counterparties with wrong-sign balances.',
    effect: 'read',
    permission: 'subledger.read',
    input: z.object({ entityId, kind: z.enum(['ap', 'ar']), periodKey: pk }).strict(),
    outputType: 'tie:SubledgerTieOut',
    async handler({ services }, { entityId: e, kind, periodKey }) {
      const t = await services.subledgers.tieOut(e, kind, periodEnd(periodKey));
      return { kind, accountCode: t.accountCode, asOf: t.asOf, subledgerMinor: t.subledgerMinor, glMinor: t.glMinor, differenceMinor: t.differenceMinor, counterparties: t.rows.length, wrongSign: t.wrongSign.map((w) => ({ id: w.counterpartyId, name: w.name, openMinor: w.openMinor, documents: w.documents })) };
    },
  }),
  tool({
    name: 'accruals.candidates',
    title: 'Find accrual candidates',
    description: 'Unrecorded liabilities with evidence: subsequent invoices (cut-off), recurring-vendor gaps, goods received not invoiced, and payroll earned but unpaid.',
    effect: 'read',
    permission: 'subledger.read',
    input: z.object({ entityId, periodKey: pk }).strict(),
    outputType: 'tie:UnrecordedLiability[]',
    async handler({ services }, { entityId: e, periodKey }) {
      return services.accruals.candidates(e, periodKey);
    },
  }),
  tool({
    name: 'schedules.status',
    title: 'Read schedule status',
    description: 'Depreciation and prepaid amortization lines due by the period end without a journal entry, plus schedule integrity checks (AX-SCH-01/02).',
    effect: 'read',
    permission: 'subledger.read',
    input: z.object({ entityId, periodKey: pk }).strict(),
    outputType: 'tie:DepreciationSchedule',
    async handler({ services }, { entityId: e, periodKey }) {
      return services.schedules.status(e, periodKey);
    },
  }),
  tool({
    name: 'ic.balances',
    title: 'Compare intercompany balances',
    description: 'Due-from vs due-to and IC revenue vs expense for every entity pair in the transaction currency, with one-sided entries (AX-IC-01).',
    effect: 'read',
    permission: 'ledger.read',
    input: z.object({ periodKey: pk }).strict(),
    outputType: 'tie:IntercompanyBalance[]',
    untrustedFields: ['pairs.*.oneSided.*.memo'],
    async handler({ services }, { periodKey }) {
      return { pairs: await services.intercompany.balances(periodKey) };
    },
  }),
  tool({
    name: 'fx.exposures',
    title: 'Read FX exposures',
    description: 'Foreign-currency monetary balances with carrying amount, closing rate and the remeasurement adjustment (AX-FX-01).',
    effect: 'read',
    permission: 'ledger.read',
    input: z.object({ entityId, periodKey: pk }).strict(),
    outputType: 'tie:MonetaryItem[]',
    async handler({ services }, { entityId: e, periodKey }) {
      return { items: await services.intercompany.exposures(e, periodKey) };
    },
  }),
  tool({
    name: 'flux.compute',
    title: 'Compute flux',
    description: 'Period-over-period and budget variances for income-statement accounts with drivers that sum to the variance and pending (unposted) proposals.',
    effect: 'read',
    permission: 'report.view',
    input: z.object({ entityId, periodKey: pk, comparison: z.enum(['pop', 'yoy']).optional() }).strict(),
    outputType: 'tie:VarianceAnalysis',
    untrustedFields: ['lines.*.drivers.*.label'],
    async handler({ services }, { entityId: e, periodKey, comparison }) {
      const r = await services.flux.compute(e, periodKey, { comparison });
      return { ...r, lines: r.lines.filter((l) => l.exceeds || Math.abs(l.varianceMinor) >= r.thresholds.clearlyTrivialMinor) };
    },
  }),
  tool({
    name: 'anomaly.scan',
    title: 'Scan entries for risk',
    description: 'Journal-entry risk tests for the period: self-approval, duplicate payments, weekend/holiday manual entries, round amounts, threshold skirting and a Benford first-digit test.',
    effect: 'read',
    permission: 'ledger.read',
    input: z.object({ entityId, periodKey: pk }).strict(),
    outputType: 'tie:Finding[]',
    untrustedFields: ['flagged.*.memo'],
    async handler({ services }, { entityId: e, periodKey }) {
      return services.anomaly.scan(e, periodKey);
    },
  }),
  tool({
    name: 'ontology.lookup',
    title: 'Look up a concept',
    description: 'Definition, why it matters, lineage, axioms and citations for an accounting concept in the Tieout ontology.',
    effect: 'read',
    permission: 'ontology.view',
    input: z.object({ term: z.string().min(2).max(80) }).strict(),
    outputType: 'tie:Thing',
    async handler(_ctx, { term }) {
      return closeOntology().explain(term) ?? { notFound: term, suggestions: closeOntology().search(term, 5).map((t) => t.label) };
    },
  }),
  tool({
    name: 'report.package_data',
    title: 'Assemble close package data',
    description: 'Trial balances, consolidated statements (ASC 830 translation, eliminations, CTA), approved commentary, reconciliation status, open items and agent activity for the period.',
    effect: 'read',
    permission: 'report.view',
    input: z.object({ periodKey: pk }).strict(),
    outputType: 'tie:ClosePackage',
    async handler({ services, actor }, { periodKey }) {
      const content = await services.close.packageContent(periodKey, actor.id);
      const readiness = await services.close.readiness(periodKey);
      return { content, readiness };
    },
  }),
];

function slim(l: { id: string; date: string; amountMinor: number; description: string; counterparty: string | null; reference: string | null; status: string }) {
  return { id: l.id, date: l.date, amountMinor: l.amountMinor, description: l.description, counterparty: l.counterparty, reference: l.reference, status: l.status };
}

// --------------------------------------------------------------- propose tools
const asDraft = (d: ProposalDraft) => d;

export const PROPOSE_TOOLS: AnyTool[] = [
  tool({
    name: 'propose.journal_entry',
    title: 'Propose a journal entry',
    description: 'Draft a balanced journal entry for approval. Amounts are integer minor units; every expense line needs a department. Accruals must set autoReverseOn to the first day of the next period.',
    effect: 'propose',
    permission: 'je.create',
    input: z.object({ ...Common, entry: JePayloadSchema }).strict(),
    outputType: 'tie:JournalEntryProposal',
    async handler(_ctx, i) {
      return asDraft(jeDraft(i.entry, i));
    },
  }),
  tool({
    name: 'propose.coding',
    title: 'Propose coding',
    description: 'Propose an account and department for a card charge.',
    effect: 'propose',
    permission: 'je.create',
    input: z.object({ ...Common, coding: CodingPayloadSchema }).strict(),
    outputType: 'tie:CodingProposal',
    async handler(_ctx, i) {
      return asDraft(codingDraft(i.coding, i));
    },
  }),
  tool({
    name: 'propose.rec_match',
    title: 'Propose a match',
    description: 'Propose matching bank line(s) with ledger cash line(s); both sides must sum to the same amount (AX-REC-03).',
    effect: 'propose',
    permission: 'recon.prepare',
    input: z.object({ ...Common, match: RecMatchPayloadSchema }).strict(),
    outputType: 'tie:MatchProposal',
    async handler(_ctx, i) {
      return asDraft(recMatchDraft(i.match, i));
    },
  }),
  tool({
    name: 'propose.reconciling_item',
    title: 'Propose a reconciling item',
    description: 'Record a timing difference or exception on a reconciliation (deposit in transit, outstanding check, bank fee, unexplained…).',
    effect: 'propose',
    permission: 'recon.prepare',
    input: z.object({ ...Common, item: ReconcilingItemPayloadSchema }).strict(),
    outputType: 'tie:ReconcilingItemProposal',
    async handler(_ctx, i) {
      return asDraft(reconcilingItemDraft(i.item, i));
    },
  }),
  tool({
    name: 'propose.flux_explanation',
    title: 'Propose a variance explanation',
    description: 'Explain a significant variance; drivers must add up to the variance (AX-FLX-02) and the text must be plain English.',
    effect: 'propose',
    permission: 'flux.explain',
    input: z.object({ ...Common, explanation: FluxPayloadSchema }).strict(),
    outputType: 'tie:FluxExplanationProposal',
    async handler(_ctx, i) {
      return asDraft(fluxDraft(i.explanation, i));
    },
  }),
  tool({
    name: 'propose.finding',
    title: 'Raise a finding',
    description: 'Raise a review finding (risk, control break, duplicate) with a recommended action for a person to resolve.',
    effect: 'propose',
    permission: 'ledger.read',
    input: z.object({ ...Common, finding: FindingPayloadSchema }).strict(),
    outputType: 'tie:Finding',
    async handler(_ctx, i) {
      return asDraft(findingDraft(i.finding, i));
    },
  }),
  tool({
    name: 'propose.close_package',
    title: 'Propose the close package',
    description: 'Submit the close package draft (content from report.package_data) with an executive summary for the Controller.',
    effect: 'propose',
    permission: 'close.package',
    input: z.object({ ...Common, report: ReportPayloadSchema }).strict(),
    outputType: 'tie:ClosePackage',
    async handler(_ctx, i) {
      return asDraft(reportDraft(i.report, i));
    },
  }),
];

export const ACCOUNTING_TOOLS: AnyTool[] = [...READ_TOOLS, ...PROPOSE_TOOLS];

/** Permission an agent needs to prepare each kind of proposal (checked for offline brains too). */
export const PROPOSAL_PERMISSION: Record<string, string> = {
  journal_entry: 'je.create',
  coding: 'je.create',
  rec_match: 'recon.prepare',
  reconciling_item: 'recon.prepare',
  flux_explanation: 'flux.explain',
  finding: 'ledger.read',
  report: 'close.package',
  schedule_update: 'je.create',
};
