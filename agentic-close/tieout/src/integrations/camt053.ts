/**
 * ISO 20022 camt.053 (BankToCustomerStatement) parser and writer.
 * A small, safe XML reader: no DTDs, no entities beyond the five predefined ones, no external
 * resources (XXE-proof by construction), element/attribute/text only.
 */
import { parseDate } from './csv';
import { failClosed, type ImportError, type ParsedBankStatement, type ParsedBankTransaction } from './types';

interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENT[e.toLowerCase()] ?? '';
  });
}

export function parseXml(xml: string): XNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML: DTDs and entity declarations are not allowed');
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [root];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      const name = local(m[2]);
      if (top.name !== name) throw new Error(`XML: mismatched </${name}>`);
      stack.pop();
    } else if (m[3]) {
      const node: XNode = { name: local(m[3]), attrs: {}, children: [], text: '' };
      const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[4] ?? ''))) node.attrs[local(a[1]!)] = decode(a[3] ?? a[4] ?? '');
      top.children.push(node);
      if (m[5] !== '/') stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  if (stack.length !== 1) throw new Error('XML: unclosed elements');
  return root;
}

function local(n: string): string {
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
}

function child(n: XNode | undefined, ...path: string[]): XNode | undefined {
  let cur = n;
  for (const p of path) cur = cur?.children.find((c) => c.name === p);
  return cur;
}

function all(n: XNode | undefined, name: string): XNode[] {
  return n?.children.filter((c) => c.name === name) ?? [];
}

function text(n: XNode | undefined, ...path: string[]): string {
  return child(n, ...path)?.text.trim() ?? '';
}

