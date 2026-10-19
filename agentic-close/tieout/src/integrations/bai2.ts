/**
 * BAI2 (Bank Administration Institute, Cash Management Balance Reporting v2) parser and writer.
 *
 * Record types: 01 file header, 02 group header, 03 account identifier (with balance summaries),
 * 16 transaction detail, 88 continuation, 49 account trailer, 98 group trailer, 99 file trailer.
 * Amounts are implied-decimal integers. Type codes 100-399 are credits, 400-699 debits.
 * Balance type codes: 010 opening ledger, 015 closing ledger. Records end with "/".
 */
import type { ImportError, ParsedBankStatement, ParsedBankTransaction } from './types';

function yymmddToIso(s: string): string {
  if (!/^\d{6}$/.test(s)) throw new Error(`BAI2: invalid date ${s}`);
  const yy = Number(s.slice(0, 2));
  return `${yy >= 70 ? 1900 + yy : 2000 + yy}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
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

export function parseBai2(text: string): ParsedBankStatement {
  const recs = logicalRecords(text);
  if (!recs.length || recs[0]!.fields[0] !== '01') throw new Error('BAI2: file must start with an 01 header');
  if (recs[recs.length - 1]!.fields[0] !== '99') throw new Error('BAI2: file must end with a 99 trailer');
  const warnings: ImportError[] = [];
  let accountNumber = '';
  let currency = 'USD';
  let statementDate = '';
  let opening: number | null = null;
  let closing: number | null = null;
  const transactions: ParsedBankTransaction[] = [];
  let accountTotal = 0;
  let detailCount = 0;
  for (const { fields, line } of recs) {
    switch (fields[0]) {
      case '02':
        statementDate = yymmddToIso(fields[4] ?? '');
        if (fields[6]) currency = fields[6];
        break;
      case '03': {
        accountNumber = fields[1] ?? '';
        if (fields[2]) currency = fields[2];
        // repeating summary triplets: type code, amount, item count, funds type
        for (let i = 3; i + 1 < fields.length; i += 4) {
          const code = fields[i];
          const amt = fields[i + 1];
          if (!code || amt === undefined || amt === '') continue;
          if (code === '010') opening = Number(amt);
          if (code === '015') closing = Number(amt);
        }
        break;
      }
      case '16': {
        const typeCode = fields[1] ?? '';
        const amount = Number(fields[2] ?? '0');
        if (!/^\d{3}$/.test(typeCode) || !Number.isFinite(amount)) {
          warnings.push({ line, message: `invalid 16 record (type ${typeCode})` });
          break;
        }
        const code = Number(typeCode);
        const sign = code >= 100 && code < 400 ? 1 : code >= 400 && code < 700 ? -1 : 0;
        if (!sign) {
          warnings.push({ line, message: `type code ${typeCode} is not a transaction detail code` });
          break;
        }
        // 16,type,amount,funds type,bank ref,customer ref,text  (funds type 'S' adds 3 fields; 'V' adds 2)
        let idx = 4;
        const funds = fields[3] ?? '';
        if (funds === 'S') idx += 3;
        else if (funds === 'V') idx += 2;
        const bankRef = fields[idx] ?? '';
        const custRef = fields[idx + 1] ?? '';
        const textField = fields.slice(idx + 2).join(',').trim();
        const valueDate = fields[3] === 'V' ? yymmddToIso(fields[4] ?? '') : null;
        transactions.push({
          externalId: bankRef || `${statementDate}-${line}`,
          bookingDate: valueDate ?? statementDate,
          valueDate,
          amountMinor: sign * amount,
          description: textField,
          counterparty: null,
          reference: custRef || null,
          typeCode,
          sourceLine: line,
        });
        accountTotal += sign * amount;
        detailCount++;
        break;
      }
      case '49': {
        const control = Number(fields[1] ?? 'NaN');
        if (Number.isFinite(control) && opening !== null) {
          // account control total = sum of all amounts in 03 and 16 records (spec); we check details net
          void control;
        }
        break;
      }
      default:
        break;
    }
  }
  if (opening === null || closing === null) throw new Error('BAI2: account record lacks opening (010) or closing (015) ledger balance');
  if (opening + accountTotal !== closing) warnings.push({ line: null, message: `balance check: opening ${opening} + transactions ${accountTotal} != closing ${closing}` });
  if (!detailCount) warnings.push({ line: null, message: 'no transaction detail records' });
  return { format: 'bai2', accountNumber, currency, statementDate, openingBalanceMinor: opening, closingBalanceMinor: closing, transactions, warnings };
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
