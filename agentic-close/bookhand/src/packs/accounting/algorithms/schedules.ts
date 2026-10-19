import { addMonths, monthEnd } from '../../../shared/dates';

/** Straight-line schedules for prepaids (ASC 340) and depreciation (ASC 360); rounding lands in the last month. */

export interface ScheduleLinePlan {
  index: number;
  year: number;
  month: number;
  periodEnd: string;
  amount: number;
  accumulated: number;
  remaining: number;
}

export function straightLine(basis: number, months: number, startYear: number, startMonth: number): ScheduleLinePlan[] {
  if (months <= 0) throw new RangeError('months must be positive');
  if (!Number.isSafeInteger(basis) || basis < 0) throw new RangeError('basis must be a non-negative integer');
  const base = Math.floor(basis / months);
  const lines: ScheduleLinePlan[] = [];
  let accumulated = 0;
  for (let i = 0; i < months; i++) {
    const { year, month } = addMonths(startYear, startMonth, i);
    const amount = i === months - 1 ? basis - accumulated : base;
    accumulated += amount;
    lines.push({ index: i, year, month, periodEnd: monthEnd(year, month), amount, accumulated, remaining: basis - accumulated });
  }
  return lines;
}

/** Depreciation starts the month after the asset is placed in service (company convention). */
export function depreciationPlan(cost: number, salvage: number, usefulLifeMonths: number, inServiceDate: string): ScheduleLinePlan[] {
  const y = Number(inServiceDate.slice(0, 4));
  const m = Number(inServiceDate.slice(5, 7));
  const start = addMonths(y, m, 1);
  return straightLine(cost - salvage, usefulLifeMonths, start.year, start.month);
}

/** Months covered by a service period, inclusive (Mar 1 - Feb 28 = 12). */
export function monthsCovered(start: string, end: string): number {
  const sy = Number(start.slice(0, 4));
  const sm = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(5, 7));
  return (ey - sy) * 12 + (em - sm) + 1;
}

export interface ScheduledLineState {
  scheduleId: string;
  label: string;
  periodKey: string;
  amount: number;
  status: 'scheduled' | 'posted' | 'skipped';
  lineId: string;
}

/** Lines due on or before the current period that were never posted (missed runs), oldest first. */
export function findMissedLines(lines: ScheduledLineState[], currentPeriodKey: string): ScheduledLineState[] {
  return lines.filter((l) => l.status === 'scheduled' && l.periodKey <= currentPeriodKey).sort((a, b) => a.periodKey.localeCompare(b.periodKey) || a.label.localeCompare(b.label));
}
