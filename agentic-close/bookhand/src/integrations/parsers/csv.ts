/**
 * RFC 4180 CSV parser: quoted fields, escaped quotes, embedded newlines, CRLF/LF, UTF-8 BOM.
 * Returns rows with 1-based line numbers for provenance ("row 42").
 */

export interface CsvRow {
  line: number;
  values: string[];
}

export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`CSV line ${line}: ${message}`);
  }
}

export function parseCsv(text: string, delimiter = ','): CsvRow[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let field = '';
  let values: string[] = [];
  let inQuotes = false;
  let line = 1;
  let rowStart = 1;
  let fieldStarted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (fieldStarted && field.length > 0) throw new CsvError('unexpected quote inside an unquoted field', line);
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      values.push(field);
      field = '';
      fieldStarted = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      values.push(field);
      if (values.length > 1 || values[0] !== '') rows.push({ line: rowStart, values });
      values = [];
      field = '';
      fieldStarted = false;
      line++;
      rowStart = line;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new CsvError('unterminated quoted field', rowStart);
  if (field.length || values.length) {
    values.push(field);
    if (values.length > 1 || values[0] !== '') rows.push({ line: rowStart, values });
  }
  return rows;
}

/** Parse with a header row into records keyed by normalized header names. */
export function parseCsvRecords(text: string, delimiter = ','): Array<{ line: number; record: Record<string, string> }> {
  const rows = parseCsv(text, delimiter);
  if (!rows.length) return [];
  const header = rows[0]!.values.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return rows.slice(1).map((r) => {
    if (r.values.length !== header.length) throw new CsvError(`expected ${header.length} fields, found ${r.values.length}`, r.line);
    const record: Record<string, string> = {};
    header.forEach((h, i) => (record[h] = r.values[i]!.trim()));
    return { line: r.line, record };
  });
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = v === null || v === undefined ? '' : String(v);
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\n');
}
