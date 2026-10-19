/**
 * RFC 4180 CSV parsing and safe CSV writing.
 * - handles quoted fields, escaped quotes, embedded newlines, CRLF/LF, UTF-8 BOM
 * - writer neutralises spreadsheet formula injection (cells starting with = + - @ tab CR)
 */
export interface CsvTable {
  header: string[];
  rows: Record<string, string>[];
  /** 1-based physical line number of each data row (for provenance) */
  lines: number[];
}

export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`CSV line ${line}: ${message}`);
    this.name = 'CsvError';
  }
}

export function parseCsvRecords(text: string, delimiter = ','): { fields: string[]; line: number }[] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: { fields: string[]; line: number }[] = [];
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const pushField = () => {
    fields.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    if (!(fields.length === 1 && fields[0] === '')) out.push({ fields, line: recordLine });
    fields = [];
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      if (field.length > 0) throw new CsvError('unexpected quote inside an unquoted field', line);
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRecord();
      line++;
      recordLine = line;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) throw new CsvError('unterminated quoted field', line);
  if (field.length > 0 || fields.length > 0) pushRecord();
  return out;
}

export function parseCsv(text: string, opts: { delimiter?: string; required?: string[] } = {}): CsvTable {
  const recs = parseCsvRecords(text, opts.delimiter ?? ',');
  if (!recs.length) return { header: [], rows: [], lines: [] };
  const header = recs[0]!.fields.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  for (const r of opts.required ?? []) {
    if (!header.includes(r)) throw new CsvError(`missing required column "${r}"`, 1);
  }
  const rows: Record<string, string>[] = [];
  const lines: number[] = [];
  for (const rec of recs.slice(1)) {
    if (rec.fields.length !== header.length) throw new CsvError(`expected ${header.length} fields, found ${rec.fields.length}`, rec.line);
    const row: Record<string, string> = {};
    header.forEach((h, idx) => (row[h] = rec.fields[idx]!.trim()));
    rows.push(row);
    lines.push(rec.line);
  }
  return { header, rows, lines };
}

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (FORMULA_START.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
