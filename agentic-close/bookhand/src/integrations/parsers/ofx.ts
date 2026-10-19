import { parseDecimalToMinor } from '../../shared/money';
import { type NormalizedStatement, type NormalizedStatementLine, StatementParseError } from './statement';

/**
 * OFX bank statement parser for OFX 1.x (SGML, unclosed leaf tags) and 2.x (XML). Extracts BANKACCTFROM,
 * CURDEF, BANKTRANLIST (DTSTART/DTEND, STMTTRN) and LEDGERBAL. FITID is the bank's unique id per account.
 */

function leaf(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  return m ? m[1]!.trim() : undefined;
}

function ofxDate(v: string | undefined, locator: string): string {
  if (!v || !/^\d{8}/.test(v)) throw new StatementParseError(`invalid OFX date "${v}"`, locator);
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function parseOfx(text: string): NormalizedStatement {
  if (!/<OFX>/i.test(text)) throw new StatementParseError('not an OFX document (no <OFX> element)');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new StatementParseError('DOCTYPE/ENTITY declarations are not allowed');
  const body = text.slice(text.search(/<OFX>/i));
  const stmt = /<STMTRS>([\s\S]*?)<\/STMTRS>/i.exec(body)?.[1] ?? /<CCSTMTRS>([\s\S]*?)<\/CCSTMTRS>/i.exec(body)?.[1];
  if (!stmt) throw new StatementParseError('no STMTRS (bank statement response) found');
  const currency = leaf(stmt, 'CURDEF') ?? 'USD';
  const acctBlock = /<BANKACCTFROM>([\s\S]*?)<\/BANKACCTFROM>/i.exec(stmt)?.[1] ?? /<CCACCTFROM>([\s\S]*?)<\/CCACCTFROM>/i.exec(stmt)?.[1] ?? stmt;
  const accountId = leaf(acctBlock, 'ACCTID') ?? '';
  if (!accountId) throw new StatementParseError('missing ACCTID');
  const tranList = /<BANKTRANLIST>([\s\S]*?)<\/BANKTRANLIST>/i.exec(stmt)?.[1] ?? '';
  const start = leaf(tranList, 'DTSTART');
  const end = leaf(tranList, 'DTEND');
  const lines: NormalizedStatementLine[] = [];
  const warnings: string[] = [];
  const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(tranList))) {
    const block = m[1]!;
    const loc = `STMTTRN[${i++}]`;
    const amt = parseDecimalToMinor(leaf(block, 'TRNAMT') ?? '');
    if (amt === null) throw new StatementParseError('invalid TRNAMT', loc);
    const fitid = leaf(block, 'FITID');
    if (!fitid) throw new StatementParseError('missing FITID', loc);
    const name = leaf(block, 'NAME');
    const memo = leaf(block, 'MEMO');
    const check = leaf(block, 'CHECKNUM');
    lines.push({
      bookingDate: ofxDate(leaf(block, 'DTPOSTED'), loc),
      valueDate: leaf(block, 'DTAVAIL') ? ofxDate(leaf(block, 'DTAVAIL'), loc) : null,
      amount: amt,
      description: decodeEntities([name, memo, check ? `CHECK ${check}` : undefined].filter(Boolean).join(' / ') || 'OFX transaction'),
      counterparty: name ? decodeEntities(name) : null,
      reference: check ?? leaf(block, 'REFNUM') ?? null,
      bankReference: fitid,
      typeCode: leaf(block, 'TRNTYPE') ?? null,
      locator: loc,
    });
  }
  const ledger = /<LEDGERBAL>([\s\S]*?)<\/LEDGERBAL>/i.exec(stmt)?.[1];
  const closing = ledger ? parseDecimalToMinor(leaf(ledger, 'BALAMT') ?? '') : null;
  const net = lines.reduce((s, l) => s + l.amount, 0);
  const dates = lines.map((l) => l.bookingDate).sort();
  return {
    format: 'ofx',
    accountId,
    currency,
    periodStart: start ? ofxDate(start, 'DTSTART') : (dates[0] ?? ''),
    periodEnd: end ? ofxDate(end, 'DTEND') : (dates[dates.length - 1] ?? ''),
    statementDate: ledger ? ofxDate(leaf(ledger, 'DTASOF'), 'LEDGERBAL') : (dates[dates.length - 1] ?? ''),
    openingBalance: closing !== null ? closing - net : null,
    closingBalance: closing,
    lines,
    warnings,
  };
}

export function writeOfx(opts: {
  accountId: string;
  routing: string;
  currency: string;
  start: string;
  end: string;
  closing: number;
  transactions: Array<{ type: 'DEBIT' | 'CREDIT' | 'CHECK' | 'FEE' | 'INT' | 'XFER'; date: string; amount: number; fitid: string; name: string; memo?: string; check?: string }>;
}): string {
  const d = (iso: string) => `${iso.replace(/-/g, '')}120000`;
  const amt = (m: number) => (m / 100).toFixed(2);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tx = opts.transactions
    .map(
      (t) =>
        `<STMTTRN>\n<TRNTYPE>${t.type}\n<DTPOSTED>${d(t.date)}\n<TRNAMT>${amt(t.amount)}\n<FITID>${t.fitid}\n${t.check ? `<CHECKNUM>${t.check}\n` : ''}<NAME>${esc(t.name.slice(0, 32))}\n${t.memo ? `<MEMO>${esc(t.memo)}\n` : ''}</STMTTRN>`,
    )
    .join('\n');
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>${d(opts.end)}<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>${opts.currency}
<BANKACCTFROM><BANKID>${opts.routing}<ACCTID>${opts.accountId}<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>${d(opts.start)}
<DTEND>${d(opts.end)}
${tx}
</BANKTRANLIST>
<LEDGERBAL><BALAMT>${amt(opts.closing)}<DTASOF>${d(opts.end)}</LEDGERBAL>
</STMTRS>
</STMTTRNRS></BANKMSGSRSV1>
</OFX>
`;
}
