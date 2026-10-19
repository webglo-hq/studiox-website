import { parseCsv } from '../../../framework/connectors/csv';
import { escapeXml, findAll, kid, kids, parseXml, path, textAt, type XmlElement } from '../../../framework/connectors/xml';
import { toCents, centsToDecimalString } from '../../../framework/util/money';

/**
 * Bank statement standards → one normalised shape.
 *  - BAI2 (Bank Administration Institute v2 cash management balance reporting)
 *  - ISO 20022 camt.053 (BankToCustomerStatement)
 *  - OFX 1.x (SGML) and 2.x (XML)
 *  - CSV (date, description, amount[, reference])
 * Parsers are strict about structure and tolerant about whitespace; every line keeps a
 * provenance pointer back to its position in the source document.
 */

export interface ParsedBankLine {
  postedDate: string;
  valueDate: string | null;
  amount: number;
  description: string;
  reference: string | null;
  counterparty: string | null;
  typeCode: string | null;
  externalId: string | null;
  sourceLine: string;
}

export interface ParsedBankStatement {
  format: 'BAI2' | 'CAMT053' | 'OFX' | 'CSV';
  accountNumber: string;
  currency: string;
  statementStart: string;
  statementEnd: string;
  openingBalance: number | null;
  closingBalance: number | null;
  lines: ParsedBankLine[];
  warnings: string[];
}

export class BankFormatError extends Error {
  constructor(format: string, message: string) {
    super(`${format}: ${message}`);
    this.name = 'BankFormatError';
  }
}

// ------------------------------------------------------------------------- BAI2

