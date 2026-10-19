/**
 * Time and calendar helpers. Business dates are ISO `YYYY-MM-DD` strings (no time zone drift);
 * instants are ISO-8601 UTC strings. The Clock port lets demo tenants run on a scenario clock.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock frozen to a business date plus the real time-of-day progression since creation. */
export function scenarioClock(isoDate: string, hour = 9): Clock {
  const anchor = Date.parse(`${isoDate}T${String(hour).padStart(2, '0')}:00:00Z`);
  const started = Date.now();
  return { now: () => new Date(anchor + (Date.now() - started)) };
}

export function isoNow(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function today(clock: Clock = systemClock): string {
  return toIsoDate(clock.now());
}

export function parseIsoDate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`invalid ISO date: ${s}`);
  return new Date(`${s}T00:00:00Z`);
}

export function addDays(iso: string, days: number): string {
  const d = parseIsoDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseIsoDate(a).getTime() - parseIsoDate(b).getTime()) / 86_400_000);
}

export function dayOfWeek(iso: string): number {
  return parseIsoDate(iso).getUTCDay(); // 0 = Sunday
}

export function isWeekend(iso: string): boolean {
  const d = dayOfWeek(iso);
  return d === 0 || d === 6;
}

/** Period keys are `YYYY-MM`. */
export function periodKeyOf(iso: string): string {
  return iso.slice(0, 7);
}

export function periodStart(periodKey: string): string {
  return `${periodKey}-01`;
}

export function periodEnd(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${periodKey}-${String(last).padStart(2, '0')}`;
}

export function shiftPeriod(periodKey: string, months: number): string {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function periodRange(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  let k = fromKey;
  while (k <= toKey) {
    out.push(k);
    k = shiftPeriod(k, 1);
  }
  return out;
}

export function daysInPeriod(periodKey: string): number {
  return Number(periodEnd(periodKey).slice(8, 10));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function periodLabel(periodKey: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  const name = MONTHS[m - 1]!;
  return style === 'long' ? `${name} ${y}` : `${name.slice(0, 3)} ${y}`;
}

export function formatDate(iso: string, style: 'short' | 'long' = 'short'): string {
  const d = parseIsoDate(iso.slice(0, 10));
  const m = MONTHS[d.getUTCMonth()]!;
  return style === 'long'
    ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]}, ${m.slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
    : `${m.slice(0, 3)} ${d.getUTCDate()}`;
}

export function addMinutes(isoInstant: string, minutes: number): string {
  return new Date(Date.parse(isoInstant) + minutes * 60_000).toISOString();
}
