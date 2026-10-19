/**
 * Money is always integer minor units ("cents") in a known currency.
 * Floating point is only used transiently for FX rates and percentages, and every
 * conversion back to money goes through `roundHalfAwayFromZero`.
 */
export type Cents = number;

export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  USD: 2,
  GBP: 2,
  EUR: 2,
  CAD: 2,
  JPY: 0,
});

export function assertCents(value: unknown, label = 'amount'): asserts value is Cents {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer number of minor units, got ${String(value)}`);
  }
}

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Round half away from zero (commercial rounding), symmetric for negatives. */
export function roundHalfAwayFromZero(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x}`);
  const r = Math.sign(x) * Math.round(Math.abs(x) + Number.EPSILON * Math.abs(x));
  return r === 0 ? 0 : r; // normalise -0
}

/** Parse a decimal amount ("1,234.56", "(12.00)", "-3.5", 12.34) into cents. */
export function toCents(value: number | string, minorUnits = 2): Cents {
  if (typeof value === 'number') {
    return roundHalfAwayFromZero(value * 10 ** minorUnits);
  }
  let s = value.trim();
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[,\s$£€]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new TypeError(`not a decimal amount: ${value}`);
  const [whole, frac = ''] = s.split('.') as [string, string?];
  const fracPadded = (frac + '0'.repeat(minorUnits + 1)).slice(0, minorUnits + 1);
  const base = Number(whole) * 10 ** minorUnits + Number(fracPadded.slice(0, minorUnits) || '0');
  const roundDigit = Number(fracPadded.slice(minorUnits, minorUnits + 1) || '0');
  const cents = base + (roundDigit >= 5 ? 1 : 0);
  return negative ? -cents : cents;
}

export function fromCents(cents: Cents, minorUnits = 2): number {
  return cents / 10 ** minorUnits;
}

/** Fixed-point decimal string, e.g. 123456 -> "1234.56". */
export function centsToDecimalString(cents: Cents, minorUnits = 2): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  if (minorUnits === 0) return `${neg ? '-' : ''}${abs}`;
  const s = abs.toString().padStart(minorUnits + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -minorUnits)}.${s.slice(-minorUnits)}`;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) total += v;
  if (!Number.isSafeInteger(total)) throw new RangeError('money overflow');
  return total;
}

/** Convert an amount with an exchange rate, rounding once at the end. */
export function convertCents(cents: Cents, rate: number): Cents {
  return roundHalfAwayFromZero(cents * rate);
}

/**
 * Split `total` into `parts` integer pieces that sum exactly to `total`,
 * distributing remainder pennies to the earliest pieces (largest-remainder method).
 */
export function allocateEvenly(total: Cents, parts: number): Cents[] {
  if (!Number.isInteger(parts) || parts <= 0) throw new RangeError('parts must be a positive integer');
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / parts);
  let remainder = abs - base * parts;
  const out: Cents[] = [];
  for (let i = 0; i < parts; i++) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    out.push(sign * (base + extra));
  }
  return out;
}

/** Allocate by weights (e.g. days in service), exact to the penny. */
export function allocateByWeights(total: Cents, weights: number[]): Cents[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) throw new RangeError('weights must sum to a positive number');
  const raw = weights.map((w) => (total * w) / sumW);
  const floored = raw.map((r) => (r >= 0 ? Math.floor(r) : Math.ceil(r)));
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: Math.abs(r - floored[i]!) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const step = remainder >= 0 ? 1 : -1;
  for (let k = 0; remainder !== 0; k = (k + 1) % order.length) {
    floored[order[k]!.i]! += step;
    remainder -= step;
  }
  return floored;
}

const formatters = new Map<string, Intl.NumberFormat>();

export interface FormatMoneyOptions {
  /** Show negatives as (1,234.00) like a ledger. Default true. */
  accounting?: boolean;
  /** Include the currency symbol. Default true. */
  symbol?: boolean;
  /** Compact notation (e.g. $1.2M). */
  compact?: boolean;
  /** Drop minor units (round to whole currency units). */
  whole?: boolean;
  /** Always show a sign for positives (for variances). */
  signed?: boolean;
}

export function formatMoney(cents: Cents, currency = 'USD', opts: FormatMoneyOptions = {}): string {
  const { accounting = true, symbol = true, compact = false, whole = false, signed = false } = opts;
  const minor = CURRENCY_MINOR_UNITS[currency] ?? 2;
  const key = `${currency}|${symbol}|${compact}|${whole}|${minor}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      style: symbol ? 'currency' : 'decimal',
      currency,
      notation: compact ? 'compact' : 'standard',
      minimumFractionDigits: compact ? undefined : whole ? 0 : minor,
      maximumFractionDigits: compact ? 1 : whole ? 0 : minor,
    });
    formatters.set(key, f);
  }
  const value = Math.abs(cents) / 10 ** minor;
  const body = f.format(value);
  if (cents < 0) return accounting ? `(${body})` : `−${body}`;
  if (signed && cents > 0) return `+${body}`;
  return body;
}

export function formatPct(ratio: number | null | undefined, digits = 1, signed = true): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  const pct = ratio * 100;
  const s = Math.abs(pct).toFixed(digits);
  if (pct > 0) return `${signed ? '+' : ''}${s}%`;
  if (pct < 0) return `−${s}%`;
  return `${s}%`;
}
