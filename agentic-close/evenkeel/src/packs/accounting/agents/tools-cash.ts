import { z } from 'zod';
import { addDays, periodEnd, periodStart } from '../../../framework/util/dates';
import { convertCents } from '../../../framework/util/money';
import { classifyUnmatched, matchTransactions, type ClassifiedItem, type EngineMatch, type MatchItem } from '../domain/matching';
import { accounts, entities, fxRate } from '../domain/refdata';
import { Id } from '../ontology/shapes';
import { ledgerBalance, periodLines } from '../services/balances';
import { recByKey, refreshRec, type RecSummary, listRecs } from '../services/recs';
import type { AgentCtx } from './context';
import { defineTool, type AnyTool } from './tool-kit';

// ------------------------------------------------------------------ bank reconciliation

async function resolveRec(ctx: AgentCtx, input: { bankAccount?: string; reconciliationId?: string }) {
  if (input.reconciliationId) {
    const r = await ctx.svc.db.get('reconciliation', input.reconciliationId);
    if (!r || r.tenant_id !== ctx.svc.tenantId) throw new Error('Reconciliation not found');
    return r;
  }
  if (input.bankAccount) return recByKey(ctx.svc, ctx.periodKey, `bank:${input.bankAccount}`);
  throw new Error('Give bankAccount (US-OP, US-PAY, UK-OP) or reconciliationId');
}

async function summaryOf(ctx: AgentCtx, recId: string): Promise<RecSummary> {
  await refreshRec(ctx.svc, recId);
  const all = await listRecs(ctx.svc, ctx.periodKey);
  return all.find((r) => r.id === recId)!;
}

export const getReconciliation = defineTool({
  name: 'get_reconciliation',
  description: 'Reconciliation summary for a bank account in the period: statement balance, ledger balance, difference, explained and unexplained amounts, status.',
  input: z.object({ bankAccount: z.enum(['US-OP', 'US-PAY', 'UK-OP']).optional(), reconciliationId: Id.optional() }),
  outputClass: 'ek:BankReconciliation',
  permission: 'report.view',
  handler: async (ctx: AgentCtx, input: { bankAccount?: string; reconciliationId?: string }) => {
    const rec = await resolveRec(ctx, input);
    return summaryOf(ctx, rec.id);
  },
});

interface BankItemOut {
  id: string;
  date: string;
  amount: number;
  description: string;
  reference: string | null;
}

async function recItems(ctx: AgentCtx, recId: string) {
  const rec = (await ctx.svc.db.get('reconciliation', recId))!;
  if (!rec.bank_account_id) throw new Error('Not a bank reconciliation');
  const ps = periodStart(rec.period_key);
  const pe = periodEnd(rec.period_key);
  const window = ctx.policy.thresholds.timingWindowDays ?? 15;
  const txs = await ctx.svc.db.find('bank_transaction', { bank_account_id: rec.bank_account_id, posted_date: { gte: ps, lte: addDays(pe, window) } }, { orderBy: [['posted_date', 'asc']] });
  const activeItems = await ctx.svc.db.find('rec_match_item', { active: true, record_id: { in: txs.map((t) => t.id) } });
  const matchedBank = new Set(activeItems.map((i) => i.record_id));
  const lines = await periodLines(ctx.svc, rec.entity_id, [rec.account_id], rec.period_key);
  const lineItems = lines.length ? await ctx.svc.db.find('rec_match_item', { active: true, record_id: { in: lines.map((l) => l.lineId) } }) : [];
  const matchedLines = new Set(lineItems.map((i) => i.record_id));
  const bank: BankItemOut[] = txs.filter((t) => t.posted_date <= pe && !matchedBank.has(t.id)).map((t) => ({ id: t.id, date: t.posted_date, amount: t.amount, description: [t.description, t.counterparty].filter(Boolean).join(' — '), reference: t.reference }));
  const subsequent: BankItemOut[] = txs.filter((t) => t.posted_date > pe).map((t) => ({ id: t.id, date: t.posted_date, amount: t.amount, description: t.description, reference: t.reference }));
  const book = lines.filter((l) => !matchedLines.has(l.lineId)).map((l) => ({ id: l.lineId, entryId: l.entryId, entryNumber: l.entryNumber, date: l.entryDate, amount: l.debit - l.credit, memo: l.lineMemo ?? l.memo, source: l.source }));
  return { rec, bank, subsequent, book };
}

