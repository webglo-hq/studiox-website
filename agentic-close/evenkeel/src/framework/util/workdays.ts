import { addDays, isWeekend, periodEnd, type CalendarDate, type PeriodKey } from './dates';

/**
 * Close calendars are expressed in workdays relative to period end:
 *   WD0  = last business day of the period
 *   WD-n = n business days before WD0
 *   WD+n = n-th business day after the period ends (WD+1 = first business day of next month)
 */
export class BusinessCalendar {
  private readonly holidays: Set<CalendarDate>;

  constructor(holidays: Iterable<CalendarDate> = []) {
    this.holidays = new Set(holidays);
  }

  isBusinessDay(date: CalendarDate): boolean {
    return !isWeekend(date) && !this.holidays.has(date);
  }

  holidayName(date: CalendarDate): string | undefined {
    return this.holidays.has(date) ? 'Holiday' : undefined;
  }

  /** Last business day on or before the period end. */
  wd0(period: PeriodKey): CalendarDate {
    let d = periodEnd(period);
    while (!this.isBusinessDay(d)) d = addDays(d, -1);
    return d;
  }

  /** Calendar date of workday offset `n` (…, -2, -1, 0, +1, +2, …) for the period close. */
  dateOf(period: PeriodKey, n: number): CalendarDate {
    if (n === 0) return this.wd0(period);
    if (n < 0) {
      let d = this.wd0(period);
      let remaining = -n;
      while (remaining > 0) {
        d = addDays(d, -1);
        if (this.isBusinessDay(d)) remaining--;
      }
      return d;
    }
    let d = periodEnd(period);
    let remaining = n;
    while (remaining > 0) {
      d = addDays(d, 1);
      if (this.isBusinessDay(d)) remaining--;
    }
    return d;
  }

  /**
   * Workday offset of a date relative to the period close. Non-business days map to the
   * next business day's offset (for dates after period end) or previous (before).
   */
  offsetOf(period: PeriodKey, date: CalendarDate): number {
    const end = periodEnd(period);
    if (date > end) {
      let n = 0;
      let d = end;
      while (d < date) {
        d = addDays(d, 1);
        if (this.isBusinessDay(d)) n++;
      }
      return this.isBusinessDay(date) ? n : n + 1;
    }
    const wd0 = this.wd0(period);
    if (date >= wd0) return 0;
    let n = 0;
    let d = wd0;
    while (d > date) {
      d = addDays(d, -1);
      if (this.isBusinessDay(d)) n--;
    }
    return n;
  }

  /** Business days between two dates (exclusive of start, inclusive of end). */
  businessDaysBetween(from: CalendarDate, to: CalendarDate): number {
    if (to <= from) return 0;
    let n = 0;
    for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (this.isBusinessDay(d)) n++;
    return n;
  }
}

export function workdayLabel(n: number): string {
  if (n === 0) return 'WD0';
  return n > 0 ? `WD+${n}` : `WD${n}`;
}

/** US federal holidays observed by banks (subset relevant to 2025-2027 demo calendars). */
export const US_BANK_HOLIDAYS_2025_2027: readonly CalendarDate[] = [
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
  '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
];
