/**
 * OFX bank statement parser (OFX 1.x SGML and 2.x XML). Reads STMTRS: BANKACCTFROM/ACCTID,
 * CURDEF, LEDGERBAL, BANKTRANLIST/STMTTRN (TRNTYPE, DTPOSTED, TRNAMT, FITID, NAME, MEMO, CHECKNUM).
 */
import { parseDate } from './csv';
import { failClosed, type ImportError, type ParsedBankStatement, type ParsedBankTransaction } from './types';

function ofxDate(s: string): string {
  const m = /^(\d{8})/.exec(s.trim());
  if (!m) throw new Error(`invalid date "${s}"`);
  return parseDate(m[1]!);
}

function minor(s: string): number {
  const t = s.trim().replace(',', '.');
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(t)) throw new Error(`invalid amount "${s}"`);
  const neg = t.startsWith('-');
  const [w, f = ''] = t.replace(/^[+-]/, '').split('.') as [string, string?];
  const v = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return neg && v !== 0 ? -v : v;
}

/** Extract tag values from SGML-ish or XML OFX (SGML leaves leaf tags unclosed). */
function tagValue(block: string, tag: string): string {
  const re = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i');
  return re.exec(block)?.[1]?.trim() ?? '';
}

/**
 * The contents of every <TAG>…</TAG> block, scanning forward once: linear in the file size even
 * when tags are left unclosed (an unclosed aggregate is an error, never a reason to rescan).
 */
function blocks(text: string, tag: string): string[] {
  // ASCII-only upper-casing keeps every index aligned with the original text
  const upper = text.replace(/[a-z]+/g, (w) => w.toUpperCase());
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const out: string[] = [];
  let at = upper.indexOf(open);
  while (at >= 0) {
    const end = upper.indexOf(close, at + open.length);
    if (end < 0) throw new Error(`OFX: <${tag}> is not closed`);
    const nested = upper.indexOf(open, at + open.length);
    if (nested >= 0 && nested < end) throw new Error(`OFX: <${tag}> is not closed before the next one`);
    out.push(text.slice(at + open.length, end));
    at = upper.indexOf(open, end + close.length);
  }
  return out;
}

/** Every bank statement (STMTRS) in the file. Fails closed on any unreadable transaction. */
export function parseOfxStatements(text: string): ParsedBankStatement[] {
  const start = text.search(/<OFX>/i);
  if (start < 0) throw new Error('OFX: <OFX> element not found');
  const stmts = blocks(text.slice(start), 'STMTRS');
  if (!stmts.length) throw new Error('OFX: STMTRS not found');
  return stmts.map((stmt, si) => {
    const where = stmts.length > 1 ? `statement ${si + 1}: ` : '';
    const problems: ImportError[] = [];
    const currency = tagValue(stmt, 'CURDEF');
    if (!/^[A-Z]{3}$/i.test(currency)) problems.push({ line: null, message: `${where}no currency (CURDEF)` });
    const accountNumber = tagValue(blocks(stmt, 'BANKACCTFROM')[0] ?? '', 'ACCTID');
    if (!accountNumber) problems.push({ line: null, message: `${where}no account (BANKACCTFROM/ACCTID)` });
    const ledger = blocks(stmt, 'LEDGERBAL')[0];
    let closing = 0;
    let statementDate = '';
    try {
      if (!ledger) throw new Error('no ledger balance (LEDGERBAL)');
      closing = minor(tagValue(ledger, 'BALAMT'));
      statementDate = ofxDate(tagValue(ledger, 'DTASOF'));
    } catch (err) {
      problems.push({ line: null, message: `${where}${(err as Error).message}` });
    }
    const transactions: ParsedBankTransaction[] = [];
    blocks(stmt, 'STMTTRN').forEach((t, n) => {
      const i = n + 1;
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
        problems.push({ line: i, message: `${where}${(err as Error).message}` });
      }
    });
    failClosed(problems);
    // OFX reports the closing (ledger) balance only: the opening one is what the transactions leave
    const net = transactions.reduce((s, t) => s + t.amountMinor, 0);
    return { format: 'ofx' as const, accountNumber, currency: currency.toUpperCase(), statementDate, openingBalanceMinor: closing - net, closingBalanceMinor: closing, transactions, warnings: [] };
  });
}

/** The one statement of a single-statement file. */
export function parseOfx(text: string): ParsedBankStatement {
  const statements = parseOfxStatements(text);
  if (statements.length !== 1) throw new Error(`OFX: the file holds ${statements.length} statements; read them with parseOfxStatements`);
  return statements[0]!;
}
