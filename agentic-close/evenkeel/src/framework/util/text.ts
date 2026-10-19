/** Text normalisation and similarity measures used by matching and bucketing. */

const STOP_TOKENS = new Set([
  'inc', 'llc', 'ltd', 'llp', 'co', 'corp', 'corporation', 'company', 'the', 'and', 'of', 'plc', 'gmbh',
  'ach', 'pmt', 'payment', 'debit', 'credit', 'pos', 'purchase', 'card', 'ref', 'wire', 'transfer', 'online',
]);

export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function tokens(s: string, dropStop = true): string[] {
  const t = normalize(s).split(' ').filter(Boolean);
  return dropStop ? t.filter((x) => !STOP_TOKENS.has(x) && !/^\d{1,3}$/.test(x)) : t;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Jaro-Winkler similarity in [0,1]. */
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;
  const matchDistance = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const m1 = new Array<boolean>(len1).fill(false);
  const m2 = new Array<boolean>(len2).fill(false);
  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = true;
      m2[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  const jaro = (matches / len1 + matches / len2 + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Similarity between a free-text description (bank memo, card descriptor) and a name
 * (vendor/customer), robust to truncation and noise: best of token-Jaccard, token
 * containment and Jaro-Winkler over the compacted strings.
 */
export function nameSimilarity(description: string, name: string): number {
  const td = tokens(description);
  const tn = tokens(name);
  if (tn.length === 0 || td.length === 0) return 0;
  const jac = jaccard(td, tn);
  const dset = new Set(td);
  let contained = 0;
  for (const t of tn) {
    if (dset.has(t) || td.some((x) => x.length >= 4 && (x.startsWith(t) || t.startsWith(x)))) contained++;
  }
  const containment = contained / tn.length;
  const jw = jaroWinkler(td.join(''), tn.join('').slice(0, Math.max(tn.join('').length, 1)));
  return Math.max(jac, containment * 0.95, jw * 0.9);
}

export function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

// ---------------------------------------------------------------------------
// Untrusted text hygiene (prompt-injection defence in depth)
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(instruction|instructions|prompt|rules|previous|prior|above)\b/i,
  /\b(system|developer)\s*(prompt|message|instruction)/i,
  /\byou are (now|an?|the)\b/i,
  /\b(act|behave) as\b/i,
  /\b(approve|auto-?approve|post|mark)\b[^.]{0,30}\b(all|this|these|entries|as matched|as reconciled)\b/i,
  /<\/?(system|assistant|user|instructions?|tool)[^>]*>/i,
  /\b(BEGIN|END)\s+(INSTRUCTIONS|PROMPT|SYSTEM)\b/,
  /\bdo not (tell|inform|alert|flag)\b/i,
  /\bnew (task|instructions?)\s*:/i,
];

export interface InjectionScan {
  suspicious: boolean;
  matches: string[];
}

export function scanForInjection(text: string | null | undefined): InjectionScan {
  if (!text) return { suspicious: false, matches: [] };
  const matches: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) matches.push(m[0]);
  }
  return { suspicious: matches.length > 0, matches };
}

/**
 * Make untrusted text safe to place inside a model prompt or a UI: strip control characters
 * (except newline/tab), neutralise markup that mimics prompt structure, cap length.
 */
export function sanitizeUntrusted(text: string | null | undefined, maxLen = 500): string {
  if (!text) return '';
  // eslint-disable-next-line no-control-regex
  let s = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  s = s.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));
  return truncate(s, maxLen);
}
