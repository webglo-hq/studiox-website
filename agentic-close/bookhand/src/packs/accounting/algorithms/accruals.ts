import { addMonths, monthEnd, monthStart } from '../../../shared/dates';
import { formatMoney } from '../../../shared/money';
import { normalizeDocNumber } from './text';

/**
 * Unrecorded-liability detection: three independent signals that a cost belongs in the period but has no
 * bill in the books yet.
 *   1. Recurring vendor gaps  - vendors billed nearly every month whose current-month bill is missing
 *   2. GRNI                   - PO lines received (goods/services delivered) but not billed
 *   3. Cutoff                 - bills received after period end for services performed in the period
 */

export interface HistoricalBill {
  billId: string;
  billNumber: string;
  billDate: string;
  receivedDate: string;
  serviceStart: string | null;
  serviceEnd: string | null;
  amount: number;
  accountNumber: string;
  departmentCode: string | null;
}

export interface VendorHistory {
  vendorId: string;
  vendorName: string;
  bills: HistoricalBill[];
}

export interface AccrualCandidate {
  signal: 'recurring_gap' | 'grni' | 'cutoff';
  vendorId: string;
  vendorName: string;
  amount: number;
  accountNumber: string;
  departmentCode: string | null;
  confidence: number;
  why: string;
  evidence: Array<{ type: string; id: string; label: string }>;
  memo: string;
}

/** Amounts in the entity's functional currency (a UK vendor's bills are in pounds). */
const money = (currency: string) => (m: number) => formatMoney(m, { currency });

function serviceMonth(b: HistoricalBill): string {
  return (b.serviceStart ?? b.billDate).slice(0, 7);
}

/**
 * One invoice entered twice for the same service month (the same number once normalized, e.g. INV-20931 and
 * INV20931, or the same amount for the same service period) is one cost: the later entry is left out of the history,
 * so a duplicate never inflates the run rate an accrual is based on. Duplicate detection itself (and the refund) is
 * the JE review's job.
 */
export function withoutDuplicateBills(bills: HistoricalBill[]): { kept: HistoricalBill[]; duplicates: Array<{ bill: HistoricalBill; of: HistoricalBill }> } {
  const kept: HistoricalBill[] = [];
  const duplicates: Array<{ bill: HistoricalBill; of: HistoricalBill }> = [];
  const ordered = [...bills].sort((a, b) => a.receivedDate.localeCompare(b.receivedDate) || a.billDate.localeCompare(b.billDate) || a.billId.localeCompare(b.billId));
  for (const b of ordered) {
    const of = kept.find(
      (k) =>
        serviceMonth(k) === serviceMonth(b) &&
        (normalizeDocNumber(k.billNumber) === normalizeDocNumber(b.billNumber) || (k.amount === b.amount && !!k.serviceStart && k.serviceStart === b.serviceStart && (k.serviceEnd ?? '') === (b.serviceEnd ?? ''))),
    );
    if (of) duplicates.push({ bill: b, of });
    else kept.push(b);
  }
  return { kept, duplicates };
}

/** Vendors billed in >= minMonths of the previous 6 months, with no bill for the target month. */
export function detectRecurringGaps(histories: VendorHistory[], year: number, month: number, opts: { minMonths?: number; lookback?: number; currency?: string } = {}): AccrualCandidate[] {
  const fmt = money(opts.currency ?? 'USD');
  const minMonths = opts.minMonths ?? 4;
  const lookback = opts.lookback ?? 6;
  const target = `${year}-${String(month).padStart(2, '0')}`;
  const priorMonths = Array.from({ length: lookback }, (_, i) => {
    const m = addMonths(year, month, -(i + 1));
    return `${m.year}-${String(m.month).padStart(2, '0')}`;
  });
  const out: AccrualCandidate[] = [];
  for (const h of histories) {
    const { kept, duplicates } = withoutDuplicateBills(h.bills);
    const byMonth = new Map<string, HistoricalBill[]>();
    for (const b of kept) {
      const k = serviceMonth(b);
      const list = byMonth.get(k) ?? [];
      list.push(b);
      byMonth.set(k, list);
    }
    if (byMonth.has(target)) continue;
    const present = priorMonths.filter((m) => byMonth.has(m));
    if (present.length < minMonths) continue;
    const recent = priorMonths.slice(0, 3).filter((m) => byMonth.has(m));
    if (recent.length < 2) continue; // stopped billing; not a gap
    const recentAmounts = recent.map((m) => byMonth.get(m)!.reduce((s, b) => s + b.amount, 0));
    const avg = Math.round(recentAmounts.reduce((s, a) => s + a, 0) / recentAmounts.length);
    const spread = Math.max(...recentAmounts) - Math.min(...recentAmounts);
    const stability = avg > 0 ? Math.max(0, 1 - spread / avg) : 0;
    const regularity = present.length / lookback;
    const last = byMonth.get(recent[0]!)![0]!;
    const confidence = Number(Math.min(0.96, 0.55 + 0.25 * regularity + 0.2 * stability).toFixed(3));
    out.push({
      signal: 'recurring_gap',
      vendorId: h.vendorId,
      vendorName: h.vendorName,
      amount: avg,
      accountNumber: last.accountNumber,
      departmentCode: last.departmentCode,
      confidence,
      why: `${h.vendorName} billed in ${present.length} of the last ${lookback} months (${recent.map((m, i) => `${m}: ${fmt(recentAmounts[i]!)}`).join(', ')}) but there is no bill for ${target}. Accrue the ${recent.length}-month average of ${fmt(avg)}.${duplicates.length ? ` Left out ${duplicates.map((d) => `${d.bill.billNumber} (${fmt(d.bill.amount)}), a duplicate of ${d.of.billNumber}`).join('; ')}.` : ''}`,
      evidence: recent.flatMap((m) => byMonth.get(m)!.map((b) => ({ type: 'bill', id: b.billId, label: `${b.billNumber} (${m}) ${fmt(b.amount)}` }))),
      memo: `Accrual: ${h.vendorName} ${target} (recurring, not yet billed)`,
    });
  }
  return out;
}

