import { addMonths, monthsBetween } from '../../../framework/util/dates';
import { allocateEvenly } from '../../../framework/util/money';

/** Pure prepaid amortisation and straight-line depreciation schedules. */

export function prepaidSchedule(total: number, startPeriod: string, months: number): { periodKey: string; amount: number }[] {
  return allocateEvenly(total, months).map((amount, i) => ({ periodKey: addMonths(startPeriod, i), amount }));
}

export interface AssetFact {
  id: string;
  tag: string;
  name: string;
  cost: number;
  salvage: number;
  usefulLifeMonths: number;
  inServiceDate: string;
  departmentId: string | null;
  status: string;
}

/**
 * Straight-line depreciation with a full-month convention: depreciation starts in the month
 * the asset is placed in service; the last month absorbs rounding so the total equals
 * cost − salvage exactly.
 */
export function depreciationForPeriod(a: AssetFact, periodKey: string): number {
  if (a.status !== 'in_service') return 0;
  const start = a.inServiceDate.slice(0, 7);
  const idx = monthsBetween(start, periodKey);
  if (idx < 0 || idx >= a.usefulLifeMonths) return 0;
  return allocateEvenly(a.cost - a.salvage, a.usefulLifeMonths)[idx]!;
}

export function accumulatedDepreciation(a: AssetFact, throughPeriod: string): number {
  const start = a.inServiceDate.slice(0, 7);
  const n = Math.min(a.usefulLifeMonths, monthsBetween(start, throughPeriod) + 1);
  if (n <= 0) return 0;
  return allocateEvenly(a.cost - a.salvage, a.usefulLifeMonths)
    .slice(0, n)
    .reduce((s, x) => s + x, 0);
}

export interface PrepaidCandidateFact {
  subjectType: 'bill' | 'card_transaction';
  id: string;
  label: string;
  amount: number;
  serviceStart: string | null;
  serviceEnd: string | null;
  memo: string;
}

const ANNUAL_RE = /\b(annual|yearly|12[- ]month|twelve months|1[- ]year|per year)\b/i;

/** Months of future service covered by a purchase (from service dates or "annual" hints). */
export function serviceMonths(f: PrepaidCandidateFact): number | null {
  if (f.serviceStart && f.serviceEnd) {
    return monthsBetween(f.serviceStart.slice(0, 7), f.serviceEnd.slice(0, 7)) + 1;
  }
  if (ANNUAL_RE.test(f.memo) || ANNUAL_RE.test(f.label)) return 12;
  return null;
}
