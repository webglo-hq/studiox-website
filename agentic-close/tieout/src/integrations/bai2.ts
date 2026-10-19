/**
 * BAI2 (Bank Administration Institute, Cash Management Balance Reporting v2) parser and writer.
 *
 * Record types: 01 file header, 02 group header, 03 account identifier (with balance summaries),
 * 16 transaction detail, 88 continuation, 49 account trailer, 98 group trailer, 99 file trailer.
 * Amounts are implied-decimal integers. Type codes 100-399 are credits, 400-699 debits.
 * Balance type codes: 010 opening ledger, 015 closing ledger. Records end with "/".
 */
import { parseDate } from './csv';
import { failClosed, type ImportError, type ParsedBankStatement } from './types';

function yymmddToIso(s: string): string {
  if (!/^\d{6}$/.test(s)) throw new Error(`invalid date ${s}`);
  const yy = Number(s.slice(0, 2));
  return parseDate(`${yy >= 70 ? 1900 + yy : 2000 + yy}-${s.slice(2, 4)}-${s.slice(4, 6)}`);
}

function isoToYymmdd(iso: string): string {
  return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
}

/** Join 88 continuation records onto their parent and split into fields. */
function logicalRecords(text: string): { fields: string[]; line: number }[] {
  const out: { fields: string[]; line: number }[] = [];
  const physical = text.split(/\r?\n/);
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i]!.trim();
    if (!raw) continue;
    const body = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const fields = body.split(',');
    if (fields[0] === '88') {
      const prev = out[out.length - 1];
      if (!prev) throw new Error(`BAI2 line ${i + 1}: continuation without a parent record`);
      // continuation text of a 16 record extends its free-text field
      prev.fields[prev.fields.length - 1] += fields.slice(1).join(',');
      continue;
    }
    out.push({ fields, line: i + 1 });
  }
  return out;
}

/**
 * Every account in the file, one statement each (03 account record … 49 account trailer). Fails
 * closed: an unreadable record, a type code that is not a transaction, an account whose
 * transactions do not take the opening balance to the closing one, or a 49 control total that
 * does not match its records rejects the whole file.
 */