export const listUnmatchedItems = defineTool({
  name: 'list_unmatched_items',
  description: 'Statement lines and ledger cash lines in the period that are not matched yet, plus statement lines from the first days of next month (subsequent clearing evidence).',
  input: z.object({ reconciliationId: Id }),
  outputClass: 'ek:BankTransaction',
  permission: 'report.view',
  untrustedFields: ['bank[].description', 'subsequent[].description'],
  handler: async (ctx: AgentCtx, input: { reconciliationId: string }) => {
    const { bank, subsequent, book } = await recItems(ctx, input.reconciliationId);
    return { bank, book, subsequent };
  },
});

export interface MatchOut {
  type: EngineMatch['type'];
  bank: BankItemOut[];
  ledger: { id: string; date: string; amount: number; memo: string; entryNumber: string }[];
  confidence: number;
  dateDelta: number;
  nameScore: number;
  reason: string;
}

export interface ClassifiedOut {
  side: 'bank' | 'book';
  cls: ClassifiedItem['cls'];
  item: { id: string; date: string; amount: number; text: string; reference: string | null; entryNumber?: string };
  clearedBy: { id: string; date: string; amount: number; text: string } | null;
  reason: string;
}

export interface EngineOut {
  reconciliationId: string;
  periodEnd: string;
  matches: MatchOut[];
  classified: ClassifiedOut[];
  counts: { bank: number; ledger: number; matched: number };
}