export interface PoLineStatus {
  poId: string;
  poNumber: string;
  poLineId: string;
  vendorId: string;
  vendorName: string;
  description: string;
  accountNumber: string;
  departmentCode: string | null;
  receipts: Array<{ id: string; date: string; amount: number }>;
  billedAmount: number;
}

/** Goods/services received on or before period end but not yet billed. */
export function detectGrni(lines: PoLineStatus[], periodEnd: string, currency = 'USD'): AccrualCandidate[] {
  const fmt = money(currency);
  const out: AccrualCandidate[] = [];
  for (const l of lines) {
    const received = l.receipts.filter((r) => r.date <= periodEnd).reduce((s, r) => s + r.amount, 0);
    const unbilled = received - l.billedAmount;
    if (unbilled <= 0) continue;
    out.push({
      signal: 'grni',
      vendorId: l.vendorId,
      vendorName: l.vendorName,
      amount: unbilled,
      accountNumber: l.accountNumber,
      departmentCode: l.departmentCode,
      confidence: 0.94,
      why: `${l.poNumber} "${l.description}": ${fmt(received)} received by ${periodEnd} but only ${fmt(l.billedAmount)} billed. Accrue the ${fmt(unbilled)} goods-received-not-invoiced balance.`,
      evidence: [{ type: 'purchase_order', id: l.poId, label: l.poNumber }, ...l.receipts.filter((r) => r.date <= periodEnd).map((r) => ({ type: 'goods_receipt', id: r.id, label: `Receipt ${r.date} ${fmt(r.amount)}` }))],
      memo: `Accrual: ${l.vendorName} ${l.poNumber} received not invoiced`,
    });
  }
  return out;
}

export interface LateBill extends HistoricalBill {
  vendorId: string;
  vendorName: string;
  /** Bill already posted in the books? (then nothing to accrue) */
  postedInPeriod: boolean;
}

/** Bills dated/received after period end whose service period falls (partly) in the period. */
export function detectCutoffBills(bills: LateBill[], year: number, month: number, currency = 'USD'): AccrualCandidate[] {
  const fmt = money(currency);
  const start = monthStart(year, month);
  const end = monthEnd(year, month);
  const out: AccrualCandidate[] = [];
  for (const b of bills) {
    if (b.postedInPeriod) continue;
    if (b.receivedDate <= end) continue;
    const sStart = b.serviceStart ?? b.billDate;
    const sEnd = b.serviceEnd ?? b.billDate;
    if (sEnd < start || sStart > end) continue;
    const totalDays = Math.max(1, (Date.parse(sEnd) - Date.parse(sStart)) / 86_400_000 + 1);
    const overlapStart = sStart > start ? sStart : start;
    const overlapEnd = sEnd < end ? sEnd : end;
    const days = (Date.parse(overlapEnd) - Date.parse(overlapStart)) / 86_400_000 + 1;
    const amount = Math.round((b.amount * days) / totalDays);
    out.push({
      signal: 'cutoff',
      vendorId: b.vendorId,
      vendorName: b.vendorName,
      amount,
      accountNumber: b.accountNumber,
      departmentCode: b.departmentCode,
      confidence: 0.97,
      why: `Bill ${b.billNumber} from ${b.vendorName} arrived ${b.receivedDate} (after period end) for services ${sStart} to ${sEnd}; ${days} of ${totalDays} days fall in the period, so ${fmt(amount)} belongs to this month (cutoff).`,
      evidence: [{ type: 'bill', id: b.billId, label: `${b.billNumber} received ${b.receivedDate}` }],
      memo: `Accrual: ${b.vendorName} ${b.billNumber} (cutoff)`,
    });
  }
  return out;
}

/** Merge signals: one accrual per vendor+account, preferring the strongest evidence (cutoff > GRNI > recurring). */
export function mergeCandidates(candidates: AccrualCandidate[]): AccrualCandidate[] {
  const rank = { cutoff: 3, grni: 2, recurring_gap: 1 } as const;
  const best = new Map<string, AccrualCandidate>();
  for (const c of candidates) {
    const key = `${c.vendorId}|${c.accountNumber}`;
    const prev = best.get(key);
    if (!prev || rank[c.signal] > rank[prev.signal]) best.set(key, c);
  }
  return Array.from(best.values()).sort((a, b) => b.amount - a.amount);
}
