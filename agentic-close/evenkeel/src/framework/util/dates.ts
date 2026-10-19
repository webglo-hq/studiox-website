/**
 * Calendar dates are ISO strings "YYYY-MM-DD" (no time zone); periods are "YYYY-MM".
 * All arithmetic is done in UTC so results never depend on the host time zone.
 */
export type CalendarDate = string;
export type PeriodKey = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export function isCalendarDate(s: unknown): s is CalendarDate {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function isPeriodKey(s: unknown): s is PeriodKey {
  if (typeof s !== 'string') return false;
  const m = PERIOD_RE.exec(s);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

function toUtc(date: CalendarDate): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new TypeError(`invalid calendar date: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fromUtc(d: Date): CalendarDate {
  return d.toISOString().slice(0, 10);
}

export function makeDate(year: number, month: number, day: number): CalendarDate {
  return fromUtc(new Date(Date.UTC(year, month - 1, day)));
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

export function diffDays(a: CalendarDate, b: CalendarDate): number {
  return Math.round((toUtc(a).getTime() - toUtc(b).getTime()) / 86_400_000);
}

/** 0 = Sunday ... 6 = Saturday */
export function dayOfWeek(date: CalendarDate): number {
  return toUtc(date).getUTCDay();
}

export function isWeekend(date: CalendarDate): boolean {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}

export function periodOf(date: CalendarDate): PeriodKey {
  return date.slice(0, 7);
}

export function periodStart(period: PeriodKey): CalendarDate {
  if (!isPeriodKey(period)) throw new TypeError(`invalid period: ${period}`);
  return `${period}-01`;
}

export function periodEnd(period: PeriodKey): CalendarDate {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return fromUtc(new Date(Date.UTC(y, m, 0)));
}

export function daysInPeriod(period: PeriodKey): number {
  return Number(periodEnd(period).slice(8, 10));
}

export function addMonths(period: PeriodKey, n: number): PeriodKey {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function monthsBetween(from: PeriodKey, to: PeriodKey): number {
  const [y1, m1] = from.split('-').map(Number) as [number, number];
  const [y2, m2] = to.split('-').map(Number) as [number, number];
  return (y2 - y1) * 12 + (m2 - m1);
}

export function periodRange(from: PeriodKey, to: PeriodKey): PeriodKey[] {
  const out: PeriodKey[] = [];
  for (let p = from; monthsBetween(p, to) >= 0; p = addMonths(p, 1)) out.push(p);
  return out;
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a <= b ? a : b;
}

export function maxDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a >= b ? a : b;
}

export function isBetween(date: CalendarDate, from: CalendarDate, to: CalendarDate): boolean {
  return date >= from && date <= to;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatPeriod(period: PeriodKey, style: 'long' | 'short' = 'long'): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return `${(style === 'long' ? MONTHS : MONTHS_SHORT)[m - 1]} ${y}`;
}

export function formatDate(date: CalendarDate, style: 'short' | 'medium' | 'long' = 'medium'): string {
  const d = toUtc(date);
  const mon = MONTHS_SHORT[d.getUTCMonth()];
  if (style === 'short') return `${mon} ${d.getUTCDate()}`;
  if (style === 'long') return `${DOW[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  return `${mon} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function weekdayName(date: CalendarDate): string {
  return DOW[dayOfWeek(date)]!;
}

/** Local calendar date of an instant in an IANA time zone. */
export function dateInZone(instant: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Hour (0-23) of an instant in a time zone; used for after-hours posting tests. */
export function hourInZone(instant: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(instant);
  return Number(h);
}

export function formatTimestamp(iso: string, timeZone = 'America/Los_Angeles'): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}