function baiDate(yymmdd: string): string {
  if (!/^\d{6}$/.test(yymmdd)) throw new BankFormatError('BAI2', `bad date ${yymmdd}`);
  const yy = Number(yymmdd.slice(0, 2));
  return `${yy >= 70 ? 1900 + yy : 2000 + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

/** BAI2 transaction type codes: 100–399 credits, 400–699 debits. */
export function baiIsCredit(typeCode: string): boolean {
  const n = Number(typeCode);
  return n >= 100 && n < 400;
}

const BAI_TYPE_TEXT: Record<string, string> = {
  '165': 'ACH credit',
  '195': 'Incoming wire',
  '301': 'Deposit',
  '354': 'Interest credit',
  '455': 'ACH debit',
  '475': 'Check paid',
  '495': 'Outgoing wire',
  '661': 'Account analysis fee',
  '699': 'Miscellaneous debit',
};

export function parseBai2(text: string): ParsedBankStatement[] {
  const physical = text.replace(/\r/g, '').split('\n');
  // Merge 88 continuation records into their predecessor
  const records: { fields: string; line: number }[] = [];
  physical.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('88,')) {
      const prev = records[records.length - 1];
      if (!prev) throw new BankFormatError('BAI2', `continuation without a record at line ${idx + 1}`);
      // 16-record continuations extend the free-text field; others continue the field list
      prev.fields = prev.fields.startsWith('16,') ? `${prev.fields.replace(/\/$/, '')} ${line.slice(3)}` : `${prev.fields.replace(/\/$/, '')},${line.slice(3)}`;
      return;
    }
    records.push({ fields: line, line: idx + 1 });
  });
  if (!records.length || !records[0]!.fields.startsWith('01,')) throw new BankFormatError('BAI2', 'file must start with a 01 header record');
  if (!records[records.length - 1]!.fields.startsWith('99,')) throw new BankFormatError('BAI2', 'file must end with a 99 trailer record');

  const out: ParsedBankStatement[] = [];
  let groupDate = '';
  let groupCurrency = 'USD';
  let current: (ParsedBankStatement & { control: number }) | null = null;
  const all: (ParsedBankStatement & { control: number })[] = [];
  for (const rec of records) {
    const type = rec.fields.slice(0, 2);
    const body = rec.fields.replace(/\/$/, '');
    const f = body.split(',');
    switch (type) {
      case '01':
        if (f[8] && f[8] !== '2') throw new BankFormatError('BAI2', `unsupported version ${f[8]}`);
        break;
      case '02':
        groupDate = baiDate(f[4] ?? '');
        groupCurrency = f[6] || 'USD';
        break;
      case '03': {
        const accountNumber = f[1] ?? '';
        const currency = f[2] || groupCurrency;
        let opening: number | null = null;
        let closing: number | null = null;
        let control = 0;
        // Summary/status triples: typeCode, amount, itemCount, fundsType
        for (let k = 3; k + 1 < f.length; k += 4) {
          const code = f[k];
          const amt = f[k + 1];
          if (!code || amt === undefined || amt === '') continue;
          const v = Number(amt.replace(/^\+/, ''));
          if (!Number.isFinite(v)) throw new BankFormatError('BAI2', `bad amount ${amt} at line ${rec.line}`);
          control += v;
          if (code === '010') opening = v;
          if (code === '015') closing = v;
        }
        current = { format: 'BAI2', accountNumber, currency, statementStart: groupDate, statementEnd: groupDate, openingBalance: opening, closingBalance: closing, lines: [], warnings: [], control };
        all.push(current);
        break;
      }
      case '16': {
        if (!current) throw new BankFormatError('BAI2', `16 record outside an account at line ${rec.line}`);
        // 16,type,amount,fundsType,[funds detail...],bankRef,customerRef,text — funds type S/V/D carry extra fields
        const typeCode = f[1] ?? '';
        const amount = Number(f[2]);
        if (!/^\d{3}$/.test(typeCode) || !Number.isFinite(amount)) throw new BankFormatError('BAI2', `bad transaction at line ${rec.line}`);
        let idx = 4;
        const fundsType = f[3] ?? '';
        let valueDate: string | null = null;
        if (fundsType === 'S') idx += 3;
        else if (fundsType === 'V') {
          valueDate = baiDate(f[4] ?? '');
          idx += 2;
        } else if (fundsType === 'D') idx += 1 + 2 * Number(f[4] ?? 0);
        const bankRef = f[idx] || null;
        const custRef = f[idx + 1] || null;
        const textField = f.slice(idx + 2).join(',').trim();
        current.control += amount;
        const signed = baiIsCredit(typeCode) ? amount : -amount;
        // Our BAI2 text carries "YYMMDD description" when the posting date differs from the group date
        let posted = groupDate;
        let description = textField;
        const dm = /^(\d{6})\s+(.*)$/.exec(textField);
        if (dm) {
          posted = baiDate(dm[1]!);
          description = dm[2]!;
        }
        current.lines.push({
          postedDate: posted,
          valueDate,
          amount: signed,
          description: description || BAI_TYPE_TEXT[typeCode] || `BAI ${typeCode}`,
          reference: custRef ?? bankRef,
          counterparty: null,
          typeCode,
          externalId: bankRef,
          sourceLine: `line ${rec.line}`,
        });
        if (posted < current.statementStart) current.statementStart = posted;
        if (posted > current.statementEnd) current.statementEnd = posted;
        break;
      }
      case '49': {
        if (!current) break;
        const declared = Number(f[1]);
        if (Number.isFinite(declared) && declared !== current.control) current.warnings.push(`account control total ${declared} ≠ computed ${current.control}`);
        current = null;
        break;
      }
      case '98':
      case '99':
        break;
      default:
        throw new BankFormatError('BAI2', `unknown record type ${type} at line ${rec.line}`);
    }
  }
  void out;
  return all.map(({ control: _c, ...rest }) => rest);
}

export interface BankLineInput {
  date: string;
  amount: number;
  typeCode: string;
  bankRef: string;
  customerRef: string;
  text: string;
}

export function writeBai2(input: { sender: string; receiver: string; created: string; accountNumber: string; currency: string; asOf: string; opening: number; closing: number; lines: BankLineInput[] }): string {
  const yymmdd = (d: string) => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  const credits = input.lines.filter((l) => l.amount > 0);
  const debits = input.lines.filter((l) => l.amount < 0);
  const tc = credits.reduce((s, l) => s + l.amount, 0);
  const td = debits.reduce((s, l) => s - l.amount, 0);
  const recs: string[] = [];
  recs.push(`01,${input.sender},${input.receiver},${yymmdd(input.created)},0600,1,,,2/`);
  recs.push(`02,${input.receiver},${input.sender},1,${yymmdd(input.asOf)},2359,${input.currency},2/`);
  const acct = `03,${input.accountNumber},${input.currency},010,${input.opening},,,015,${input.closing},,,100,${tc},${credits.length},,400,${td},${debits.length},/`;
  recs.push(acct);
  let control = input.opening + input.closing + tc + td;
  for (const l of input.lines) {
    const amt = Math.abs(l.amount);
    control += amt;
    const text = `${yymmdd(l.date)} ${l.text.replace(/\//g, ' ')}`;
    // Variable-length records (blank physical record length in the 01 header): no 88 splits needed
    recs.push(`16,${l.typeCode},${amt},0,${l.bankRef},${l.customerRef},${text}`);
  }
  recs.push(`49,${control},${input.lines.length + 2}/`);
  recs.push(`98,${control},1,${input.lines.length + 4}/`);
  recs.push(`99,${control},1,${input.lines.length + 6}/`);
  return recs.join('\n') + '\n';
}

// -------------------------------------------------------------------- camt.053

function camtAmount(el: XmlElement | undefined): number {
  const amt = kid(el, 'Amt');
  if (!amt) throw new BankFormatError('camt.053', 'missing Amt');
  const v = toCents(amt.text.trim());
  const ind = textAt(el, 'CdtDbtInd');
  if (ind !== 'CRDT' && ind !== 'DBIT') throw new BankFormatError('camt.053', `bad CdtDbtInd ${ind}`);
  return ind === 'CRDT' ? v : -v;
}

function camtDate(el: XmlElement | undefined): string | null {
  return textAt(el, 'Dt')?.slice(0, 10) ?? textAt(el, 'DtTm')?.slice(0, 10) ?? null;
}

export function parseCamt053(xml: string): ParsedBankStatement[] {
  const doc = parseXml(xml);
  if (doc.local !== 'Document') throw new BankFormatError('camt.053', 'root element must be Document');
  const ns = doc.attrs.xmlns ?? '';
  if (!/camt\.053/.test(ns)) throw new BankFormatError('camt.053', `unexpected namespace ${ns || '(none)'}`);
  const stmts = findAll(doc, 'Stmt');
  if (!stmts.length) throw new BankFormatError('camt.053', 'no Stmt elements');
  return stmts.map((st) => {
    const acct = kid(st, 'Acct');
    const accountNumber = textAt(acct, 'Id', 'IBAN') ?? textAt(acct, 'Id', 'Othr', 'Id') ?? 'unknown';
    const currency = textAt(acct, 'Ccy') ?? 'EUR';
    let opening: number | null = null;
    let closing: number | null = null;
    for (const b of kids(st, 'Bal')) {
      const code = textAt(b, 'Tp', 'CdOrPrtry', 'Cd');
      if (code === 'OPBD' || code === 'PRCD') opening = camtAmount(b);
      if (code === 'CLBD') closing = camtAmount(b);
    }
    const from = textAt(st, 'FrToDt', 'FrDtTm')?.slice(0, 10);
    const to = textAt(st, 'FrToDt', 'ToDtTm')?.slice(0, 10);
    const warnings: string[] = [];
    const lines: ParsedBankLine[] = kids(st, 'Ntry').map((n, idx) => {
      const status = textAt(n, 'Sts', 'Cd') ?? textAt(n, 'Sts');
      if (status && status !== 'BOOK') warnings.push(`entry ${idx + 1} has status ${status}`);
      const tx = path(n, 'NtryDtls', 'TxDtls');
      const credit = textAt(n, 'CdtDbtInd') === 'CRDT';
      const party = credit ? (textAt(tx, 'RltdPties', 'Dbtr', 'Nm') ?? textAt(tx, 'RltdPties', 'Dbtr', 'Pty', 'Nm')) : (textAt(tx, 'RltdPties', 'Cdtr', 'Nm') ?? textAt(tx, 'RltdPties', 'Cdtr', 'Pty', 'Nm'));
      const remit = textAt(tx, 'RmtInf', 'Ustrd');
      const addl = textAt(n, 'AddtlNtryInf');
      return {
        postedDate: camtDate(kid(n, 'BookgDt')) ?? from ?? '',
        valueDate: camtDate(kid(n, 'ValDt')),
        amount: camtAmount(n),
        description: [party, remit ?? addl].filter(Boolean).join(' — ') || 'Bank entry',
        reference: textAt(tx, 'Refs', 'EndToEndId') ?? textAt(n, 'NtryRef') ?? null,
        counterparty: party ?? null,
        typeCode: textAt(n, 'BkTxCd', 'Prtry', 'Cd') ?? textAt(n, 'BkTxCd', 'Domn', 'Fmly', 'SubFmlyCd') ?? null,
        externalId: textAt(n, 'AcctSvcrRef') ?? null,
        sourceLine: `Stmt/Ntry[${idx + 1}]`,
      };
    });
    if (opening !== null && closing !== null) {
      const sum = lines.reduce((s, l) => s + l.amount, 0);
      if (opening + sum !== closing) warnings.push(`opening ${opening} + entries ${sum} ≠ closing ${closing}`);
    }
    const dates = lines.map((l) => l.postedDate).sort();
    return { format: 'CAMT053' as const, accountNumber, currency, statementStart: from ?? dates[0] ?? '', statementEnd: to ?? dates[dates.length - 1] ?? '', openingBalance: opening, closingBalance: closing, lines, warnings };
  });
}

export function writeCamt053(input: { msgId: string; created: string; iban: string; currency: string; from: string; to: string; opening: number; closing: number; entries: { date: string; amount: number; ref: string; svcrRef: string; party: string; remittance: string; code: string }[] }): string {
  const amt = (c: number) => `<Amt Ccy="${input.currency}">${centsToDecimalString(Math.abs(c))}</Amt><CdtDbtInd>${c >= 0 ? 'CRDT' : 'DBIT'}</CdtDbtInd>`;
  const bal = (code: string, c: number, d: string) => `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp>${amt(c)}<Dt><Dt>${d}</Dt></Dt></Bal>`;
  const entries = input.entries
    .map(
      (e) =>
        `<Ntry><NtryRef>${escapeXml(e.ref)}</NtryRef>${amt(e.amount)}<Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${e.date}</Dt></BookgDt><ValDt><Dt>${e.date}</Dt></ValDt><AcctSvcrRef>${escapeXml(e.svcrRef)}</AcctSvcrRef><BkTxCd><Prtry><Cd>${escapeXml(e.code)}</Cd></Prtry></BkTxCd><NtryDtls><TxDtls><Refs><EndToEndId>${escapeXml(e.ref)}</EndToEndId></Refs><RltdPties>${e.amount >= 0 ? `<Dbtr><Nm>${escapeXml(e.party)}</Nm></Dbtr>` : `<Cdtr><Nm>${escapeXml(e.party)}</Nm></Cdtr>`}</RltdPties><RmtInf><Ustrd>${escapeXml(e.remittance)}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`,
    )
    .join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>${escapeXml(input.msgId)}</MsgId><CreDtTm>${input.created}T06:00:00Z</CreDtTm></GrpHdr>
    <Stmt>
      <Id>${escapeXml(input.msgId)}-1</Id>
      <CreDtTm>${input.created}T06:00:00Z</CreDtTm>
      <FrToDt><FrDtTm>${input.from}T00:00:00Z</FrDtTm><ToDtTm>${input.to}T23:59:59Z</ToDtTm></FrToDt>
      <Acct><Id><IBAN>${escapeXml(input.iban)}</IBAN></Id><Ccy>${input.currency}</Ccy></Acct>
      ${bal('OPBD', input.opening, input.from)}
      ${bal('CLBD', input.closing, input.to)}
      ${entries}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;
}

// ------------------------------------------------------------------------- OFX

interface OfxNode {
  tag: string;
  value: string | null;
  children: OfxNode[];
}

/** Tolerant OFX parser: aggregates have explicit end tags; leaf elements may not (SGML). */
function parseOfxTree(text: string): OfxNode {
  const start = text.indexOf('<OFX>');
  if (start === -1) throw new BankFormatError('OFX', 'no <OFX> root');
  const body = text.slice(start);
  const tokenRe = /<(\/?)([A-Z0-9.]+)>([^<]*)/gi;
  const root: OfxNode = { tag: '#root', value: null, children: [] };
  const stack: OfxNode[] = [root];
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = tokenRe.exec(body))) {
    if (++count > 200_000) throw new BankFormatError('OFX', 'document too large');
    const closing = m[1] === '/';
    const tag = m[2]!.toUpperCase();
    const value = m[3]!.trim();
    if (closing) {
      // close back to the matching aggregate (leaves with explicit close are handled too)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.tag === tag) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const node: OfxNode = { tag, value: value || null, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!value) stack.push(node);
  }
  return root;
}

