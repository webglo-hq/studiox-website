/**
 * Intercompany (ASC 810) and foreign-currency remeasurement (ASC 830).
 *
 * Intercompany: each entity's due-from/due-to balance and revenue/expense with each counterparty
 * is compared in the transaction currency; one-sided entries are listed so the missing side can
 * be booked. Eliminations are computed pro forma (as if pending true-ups were posted).
 *
 * FX: monetary balances carried in a foreign transaction currency are remeasured at the closing
 * rate; the change is an unrealized gain or loss (AX-FX-01).
 */
import { periodEnd, periodStart } from '../../../core/util/time';
import type { JournalEntryRow } from '../../../schema';
import { fxRate } from '../fx/rates';
import { convert } from '../ledger/money';
import type { AcctContext } from './context';

export interface IcEntry {
  entityId: string;
  entityCode: string;
  jeId: string;
  jeNumber: string;
  date: string;
  memo: string;
  sourceRef: string | null;
  accountCode: string;
  /** signed in the transaction currency (receivable +, payable −) */
  txnAmountMinor: number;
  functionalAmountMinor: number;
}

export interface IcPair {
  receivableEntityId: string;
  receivableEntityCode: string;
  payableEntityId: string;
  payableEntityCode: string;
  currency: string;
  receivableTxnMinor: number;
  payableTxnMinor: number;
  differenceTxnMinor: number;
  receivableReportingMinor: number;
  payableReportingMinor: number;
  closingRate: number;
  averageRate: number;
  oneSided: IcEntry[];
  revenueTxnMinor: number;
  expenseTxnMinor: number;
  /** payable carrying amount in the payable entity's functional currency (credit positive) */
  payableFunctionalMinor: number;
  /** IC expense booked by the payable entity this period, functional currency */
  expenseFunctionalMinor: number;
  /** proposals not yet posted that touch these intercompany accounts (for pro forma eliminations) */
  pending: { proposalId: string; ref: string; status: string; entityId: string; accountCode: string; functionalMinor: number; txnMinor: number }[];
  eliminationEntityId: string | null;
}

export interface FxExposure {
  accountCode: string;
  accountName: string;
  currency: string;
  foreignMinor: number;
  carryingMinor: number;
  closingRate: number;
  revaluedMinor: number;
  adjustmentMinor: number;
  counterpartyEntityId: string | null;
  lineCount: number;
}

export class IntercompanyService {
  constructor(private readonly c: AcctContext) {}

  private async entriesFor(entityId: string, accountCodes: string[], toDate: string, fromDate?: string) {
    const chart = await this.c.chart();
    const ids = accountCodes.map((c) => chart.account(c).id);
    const headers = await this.c.tx.find('journal_entries', { entity_id: entityId, status: 'posted', posting_date: fromDate ? { gte: fromDate, lte: toDate } : { lte: toDate } });
    const byId = new Map(headers.map((h) => [h.id, h]));
    const lines = (await this.c.tx.find('journal_lines', { account_id: { in: ids } })).filter((l) => byId.has(l.journal_entry_id));
    return lines.map((l) => ({ l, h: byId.get(l.journal_entry_id)! as JournalEntryRow, code: chart.account(l.account_id).code }));
  }