export const runMatchingEngine = defineTool({
  name: 'run_matching_engine',
  description: 'Deterministic matching engine (exact → fuzzy → many-to-one → one-to-many) over unmatched items, then classification of what is left (deposit in transit, outstanding check, fee, interest, unexplained) using next month’s statement as clearing evidence.',
  input: z.object({ reconciliationId: Id }),
  outputClass: 'ek:Match',
  permission: 'report.view',
  untrustedFields: ['matches[].bank[].description', 'classified[].item.text', 'classified[].clearedBy.text'],
  handler: async (ctx: AgentCtx, input: { reconciliationId: string }): Promise<EngineOut> => {
    const { rec, bank, subsequent, book } = await recItems(ctx, input.reconciliationId);
    const bankItems: MatchItem[] = bank.map((b) => ({ id: b.id, amount: b.amount, date: b.date, text: b.description, reference: b.reference }));
    const ledgerItems: MatchItem[] = book.map((l) => ({ id: l.id, amount: l.amount, date: l.date, text: l.memo, reference: /\b(?:CHK|check)\s*#?(\d{4,})/i.exec(l.memo)?.[1] ?? null }));
    const res = matchTransactions(bankItems, ledgerItems);
    const subsequentItems: MatchItem[] = subsequent.map((s) => ({ id: s.id, amount: s.amount, date: s.date, text: s.description, reference: s.reference }));
    const classified = classifyUnmatched(res.unmatchedBank, res.unmatchedLedger, subsequentItems, periodEnd(rec.period_key));
    const bookById = new Map(book.map((b) => [b.id, b]));
    const bankById = new Map(bank.map((b) => [b.id, b]));
    return {
      reconciliationId: rec.id,
      periodEnd: periodEnd(rec.period_key),
      matches: res.matches.map((m) => ({
        type: m.type,
        bank: m.bank.map((b) => bankById.get(b.id)!),
        ledger: m.ledger.map((l) => {
          const x = bookById.get(l.id)!;
          return { id: x.id, date: x.date, amount: x.amount, memo: x.memo, entryNumber: x.entryNumber };
        }),
        confidence: m.confidence,
        dateDelta: m.dateDelta,
        nameScore: m.nameScore,
        reason: m.reason,
      })),
      classified: classified.map((c) => ({
        side: c.side,
        cls: c.cls,
        item: { id: c.item.id, date: c.item.date, amount: c.item.amount, text: c.item.text, reference: c.item.reference ?? null, entryNumber: bookById.get(c.item.id)?.entryNumber },
        clearedBy: c.clearedBy ? { id: c.clearedBy.id, date: c.clearedBy.date, amount: c.clearedBy.amount, text: c.clearedBy.text } : null,
        reason: c.reason,
      })),
      counts: { bank: bank.length, ledger: book.length, matched: res.matches.length },
    };
  },
});

// ------------------------------------------------------------------ subledger tie-out

export const getTieout = defineTool({
  name: 'get_tieout',
  description: 'Tie-out summary for AP or AR in one entity: control-account balance, open-item balance, difference, explained and unexplained amounts.',
  input: z.object({ subledger: z.enum(['ap', 'ar']), entityCode: z.enum(['US', 'UK']) }),
  outputClass: 'ek:SubledgerTieOut',
  permission: 'report.view',
  handler: async (ctx: AgentCtx, input: { subledger: 'ap' | 'ar'; entityCode: 'US' | 'UK' }) => {
    const rec = await recByKey(ctx.svc, ctx.periodKey, `sub:${input.subledger}:${input.entityCode}`);
    return summaryOf(ctx, rec.id);
  },
});

export interface ControlActivityOut {
  lineId: string;
  entryId: string;
  entryNumber: string;
  date: string;
  source: string;
  entryType: string;
  memo: string;
  effect: number;
  preparedBy: string | null;
  approvedBy: string | null;
  externalPreparer: string | null;
  externalApprover: string | null;
}

export const listControlAccountActivity = defineTool({
  name: 'list_control_account_activity',
  description: 'Postings to the AP or AR control account in the period that did not come from the subledger (manual journals, imports). Effect is in the account’s natural sign.',
  input: z.object({ subledger: z.enum(['ap', 'ar']), entityCode: z.enum(['US', 'UK']) }),
  outputClass: 'ek:JournalLine',
  permission: 'report.view',
  untrustedFields: ['lines[].memo'],
  handler: async (ctx: AgentCtx, input: { subledger: 'ap' | 'ar'; entityCode: 'US' | 'UK' }) => {
    const rec = await recByKey(ctx.svc, ctx.periodKey, `sub:${input.subledger}:${input.entityCode}`);
    const acct = (await accounts(ctx.svc)).get(rec.account_id)!;
    const lines = await periodLines(ctx.svc, rec.entity_id, [rec.account_id], ctx.periodKey);
    const subTypes = input.subledger === 'ap' ? ['bill', 'vendor_payment'] : ['invoice', 'customer_receipt'];
    const names = new Map((await ctx.svc.db.find('app_user', { tenant_id: ctx.svc.tenantId })).map((u) => [u.id, u.display_name]));
    const out: ControlActivityOut[] = lines
      .filter((l) => !(l.sourceType && subTypes.includes(l.sourceType)) && l.source !== 'subledger')
      .map((l) => ({
        lineId: l.lineId,
        entryId: l.entryId,
        entryNumber: l.entryNumber,
        date: l.entryDate,
        source: l.source,
        entryType: l.entryType,
        memo: l.memo,
        effect: acct.normal_balance === 'debit' ? l.debit - l.credit : l.credit - l.debit,
        preparedBy: l.preparedBy ? (names.get(l.preparedBy) ?? null) : null,
        approvedBy: l.approvedBy ? (names.get(l.approvedBy) ?? null) : null,
        externalPreparer: l.externalPreparer,
        externalApprover: l.externalApprover,
      }));
    return { reconciliationId: rec.id, account: `${acct.code} ${acct.name}`, lines: out };
  },
});

export interface OverpaymentOut {
  billId: string;
  billNumber: string;
  vendorId: string;
  vendorName: string;
  billAmount: number;
  paid: number;
  excess: number;
  payments: { id: string; date: string; method: string; reference: string; amount: number; journalEntryId: string | null }[];
}

export const findOverpayments = defineTool({
  name: 'find_overpayments',
  description: 'Vendor bills whose payments (to period end) exceed the bill amount — duplicate or over-payments.',
  input: z.object({ entityCode: z.enum(['US', 'UK']) }),
  outputClass: 'ek:VendorPayment',
  permission: 'report.view',
  handler: async (ctx: AgentCtx, input: { entityCode: 'US' | 'UK' }) => {
    const ent = [...(await entities(ctx.svc)).values()].find((e) => e.code === input.entityCode)!;
    const pays = await ctx.svc.db.find('vendor_payment', { tenant_id: ctx.svc.tenantId, entity_id: ent.id, payment_date: { lte: periodEnd(ctx.periodKey) } });
    const byBill = new Map<string, typeof pays>();
    for (const p of pays) if (p.bill_id && p.status !== 'void') byBill.set(p.bill_id, [...(byBill.get(p.bill_id) ?? []), p]);
    const vendors = new Map((await ctx.svc.db.find('vendor', { tenant_id: ctx.svc.tenantId })).map((v) => [v.id, v.name]));
    const items: OverpaymentOut[] = [];
    for (const [billId, ps] of byBill) {
      const bill = await ctx.svc.db.get('bill', billId);
      if (!bill) continue;
      const paid = ps.reduce((s, p) => s + p.amount, 0);
      if (paid <= bill.amount) continue;
      if (!ps.some((p) => p.payment_date >= periodStart(ctx.periodKey))) continue;
      items.push({ billId, billNumber: bill.bill_number, vendorId: bill.vendor_id, vendorName: vendors.get(bill.vendor_id) ?? 'Vendor', billAmount: bill.amount, paid, excess: paid - bill.amount, payments: ps.map((p) => ({ id: p.id, date: p.payment_date, method: p.method, reference: p.reference, amount: p.amount, journalEntryId: p.journal_entry_id })) });
    }
    return { entityCode: input.entityCode, items };
  },
});

// ------------------------------------------------------------------ intercompany

export interface IcActivityOut {
  ref: string;
  status: 'matched' | 'lender_only' | 'borrower_only' | 'amount_mismatch';
  lender: { entryNumber: string; date: string; amount: number; memo: string }[];
  borrower: { entryNumber: string; date: string; amount: number; amountFunctional: number; memo: string }[];
  difference: number;
  lenderLines: { accountId: string; debit: number; credit: number; departmentId: string | null }[];
}

export interface IcPositionOut {
  periodKey: string;
  lender: { entityId: string; code: string; currency: string; accountId: string; balance: number };
  borrower: { entityId: string; code: string; currency: string; accountId: string; balanceTxn: number; balanceFunctional: number };
  difference: number;
  tolerance: number;
  activity: IcActivityOut[];
  reconciliationId: string;
  averageRate: number;
  closingRate: number;
}

const IC_REF = /\[(IC-[A-Z0-9-]+)\]/;

export const getIntercompanyPosition = defineTool({
  name: 'get_intercompany_position',
  description: 'Intercompany position between Kitewell US (lender) and Kitewell UK: due-from vs the counterparty’s due-to in USD, and this month’s activity grouped by intercompany reference with match status.',
  input: z.object({}),
  outputClass: 'ek:IntercompanyBalance',
  permission: 'report.view',
  untrustedFields: ['activity[].lender[].memo', 'activity[].borrower[].memo'],
  handler: async (ctx: AgentCtx): Promise<IcPositionOut> => {
    const ents = [...(await entities(ctx.svc)).values()];
    const us = ents.find((e) => e.code === 'US')!;
    const uk = ents.find((e) => e.code === 'UK')!;
    const accs = [...(await accounts(ctx.svc)).values()];
    const dueFrom = accs.find((a) => a.code === '1300')!;
    const dueTo = accs.find((a) => a.code === '2400')!;
    const rec = await recByKey(ctx.svc, ctx.periodKey, 'ic:US-UK');
    const lenderBal = await ledgerBalance(ctx.svc, us.id, dueFrom.id, ctx.periodKey);
    const ukLinesAll = await ctx.svc.db.find('journal_line', { tenant_id: ctx.svc.tenantId, account_id: dueTo.id, counterparty_entity_id: us.id });
    const ukEntries = new Map((await ctx.svc.db.find('journal_entry', { tenant_id: ctx.svc.tenantId, entity_id: uk.id, status: 'posted', period_key: { lte: ctx.periodKey } })).map((e) => [e.id, e]));
    let borrowerTxn = 0;
    let borrowerFunctional = 0;
    for (const l of ukLinesAll) {
      if (!ukEntries.has(l.journal_entry_id)) continue;
      borrowerTxn += l.txn_currency === 'USD' && l.txn_amount !== null ? -l.txn_amount : 0;
      borrowerFunctional += l.credit - l.debit;
    }
    const usLines = await periodLines(ctx.svc, us.id, [dueFrom.id], ctx.periodKey);
    const ukLines = await periodLines(ctx.svc, uk.id, [dueTo.id], ctx.periodKey);
    const groups = new Map<string, IcActivityOut>();
    const g = (ref: string) => {
      let x = groups.get(ref);
      if (!x) groups.set(ref, (x = { ref, status: 'matched', lender: [], borrower: [], difference: 0, lenderLines: [] }));
      return x;
    };
    for (const l of usLines) {
      const ref = IC_REF.exec(l.memo)?.[1];
      if (!ref) continue;
      const x = g(ref);
      x.lender.push({ entryNumber: l.entryNumber, date: l.entryDate, amount: l.debit - l.credit, memo: l.memo });
      const full = await ctx.svc.db.find('journal_line', { journal_entry_id: l.entryId });
      x.lenderLines = full.map((f) => ({ accountId: f.account_id, debit: f.debit, credit: f.credit, departmentId: f.department_id }));
    }
    for (const l of ukLines) {
      const ref = IC_REF.exec(l.memo)?.[1];
      if (!ref) continue;
      if (l.entryType === 'fx_revaluation') continue;
      g(ref).borrower.push({ entryNumber: l.entryNumber, date: l.entryDate, amount: l.txnAmount !== null && l.txnCurrency === 'USD' ? -l.txnAmount : 0, amountFunctional: l.credit - l.debit, memo: l.memo });
    }
    for (const x of groups.values()) {
      const a = x.lender.reduce((s, y) => s + y.amount, 0);
      const b = x.borrower.reduce((s, y) => s + y.amount, 0);
      x.difference = a - b;
      x.status = !x.borrower.length ? 'lender_only' : !x.lender.length ? 'borrower_only' : x.difference === 0 ? 'matched' : 'amount_mismatch';
    }
    const pe = periodEnd(ctx.periodKey);
    return {
      periodKey: ctx.periodKey,
      lender: { entityId: us.id, code: us.code, currency: us.functional_currency, accountId: dueFrom.id, balance: lenderBal },
      borrower: { entityId: uk.id, code: uk.code, currency: uk.functional_currency, accountId: dueTo.id, balanceTxn: borrowerTxn, balanceFunctional: borrowerFunctional },
      difference: lenderBal - borrowerTxn,
      tolerance: ctx.policy.thresholds.toleranceCents ?? 100,
      activity: [...groups.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
      reconciliationId: rec.id,
      averageRate: await fxRate(ctx.svc, uk.functional_currency, us.functional_currency, pe, 'average'),
      closingRate: await fxRate(ctx.svc, uk.functional_currency, us.functional_currency, pe, 'closing'),
    };
  },
});

export const getEliminationBasis = defineTool({
  name: 'get_elimination_basis',
  description: 'What consolidation must eliminate this month: intercompany revenue and expense (USD) and due-from / due-to balances at month end, plus eliminations already posted.',
  input: z.object({}),
  outputClass: 'ek:EliminationEntry',
  permission: 'report.view',
  handler: async (ctx: AgentCtx) => {
    const ents = [...(await entities(ctx.svc)).values()];
    const us = ents.find((e) => e.code === 'US')!;
    const consol = ents.find((e) => e.is_elimination)!;
    const accs = [...(await accounts(ctx.svc)).values()];
    const code = (c: string) => accs.find((a) => a.code === c)!;
    const usLines = await periodLines(ctx.svc, us.id, [code('4900').id], ctx.periodKey);
    const icRevenue = usLines.reduce((s, l) => s + l.credit - l.debit, 0);
    const dueFrom = await ledgerBalance(ctx.svc, us.id, code('1300').id, ctx.periodKey);
    const existing = await ctx.svc.db.find('journal_entry', { tenant_id: ctx.svc.tenantId, entity_id: consol.id, period_key: ctx.periodKey, entry_type: 'elimination', status: { in: ['posted', 'pending_approval'] } });
    return {
      periodKey: ctx.periodKey,
      consolidationEntityId: consol.id,
      lenderEntityId: us.id,
      borrowerEntityId: ents.find((e) => e.code === 'UK')!.id,
      icRevenueUsd: icRevenue,
      icExpenseUsd: icRevenue,
      dueFromUsd: dueFrom,
      accounts: { icRevenue: code('4900').id, icExpense: code('6950').id, dueFrom: code('1300').id, dueTo: code('2400').id },
      existing: existing.map((e) => ({ entryNumber: e.entry_number, memo: e.memo, total: e.total_debit, status: e.status })),
    };
  },
});

// ------------------------------------------------------------------ FX

export interface FxBalanceOut {
  entityId: string;
  entityCode: string;
  functionalCurrency: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  txnCurrency: string;
  txnBalance: number;
  booked: number;
  closingRate: number;
  remeasured: number;
  difference: number;
  counterpartyEntityId: string | null;
}

export const listForeignCurrencyBalances = defineTool({
  name: 'list_foreign_currency_balances',
  description: 'Monetary balances carried in a transaction currency different from the entity’s functional currency, with booked amount, closing rate, remeasured amount and the difference to book.',
  input: z.object({}),
  outputClass: 'ek:MonetaryItem',
  permission: 'report.view',
  handler: async (ctx: AgentCtx) => {
    const accs = await accounts(ctx.svc);
    const out: FxBalanceOut[] = [];
    for (const e of [...(await entities(ctx.svc)).values()].filter((x) => !x.is_elimination)) {
      const entries = new Map((await ctx.svc.db.find('journal_entry', { tenant_id: ctx.svc.tenantId, entity_id: e.id, status: 'posted', period_key: { lte: ctx.periodKey } })).map((x) => [x.id, x]));
      const lines = await ctx.svc.db.find('journal_line', { tenant_id: ctx.svc.tenantId, txn_currency: { ne: e.functional_currency } });
      const groups = new Map<string, { accountId: string; ccy: string; cp: string | null; txn: number; booked: number }>();
      for (const l of lines) {
        if (!l.txn_currency || !entries.has(l.journal_entry_id)) continue;
        const a = accs.get(l.account_id);
        if (!a?.is_monetary) continue;
        const k = `${l.account_id}|${l.txn_currency}|${l.counterparty_entity_id ?? ''}`;
        const gr = groups.get(k) ?? { accountId: l.account_id, ccy: l.txn_currency, cp: l.counterparty_entity_id, txn: 0, booked: 0 };
        gr.txn += l.txn_amount ?? 0;
        gr.booked += l.debit - l.credit;
        groups.set(k, gr);
      }
      for (const gr of groups.values()) {
        const a = accs.get(gr.accountId)!;
        const rate = await fxRate(ctx.svc, gr.ccy, e.functional_currency, periodEnd(ctx.periodKey), 'closing');
        const remeasured = convertCents(gr.txn, rate);
        out.push({ entityId: e.id, entityCode: e.code, functionalCurrency: e.functional_currency, accountId: a.id, accountCode: a.code, accountName: a.name, txnCurrency: gr.ccy, txnBalance: gr.txn, booked: gr.booked, closingRate: rate, remeasured, difference: remeasured - gr.booked, counterpartyEntityId: gr.cp });
      }
    }
    return { periodKey: ctx.periodKey, items: out };
  },
});

export const getFxRates = defineTool({
  name: 'get_fx_rates',
  description: 'Closing and average exchange rates for the period (GBP/USD).',
  input: z.object({}),
  outputClass: 'ek:ExchangeRate',
  permission: 'report.view',
  handler: async (ctx: AgentCtx) => {
    const pe = periodEnd(ctx.periodKey);
    return { periodKey: ctx.periodKey, rates: [{ pair: 'GBP/USD', closing: await fxRate(ctx.svc, 'GBP', 'USD', pe, 'closing'), average: await fxRate(ctx.svc, 'GBP', 'USD', pe, 'average') }] };
  },
});

export const CASH_TOOLS: AnyTool[] = [getReconciliation, listUnmatchedItems, runMatchingEngine, getTieout, listControlAccountActivity, findOverpayments, getIntercompanyPosition, getEliminationBasis, listForeignCurrencyBalances, getFxRates];
