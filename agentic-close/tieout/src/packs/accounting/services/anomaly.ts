/**
 * Journal-entry risk review (PCAOB AS 2401 ¶.58–.62 style tests over the period's entries):
 *
 *   self_approval      prepared and approved by the same person (SoD break)
 *   duplicate_payment  the same bill paid twice, or same vendor + amount within a week
 *   weekend_holiday    manual/imported entries dated on a non-business day
 *   round_amount       large manual entries in round thousands
 *   threshold_skirting manual entries just under an approval limit
 *   benford            first-digit distribution of the year's line amounts (MAD, Nigrini 2012)
 *
 * Each test is deterministic and explains itself; the risk score is a transparent sum of weights.
 */
import { addDays, diffDays, periodEnd, periodStart, shiftPeriod } from '../../../core/util/time';
import { isBusinessDay } from '../close/workdays';
import { ROLES } from '../controls/permissions';
import type { AcctContext } from './context';

export interface RiskHit {
  test: 'self_approval' | 'duplicate_payment' | 'weekend_holiday' | 'round_amount' | 'threshold_skirting';
  weight: number;
  detail: string;
}

export interface FlaggedEntry {
  jeId: string;
  jeNumber: string;
  date: string;
  memo: string;
  amountMinor: number;
  source: string;
  preparedBy: string;
  approvedBy: string | null;
  hits: RiskHit[];
  score: number;
}

export interface DuplicatePayment {
  vendorId: string;
  vendorName: string;
  amountMinor: number;
  billId: string | null;
  billNumber: string | null;
  payments: { id: string; number: string; date: string; jeId: string | null }[];
  reason: string;
}

export interface BenfordResult {
  sample: number;
  mad: number;
  conformity: 'close' | 'acceptable' | 'marginal' | 'nonconformity' | 'insufficient_data';
  observed: number[];
  expected: number[];
}

const MANUAL = new Set(['manual', 'import', 'agent']);
const BENFORD = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => Math.log10(1 + 1 / d));

export class AnomalyService {
  constructor(private readonly c: AcctContext) {}

