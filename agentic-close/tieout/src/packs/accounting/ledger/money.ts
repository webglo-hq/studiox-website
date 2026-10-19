/**
 * Money: integer minor units everywhere (AX: tie:MoneyAmount). Conversion uses decimal rates
 * and rounds half away from zero to the minor unit — the convention most ERPs use for FX.
 */

export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function convert(minor: number, rate: number): number {
  return roundHalfAway(minor * rate);
}

export function toMinor(major: number): number {
  return roundHalfAway(major * 100);
}

export function fromMinor(minor: number): number {
  return minor / 100;
}

const SYMBOL: Record<string, string> = { USD: '$', GBP: '£', EUR: '€' };

/** Accounting format: thousands separators, negatives in parentheses unless `signed`. */
export function formatMoney(minor: number, currency = 'USD', opts: { signed?: boolean; decimals?: 0 | 2; compact?: boolean } = {}): string {
  const sym = SYMBOL[currency] ?? `${currency} `;
  const abs = Math.abs(minor) / 100;
  let body: string;
  if (opts.compact && abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  else if (opts.compact && abs >= 10_000) body = `${(abs / 1000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  else body = abs.toLocaleString('en-US', { minimumFractionDigits: opts.decimals ?? 2, maximumFractionDigits: opts.decimals ?? 2 });
  if (minor < 0) return opts.signed ? `−${sym}${body}` : `(${sym}${body})`;
  return opts.signed && minor > 0 ? `+${sym}${body}` : `${sym}${body}`;
}

/** Split `total` into `n` integer parts that sum exactly to total (remainder on the last part). */
export function allocateEvenly(total: number, n: number): number[] {
  if (n <= 0) throw new Error('allocateEvenly: n must be positive');
  const base = Math.trunc(total / n);
  const parts = Array.from({ length: n }, () => base);
  parts[n - 1]! += total - base * n;
  return parts;
}

/** Signed balance in the account's natural direction (positive = normal balance). */
export function naturalBalance(debitMinor: number, creditMinor: number, normal: 'debit' | 'credit'): number {
  return normal === 'debit' ? debitMinor - creditMinor : creditMinor - debitMinor;
}
