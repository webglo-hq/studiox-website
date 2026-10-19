import { z } from 'zod';
import type { Row } from '../../../persistence/schema';
import { convertMinor } from '../../../shared/money';
import { matchIntercompany, remeasure, type IcTransaction, type MonetaryBalance } from '../algorithms/intercompany';
import { glBalance } from '../services/recon';
import { EntityCode, entityOf, PeriodKey, periodOf, type Tool, type X } from './common';

/** Group close: intercompany reconciliation, FX remeasurement and consolidation eliminations. */

async function postedLines(x: X, entityId: string, periodIds: string[], accountIds: string[]) {
  if (!periodIds.length || !accountIds.length) return { lines: [] as Row<'journal_lines'>[], entries: new Map<string, Row<'journal_entries'>>() };
  const lines = await x.tx.find('journal_lines', { entity_id: entityId, period_id: { in: periodIds }, account_id: { in: accountIds } });
  const entries = new Map((lines.length ? await x.tx.find('journal_entries', { id: { in: [...new Set(lines.map((l) => l.journal_entry_id))] } }) : []).map((e) => [e.id, e]));
  return { lines: lines.filter((l) => entries.get(l.journal_entry_id)?.status === 'posted'), entries };
}

function icAccounts(x: X) {
  const all = [...x.pack.lookups.accountsById.values()];
  return {
    receivable: all.find((a) => a.subtype === 'bh:IntercompanyReceivable')!,
    payable: all.find((a) => a.subtype === 'bh:IntercompanyPayable')!,
    revenue: all.find((a) => a.subtype === 'bh:IntercompanyRevenue')!,
    expense: all.find((a) => a.subtype === 'bh:IntercompanyExpense')!,
    fx: all.find((a) => a.subtype === 'bh:ForeignExchangeGainLoss')!,
    cta: all.find((a) => a.subtype === 'bh:CumulativeTranslationAdjustment')!,
  };
}

/** Foreign-currency (transaction-currency) balance and functional carrying amount of an account. */
async function foreignBalance(x: X, entityId: string, accountId: string, asOf: string, currency: string) {
  const lines = (await x.tx.find('journal_lines', { entity_id: entityId, account_id: accountId, entry_date: { lte: asOf } })).filter((l) => l.txn_currency === currency);
  const entries = new Map((lines.length ? await x.tx.find('journal_entries', { id: { in: [...new Set(lines.map((l) => l.journal_entry_id))] } }) : []).map((e) => [e.id, e]));
  const posted = lines.filter((l) => entries.get(l.journal_entry_id)?.status === 'posted');
  return { txn: posted.reduce((s, l) => s + l.txn_amount_minor, 0), functional: posted.reduce((s, l) => s + l.debit_minor - l.credit_minor, 0) };
}

