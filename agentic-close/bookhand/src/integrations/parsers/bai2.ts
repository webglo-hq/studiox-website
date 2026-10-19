import { type NormalizedStatement, type NormalizedStatementLine, StatementParseError } from './statement';

/**
 * BAI2 (Bank Administration Institute, version 2) cash-management file parser.
 * Records: 01 file header, 02 group header, 03 account identifier (+ summary codes), 16 transaction detail,
 * 88 continuation, 49 account trailer (control total + record count), 98 group trailer, 99 file trailer.
 * Amounts are implied two-decimal integers. Transaction type codes 100-399 are credits, 400-699 debits.
 * Trailer control totals and record counts are verified.
 */

interface RawRecord {
  code: string;
  fields: string[];
  line: number;
  /** Number of 88 continuation records merged into this one (they count toward trailer record counts). */
  extra: number;
}

function yymmdd(s: string, locator: string): string {
  if (!/^\d{6}$/.test(s)) throw new StatementParseError(`invalid date "${s}"`, locator);
  const yy = Number(s.slice(0, 2));
  return `${yy < 70 ? 2000 + yy : 1900 + yy}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
}

function amount(s: string | undefined, locator: string): number {
  if (s === undefined || s === '') return 0;
  const signed = s.startsWith('-') ? -1 : 1;
  const digits = s.replace(/^[+-]/, '');
  if (!/^\d+$/.test(digits)) throw new StatementParseError(`invalid amount "${s}"`, locator);
  return signed * Number(digits);
}

/** Split a BAI2 file into logical records (joining 88 continuations) on "/" terminators. */
function records(text: string): RawRecord[] {
  const out: RawRecord[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const l = raw.trim();
    if (!l) return;
    const body = l.endsWith('/') ? l.slice(0, -1) : l;
    const parts = body.split(',');
    const code = parts[0]!;
    if (code === '88') {
      const prev = out[out.length - 1];
      if (!prev) throw new StatementParseError('continuation record without a preceding record', `line ${lineNo}`);
      // Text continuation: append to the last field of a 16 record; other records append fields.
      if (prev.code === '16') prev.fields[prev.fields.length - 1] = `${prev.fields[prev.fields.length - 1] ?? ''}${parts.slice(1).join(',')}`;
      else prev.fields.push(...parts.slice(1));
      prev.extra++;
      return;
    }
    out.push({ code, fields: parts.slice(1), line: lineNo, extra: 0 });
  });
  return out;
}

export function parseBai2(text: string): NormalizedStatement {
  const recs = records(text);
  if (recs[0]?.code !== '01') throw new StatementParseError('BAI2 file must start with an 01 file header', 'line 1');
  let currency = 'USD';
  let accountId = '';
  let asOfDate = '';
  let opening: number | null = null;
  let closing: number | null = null;
  const lines: NormalizedStatementLine[] = [];
  const warnings: string[] = [];
  let accountRecordCount = 0;
  let accountControl = 0;
  let inAccount = false;
  let sawFileTrailer = false;
  for (const r of recs) {
    const loc = `${r.code} record at line ${r.line}`;
    if (inAccount) accountRecordCount += 1 + r.extra;
    switch (r.code) {
      case '01':
        break;
      case '02': {
        // 02,ultimate receiver,originator,group status,as-of date,as-of time,currency,as-of date modifier
        asOfDate = yymmdd(r.fields[3] ?? '', loc);
        if (r.fields[5]) currency = r.fields[5];
        break;
      }
      case '03': {
        // 03,account number,currency,[type code,amount,item count,funds type]...
        if (inAccount) throw new StatementParseError('nested account record', loc);
        inAccount = true;
        accountRecordCount = 1 + r.extra;
        accountControl = 0;
        accountId = r.fields[0] ?? '';
        if (r.fields[1]) currency = r.fields[1];
        for (let i = 2; i + 1 < r.fields.length; i += 4) {
          const type = r.fields[i];
          const amt = r.fields[i + 1];
          if (!type || amt === undefined || amt === '') continue;
          const value = amount(amt, loc);
          if (type === '010' && opening === null) opening = value; // opening ledger of the first day
          if (type === '015') closing = value; // closing ledger of the last day
          accountControl += value;
        }
        break;
      }
      case '16': {
        // 16,type code,amount,funds type,[funds detail...],bank ref,customer ref,text
        const type = r.fields[0] ?? '';
        const value = amount(r.fields[1], loc);
        accountControl += value;
        let idx = 2;
        const funds = r.fields[idx++] ?? '';
        if (funds === 'S') idx += 3;
        else if (funds === 'V') idx += 2;
        else if (funds === 'D') idx += 1 + 2 * Number(r.fields[idx] ?? 0);
        const bankRef = r.fields[idx++] ?? '';
        const custRef = r.fields[idx++] ?? '';
        const textField = r.fields.slice(idx).join(',').trim();
        const code = Number(type);
        if (!(code >= 100 && code <= 699)) {
          warnings.push(`${loc}: unsupported type code ${type}, skipped`);
          break;
        }
        const signed = code >= 400 ? -value : value;
        lines.push({
          bookingDate: asOfDate,
          valueDate: null,
          amount: signed,
          description: textField || `BAI2 ${type}`,
          counterparty: null,
          reference: custRef || null,
          bankReference: bankRef || `${asOfDate}-${r.line}`,
          typeCode: type,
          locator: loc,
        });
        break;
      }
      case '49': {
        const control = amount(r.fields[0], loc);
        const count = Number(r.fields[1]);
        if (control !== accountControl) throw new StatementParseError(`account control total ${control} != computed ${accountControl}`, loc);
        if (count !== accountRecordCount) throw new StatementParseError(`account record count ${count} != computed ${accountRecordCount}`, loc);
        inAccount = false;
        break;
      }
      case '98':
      case '99':
        if (r.code === '99') sawFileTrailer = true;
        break;
      default:
        warnings.push(`${loc}: unknown record type ${r.code}`);
    }
  }
  if (inAccount) throw new StatementParseError('missing 49 account trailer');
  if (!sawFileTrailer) throw new StatementParseError('missing 99 file trailer');
  // BAI2 usually carries one business day per file; multi-day files repeat 02 groups. Use min/max dates.
  const dates = lines.map((l) => l.bookingDate).sort();
  return {
    format: 'bai2',
    accountId,
    currency,
    periodStart: dates[0] ?? asOfDate,
    periodEnd: dates[dates.length - 1] ?? asOfDate,
    statementDate: asOfDate,
    openingBalance: opening,
    closingBalance: closing,
    lines,
    warnings,
  };
}

/** Writer used by the seed generator and tests (one 02 group per business day). */
export function writeBai2(opts: {
  sender: string;
  receiver: string;
  fileId: string;
  createdAt: string;
  accountNumber: string;
  currency: string;
  days: Array<{ date: string; opening: number; closing: number; lines: Array<{ typeCode: string; amount: number; bankRef: string; customerRef: string; text: string }> }>;
}): string {
  const d = (iso: string) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  const out: string[] = [`01,${opts.sender},${opts.receiver},${d(opts.createdAt)},0600,${opts.fileId},,,2/`];
  let fileControl = 0;
  let fileRecords = 1;
  for (const day of opts.days) {
    const group: string[] = [`02,${opts.receiver},${opts.sender},1,${d(day.date)},0600,${opts.currency},2/`];
    const account: string[] = [`03,${opts.accountNumber},${opts.currency},010,${day.opening},,,015,${day.closing},,/`];
    let control = day.opening + day.closing;
    for (const l of day.lines) {
      const text = l.text.replace(/[,/]/g, ' ');
      const head = `16,${l.typeCode},${l.amount},Z,${l.bankRef},${l.customerRef},`;
      if (head.length + text.length > 78) {
        account.push(`${head}${text.slice(0, 40)}`);
        account.push(`88,${text.slice(40)}`);
      } else {
        account.push(`${head}${text}`);
      }
      control += l.amount;
    }
    const accountRecords = account.length + 1;
    account.push(`49,${control},${accountRecords}/`);
    group.push(...account);
    group.push(`98,${control},1,${group.length + 1}/`);
    out.push(...group);
    fileControl += control;
    fileRecords += group.length;
  }
  out.push(`99,${fileControl},${opts.days.length},${fileRecords + 1}/`);
  return out.join('\n') + '\n';
}
