/**
 * Money is stored as integer minor units (cents/pence) in a JS number. Safe integer range covers
 * ±90 trillion dollars, far beyond any balance this product handles; `assertSafeMinor` guards it.
 *
 * Sign convention used across the ledger ("net"): debit-positive. net = debit - credit.
 * Presentation flips the sign for credit-normal accounts (see ontology NormalBalance).
 */

export type CurrencyCode = string; // ISO 4217, validated by isCurrencyCode

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

export function assertSafeMinor(value: number, label = 'amount'): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be an integer number of minor units`);
  return value;
}

/** Round half to even (banker's rounding) for FX conversions; avoids systematic drift. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  const epsilon = 1e-9;
  if (diff > 0.5 + epsilon) return floor + 1;
  if (diff < 0.5 - epsilon) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Convert minor units at an FX rate (units of target per 1 unit of source). */
export function convertMinor(minor: number, rate: number): number {
  return roundHalfEven(minor * rate);
}

export function sumMinor(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return assertSafeMinor(total, 'sum');
}

/** Parse "1,234.56" / "-12.3" / "(45.00)" into minor units. Returns null when not a number. */
export function parseDecimalToMinor(text: string, decimals = 2): number | null {
  let s = text.trim();
  if (!s) return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[,\s]/g, '').replace(/^[$£€]/, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const extra = frac.length > decimals ? Number(frac[decimals]) : 0;
  let minor = Number(whole) * 10 ** decimals + Number(fracPadded || '0');
  if (extra >= 5) minor += 1;
  return negative ? -minor : minor;
}

const SYMBOLS: Record<string, string> = { USD: '$', GBP: '£', EUR: '€', CAD: 'CA$', JPY: '¥' };

export interface FormatMoneyOptions {
  currency?: CurrencyCode;
  /** Show the currency symbol (default true). */
  symbol?: boolean;
  /** Use parentheses for negatives, accounting style (default true). */
  accounting?: boolean;
  /** Compact form: $1.2M, $45.3K. */
  compact?: boolean;
  /** Show cents (default true unless compact). */
  cents?: boolean;
  signDisplay?: 'auto' | 'always';
}

export function formatMoney(minor: number, opts: FormatMoneyOptions = {}): string {
  const currency = opts.currency ?? 'USD';
  const symbol = opts.symbol === false ? '' : (SYMBOLS[currency] ?? `${currency} `);
  const negative = minor < 0;
  const abs = Math.abs(minor) / 100;
  let body: string;
  if (opts.compact) {
    if (abs >= 1_000_000_000) body = `${trim(abs / 1_000_000_000)}B`;
    else if (abs >= 1_000_000) body = `${trim(abs / 1_000_000)}M`;
    else if (abs >= 10_000) body = `${trim(abs / 1_000)}K`;
    else body = abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
  } else {
    const cents = opts.cents ?? true;
    body = abs.toLocaleString('en-US', {
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0,
    });
  }
  const text = `${symbol}${body}`;
  if (negative) return opts.accounting === false ? `-${text}` : `(${text})`;
  if (opts.signDisplay === 'always' && minor > 0) return `+${text}`;
  return text;
}

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1).replace(/\.0$/, '') : n.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}