  /** Compare intercompany positions for the period (all entity pairs with balances). */
  async balances(periodKey: string, reporting = 'USD'): Promise<IcPair[]> {
    const chart = await this.c.chart();
    const legal = chart.legalEntities();
    const end = periodEnd(periodKey);
    const start = periodStart(periodKey);
    const out: IcPair[] = [];
    for (const recv of legal) {
      for (const pay of legal) {
        if (recv.id === pay.id) continue;
        const r = (await this.entriesFor(recv.id, ['1400'], end)).filter((x) => (x.l.counterparty_entity_id ?? x.h.counterparty_entity_id) === pay.id);
        const p = (await this.entriesFor(pay.id, ['2400'], end)).filter((x) => (x.l.counterparty_entity_id ?? x.h.counterparty_entity_id) === recv.id);
        if (!r.length && !p.length) continue;
        const currency = recv.functional_currency; // balances are denominated in the creditor's currency
        const txnOf = (x: { l: { txn_currency: string | null; txn_amount_minor: number | null; debit_minor: number; credit_minor: number } }, functional: string) =>
          x.l.txn_currency === currency ? x.l.txn_amount_minor! : functional === currency ? x.l.debit_minor - x.l.credit_minor : 0;
        const recTxn = r.reduce((s, x) => s + txnOf(x, recv.functional_currency), 0);
        const payTxn = -p.reduce((s, x) => s + txnOf(x, pay.functional_currency), 0);
        const closing = await fxRate(this.c.tx, currency, reporting, end, 'closing');
        const average = await fxRate(this.c.tx, currency, reporting, end, 'average');
        // one-sided entries in the period: match by source reference across the pair
        const rPeriod = r.filter((x) => x.h.posting_date >= start);
        const pPeriod = p.filter((x) => x.h.posting_date >= start);
        const pRefs = new Set(pPeriod.map((x) => x.h.source_ref).filter(Boolean));
        const rRefs = new Set(rPeriod.map((x) => x.h.source_ref).filter(Boolean));
        const oneSided: IcEntry[] = [
          ...rPeriod.filter((x) => x.h.source_ref && !pRefs.has(x.h.source_ref) && x.h.entry_type !== 'fx_revaluation').map((x) => toEntry(x, recv.code, txnOf(x, recv.functional_currency))),
          ...pPeriod.filter((x) => x.h.source_ref && !rRefs.has(x.h.source_ref) && x.h.entry_type !== 'fx_revaluation' && x.l.txn_currency).map((x) => toEntry(x, pay.code, txnOf(x, pay.functional_currency))),
        ];
        const rev = (await this.entriesFor(recv.id, ['4900'], end, start)).reduce((s, x) => s + (x.l.credit_minor - x.l.debit_minor), 0);
        const expLines = (await this.entriesFor(pay.id, ['6950'], end, start)).filter((x) => (x.l.counterparty_entity_id ?? x.h.counterparty_entity_id) === recv.id);
        const exp = expLines.reduce((s, x) => s + (x.l.txn_currency === currency ? (x.l.txn_amount_minor ?? 0) : 0), 0);
        const pending = await this.pendingFor([recv.id, pay.id], periodKey);
        out.push({
          receivableEntityId: recv.id,
          receivableEntityCode: recv.code,
          payableEntityId: pay.id,
          payableEntityCode: pay.code,
          currency,
          receivableTxnMinor: recTxn,
          payableTxnMinor: payTxn,
          differenceTxnMinor: recTxn - payTxn,
          receivableReportingMinor: convert(recTxn, closing),
          payableReportingMinor: convert(payTxn, closing),
          closingRate: closing,
          averageRate: average,
          oneSided,
          revenueTxnMinor: rev,
          expenseTxnMinor: exp,
          payableFunctionalMinor: -p.reduce((s, x) => s + x.l.debit_minor - x.l.credit_minor, 0),
          expenseFunctionalMinor: expLines.reduce((s, x) => s + x.l.debit_minor - x.l.credit_minor, 0),
          pending,
          eliminationEntityId: chart.entities.find((x) => x.kind === 'elimination')?.id ?? null,
        });
      }
    }
    return out;
  }

  /** Journal-entry proposals not yet posted that touch intercompany accounts of these entities. */
  private async pendingFor(entityIds: string[], periodKey: string): Promise<IcPair['pending']> {
    const props = await this.c.tx.find('proposals', { kind: 'journal_entry', period_key: periodKey, status: { in: ['pending_approval', 'suggested', 'approved', 'auto_approved'] }, entity_id: { in: entityIds } });
    const out: IcPair['pending'] = [];
    for (const pr of props) {
      const lines = (pr.payload.lines ?? []) as { account: string; debit?: number; credit?: number; txn_amount_minor?: number | null }[];
      if ((pr.payload.entryType as string) === 'elimination') continue;
      for (const l of lines) if (['1400', '2400', '4900', '6950'].includes(l.account)) out.push({ proposalId: pr.id, ref: pr.ref, status: pr.status, entityId: pr.entity_id!, accountCode: l.account, functionalMinor: (l.debit ?? 0) - (l.credit ?? 0), txnMinor: l.txn_amount_minor ?? 0 });
    }
    return out;
  }

