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

/** "1,234.56", "(1,234.56)", "-1234.56", "$1,234.56" -> minor units. */
export function parseAmountMinor(s: string): number {
  const t = s.trim();
  if (!t) throw new Error('empty amount');
  const negative = /^\(.*\)$/.test(t) || /^-/.test(t) || /-$/.test(t);
  const digits = t.replace(/[()$£€,\s-]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(digits)) throw new Error(`invalid amount "${s}"`);
  const [whole, frac = ''] = digits.split('.') as [string, string?];
  const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return negative ? -minor : minor;
}

/** Accepts YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY (with hint), YYYYMMDD. */
export function parseDate(s: string, hint: 'us' | 'uk' = 'us'): string {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) {
    const [a, b2, y] = [Number(m[1]), Number(m[2]), m[3]!];
    const [mm, dd] = hint === 'us' ? [a, b2] : [b2, a];
    return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  throw new Error(`invalid date "${s}"`);
}
