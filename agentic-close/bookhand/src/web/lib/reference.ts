import { useApi } from './hooks';

/** Reference data shared by the ledger, reports and entry forms (entities, postable accounts, departments). */

export interface Reference {
  entities: Array<{ id: string; code: string; name: string; kind: string; currency: string; period: string | null }>;
  accounts: Array<{ number: string; name: string; subtype: string; class: string; requiresDepartment: boolean; normalBalance: 'debit' | 'credit' }>;
  departments: Array<{ code: string; name: string }>;
  /** The open close's period key (YYYY-MM). */
  period: string | null;
}

export function useReference() {
  return useApi<Reference>('/api/reference');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09" -> "Sep 2026". */
export function periodLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return `${MONTHS[m - 1]} ${y}`;
}

/** The current period and the `back` periods before it, newest first. */
export function periodOptions(current: string | null, back = 12): string[] {
  if (!current) return [];
  const [y, m] = current.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i <= back; i++) {
    const idx = y! * 12 + (m! - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Last calendar day of a period key. */
export function periodEnd(key: string): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m!, 0));
  return d.toISOString().slice(0, 10);
}

/** First day of the month after a period key. */
export function nextPeriodStart(key: string): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m!, 1));
  return d.toISOString().slice(0, 10);
}

/** Parse a typed amount ("1,250.50", "$900") to minor units; null when empty or invalid. */
export function parseAmount(text: string): number | null {
  const t = text.replace(/[$,\s]/g, '');
  if (!t) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
