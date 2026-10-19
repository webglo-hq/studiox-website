/**
 * Workday calendar (tie:Workday): WD+n is the n-th business day after period end; WD-n the n-th
 * business day counting back from (and including) the last business day of the period.
 * Weekends and holiday calendars (US federal, UK England & Wales bank holidays) are excluded.
 */
import { addDays, isWeekend, parseIsoDate, periodEnd, toIsoDate } from '../../../core/util/time';

function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const d = new Date(Date.UTC(year, month - 1, 1));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === weekday) {
      count++;
      if (count === n) return toIsoDate(d);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return toIsoDate(d);
}

function observed(iso: string): string {
  const day = parseIsoDate(iso).getUTCDay();
  if (day === 6) return addDays(iso, -1);
  if (day === 0) return addDays(iso, 1);
  return iso;
}

function easterSunday(year: number): string {
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher)
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toIsoDate(new Date(Date.UTC(year, month - 1, day)));
}

const cache = new Map<string, Set<string>>();

export function holidays(calendar: 'US' | 'UK', year: number): Set<string> {
  const key = `${calendar}:${year}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const set = new Set<string>();
  if (calendar === 'US') {
    set.add(observed(`${year}-01-01`));
    set.add(nthWeekday(year, 1, 1, 3)); // MLK
    set.add(nthWeekday(year, 2, 1, 3)); // Presidents
    set.add(lastWeekday(year, 5, 1)); // Memorial
    set.add(observed(`${year}-06-19`)); // Juneteenth
    set.add(observed(`${year}-07-04`));
    set.add(nthWeekday(year, 9, 1, 1)); // Labor
    set.add(nthWeekday(year, 10, 1, 2)); // Columbus / Indigenous Peoples
    set.add(observed(`${year}-11-11`));
    set.add(nthWeekday(year, 11, 4, 4)); // Thanksgiving
    set.add(observed(`${year}-12-25`));
  } else {
    const easter = easterSunday(year);
    set.add(observed(`${year}-01-01`));
    set.add(addDays(easter, -2)); // Good Friday
    set.add(addDays(easter, 1)); // Easter Monday
    set.add(nthWeekday(year, 5, 1, 1)); // Early May
    set.add(lastWeekday(year, 5, 1)); // Spring
    set.add(lastWeekday(year, 8, 1)); // Summer
    // Christmas and Boxing Day with substitute days (England & Wales)
    const xd = parseIsoDate(`${year}-12-25`).getUTCDay();
    const pair: Record<number, [string, string]> = {
      6: [`${year}-12-27`, `${year}-12-28`], // Sat: Mon + Tue
      0: [`${year}-12-26`, `${year}-12-27`], // Sun: Mon + Tue
      5: [`${year}-12-25`, `${year}-12-28`], // Fri: Fri + Mon
    };
    for (const d of pair[xd] ?? [`${year}-12-25`, `${year}-12-26`]) set.add(d);
  }
  cache.set(key, set);
  return set;
}

export function isBusinessDay(iso: string, calendar: 'US' | 'UK' = 'US'): boolean {
  if (isWeekend(iso)) return false;
  return !holidays(calendar, Number(iso.slice(0, 4))).has(iso);
}

/** Calendar date of a workday offset relative to a period (WD+1 = first business day after period end). */
export function workdayDate(periodKey: string, offset: number, calendar: 'US' | 'UK' = 'US'): string {
  if (offset === 0) throw new Error('workday offset 0 is undefined; use WD-1 or WD+1');
  const end = periodEnd(periodKey);
  if (offset > 0) {
    let d = end;
    let n = 0;
    while (n < offset) {
      d = addDays(d, 1);
      if (isBusinessDay(d, calendar)) n++;
    }
    return d;
  }
  let d = addDays(end, 1);
  let n = 0;
  while (n < -offset) {
    d = addDays(d, -1);
    if (isBusinessDay(d, calendar)) n++;
  }
  return d;
}

/** Which workday offset a date is, relative to a period (null if not a business day). */
export function workdayOffset(periodKey: string, iso: string, calendar: 'US' | 'UK' = 'US'): number | null {
  if (!isBusinessDay(iso, calendar)) return null;
  const end = periodEnd(periodKey);
  if (iso > end) {
    let d = end;
    let n = 0;
    while (d < iso) {
      d = addDays(d, 1);
      if (isBusinessDay(d, calendar)) n++;
    }
    return n;
  }
  let d = addDays(end, 1);
  let n = 0;
  while (d > iso) {
    d = addDays(d, -1);
    if (isBusinessDay(d, calendar)) n++;
  }
  return -n;
}

export function formatWorkday(offset: number): string {
  return offset > 0 ? `WD+${offset}` : `WD${offset}`;
}
