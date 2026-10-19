import { XMLParser } from 'fast-xml-parser';
import { parseDecimalToMinor } from '../../shared/money';
import { type NormalizedStatement, type NormalizedStatementLine, StatementParseError } from './statement';

/**
 * ISO 20022 camt.053 (Bank-to-Customer Statement) parser, versions 001.02 through 001.12.
 * Booked entries (Sts = BOOK) become statement lines; OPBD/CLBD balances become opening/closing.
 * DOCTYPE/ENTITY declarations are rejected outright (no XXE or entity-expansion attacks).
 */

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  isArray: (name) => ['Stmt', 'Bal', 'Ntry', 'TxDtls', 'Ustrd', 'NtryDtls'].includes(name),
});

/** Decode the five predefined XML entities and numeric character references (custom entities are rejected earlier). */
function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return decodeXml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in (v as Node)) return decodeXml(String((v as Node)['#text']));
  return undefined;
}

function get(node: unknown, ...path: string[]): unknown {
  let cur: unknown = node;
  for (const p of path) {
    if (cur === undefined || cur === null) return undefined;
    cur = Array.isArray(cur) ? (cur[0] as Node)?.[p] : (cur as Node)[p];
  }
  return cur;
}

function amountOf(amt: unknown, indicator: unknown, locator: string): { minor: number; currency: string | undefined } {
  const raw = text(amt);
  const minor = raw === undefined ? null : parseDecimalToMinor(raw);
  if (minor === null) throw new StatementParseError(`invalid amount "${raw}"`, locator);
  const ind = text(indicator);
  if (ind !== 'CRDT' && ind !== 'DBIT') throw new StatementParseError(`invalid CdtDbtInd "${ind}"`, locator);
  const currency = typeof amt === 'object' && amt !== null ? (amt as Node)['@_Ccy'] : undefined;
  return { minor: ind === 'DBIT' ? -minor : minor, currency: currency as string | undefined };
}

function dateOf(node: unknown): string | undefined {
  const d = text(get(node, 'Dt')) ?? text(get(node, 'DtTm'));
  return d ? d.slice(0, 10) : undefined;
}

