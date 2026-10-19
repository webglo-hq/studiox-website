import { addMonths, diffDays, maxDate, minDate, periodEnd, periodStart } from '../../../framework/util/dates';
import { roundHalfAwayFromZero } from '../../../framework/util/money';
import type { BusinessCalendar } from '../../../framework/util/workdays';

/** Pure accrual detection (unrecorded liabilities). */

export interface BillFact {
  id: string;
  vendorId: string;
  vendorName: string;
  billNumber: string;
  billDate: string;
  amount: number;
  serviceStart: string | null;
  serviceEnd: string | null;
  accountId: string | null;
  departmentId: string | null;
  poId: string | null;
}

export interface PoFact {
  id: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  amount: number;
  status: string;
  receivedDate: string | null;
  serviceStart: string | null;
  serviceEnd: string | null;
  accountId: string | null;
  departmentId: string | null;
  description: string;
}

export type AccrualKind = 'recurring_gap' | 'grni' | 'subsequent_bill' | 'payroll';

export interface AccrualCandidate {
  kind: AccrualKind;
  key: string;
  vendorId: string | null;
  label: string;
  amount: number;
  accountId: string | null;
  departmentId: string | null;
  confidence: number;
  basis: string;
  refs: { type: string; id: string; label: string }[];
}

function billPeriod(b: BillFact): string {
  return (b.serviceStart ?? b.billDate).slice(0, 7);
}

/** Share of [start, end] that falls within the period (by days). */
export function overlapRatio(start: string, end: string, period: string): number {
  const ps = periodStart(period);
  const pe = periodEnd(period);
  const s = maxDate(start, ps);
  const e = minDate(end, pe);
  if (e < s) return 0;
  const total = diffDays(end, start) + 1;
  return (diffDays(e, s) + 1) / total;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : roundHalfAwayFromZero((s[m - 1]! + s[m]!) / 2);
}

/**
 * Vendors that billed in at least `minHits` of the previous `lookback` months but have no
 * bill covering the current period → accrue the median of recent amounts.
 */
