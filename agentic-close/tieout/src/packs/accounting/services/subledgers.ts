/**
 * Subledgers: AP and AR agings rebuilt from documents (bills/invoices less applications) and
 * tied out to their GL control accounts (tie:SubledgerTieOut). Counterparty balances with the
 * wrong sign (a vendor we overpaid) are surfaced for reclassification.
 */
import { diffDays } from '../../../core/util/time';
import type { AcctContext } from './context';

export interface AgingRow {
  counterpartyId: string;
  name: string;
  openMinor: number;
  buckets: { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
  documents: { id: string; number: string; date: string; due: string; totalMinor: number; openMinor: number }[];
}

export interface TieOut {
  kind: 'ap' | 'ar';
  accountCode: string;
  asOf: string;
  subledgerMinor: number;
  glMinor: number;
  differenceMinor: number;
  wrongSign: AgingRow[];
  rows: AgingRow[];
}

function bucket(asOf: string, due: string): keyof AgingRow['buckets'] {
  const late = diffDays(asOf, due);
  if (late <= 0) return 'current';
  if (late <= 30) return 'd1_30';
  if (late <= 60) return 'd31_60';
  if (late <= 90) return 'd61_90';
  return 'd90_plus';
}

const emptyBuckets = () => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });

export class SubledgerService {
  constructor(private readonly c: AcctContext) {}

  /** AP aging as of a date (credit-positive: what we owe). */
  async apAging(entityId: string, asOf: string): Promise<AgingRow[]> {
    const bills = (await this.c.tx.find('bills', { entity_id: entityId, status: { in: ['posted', 'partially_paid', 'paid'] } })).filter((b) => b.journal_entry_id);
    const jes = new Map((await this.c.tx.find('journal_entries', { entity_id: entityId, status: 'posted' })).map((j) => [j.id, j]));
    const payments = new Map((await this.c.tx.find('payments', { entity_id: entityId })).filter((p) => p.status !== 'void').map((p) => [p.id, p]));
    const apps = await this.c.tx.find('payment_applications', {});
    const paidByBill = new Map<string, number>();
    for (const a of apps) {
      const p = payments.get(a.payment_id);
      if (!p || p.payment_date > asOf) continue;
      paidByBill.set(a.bill_id, (paidByBill.get(a.bill_id) ?? 0) + a.amount_minor);
    }
    const vendors = new Map((await this.c.tx.find('vendors', {})).map((v) => [v.id, v]));
    const rows = new Map<string, AgingRow>();
    for (const b of bills) {
      const je = jes.get(b.journal_entry_id!);
      const glDate = je?.posting_date ?? b.bill_date;
      if (glDate > asOf) continue;
      const open = b.total_minor - (paidByBill.get(b.id) ?? 0);
      if (open === 0) continue;
      const v = vendors.get(b.vendor_id);
      const row = rows.get(b.vendor_id) ?? { counterpartyId: b.vendor_id, name: v?.name ?? b.vendor_id, openMinor: 0, buckets: emptyBuckets(), documents: [] };
      row.openMinor += open;
      row.buckets[bucket(asOf, b.due_date)] += open;
      row.documents.push({ id: b.id, number: b.bill_number, date: b.bill_date, due: b.due_date, totalMinor: b.total_minor, openMinor: open });
      rows.set(b.vendor_id, row);
    }
    return [...rows.values()].sort((a, b) => b.openMinor - a.openMinor);
  }

  /** AR aging as of a date (debit-positive: what customers owe us). */
  async arAging(entityId: string, asOf: string): Promise<AgingRow[]> {
    const invoices = (await this.c.tx.find('invoices', { entity_id: entityId, status: { in: ['posted', 'partially_paid', 'paid'] } })).filter((i) => i.journal_entry_id);
    const jes = new Map((await this.c.tx.find('journal_entries', { entity_id: entityId, status: 'posted' })).map((j) => [j.id, j]));
    const receipts = new Map((await this.c.tx.find('receipts', { entity_id: entityId })).map((r) => [r.id, r]));
    const apps = await this.c.tx.find('receipt_applications', {});
    const paid = new Map<string, number>();
    for (const a of apps) {
      const r = receipts.get(a.receipt_id);
      if (!r || r.receipt_date > asOf) continue;
      paid.set(a.invoice_id, (paid.get(a.invoice_id) ?? 0) + a.amount_minor);
    }
    const customers = new Map((await this.c.tx.find('customers', {})).map((c) => [c.id, c]));
    const rows = new Map<string, AgingRow>();
    for (const inv of invoices) {
      const je = jes.get(inv.journal_entry_id!);
      if ((je?.posting_date ?? inv.invoice_date) > asOf) continue;
      const open = inv.total_minor - (paid.get(inv.id) ?? 0);
      if (open === 0) continue;
      const cust = customers.get(inv.customer_id);
      const row = rows.get(inv.customer_id) ?? { counterpartyId: inv.customer_id, name: cust?.name ?? inv.customer_id, openMinor: 0, buckets: emptyBuckets(), documents: [] };
      row.openMinor += open;
      row.buckets[bucket(asOf, inv.due_date)] += open;
      row.documents.push({ id: inv.id, number: inv.invoice_number, date: inv.invoice_date, due: inv.due_date, totalMinor: inv.total_minor, openMinor: open });
      rows.set(inv.customer_id, row);
    }
    return [...rows.values()].sort((a, b) => b.openMinor - a.openMinor);
  }

  async glBalance(entityId: string, accountCode: string, asOf: string): Promise<number> {
    const acct = (await this.c.chart()).account(accountCode);
    const s = await this.c.tx.sumLines({ entityIds: [entityId], accountIds: [acct.id], toDate: asOf, groupBy: ['account_id'] });
    const net = s.reduce((t, r) => t + r.debit_minor - r.credit_minor, 0);
    return acct.normal_balance === 'debit' ? net : -net;
  }

  async tieOut(entityId: string, kind: 'ap' | 'ar', asOf: string): Promise<TieOut> {
    const rows = kind === 'ap' ? await this.apAging(entityId, asOf) : await this.arAging(entityId, asOf);
    const code = kind === 'ap' ? '2000' : '1100';
    const sub = rows.reduce((s, r) => s + r.openMinor, 0);
    const gl = await this.glBalance(entityId, code, asOf);
    return { kind, accountCode: code, asOf, subledgerMinor: sub, glMinor: gl, differenceMinor: sub - gl, wrongSign: rows.filter((r) => r.openMinor < 0), rows };
  }
}