export function parseBai2Statements(text: string): ParsedBankStatement[] {
  const recs = logicalRecords(text);
  if (!recs.length || recs[0]!.fields[0] !== '01') throw new Error('BAI2: file must start with an 01 header');
  if (recs[recs.length - 1]!.fields[0] !== '99') throw new Error('BAI2: file must end with a 99 trailer');
  const problems: ImportError[] = [];
  const statements: ParsedBankStatement[] = [];
  let groupDate = '';
  let groupCurrency = 'USD';
  let cur: (ParsedBankStatement & { opening: number | null; closing: number | null; control: number; line: number }) | null = null;
  const close = (line: number | null) => {
    if (!cur) return;
    const c = cur;
    cur = null;
    if (c.opening === null || c.closing === null) {
      problems.push({ line: c.line, message: `account ${c.accountNumber} lacks an opening (010) or closing (015) ledger balance` });
      return;
    }
    const net = c.transactions.reduce((s, t) => s + t.amountMinor, 0);
    if (c.opening + net !== c.closing) problems.push({ line, message: `account ${c.accountNumber}: opening balance ${c.opening} + transactions ${net} does not equal the closing balance ${c.closing}` });
    if (!c.transactions.length) c.warnings.push({ line: c.line, message: 'no transaction detail records' });
    statements.push({ format: 'bai2', accountNumber: c.accountNumber, currency: c.currency, statementDate: c.statementDate, openingBalanceMinor: c.opening, closingBalanceMinor: c.closing, transactions: c.transactions, warnings: c.warnings });
  };
  for (const { fields, line } of recs) {
    try {
      switch (fields[0]) {
        case '02':
          groupDate = yymmddToIso(fields[4] ?? '');
          if (fields[6]) groupCurrency = fields[6];
          break;
        case '03': {
          if (cur) throw new Error(`account ${cur.accountNumber} has no 49 trailer before the next account`);
          if (!groupDate) throw new Error('account record outside a 02 group');
          cur = { format: 'bai2', accountNumber: fields[1] ?? '', currency: fields[2] || groupCurrency, statementDate: groupDate, openingBalanceMinor: 0, closingBalanceMinor: 0, transactions: [], warnings: [], opening: null, closing: null, control: 0, line };
          if (!cur.accountNumber) throw new Error('account record without an account number');
          // repeating summaries: type code, amount, item count, funds type
          for (let i = 3; i + 1 < fields.length; i += 4) {
            const code = fields[i];
            const amt = fields[i + 1];
            if (!code || amt === undefined || amt === '') continue;
            if (!/^[+-]?\d+$/.test(amt)) throw new Error(`invalid amount "${amt}" for balance ${code}`);
            cur.control += Number(amt);
            if (code === '010') cur.opening = Number(amt);
            if (code === '015') cur.closing = Number(amt);
          }
          break;
        }
        case '16': {
          if (!cur) throw new Error('transaction record outside an account');
          const typeCode = fields[1] ?? '';
          const rawAmount = fields[2] ?? '';
          if (!/^\d{3}$/.test(typeCode)) throw new Error(`invalid type code "${typeCode}"`);
          if (!/^\d+$/.test(rawAmount)) throw new Error(`invalid amount "${rawAmount}"`);
          const code = Number(typeCode);
          const sign = code >= 100 && code < 400 ? 1 : code >= 400 && code < 700 ? -1 : 0;
          if (!sign) throw new Error(`type code ${typeCode} is not a credit or debit transaction code`);
          const amount = Number(rawAmount);
          cur.control += amount;
          // 16,type,amount,funds type,bank ref,customer ref,text  (funds type 'S' adds 3 fields; 'V' adds 2)
          let idx = 4;
          const funds = fields[3] ?? '';
          if (funds === 'S') idx += 3;
          else if (funds === 'V') idx += 2;
          const bankRef = fields[idx] ?? '';
          const custRef = fields[idx + 1] ?? '';
          const textField = fields.slice(idx + 2).join(',').trim();
          const valueDate = funds === 'V' ? yymmddToIso(fields[4] ?? '') : null;
          cur.transactions.push({
            externalId: bankRef || `${cur.statementDate}-${line}`,
            bookingDate: valueDate ?? cur.statementDate,
            valueDate,
            amountMinor: sign * amount,
            description: textField,
            counterparty: null,
            reference: custRef || null,
            typeCode,
            sourceLine: line,
          });
          break;
        }
        case '49': {
          if (!cur) throw new Error('account trailer without an account');
          // account control total = algebraic sum of the amounts in the 03 and 16 records
          const control = fields[1] ?? '';
          if (!/^[+-]?\d+$/.test(control)) throw new Error(`invalid account control total "${control}"`);
          if (Number(control) !== cur.control) throw new Error(`account ${cur.accountNumber}: control total ${control} does not match its records (${cur.control})`);
          close(line);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      problems.push({ line, message: (err as Error).message });
    }
  }
  if (cur) problems.push({ line: null, message: `account ${(cur as { accountNumber: string }).accountNumber} has no 49 trailer` });
  if (!statements.length && !problems.length) problems.push({ line: null, message: 'no account records (03)' });
  failClosed(problems);
  return statements;
}

/** The one account of a single-account file. */
export function parseBai2(text: string): ParsedBankStatement {
  const statements = parseBai2Statements(text);
  if (statements.length !== 1) throw new Error(`BAI2: the file reports ${statements.length} accounts; read them with parseBai2Statements`);
  return statements[0]!;
}

export interface Bai2WriteInput {
  senderId: string;
  receiverId: string;
  fileDate: string;
  accountNumber: string;
  currency: string;
  openingMinor: number;
  closingMinor: number;
  transactions: { date: string; amountMinor: number; typeCode: string; bankRef: string; customerRef: string | null; text: string }[];
}

/** Write a BAI2 file; each transaction carries its value date (funds type V) so one file covers a month. */
export function writeBai2(input: Bai2WriteInput): string {
  const lines: string[] = [];
  const d = isoToYymmdd(input.fileDate);
  lines.push(`01,${input.senderId},${input.receiverId},${d},0600,1,80,,2/`);
  lines.push(`02,${input.receiverId},${input.senderId},1,${d},2400,${input.currency},2/`);
  let control = input.openingMinor + input.closingMinor;
  lines.push(`03,${input.accountNumber},${input.currency},010,${input.openingMinor},,,015,${input.closingMinor},,/`);
  let records = 3;
  for (const t of input.transactions) {
    const amt = Math.abs(t.amountMinor);
    control += amt;
    const text = t.text.replace(/[,/]/g, ' ');
    const head = `16,${t.typeCode},${amt},V,${isoToYymmdd(t.date)},,${t.bankRef},${t.customerRef ?? ''},`;
    // keep physical records ≤ 80 chars using 88 continuations
    const first = (head + text).slice(0, 79);
    lines.push(`${first}/`);
    records++;
    let rest = (head + text).slice(79);
    while (rest.length) {
      lines.push(`88,${rest.slice(0, 76)}/`);
      rest = rest.slice(76);
      records++;
    }
  }
  records++;
  lines.push(`49,${control},${records}/`);
  lines.push(`98,${control},1,${records + 2}/`);
  lines.push(`99,${control},1,${records + 4}/`);
  return lines.join('\n') + '\n';
}