export function detectRecurringGaps(bills: BillFact[], periodKey: string, lookback = 4, minHits = 3): AccrualCandidate[] {
  const byVendor = new Map<string, BillFact[]>();
  for (const b of bills) byVendor.set(b.vendorId, [...(byVendor.get(b.vendorId) ?? []), b]);
  const window = Array.from({ length: lookback }, (_, i) => addMonths(periodKey, -(i + 1)));
  const out: AccrualCandidate[] = [];
  for (const [vendorId, vb] of byVendor) {
    const monthly = new Map<string, number>();
    for (const b of vb) monthly.set(billPeriod(b), (monthly.get(billPeriod(b)) ?? 0) + b.amount);
    const hits = window.filter((p) => monthly.has(p));
    if (hits.length < minHits || monthly.has(periodKey)) continue;
    const amounts = hits.slice(0, 3).map((p) => monthly.get(p)!);
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const sd = Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length);
    const cv = mean ? sd / mean : 1;
    const latest = vb.sort((a, b) => b.billDate.localeCompare(a.billDate))[0]!;
    out.push({
      kind: 'recurring_gap',
      key: `recurring:${vendorId}:${periodKey}`,
      vendorId,
      label: `${latest.vendorName} — no ${periodKey} bill yet`,
      amount: median(amounts),
      accountId: latest.accountId,
      departmentId: latest.departmentId,
      confidence: Math.round(Math.max(0.6, Math.min(0.95, 0.95 - cv * 0.6)) * 100) / 100,
      basis: `Billed in ${hits.length} of the last ${lookback} months (median ${median(amounts)} cents, variation ${Math.round(cv * 100)}%) but nothing yet for ${periodKey}.`,
      refs: vb.slice(0, 3).map((b) => ({ type: 'bill', id: b.id, label: `${b.billNumber} (${b.billDate})` })),
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/** Purchase orders received in the period without a vendor bill (GRNI). */
export function detectGrni(pos: PoFact[], bills: BillFact[], periodKey: string): AccrualCandidate[] {
  const billedPo = new Set(bills.filter((b) => b.poId).map((b) => b.poId));
  const pe = periodEnd(periodKey);
  return pos
    .filter((p) => p.status === 'received' && p.receivedDate !== null && p.receivedDate <= pe && !billedPo.has(p.id))
    .map((p) => {
      const ratio = p.serviceStart && p.serviceEnd ? overlapRatio(p.serviceStart, p.serviceEnd, periodKey) : 1;
      const amount = roundHalfAwayFromZero(p.amount * ratio);
      return {
        kind: 'grni' as const,
        key: `grni:${p.id}:${periodKey}`,
        vendorId: p.vendorId,
        label: `${p.vendorName} — ${p.poNumber} received, not invoiced`,
        amount,
        accountId: p.accountId,
        departmentId: p.departmentId,
        confidence: 0.92,
        basis: `${p.poNumber} (${p.description}) was received on ${p.receivedDate}; no bill references it.${ratio < 1 ? ` ${Math.round(ratio * 100)}% of the service period falls in ${periodKey}.` : ''}`,
        refs: [{ type: 'purchase_order', id: p.id, label: p.poNumber }],
      };
    })
    .filter((c) => c.amount > 0);
}

/** Bills dated after period end whose service period falls (partly) in the period. */
export function detectSubsequentBills(bills: BillFact[], periodKey: string, accruedVendorIds: Set<string>): AccrualCandidate[] {
  const pe = periodEnd(periodKey);
  return bills
    .filter((b) => b.billDate > pe && b.serviceStart !== null && b.serviceEnd !== null && b.serviceStart <= pe && !accruedVendorIds.has(b.vendorId))
    .map((b) => {
      const ratio = overlapRatio(b.serviceStart!, b.serviceEnd!, periodKey);
      return {
        kind: 'subsequent_bill' as const,
        key: `subsequent:${b.id}:${periodKey}`,
        vendorId: b.vendorId,
        label: `${b.vendorName} — ${b.billNumber} received after month end`,
        amount: roundHalfAwayFromZero(b.amount * ratio),
        accountId: b.accountId,
        departmentId: b.departmentId,
        confidence: 0.96,
        basis: `Bill ${b.billNumber} dated ${b.billDate} covers ${b.serviceStart} – ${b.serviceEnd}; ${Math.round(ratio * 100)}% of that service belongs to ${periodKey}.`,
        refs: [{ type: 'bill', id: b.id, label: b.billNumber }],
      };
    })
    .filter((c) => c.amount > 0);
}

export interface PayrollFact {
  id: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  grossWages: number;
  employerTaxes: number;
  benefits: number;
  byDepartment: { departmentId: string; gross: number; taxes: number }[];
}

/**
 * Wages earned after the last pay period that ended inside the month, through month end,
 * based on the most recent payroll's daily run-rate (business days).
 */
export function payrollAccrual(payrolls: PayrollFact[], periodKey: string, cal: BusinessCalendar): { amountWages: number; amountTaxes: number; byDepartment: { departmentId: string; amount: number }[]; days: number; basis: string; ref: PayrollFact } | null {
  const pe = periodEnd(periodKey);
  const within = payrolls.filter((p) => p.periodEnd <= pe).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const last = within[0];
  if (!last || last.periodEnd >= pe) return null;
  const covered = payrolls.some((p) => p.periodStart <= pe && p.periodEnd >= pe && p.payDate <= pe);
  if (covered) return null;
  const unpaidDays = cal.businessDaysBetween(last.periodEnd, pe);
  const periodDays = Math.max(1, cal.businessDaysBetween(addDaysSafe(last.periodStart, -1), last.periodEnd));
  if (unpaidDays <= 0) return null;
  const ratio = unpaidDays / periodDays;
  const byDepartment = last.byDepartment.map((d) => ({ departmentId: d.departmentId, amount: roundHalfAwayFromZero((d.gross + d.taxes) * ratio) }));
  return {
    amountWages: roundHalfAwayFromZero(last.grossWages * ratio),
    amountTaxes: roundHalfAwayFromZero(last.employerTaxes * ratio),
    byDepartment,
    days: unpaidDays,
    basis: `Last payroll covered ${last.periodStart} – ${last.periodEnd} (${periodDays} business days). ${unpaidDays} business days from ${last.periodEnd} to ${pe} are earned but unpaid.`,
    ref: last,
  };
}

function addDaysSafe(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