function amountMinor(n: XNode | undefined): number {
  const t = n?.text.trim() ?? '';
  if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error(`invalid amount "${t}"`);
  const [w, f = ''] = t.split('.') as [string, string?];
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

/** CRDT or DBIT, nothing else: a missing or unknown indicator never defaults to a credit. */
function sign(n: XNode, what: string): 1 | -1 {
  const v = text(n, 'CdtDbtInd');
  if (v === 'CRDT') return 1;
  if (v === 'DBIT') return -1;
  throw new Error(`${what} has ${v ? `an invalid credit/debit indicator "${v}"` : 'no credit/debit indicator (CdtDbtInd)'}`);
}

/** Every statement in the message (a camt.053 may carry several, e.g. one per account). */
export function parseCamt053Statements(xml: string): ParsedBankStatement[] {
  const doc = parseXml(xml);
  const stmts = all(child(doc, 'Document', 'BkToCstmrStmt'), 'Stmt');
  if (!stmts.length) throw new Error('camt.053: Document/BkToCstmrStmt/Stmt not found');
  return stmts.map((stmt, si) => parseStatement(stmt, stmts.length > 1 ? `statement ${si + 1}: ` : ''));
}

/** The one statement of a single-statement message. */
export function parseCamt053(xml: string): ParsedBankStatement {
  const statements = parseCamt053Statements(xml);
  if (statements.length !== 1) throw new Error(`camt.053: the message holds ${statements.length} statements; read them with parseCamt053Statements`);
  return statements[0]!;
}

function parseStatement(stmt: XNode, where: string): ParsedBankStatement {
  const problems: ImportError[] = [];
  const acct = child(stmt, 'Acct');
  const accountNumber = text(acct, 'Id', 'IBAN') || text(acct, 'Id', 'Othr', 'Id');
  if (!accountNumber) problems.push({ line: null, message: `${where}the statement names no account (Acct/Id)` });
  const balances = all(stmt, 'Bal');
  const currency = text(acct, 'Ccy') || child(balances[0], 'Amt')?.attrs.Ccy || '';
  if (!/^[A-Z]{3}$/.test(currency)) problems.push({ line: null, message: `${where}the statement has no currency (Acct/Ccy)` });
  let opening: number | null = null;
  let closing: number | null = null;
  for (const bal of balances) {
    const code = text(bal, 'Tp', 'CdOrPrtry', 'Cd');
    try {
      const amt = sign(bal, `the ${code || 'unnamed'} balance`) * amountMinor(child(bal, 'Amt'));
      if (code === 'OPBD' || code === 'PRCD') opening = amt;
      if (code === 'CLBD') closing = amt;
    } catch (err) {
      problems.push({ line: null, message: `${where}${(err as Error).message}` });
    }
  }
  const statementDate = (text(stmt, 'CreDtTm') || text(stmt, 'FrToDt', 'ToDtTm')).slice(0, 10);
  const transactions: ParsedBankTransaction[] = [];
  all(stmt, 'Ntry').forEach((e, i) => {
    try {
      const amtNode = child(e, 'Amt');
      if (amtNode?.attrs.Ccy && amtNode.attrs.Ccy !== currency) throw new Error(`the entry is in ${amtNode.attrs.Ccy}, the statement in ${currency}`);
      const amount = sign(e, 'the entry') * amountMinor(amtNode);
      const booked = text(e, 'BookgDt', 'Dt') || text(e, 'BookgDt', 'DtTm').slice(0, 10);
      if (!booked) throw new Error('the entry has no booking date');
      const valued = text(e, 'ValDt', 'Dt');
      const tx = child(e, 'NtryDtls', 'TxDtls');
      const credit = amount > 0;
      const counterparty = credit ? text(tx, 'RltdPties', 'Dbtr', 'Nm') || text(tx, 'RltdPties', 'Dbtr', 'Pty', 'Nm') : text(tx, 'RltdPties', 'Cdtr', 'Nm') || text(tx, 'RltdPties', 'Cdtr', 'Pty', 'Nm');
      const ustrd = all(child(tx, 'RmtInf'), 'Ustrd').map((u) => u.text.trim()).join(' ');
      transactions.push({
        externalId: text(e, 'AcctSvcrRef') || text(e, 'NtryRef') || `${statementDate}-${i + 1}`,
        bookingDate: parseDate(booked),
        valueDate: valued ? parseDate(valued) : null,
        amountMinor: amount,
        description: [text(e, 'AddtlNtryInf'), ustrd].filter(Boolean).join(' – ') || (credit ? 'Credit' : 'Debit'),
        counterparty: counterparty || null,
        reference: text(tx, 'Refs', 'EndToEndId') || null,
        typeCode: text(e, 'BkTxCd', 'Domn', 'Fmly', 'SubFmlyCd') || text(e, 'BkTxCd', 'Prtry', 'Cd') || null,
        sourceLine: i + 1,
      });
    } catch (err) {
      problems.push({ line: i + 1, message: `${where}${(err as Error).message}` });
    }
  });
  if (opening === null || closing === null) problems.push({ line: null, message: `${where}opening (OPBD) and closing (CLBD) balances are required` });
  failClosed(problems);
  const net = transactions.reduce((s, t) => s + t.amountMinor, 0);
  // the entries must account for the whole movement between the two balances
  failClosed(opening! + net !== closing! ? [{ line: null, message: `${where}opening balance ${opening} + entries ${net} does not equal the closing balance ${closing} (minor units)` }] : []);
  return { format: 'camt053', accountNumber, currency, statementDate, openingBalanceMinor: opening!, closingBalanceMinor: closing!, transactions, warnings: [] };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amt = (minor: number) => `${Math.trunc(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;

export interface CamtWriteInput {
  messageId: string;
  createdAt: string;
  iban: string;
  currency: string;
  from: string;
  to: string;
  openingMinor: number;
  closingMinor: number;
  entries: { ref: string; bookingDate: string; amountMinor: number; info: string; counterparty: string | null; endToEnd: string | null; subFamily: string }[];
}

export function writeCamt053(i: CamtWriteInput): string {
  const bal = (code: string, minor: number, date: string) =>
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${i.currency}">${amt(minor)}</Amt><CdtDbtInd>${minor < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
  const entries = i.entries
    .map((e) => {
      const credit = e.amountMinor > 0;
      const party = e.counterparty ? (credit ? `<RltdPties><Dbtr><Nm>${esc(e.counterparty)}</Nm></Dbtr></RltdPties>` : `<RltdPties><Cdtr><Nm>${esc(e.counterparty)}</Nm></Cdtr></RltdPties>`) : '';
      return `<Ntry><NtryRef>${esc(e.ref)}</NtryRef><Amt Ccy="${i.currency}">${amt(e.amountMinor)}</Amt><CdtDbtInd>${credit ? 'CRDT' : 'DBIT'}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${e.bookingDate}</Dt></BookgDt><ValDt><Dt>${e.bookingDate}</Dt></ValDt><AcctSvcrRef>${esc(e.ref)}</AcctSvcrRef><BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>${credit ? 'RCDT' : 'ICDT'}</Cd><SubFmlyCd>${esc(e.subFamily)}</SubFmlyCd></Fmly></Domn></BkTxCd><NtryDtls><TxDtls><Refs>${e.endToEnd ? `<EndToEndId>${esc(e.endToEnd)}</EndToEndId>` : ''}</Refs>${party}<RmtInf><Ustrd>${esc(e.info)}</Ustrd></RmtInf></TxDtls></NtryDtls><AddtlNtryInf>${esc(e.info)}</AddtlNtryInf></Ntry>`;
    })
    .join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>${esc(i.messageId)}</MsgId><CreDtTm>${i.createdAt}</CreDtTm></GrpHdr>
    <Stmt>
      <Id>${esc(i.messageId)}-1</Id>
      <CreDtTm>${i.createdAt}</CreDtTm>
      <FrToDt><FrDtTm>${i.from}T00:00:00Z</FrDtTm><ToDtTm>${i.to}T23:59:59Z</ToDtTm></FrToDt>
      <Acct><Id><IBAN>${esc(i.iban)}</IBAN></Id><Ccy>${i.currency}</Ccy></Acct>
      ${bal('OPBD', i.openingMinor, i.from)}
      ${bal('CLBD', i.closingMinor, i.to)}
      ${entries}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;
}
