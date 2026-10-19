/** RFC 4180 CSV parsing and writing (quoted fields, escaped quotes, CRLF/LF, BOM). */

export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (inQuotes) throw new Error('CSV: unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/** Parse with a header row into objects keyed by normalised header names. */
export function parseCsvObjects(text: string): { header: string[]; records: { line: number; values: Record<string, string> }[] } {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const records = rows.slice(1).map((r, i) => ({ line: i + 2, values: Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()])) }));
  return { header, records };
}

const needsQuote = /[",\r\n]/;

/** Write CSV; also neutralises spreadsheet formula injection (CWE-1236) by prefixing ' to =,+,-,@ cells. */
export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          let s = v === null || v === undefined ? '' : String(v);
          if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
          return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\r\n');
}

/**
 * "1,234.56", "(1,234.56)", "-1234.56", "1234.56-", "$1,234.56" -> minor units. One sign at most,
 * thousands separators only in their places, at most two decimals; anything else ("12-34",
 * "--5", "1,23", "12.345") is refused rather than read as some other number.
 */
export function parseAmountMinor(s: string): number {
  let t = s.trim();
  if (!t) throw new Error('empty amount');
  let negative = false;
  const minus = () => {
    if (negative) throw new Error(`invalid amount "${s}"`);
    negative = true;
  };
  if (/^\(.*\)$/.test(t)) {
    minus();
    t = t.slice(1, -1).trim();
  }
  if (t.startsWith('-')) {
    minus();
    t = t.slice(1).trim();
  } else if (t.endsWith('-')) {
    minus();
    t = t.slice(0, -1).trim();
  }
  t = t.replace(/^[$£€]\s*/, '');
  if (t.startsWith('-')) {
    minus();
    t = t.slice(1);
  }
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(t)) throw new Error(`invalid amount "${s}"`);
  const [whole, frac = ''] = t.replace(/,/g, '').split('.') as [string, string?];
  const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(minor)) throw new Error(`invalid amount "${s}"`);
  return negative && minor !== 0 ? -minor : minor;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Accepts YYYY-MM-DD, YYYYMMDD, MM/DD/YYYY and DD/MM/YYYY (with hint) — and only dates that exist
 * ("13/45/2026" and "2026-02-30" are refused, not turned into nonsense).
 */
export function parseDate(s: string, hint: 'us' | 'uk' = 'us'): string {
  const t = s.trim();
  let y: number;
  let mo: number;
  let d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (slashed) {
    const [a, b] = [Number(slashed[1]), Number(slashed[2])];
    [mo, d] = hint === 'us' ? [a, b] : [b, a];
    y = Number(slashed[3]);
  } else throw new Error(`invalid date "${s}"`);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) throw new Error(`invalid date "${s}"`);
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}