export function parseCamt053(xml: string): NormalizedStatement {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new StatementParseError('DOCTYPE/ENTITY declarations are not allowed');
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (e) {
    throw new StatementParseError(`not well-formed XML: ${(e as Error).message}`);
  }
  const stmts = get(doc, 'Document', 'BkToCstmrStmt', 'Stmt');
  const stmtList = Array.isArray(stmts) ? (stmts as Node[]) : [];
  if (!stmtList.length) throw new StatementParseError('no BkToCstmrStmt/Stmt element (is this camt.053?)');
  if (stmtList.length > 1) throw new StatementParseError('multiple statements per file are not supported; split the file');
  const stmt = stmtList[0]!;
  const acct = stmt.Acct as Node | undefined;
  const accountId = text(get(acct, 'Id', 'IBAN')) ?? text(get(acct, 'Id', 'Othr', 'Id')) ?? '';
  if (!accountId) throw new StatementParseError('missing Acct/Id');
  let currency = text(get(acct, 'Ccy')) ?? '';
  const warnings: string[] = [];

  let opening: number | null = null;
  let closing: number | null = null;
  const bals = (stmt.Bal as Node[] | undefined) ?? [];
  bals.forEach((b, i) => {
    const code = text(get(b, 'Tp', 'CdOrPrtry', 'Cd'));
    const { minor, currency: ccy } = amountOf(b.Amt, b.CdtDbtInd, `Bal[${i}]`);
    if (!currency && ccy) currency = ccy;
    if (code === 'OPBD' || code === 'PRCD') opening = minor;
    if (code === 'CLBD') closing = minor;
  });

  const lines: NormalizedStatementLine[] = [];
  const entries = (stmt.Ntry as Node[] | undefined) ?? [];
  entries.forEach((n, i) => {
    const loc = `Ntry[${i}]`;
    const status = text(get(n, 'Sts', 'Cd')) ?? text(n.Sts);
    if (status && status !== 'BOOK') {
      warnings.push(`${loc}: status ${status} skipped (only booked entries are imported)`);
      return;
    }
    const { minor, currency: ccy } = amountOf(n.Amt, n.CdtDbtInd, loc);
    if (ccy && currency && ccy !== currency) warnings.push(`${loc}: entry currency ${ccy} differs from account currency ${currency}`);
    const booking = dateOf(n.BookgDt);
    if (!booking) throw new StatementParseError('missing BookgDt', loc);
    const tx = get(n, 'NtryDtls', 'TxDtls');
    const ustrd = get(tx, 'RmtInf', 'Ustrd');
    const remittance = Array.isArray(ustrd) ? ustrd.map(text).filter(Boolean).join(' ') : text(ustrd);
    const party = text(get(tx, 'RltdPties', minor < 0 ? 'Cdtr' : 'Dbtr', 'Nm')) ?? text(get(tx, 'RltdPties', minor < 0 ? 'Cdtr' : 'Dbtr', 'Pty', 'Nm')) ?? null;
    const addtl = text(n.AddtlNtryInf);
    const ref = text(get(tx, 'Refs', 'EndToEndId')) ?? text(n.NtryRef) ?? null;
    const svcrRef = text(n.AcctSvcrRef) ?? text(get(tx, 'Refs', 'AcctSvcrRef')) ?? `${booking}-${i}`;
    const domain = text(get(n, 'BkTxCd', 'Domn', 'Cd'));
    const family = text(get(n, 'BkTxCd', 'Domn', 'Fmly', 'Cd'));
    const sub = text(get(n, 'BkTxCd', 'Domn', 'Fmly', 'SubFmlyCd'));
    lines.push({
      bookingDate: booking,
      valueDate: dateOf(n.ValDt) ?? null,
      amount: minor,
      description: [party, remittance, addtl].filter(Boolean).join(' / ') || 'camt.053 entry',
      counterparty: party,
      reference: ref && ref !== 'NOTPROVIDED' ? ref : null,
      bankReference: svcrRef,
      typeCode: [domain, family, sub].filter(Boolean).join('-') || null,
      locator: loc,
    });
  });

  const from = text(get(stmt, 'FrToDt', 'FrDtTm'))?.slice(0, 10);
  const to = text(get(stmt, 'FrToDt', 'ToDtTm'))?.slice(0, 10);
  const dates = lines.map((l) => l.bookingDate).sort();
  return {
    format: 'camt053',
    accountId,
    currency: currency || 'EUR',
    periodStart: from ?? dates[0] ?? '',
    periodEnd: to ?? dates[dates.length - 1] ?? '',
    statementDate: text(stmt.CreDtTm)?.slice(0, 10) ?? to ?? '',
    openingBalance: opening,
    closingBalance: closing,
    lines,
    warnings,
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dec = (minor: number) => (Math.abs(minor) / 100).toFixed(2);

/** Writer used by the seed generator and tests. */
export function writeCamt053(opts: {
  messageId: string;
  createdAt: string;
  iban: string;
  currency: string;
  from: string;
  to: string;
  opening: number;
  closing: number;
  entries: Array<{ amount: number; bookingDate: string; valueDate: string; ref: string; svcrRef: string; party: string; remittance: string; family: string; sub: string }>;
}): string {
  const bal = (code: string, amount: number, date: string) =>
    `      <Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${opts.currency}">${dec(amount)}</Amt><CdtDbtInd>${amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
  const entries = opts.entries
    .map((e) => {
      const role = e.amount < 0 ? 'Cdtr' : 'Dbtr';
      return `      <Ntry>
        <Amt Ccy="${opts.currency}">${dec(e.amount)}</Amt>
        <CdtDbtInd>${e.amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd>
        <Sts><Cd>BOOK</Cd></Sts>
        <BookgDt><Dt>${e.bookingDate}</Dt></BookgDt>
        <ValDt><Dt>${e.valueDate}</Dt></ValDt>
        <AcctSvcrRef>${esc(e.svcrRef)}</AcctSvcrRef>
        <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>${e.family}</Cd><SubFmlyCd>${e.sub}</SubFmlyCd></Fmly></Domn></BkTxCd>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>${esc(e.ref)}</EndToEndId></Refs>
          <RltdPties><${role}><Nm>${esc(e.party)}</Nm></${role}></RltdPties>
          <RmtInf><Ustrd>${esc(e.remittance)}</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>${esc(opts.messageId)}</MsgId><CreDtTm>${opts.createdAt}</CreDtTm></GrpHdr>
    <Stmt>
      <Id>${esc(opts.messageId)}-1</Id>
      <CreDtTm>${opts.createdAt}</CreDtTm>
      <FrToDt><FrDtTm>${opts.from}T00:00:00</FrDtTm><ToDtTm>${opts.to}T23:59:59</ToDtTm></FrToDt>
      <Acct><Id><IBAN>${esc(opts.iban)}</IBAN></Id><Ccy>${opts.currency}</Ccy></Acct>
${bal('OPBD', opts.opening, opts.from)}
${bal('CLBD', opts.closing, opts.to)}
${entries}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;
}