export const groupTools: Tool[] = [
  {
    name: 'fx_rate',
    title: 'Look up an exchange rate',
    description: 'Exchange rate (bh:ExchangeRate) from the company rate table: units of `to` per one unit of `from` on a date. Types: spot (latest on or before the date), average (month containing the date), closing (month end).',
    input: z.object({ from: z.string().length(3), to: z.string().length(3), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), type: z.enum(['spot', 'average', 'closing']).default('spot') }).strict(),
    permission: 'reports.view',
    mutation: false,
    ontology: ['bh:ExchangeRate'],
    async execute(input: { from: string; to: string; date: string; type: 'spot' | 'average' | 'closing' }, x: X) {
      const fx = await x.pack.fx();
      return { from: input.from, to: input.to, date: input.date, type: input.type, rate: Number(fx.rate(input.from, input.to, input.date, input.type).toFixed(8)) };
    },
    summarize: (o: { from: string; to: string; rate: number }) => `${o.from}/${o.to} ${o.rate}`,
  },
  {
    name: 'ic_reconcile',
    title: 'Reconcile intercompany',
    description: 'Pairs intercompany charges between entities by reference (bh:IntercompanyTransaction) in the agreement currency and compares intercompany balances (bh:IntercompanyBalance) at period end. Mismatches must be resolved before eliminating.',
    input: z.object({ period: PeriodKey }).strict(),
    permission: 'rec.view',
    mutation: false,
    untrustedOutput: true,
    ontology: ['bh:IntercompanyReconciliation', 'bh:IntercompanyTransaction'],
    async execute(input: { period: string }, x: X) {
      const { lookups } = x.pack;
      const acc = icAccounts(x);
      const txns: IcTransaction[] = [];
      const details: Record<string, Array<{ entity: string; entryId: string; entryNumber: string; memo: string | null; amountTxn: number; currency: string; date: string }>> = {};
      for (const e of lookups.operatingEntities()) {
        const p = periodOf(x, e.id, input.period);
        const { lines, entries } = await postedLines(x, e.id, [p.id], [acc.revenue.id, acc.expense.id]);
        const byEntry = new Map<string, Row<'journal_lines'>[]>();
        for (const l of lines) byEntry.set(l.journal_entry_id, [...(byEntry.get(l.journal_entry_id) ?? []), l]);
        for (const [entryId, ls] of byEntry) {
          const entry = entries.get(entryId)!;
          if (!entry.ic_reference) continue;
          const isRevenue = ls.some((l) => l.account_id === acc.revenue.id);
          const amountTxn = Math.abs(ls.reduce((s, l) => s + l.txn_amount_minor, 0));
          const currency = ls[0]!.txn_currency;
          const cp = entry.counterparty_entity_id ? lookups.entitiesById.get(entry.counterparty_entity_id)?.code : (ls[0]!.counterparty_entity_id ? lookups.entitiesById.get(ls[0]!.counterparty_entity_id)?.code : '');
          txns.push({ entityCode: e.code, counterpartyCode: cp ?? '', reference: entry.ic_reference, date: entry.entry_date, side: isRevenue ? 'receivable' : 'payable', amountTxn, txnCurrency: currency, journalEntryId: entry.id, description: entry.description });
          (details[entry.ic_reference.toUpperCase()] ??= []).push({ entity: e.code, entryId: entry.id, entryNumber: entry.entry_number, memo: ls.map((l) => l.memo).filter(Boolean).join(' | ') || null, amountTxn, currency, date: entry.entry_date });
        }
      }
      const pairs = matchIntercompany(txns).map((p) => ({ ...p, entries: details[p.reference] ?? [] }));
      const us = lookups.operatingEntities().find((e) => !e.parent_entity_id)!;
      const sub = lookups.operatingEntities().find((e) => e.parent_entity_id)!;
      const pUs = periodOf(x, us.id, input.period);
      const receivable = await glBalance(x.tx, x.ctx.tenantId, us.id, acc.receivable.id, pUs.end_date);
      const payable = await foreignBalance(x, sub.id, acc.payable.id, pUs.end_date, us.functional_currency);
      return {
        period: input.period,
        pairs,
        balances: { receivableEntity: us.code, receivable, payableEntity: sub.code, payableInAgreementCurrency: -payable.txn, payableCarryingFunctional: -payable.functional, functionalCurrency: sub.functional_currency, difference: receivable - -payable.txn },
        accounts: { receivable: acc.receivable.number, payable: acc.payable.number, revenue: acc.revenue.number, expense: acc.expense.number },
      };
    },
    summarize: (o: { pairs: Array<{ status: string }> }) => `${o.pairs.filter((p) => p.status === 'matched').length} matched, ${o.pairs.filter((p) => p.status !== 'matched').length} exception(s)`,
  },
  {
    name: 'fx_monetary_balances',
    title: 'Read foreign-currency monetary balances',
    description: 'Monetary balances held in a currency other than the entity\'s functional currency (bh:MonetaryItem), their carrying amount and the closing rate (bh:ExchangeRate); computes the remeasurement adjustment (bh:Remeasurement, ASC 830) per account.',
    input: z.object({ entity: EntityCode, period: PeriodKey }).strict(),
    permission: 'reports.view',
    mutation: false,
    ontology: ['bh:Remeasurement', 'bh:MonetaryItem', 'bh:ExchangeRate'],
    async execute(input: { entity: string; period: string }, x: X) {
      const entity = entityOf(x, input.entity);
      const period = periodOf(x, entity.id, input.period);
      const fx = await x.pack.fx();
      const monetary = [...x.pack.lookups.accountsById.values()].filter((a) => a.is_monetary);
      const currencies = new Set<string>();
      const balances: Array<MonetaryBalance & { accountId: string }> = [];
      for (const a of monetary) {
        const lines = await x.tx.find('journal_lines', { entity_id: entity.id, account_id: a.id, entry_date: { lte: period.end_date } });
        for (const c of new Set(lines.map((l) => l.txn_currency).filter((c) => c !== entity.functional_currency))) {
          currencies.add(c);
          const b = await foreignBalance(x, entity.id, a.id, period.end_date, c);
          if (b.txn !== 0 || b.functional !== 0) balances.push({ accountId: a.id, accountNumber: a.number, accountName: a.name, txnBalance: b.txn, txnCurrency: c, functionalBalance: b.functional });
        }
      }
      const out = [];
      for (const c of currencies) {
        const rate = fx.rate(c, entity.functional_currency, period.end_date, 'closing');
        out.push({ currency: c, closingRate: Number(rate.toFixed(6)), rateSource: `closing ${c}/${entity.functional_currency} ${period.end_date}`, adjustments: remeasure(balances.filter((b) => b.txnCurrency === c), rate) });
      }
      const already = await x.tx.find('journal_entries', { entity_id: entity.id, period_id: period.id, entry_type: 'revaluation', status: 'posted' });
      return { entity: entity.code, functionalCurrency: entity.functional_currency, period: input.period, periodEnd: period.end_date, gainLossAccount: x.pack.lookups.accountsBySubtype('bh:ForeignExchangeGainLoss')[0]?.number, currencies: out, balances, postedRevaluations: already.map((e) => ({ id: e.id, entryNumber: e.entry_number, description: e.description })) };
    },
    summarize: (o: { currencies: Array<{ adjustments: unknown[] }> }) => `${o.currencies.reduce((s, c) => s + c.adjustments.length, 0)} adjustment(s)`,
  },
  {
    name: 'elim_candidates',
    title: 'Compute consolidation eliminations',
    description: 'Computes elimination entries (bh:Elimination) for the elimination entity in the reporting currency: intercompany revenue and expense (subsidiary side translated at the period average rate) and intercompany balances (subsidiary side translated at the closing rate, reversed next period), with translation differences to FX and CTA (ASC 830 / ASC 810).',
    input: z.object({ period: PeriodKey }).strict(),
    permission: 'reports.view',
    mutation: false,
    ontology: ['bh:Elimination', 'bh:Consolidation', 'bh:Translation'],
    async execute(input: { period: string }, x: X) {
      const { lookups } = x.pack;
      const acc = icAccounts(x);
      const fx = await x.pack.fx();
      const elim = lookups.eliminationEntity()!;
      const parent = lookups.operatingEntities().find((e) => !e.parent_entity_id)!;
      const sub = lookups.operatingEntities().find((e) => e.parent_entity_id)!;
      const pP = periodOf(x, parent.id, input.period);
      const pS = periodOf(x, sub.id, input.period);
      const pE = periodOf(x, elim.id, input.period);
      const sums = async (entityId: string, periodId: string, accountId: string) => (await x.tx.sumLines({ tenantId: x.ctx.tenantId, entityIds: [entityId], periodIds: [periodId], accountIds: [accountId], groupBy: ['account_id'] })).reduce((s, r) => s + r.debit_minor - r.credit_minor, 0);
      const revenue = -(await sums(parent.id, pP.id, acc.revenue.id));
      const expenseFunctional = await sums(sub.id, pS.id, acc.expense.id);
      const avg = fx.rate(sub.functional_currency, parent.functional_currency, pS.end_date, 'average');
      const close = fx.rate(sub.functional_currency, parent.functional_currency, pS.end_date, 'closing');
      const expenseUsd = convertMinor(expenseFunctional, avg);
      const isDiff = revenue - expenseUsd;
      const receivable = await glBalance(x.tx, x.ctx.tenantId, parent.id, acc.receivable.id, pP.end_date);
      const payableFunctional = -(await glBalance(x.tx, x.ctx.tenantId, sub.id, acc.payable.id, pS.end_date));
      const payableUsd = convertMinor(payableFunctional, close);
      const bsDiff = payableUsd - receivable;
      const next = lookups.nextPeriod(pE);
      const income = revenue || expenseUsd
        ? {
            entity: elim.code,
            date: pE.end_date,
            type: 'elimination' as const,
            description: `Eliminate intercompany fees ${input.period}`,
            lines: [
              { account: acc.revenue.number, debit: revenue, counterpartyEntity: sub.code, memo: 'Eliminate IC revenue' },
              { account: acc.expense.number, credit: expenseUsd, counterpartyEntity: parent.code, memo: `Eliminate IC expense (translated at average ${avg.toFixed(4)})` },
              ...(isDiff > 0 ? [{ account: acc.fx.number, credit: isDiff, memo: 'Translation difference' }] : isDiff < 0 ? [{ account: acc.fx.number, debit: -isDiff, memo: 'Translation difference' }] : []),
            ],
          }
        : null;
      const balance = receivable
        ? {
            entity: elim.code,
            date: pE.end_date,
            type: 'elimination' as const,
            description: `Eliminate intercompany balances at ${pE.end_date}`,
            autoReverseDate: next?.start_date ?? null,
            lines: [
              { account: acc.payable.number, debit: payableUsd, counterpartyEntity: parent.code, memo: `Eliminate IC payable (translated at closing ${close.toFixed(4)})` },
              { account: acc.receivable.number, credit: receivable, counterpartyEntity: sub.code, memo: 'Eliminate IC receivable' },
              ...(bsDiff > 0 ? [{ account: acc.cta.number, credit: bsDiff, memo: 'Translation difference' }] : bsDiff < 0 ? [{ account: acc.cta.number, debit: -bsDiff, memo: 'Translation difference' }] : []),
            ],
          }
        : null;
      const existing = await x.tx.find('journal_entries', { entity_id: elim.id, period_id: pE.id, entry_type: 'elimination', status: 'posted' });
      return { period: input.period, rates: { average: avg, closing: close }, revenue, expenseFunctional, expenseUsd, receivable, payableFunctional, payableUsd, entries: { income, balance }, alreadyPosted: existing.map((e) => ({ id: e.id, entryNumber: e.entry_number, description: e.description })) };
    },
    summarize: (o: { entries: { income: unknown; balance: unknown } }) => `${[o.entries.income, o.entries.balance].filter(Boolean).length} elimination entr${[o.entries.income, o.entries.balance].filter(Boolean).length === 1 ? 'y' : 'ies'}`,
  },
];
