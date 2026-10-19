/**
 * ISO 20022 camt.053 (BankToCustomerStatement) parser and writer.
 * A small, safe XML reader: no DTDs, no entities beyond the five predefined ones, no external
 * resources (XXE-proof by construction), element/attribute/text only.
 */
import type { ImportError, ParsedBankStatement, ParsedBankTransaction } from './types';

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
  if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error(`camt.053: invalid amount "${t}"`);
  const [w, f = ''] = t.split('.') as [string, string?];
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

export function parseCamt053(xml: string): ParsedBankStatement {
  const doc = parseXml(xml);
  const stmt = child(doc, 'Document', 'BkToCstmrStmt', 'Stmt');
  if (!stmt) throw new Error('camt.053: Document/BkToCstmrStmt/Stmt not found');
  const warnings: ImportError[] = [];
  const acct = child(stmt, 'Acct');
  const accountNumber = text(acct, 'Id', 'IBAN') || text(acct, 'Id', 'Othr', 'Id');
  const currency = text(acct, 'Ccy') || 'EUR';
  let opening: number | null = null;
  let closing: number | null = null;
  for (const bal of all(stmt, 'Bal')) {
    const code = text(bal, 'Tp', 'CdOrPrtry', 'Cd');
    const amt = amountMinor(child(bal, 'Amt'));
    const sign = text(bal, 'CdtDbtInd') === 'DBIT' ? -1 : 1;
    if (code === 'OPBD' || code === 'PRCD') opening = sign * amt;
    if (code === 'CLBD') closing = sign * amt;
  }
  const statementDate = (text(stmt, 'CreDtTm') || text(stmt, 'FrToDt', 'ToDtTm')).slice(0, 10);
  const transactions: ParsedBankTransaction[] = [];
  all(stmt, 'Ntry').forEach((e, i) => {
    try {
      const amt = amountMinor(child(e, 'Amt'));
      const sign = text(e, 'CdtDbtInd') === 'DBIT' ? -1 : 1;
      const tx = child(e, 'NtryDtls', 'TxDtls');
      const credit = sign > 0;
      const counterparty = credit ? text(tx, 'RltdPties', 'Dbtr', 'Nm') || text(tx, 'RltdPties', 'Dbtr', 'Pty', 'Nm') : text(tx, 'RltdPties', 'Cdtr', 'Nm') || text(tx, 'RltdPties', 'Cdtr', 'Pty', 'Nm');
      const ustrd = all(child(tx, 'RmtInf'), 'Ustrd').map((u) => u.text.trim()).join(' ');
      transactions.push({
        externalId: text(e, 'AcctSvcrRef') || text(e, 'NtryRef') || `${statementDate}-${i + 1}`,
        bookingDate: text(e, 'BookgDt', 'Dt') || text(e, 'BookgDt', 'DtTm').slice(0, 10),
        valueDate: text(e, 'ValDt', 'Dt') || null,
        amountMinor: sign * amt,
        description: [text(e, 'AddtlNtryInf'), ustrd].filter(Boolean).join(' – ') || (credit ? 'Credit' : 'Debit'),
        counterparty: counterparty || null,
        reference: text(tx, 'Refs', 'EndToEndId') || null,
        typeCode: text(e, 'BkTxCd', 'Domn', 'Fmly', 'SubFmlyCd') || text(e, 'BkTxCd', 'Prtry', 'Cd') || null,
        sourceLine: i + 1,
      });
    } catch (err) {
      warnings.push({ line: i + 1, message: (err as Error).message });
    }
  });
  if (opening === null || closing === null) throw new Error('camt.053: opening (OPBD) and closing (CLBD) balances are required');
  const net = transactions.reduce((s, t) => s + t.amountMinor, 0);
  if (opening + net !== closing) warnings.push({ line: null, message: `balance check: opening ${opening} + entries ${net} != closing ${closing}` });
  return { format: 'camt053', accountNumber, currency, statementDate, openingBalanceMinor: opening, closingBalanceMinor: closing, transactions, warnings };
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