function ofxFind(n: OfxNode, tag: string): OfxNode[] {
  const out: OfxNode[] = [];
  const walk = (x: OfxNode) => {
    for (const c of x.children) {
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
}

function ofxVal(n: OfxNode | undefined, tag: string): string | null {
  return n?.children.find((c) => c.tag === tag)?.value ?? null;
}

function ofxDate(v: string | null): string {
  if (!v || !/^\d{8}/.test(v)) throw new BankFormatError('OFX', `bad date ${v}`);
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

export function parseOfx(text: string): ParsedBankStatement[] {
  const tree = parseOfxTree(text);
  const stmts = ofxFind(tree, 'STMTRS');
  if (!stmts.length) throw new BankFormatError('OFX', 'no STMTRS (bank statement) found');
  return stmts.map((st) => {
    const acct = ofxFind(st, 'BANKACCTFROM')[0];
    const list = ofxFind(st, 'BANKTRANLIST')[0];
    const ledger = ofxFind(st, 'LEDGERBAL')[0];
    const currency = ofxVal(st, 'CURDEF') ?? 'USD';
    const lines: ParsedBankLine[] = ofxFind(st, 'STMTTRN').map((t, idx) => {
      const amt = ofxVal(t, 'TRNAMT');
      if (!amt) throw new BankFormatError('OFX', `transaction ${idx + 1} has no TRNAMT`);
      const name = ofxVal(t, 'NAME');
      const memo = ofxVal(t, 'MEMO');
      const check = ofxVal(t, 'CHECKNUM');
      return {
        postedDate: ofxDate(ofxVal(t, 'DTPOSTED')),
        valueDate: ofxVal(t, 'DTAVAIL') ? ofxDate(ofxVal(t, 'DTAVAIL')) : null,
        amount: toCents(amt),
        description: [name, memo].filter(Boolean).join(' — ') || (check ? `CHECK ${check}` : 'Transaction'),
        reference: check ? `CHECK ${check}` : (ofxVal(t, 'REFNUM') ?? null),
        counterparty: name,
        typeCode: ofxVal(t, 'TRNTYPE'),
        externalId: ofxVal(t, 'FITID'),
        sourceLine: `STMTTRN[${idx + 1}]`,
      };
    });
    const closing = ofxVal(ledger, 'BALAMT');
    return {
      format: 'OFX' as const,
      accountNumber: ofxVal(acct, 'ACCTID') ?? 'unknown',
      currency,
      statementStart: ofxDate(ofxVal(list, 'DTSTART')),
      statementEnd: ofxDate(ofxVal(list, 'DTEND')),
      openingBalance: null,
      closingBalance: closing ? toCents(closing) : null,
      lines,
      warnings: [],
    };
  });
}

export function writeOfx(input: { bankId: string; accountId: string; currency: string; from: string; to: string; closing: number; txns: { date: string; amount: number; fitid: string; name: string; memo: string; type: string; check?: string }[] }): string {
  const d = (x: string) => x.replace(/-/g, '');
  const txns = input.txns
    .map(
      (t) =>
        `<STMTTRN>\n<TRNTYPE>${t.type}\n<DTPOSTED>${d(t.date)}120000\n<TRNAMT>${centsToDecimalString(t.amount)}\n<FITID>${t.fitid}\n${t.check ? `<CHECKNUM>${t.check}\n` : ''}<NAME>${escapeXml(t.name).slice(0, 32)}\n<MEMO>${escapeXml(t.memo)}\n</STMTTRN>`,
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
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>${d(input.to)}235959<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>${input.currency}
<BANKACCTFROM><BANKID>${input.bankId}<ACCTID>${input.accountId}<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>${d(input.from)}<DTEND>${d(input.to)}
${txns}
</BANKTRANLIST>
<LEDGERBAL><BALAMT>${centsToDecimalString(input.closing)}<DTASOF>${d(input.to)}235959</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
`;
}

// ------------------------------------------------------------------------- CSV

export function parseBankCsv(text: string, accountNumber: string, currency: string): ParsedBankStatement[] {
  const t = parseCsv(text, { required: ['date', 'description', 'amount'] });
  const lines = t.rows.map((r, i) => ({
    postedDate: r.date!,
    valueDate: null,
    amount: toCents(r.amount!),
    description: r.description!,
    reference: r.reference || null,
    counterparty: r.counterparty || null,
    typeCode: r.type || null,
    externalId: r.id || null,
    sourceLine: `line ${t.lines[i]}`,
  }));
  const dates = lines.map((l) => l.postedDate).sort();
  return [{ format: 'CSV', accountNumber, currency, statementStart: dates[0] ?? '', statementEnd: dates[dates.length - 1] ?? '', openingBalance: null, closingBalance: null, lines, warnings: [] }];
}

export function detectBankFormat(content: string): 'BAI2' | 'CAMT053' | 'OFX' | 'CSV' {
  const head = content.trimStart().slice(0, 400);
  if (head.startsWith('01,')) return 'BAI2';
  if (/camt\.053/.test(head) || head.startsWith('<?xml') && /BkToCstmrStmt/.test(content.slice(0, 2000))) return 'CAMT053';
  if (/OFXHEADER|<OFX>/i.test(head)) return 'OFX';
  return 'CSV';
}
