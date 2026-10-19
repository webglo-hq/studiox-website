/** Text normalization and similarity used by matching, coding and anomaly detection. */

const STOPWORDS = new Set([
  'ach', 'debit', 'credit', 'dr', 'cr', 'payment', 'pmt', 'pymt', 'inc', 'llc', 'ltd', 'llp', 'co', 'corp', 'the', 'and', 'of',
  'to', 'from', 'for', 'ref', 'id', 'trn', 'txn', 'wire', 'out', 'in', 'pos', 'purchase', 'online', 'card', 'transfer', 'xfer',
  'deposit', 'dep', 'bill', 'invoice', 'inv', 'ccd', 'ppd', 'web', 'www', 'com', 'services', 'service', 'svcs', 'svc', 'plc',
]);

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(text: string, keepStopwords = false): string[] {
  return normalizeText(text)
    .split(' ')
    .filter((t) => t.length > 1 && (keepStopwords || !STOPWORDS.has(t)) && !/^\d{1,2}$/.test(t));
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  const t = s.replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** Sorensen-Dice on character bigrams: robust to truncation ("NIMBUS CLD" vs "Nimbus Cloud"). */
export function dice(a: string, b: string): number {
  const x = bigrams(normalizeText(a));
  const y = bigrams(normalizeText(b));
  if (!x.length || !y.length) return 0;
  const counts = new Map<string, number>();
  for (const g of x) counts.set(g, (counts.get(g) ?? 0) + 1);
  let inter = 0;
  for (const g of y) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      inter++;
      counts.set(g, c - 1);
    }
  }
  return (2 * inter) / (x.length + y.length);
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const tokenScore = jaccard(ta, tb);
  const charScore = dice(ta.join(' '), tb.join(' '));
  // prefix containment ("nimbus" in "nimbuscloud")
  const contain = ta.some((t) => t.length >= 4 && tb.some((u) => u.startsWith(t) || t.startsWith(u))) ? 0.6 : 0;
  return Math.max(tokenScore, charScore, contain);
}

/** Pull reference-like tokens (check numbers, invoice ids, trace numbers). */
export function references(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:chk|check|ck|#|no\.?|ref|inv|invoice|trace)\s*[:#-]?\s*([a-z0-9-]{3,})\b/gi)) out.add(m[1]!.toLowerCase().replace(/-/g, ''));
  for (const m of text.matchAll(/\b([a-z]{2,4}-?\d{3,})\b/gi)) out.add(m[1]!.toLowerCase().replace(/-/g, ''));
  for (const m of text.matchAll(/\b(\d{5,})\b/g)) out.add(m[1]!);
  return Array.from(out);
}

/** Normalize document numbers so "INV-20931", "INV20931" and "inv 20931" compare equal. */
export function normalizeDocNumber(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '');
}