  async scan(entityId: string, periodKey: string): Promise<{ flagged: FlaggedEntry[]; duplicates: DuplicatePayment[]; benford: BenfordResult; scanned: number }> {
    const entity = await this.c.entity(entityId);
    const headers = await this.c.tx.find('journal_entries', { entity_id: entityId, status: 'posted', posting_date: { gte: periodStart(periodKey), lte: periodEnd(periodKey) } });
    const users = new Map((await this.c.tx.find('users', {})).map((u) => [u.id, u.display_name]));
    const name = (id: string | null) => (id ? (users.get(id) ?? id) : 'nobody');
    const limits = [...new Set(ROLES.map((r) => r.approvalLimitMinor).filter((x): x is number => !!x && x > 0))];
    const flagged: FlaggedEntry[] = [];
    for (const h of headers) {
      const hits: RiskHit[] = [];
      if (h.approval_route === 'human' && h.approved_by && h.approved_by === h.prepared_by) hits.push({ test: 'self_approval', weight: 50, detail: `Prepared and approved by ${name(h.prepared_by)} (no second person).` });
      if (MANUAL.has(h.source)) {
        if (!isBusinessDay(h.posting_date, entity.holiday_calendar)) hits.push({ test: 'weekend_holiday', weight: 15, detail: `Dated ${h.posting_date}, a ${new Date(`${h.posting_date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} — not a business day.` });
        if (h.total_minor >= 1_000_000 && h.total_minor % 100_000 === 0) hits.push({ test: 'round_amount', weight: 10, detail: `Round amount (${(h.total_minor / 100).toLocaleString('en-US', { style: 'currency', currency: entity.functional_currency })}).` });
        for (const lim of limits) if (h.total_minor < lim && h.total_minor >= lim * 0.97) hits.push({ test: 'threshold_skirting', weight: 20, detail: `Just under the ${(lim / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} approval limit.` });
        if (h.source === 'import') for (const x of hits) if (x.test === 'self_approval') x.detail += ' Imported entries bypass the in-app maker-checker, so this was never independently approved.';
      }
      if (!hits.length) continue;
      const score = hits.reduce((s, x) => s + x.weight, 0);
      if (score < 20) continue;
      flagged.push({ jeId: h.id, jeNumber: h.je_number, date: h.posting_date, memo: h.memo, amountMinor: h.total_minor, source: h.source, preparedBy: name(h.prepared_by), approvedBy: h.approved_by ? name(h.approved_by) : null, hits, score });
    }
    flagged.sort((a, b) => b.score - a.score || b.amountMinor - a.amountMinor);
    const duplicates = await this.duplicatePayments(entityId, periodKey);
    const benford = await this.benford(entityId, periodKey);
    return { flagged, duplicates, benford, scanned: headers.length };
  }

  async duplicatePayments(entityId: string, periodKey: string): Promise<DuplicatePayment[]> {
    const pays = (await this.c.tx.find('payments', { entity_id: entityId, payment_date: { gte: addDays(periodStart(periodKey), -7), lte: periodEnd(periodKey) } })).filter((p) => p.status !== 'void');
    const vendors = new Map((await this.c.tx.find('vendors', {})).map((v) => [v.id, v.name]));
    const apps = await this.c.tx.find('payment_applications', { payment_id: { in: pays.map((p) => p.id) } });
    const out: DuplicatePayment[] = [];
    const seen = new Set<string>();
    // same bill paid more than once
    const byBill = new Map<string, typeof pays>();
    for (const a of apps) {
      const p = pays.find((x) => x.id === a.payment_id)!;
      byBill.set(a.bill_id, [...(byBill.get(a.bill_id) ?? []), p]);
    }
    for (const [billId, ps] of byBill) {
      if (ps.length < 2) continue;
      const bill = await this.c.tx.get('bills', billId);
      if (!bill) continue;
      const applied = apps.filter((a) => a.bill_id === billId).reduce((s, a) => s + a.amount_minor, 0);
      if (applied <= bill.total_minor) continue;
      ps.forEach((p) => seen.add(p.id));
      out.push({ vendorId: bill.vendor_id, vendorName: vendors.get(bill.vendor_id) ?? '', amountMinor: applied - bill.total_minor, billId, billNumber: bill.bill_number, payments: ps.map((p) => ({ id: p.id, number: p.payment_number, date: p.payment_date, jeId: p.journal_entry_id })), reason: `Bill ${bill.bill_number} (${(bill.total_minor / 100).toLocaleString('en-US', { style: 'currency', currency: bill.currency })}) has ${ps.length} payments applied (${ps.map((p) => `${p.payment_number} on ${p.payment_date}`).join(', ')}); it was overpaid by ${((applied - bill.total_minor) / 100).toLocaleString('en-US', { style: 'currency', currency: bill.currency })}.` });
    }
    // same vendor, same amount within 7 days (different bills)
    const sorted = [...pays].sort((a, b) => a.payment_date.localeCompare(b.payment_date));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (diffDays(b.payment_date, a.payment_date) > 7) break;
        if (seen.has(a.id) || seen.has(b.id) || a.vendor_id !== b.vendor_id || a.amount_minor !== b.amount_minor) continue;
        seen.add(a.id);
        seen.add(b.id);
        out.push({ vendorId: a.vendor_id, vendorName: vendors.get(a.vendor_id) ?? '', amountMinor: a.amount_minor, billId: null, billNumber: null, payments: [a, b].map((p) => ({ id: p.id, number: p.payment_number, date: p.payment_date, jeId: p.journal_entry_id })), reason: `Two payments of the same amount to the same vendor within ${diffDays(b.payment_date, a.payment_date)} days.` });
      }
    }
    return out.filter((d) => d.payments.some((p) => p.date >= periodStart(periodKey)));
  }

  /** Benford first-digit test over the trailing twelve months of line amounts (≥ $10). */
  async benford(entityId: string, periodKey: string): Promise<BenfordResult> {
    const sums = await this.c.tx.find('journal_entries', { entity_id: entityId, status: 'posted', posting_date: { gte: periodStart(shiftPeriod(periodKey, -11)), lte: periodEnd(periodKey) } });
    const ids = sums.filter((h) => h.entry_type !== 'opening').map((h) => h.id);
    const counts = Array(9).fill(0) as number[];
    let n = 0;
    if (ids.length) {
      for (const l of await this.c.tx.find('journal_lines', { journal_entry_id: { in: ids } })) {
        const amt = l.debit_minor || l.credit_minor;
        if (amt < 1000) continue;
        const d = Number(String(amt)[0]);
        counts[d - 1]!++;
        n++;
      }
    }
    if (n < 300) return { sample: n, mad: 0, conformity: 'insufficient_data', observed: counts.map(() => 0), expected: BENFORD };
    const observed = counts.map((c) => c / n);
    const mad = observed.reduce((s, o, i) => s + Math.abs(o - BENFORD[i]!), 0) / 9;
    const conformity = mad < 0.006 ? 'close' : mad < 0.012 ? 'acceptable' : mad < 0.015 ? 'marginal' : 'nonconformity';
    return { sample: n, mad: Math.round(mad * 10000) / 10000, conformity, observed: observed.map((o) => Math.round(o * 1000) / 1000), expected: BENFORD.map((e) => Math.round(e * 1000) / 1000) };
  }
}