  /** Functional-currency activity on the payable side's IC expense and revenue for eliminations. */
  async eliminationInputs(pair: IcPair, periodKey: string) {
    const end = periodEnd(periodKey);
    const start = periodStart(periodKey);
    const rev = await this.entriesFor(pair.receivableEntityId, ['4900'], end, start);
    const exp = (await this.entriesFor(pair.payableEntityId, ['6950'], end, start)).filter((x) => (x.l.counterparty_entity_id ?? x.h.counterparty_entity_id) === pair.receivableEntityId);
    const pay = (await this.entriesFor(pair.payableEntityId, ['2400'], end)).filter((x) => (x.l.counterparty_entity_id ?? x.h.counterparty_entity_id) === pair.receivableEntityId);
    const avg = await fxRate(this.c.tx, pair.currency, 'USD', end, 'average');
    return {
      revenueTxnMinor: rev.reduce((s, x) => s + x.l.credit_minor - x.l.debit_minor, 0),
      expenseFunctionalMinor: exp.reduce((s, x) => s + x.l.debit_minor - x.l.credit_minor, 0),
      payableFunctionalMinor: -pay.reduce((s, x) => s + x.l.debit_minor - x.l.credit_minor, 0),
      averageRate: avg,
    };
  }

  /** Foreign-currency monetary balances and their remeasurement at the closing rate. */
  async exposures(entityId: string, periodKey: string): Promise<FxExposure[]> {
    const chart = await this.c.chart();
    const entity = chart.entity(entityId);
    const end = periodEnd(periodKey);
    const sums = await this.c.tx.sumLines({ entityIds: [entityId], toDate: end, groupBy: ['account_id', 'txn_currency'] });
    const pairs = sums.filter((s) => s.txn_currency && s.txn_currency !== entity.functional_currency);
    const out: FxExposure[] = [];
    const revals = await this.c.tx.find('journal_entries', { entity_id: entityId, status: 'posted', entry_type: 'fx_revaluation', posting_date: { lte: end } });
    for (const p of pairs) {
      const acct = chart.account(p.account_id!);
      if (!acct.is_monetary) continue;
      let revalNet = 0;
      for (const j of revals) {
        for (const l of await this.c.tx.find('journal_lines', { journal_entry_id: j.id, account_id: acct.id })) if (!l.txn_currency) revalNet += l.debit_minor - l.credit_minor;
      }
      const foreign = p.txn_amount_minor;
      const carrying = p.debit_minor - p.credit_minor + revalNet;
      const closing = await fxRate(this.c.tx, p.txn_currency!, entity.functional_currency, end, 'closing');
      const revalued = convert(foreign, closing);
      const lines = await this.c.tx.find('journal_lines', { account_id: acct.id, txn_currency: p.txn_currency! });
      out.push({ accountCode: acct.code, accountName: acct.name, currency: p.txn_currency!, foreignMinor: foreign, carryingMinor: carrying, closingRate: closing, revaluedMinor: revalued, adjustmentMinor: revalued - carrying, counterpartyEntityId: lines.find((l) => l.counterparty_entity_id)?.counterparty_entity_id ?? null, lineCount: p.line_count });
    }
    return out;
  }
}

function toEntry(x: { l: { account_id: string; debit_minor: number; credit_minor: number }; h: JournalEntryRow; code: string }, entityCode: string, txn: number): IcEntry {
  return { entityId: x.h.entity_id, entityCode, jeId: x.h.id, jeNumber: x.h.je_number, date: x.h.posting_date, memo: x.h.memo, sourceRef: x.h.source_ref, accountCode: x.code, txnAmountMinor: txn, functionalAmountMinor: x.l.debit_minor - x.l.credit_minor };
}
