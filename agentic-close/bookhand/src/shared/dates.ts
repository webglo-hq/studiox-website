/**
 * Date-only arithmetic on ISO strings (YYYY-MM-DD), computed in UTC so results never depend on the
 * host time zone. Includes the close calendar's workday math (WD-n / WD+n) and US bank holidays.
 */

export type IsoDate = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function toUtc(date: IsoDate): Date {
  if (!DATE_RE.test(date)) throw new RangeError(`Invalid ISO date: ${date}`);
  return new Date(`${date}T00:00:00Z`);
}

export function fromUtc(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function ymd(year: number, month: number, day: number): IsoDate {
  return fromUtc(new Date(Date.UTC(year, month - 1, day)));
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

export function diffDays(later: IsoDate, earlier: IsoDate): number {
  return Math.round((toUtc(later).getTime() - toUtc(earlier).getTime()) / 86_400_000);
}

/** 0 = Sunday ... 6 = Saturday */
export function dayOfWeek(date: IsoDate): number {
  return toUtc(date).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

export function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

export function monthOf(date: IsoDate): number {
  return Number(date.slice(5, 7));
}

export function monthStart(year: number, month: number): IsoDate {
  return ymd(year, month, 1);
}

export function monthEnd(year: number, month: number): IsoDate {
  return fromUtc(new Date(Date.UTC(year, month, 0)));
}

export function daysInMonth(year: number, month: number): number {
  return Number(monthEnd(year, month).slice(8, 10));
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function monthName(month: number, long = false): string {
  return (long ? MONTHS_LONG : MONTHS)[month - 1] ?? '';
}

export function formatDate(date: IsoDate, style: 'short' | 'long' | 'weekday' = 'short'): string {
  const y = yearOf(date);
  const m = monthOf(date);
  const d = Number(date.slice(8, 10));
  if (style === 'long') return `${monthName(m, true)} ${d}, ${y}`;
  if (style === 'weekday') return `${DAYS[dayOfWeek(date)]}, ${monthName(m)} ${d}`;
  return `${monthName(m)} ${d}, ${y}`;
}

export function formatPeriod(year: number, month: number, long = false): string {
  return `${monthName(month, long)} ${year}`;
}

// ---------------------------------------------------------------------------------------------
// Holidays (US Federal Reserve bank holidays; weekend holidays observed per Fed rules)

function nthWeekday(year: number, month: number, weekday: number, n: number): IsoDate {
  const first = ymd(year, month, 1);
  const offset = (weekday - dayOfWeek(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

function lastWeekday(year: number, month: number, weekday: number): IsoDate {
  const last = monthEnd(year, month);
  const offset = (dayOfWeek(last) - weekday + 7) % 7;
  return addDays(last, -offset);
}

function observed(date: IsoDate): IsoDate {
  const dow = dayOfWeek(date);
  if (dow === 0) return addDays(date, 1); // Sunday -> Monday
  // The Fed does not shift Saturday holidays to Friday; banks are open Friday.
  return date;
}

const holidayCache = new Map<number, Map<IsoDate, string>>();

export function usBankHolidays(year: number): Map<IsoDate, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const list: Array<[IsoDate, string]> = [
    [observed(ymd(year, 1, 1)), "New Year's Day"],
    [nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day'],
    [nthWeekday(year, 2, 1, 3), "Washington's Birthday"],
    [lastWeekday(year, 5, 1), 'Memorial Day'],
    [observed(ymd(year, 6, 19)), 'Juneteenth'],
    [observed(ymd(year, 7, 4)), 'Independence Day'],
    [nthWeekday(year, 9, 1, 1), 'Labor Day'],
    [nthWeekday(year, 10, 1, 2), 'Columbus Day'],
    [observed(ymd(year, 11, 11)), 'Veterans Day'],
    [nthWeekday(year, 11, 4, 4), 'Thanksgiving Day'],
    [observed(ymd(year, 12, 25)), 'Christmas Day'],
  ];
  const map = new Map<IsoDate, string>(list);
  holidayCache.set(year, map);
  return map;
}

export interface BusinessCalendar {
  isBusinessDay(date: IsoDate): boolean;
  holidayName(date: IsoDate): string | undefined;
}

export function usBusinessCalendar(extraHolidays: IsoDate[] = []): BusinessCalendar {
  const extra = new Set(extraHolidays);
  return {
    isBusinessDay(date) {
      if (isWeekend(date) || extra.has(date)) return false;
      return !usBankHolidays(yearOf(date)).has(date);
    },
    holidayName(date) {
      if (extra.has(date)) return 'Company holiday';
      return usBankHolidays(yearOf(date)).get(date);
    },
  };
}

export function nextBusinessDay(date: IsoDate, cal: BusinessCalendar): IsoDate {
  let d = addDays(date, 1);
  while (!cal.isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

export function previousBusinessDay(date: IsoDate, cal: BusinessCalendar): IsoDate {
  let d = addDays(date, -1);
  while (!cal.isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

/**
 * Close-calendar workdays relative to a period end.
 * WD1 is the first business day AFTER the period end; WD-1 is the last business day ON or BEFORE it.
 * There is no WD0.
 */
export function workdayToDate(periodEnd: IsoDate, workday: number, cal: BusinessCalendar): IsoDate {
  if (workday === 0) throw new RangeError('There is no WD0; use WD-1 (last business day) or WD1');
  if (workday > 0) {
    let d = periodEnd;
    for (let i = 0; i < workday; i++) d = nextBusinessDay(d, cal);
    return d;
  }
  let d = cal.isBusinessDay(periodEnd) ? periodEnd : previousBusinessDay(periodEnd, cal);
  for (let i = 1; i < -workday; i++) d = previousBusinessDay(d, cal);
  return d;
}

/** Inverse of workdayToDate. A non-business date maps to the next business day's workday number. */
export function dateToWorkday(periodEnd: IsoDate, date: IsoDate, cal: BusinessCalendar): number {
  let d = date;
  while (!cal.isBusinessDay(d)) d = addDays(d, 1);
  if (d > periodEnd) {
    let count = 0;
    let cursor = periodEnd;
    while (cursor < d) {
      cursor = nextBusinessDay(cursor, cal);
      count++;
    }
    return count;
  }
  let count = 1;
  let cursor = cal.isBusinessDay(periodEnd) ? periodEnd : previousBusinessDay(periodEnd, cal);
  while (cursor > d) {
    cursor = previousBusinessDay(cursor, cal);
    count++;
  }
  return -count;
}

export function formatWorkday(wd: number): string {
  return wd > 0 ? `WD+${wd}` : `WD${wd}`;
}

/** Short label used in the UI: WD3 for positive, WD-2 for negative. */
export function workdayLabel(wd: number): string {
  return wd > 0 ? `WD${wd}` : `WD${wd}`;
}
