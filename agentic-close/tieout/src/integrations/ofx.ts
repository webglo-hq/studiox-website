/**
 * OFX bank statement parser (OFX 1.x SGML and 2.x XML). Reads STMTRS: BANKACCTFROM/ACCTID,
 * CURDEF, LEDGERBAL, BANKTRANLIST/STMTTRN (TRNTYPE, DTPOSTED, TRNAMT, FITID, NAME, MEMO, CHECKNUM).
 */
import type { ImportError, ParsedBankStatement, ParsedBankTransaction } from './types';

function ofxDate(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s.trim());
  if (!m) throw new Error(`OFX: invalid date ${s}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function minor(s: string): number {
  const t = s.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error(`OFX: invalid amount ${s}`);
  const neg = t.startsWith('-');
  const [w, f = ''] = t.replace('-', '').split('.') as [string, string?];
  const v = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -v : v;
}

/** Extract tag values from SGML-ish or XML OFX (SGML leaves leaf tags unclosed). */
function tagValue(block: string, tag: string): string {
  const re = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i');
  return re.exec(block)?.[1]?.trim() ?? '';
}

export function parseOfx(text: string): ParsedBankStatement {
  const body = text.slice(Math.max(0, text.search(/<OFX>/i)));
  if (!/<OFX>/i.test(body)) throw new Error('OFX: <OFX> element not found');
  const stmt = /<STMTRS>([\s\S]*?)<\/STMTRS>/i.exec(body)?.[1];
  if (!stmt) throw new Error('OFX: STMTRS not found');
  const warnings: ImportError[] = [];
  const currency = tagValue(stmt, 'CURDEF') || 'USD';
  const acct = /<BANKACCTFROM>([\s\S]*?)<\/BANKACCTFROM>/i.exec(stmt)?.[1] ?? '';
  const accountNumber = tagValue(acct, 'ACCTID');
  const ledger = /<LEDGERBAL>([\s\S]*?)<\/LEDGERBAL>/i.exec(stmt)?.[1] ?? '';
  const closing = ledger ? minor(tagValue(ledger, 'BALAMT')) : 0;
  const statementDate = ledger ? ofxDate(tagValue(ledger, 'DTASOF')) : ofxDate(tagValue(stmt, 'DTEND'));
  const transactions: ParsedBankTransaction[] = [];
  const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(stmt))) {
    i++;
    const t = m[1]!;
    try {
      const amount = minor(tagValue(t, 'TRNAMT'));
      const name = tagValue(t, 'NAME');
      const memo = tagValue(t, 'MEMO');
      const check = tagValue(t, 'CHECKNUM');
      transactions.push({
        externalId: tagValue(t, 'FITID') || `${statementDate}-${i}`,
        bookingDate: ofxDate(tagValue(t, 'DTPOSTED')),
        valueDate: tagValue(t, 'DTAVAIL') ? ofxDate(tagValue(t, 'DTAVAIL')) : null,
        amountMinor: amount,
        description: [check ? `CHECK ${check}` : '', name, memo].filter(Boolean).join(' ').trim() || tagValue(t, 'TRNTYPE'),
        counterparty: name || null,
        reference: check || tagValue(t, 'REFNUM') || null,
        typeCode: tagValue(t, 'TRNTYPE') || null,
        sourceLine: i,
      });
    } catch (err) {
      warnings.push({ line: i, message: (err as Error).message });
    }
  }
  const net = transactions.reduce((s, t) => s + t.amountMinor, 0);
  return { format: 'ofx', accountNumber, currency, statementDate, openingBalanceMinor: closing - net, closingBalanceMinor: closing, transactions, warnings };
}
