/**
 * Bank and feed parsers fail closed (independent review, 2026-10-19): a sign, amount or date that
 * cannot be read, balances that do not tie, or a malformed record rejects the file — nothing is
 * guessed and no line is silently dropped — and multi-statement files are read in full.
 */
import { describe, expect, it } from 'vitest';
import { adapter } from '../../src/integrations/adapters';
import { parseBai2Statements, writeBai2 } from '../../src/integrations/bai2';
import { parseCamt053Statements, writeCamt053, type CamtWriteInput } from '../../src/integrations/camt053';
import { parseAmountMinor, parseDate } from '../../src/integrations/csv';
import { parseOfxStatements } from '../../src/integrations/ofx';
import { ImportRejected } from '../../src/integrations/types';

const camt: CamtWriteInput = {
  messageId: 'MSG-1',
  createdAt: '2026-09-30T18:00:00Z',
  iban: 'GB29THMS20150912342208',
  currency: 'GBP',
  from: '2026-09-01',
  to: '2026-09-30',
  openingMinor: 500_000,
  closingMinor: 500_000 - 120_000 + 30_000,
  entries: [
    { ref: 'E1', bookingDate: '2026-09-05', amountMinor: -120_000, info: 'Rent September', counterparty: 'Canal Wharf Estates', endToEnd: 'E2E-1', subFamily: 'DMCT' },
    { ref: 'E2', bookingDate: '2026-09-20', amountMinor: 30_000, info: 'Invoice 5521', counterparty: 'Northgate Labs', endToEnd: null, subFamily: 'RCDT' },
  ],
};
const bai2 = (closingMinor = 1_245_500) =>
  writeBai2({ senderId: '021000021', receiverId: 'BRAMBLEWOOD', fileDate: '2026-09-30', accountNumber: '000004417', currency: 'USD', openingMinor: 1_000_000, closingMinor, transactions: [{ date: '2026-09-15', amountMinor: 250_000, typeCode: '195', bankRef: 'BR1', customerRef: 'INV-77', text: 'ACH CREDIT ALDERGROVE' }, { date: '2026-09-30', amountMinor: -4_500, typeCode: '698', bankRef: 'BR2', customerRef: null, text: 'SERVICE CHARGE' }] });

describe('bank statements fail closed', () => {
  it('TO-M5: camt.053 never reads a missing or invalid credit/debit indicator as a credit', () => {
    const xml = writeCamt053(camt);
    const rent = /<CdtDbtInd>DBIT<\/CdtDbtInd><Sts>/;
    expect(() => parseCamt053Statements(xml.replace(rent, '<Sts>'))).toThrow(/line 1: the entry has no credit\/debit indicator/);
    expect(() => parseCamt053Statements(xml.replace(rent, '<CdtDbtInd>DEBIT</CdtDbtInd><Sts>'))).toThrow(/line 1: the entry has an invalid credit\/debit indicator "DEBIT"/);
    expect(() => parseCamt053Statements(xml.replace(/<CdtDbtInd>CRDT<\/CdtDbtInd><Dt>/, '<Dt>'))).toThrow(/OPBD balance has no credit\/debit indicator/);
  });

  it('TO-M5: camt.053 reads every statement in a message, each with its own account', () => {
    const one = writeCamt053(camt);
    const other = writeCamt053({ ...camt, messageId: 'MSG-2', iban: 'GB11THMS20150900007777', openingMinor: 0, closingMinor: 9_900, entries: [{ ref: 'X1', bookingDate: '2026-09-10', amountMinor: 9_900, info: 'Interest', counterparty: null, endToEnd: null, subFamily: 'INTR' }] });
    const stmt = (x: string) => /<Stmt>[\s\S]*<\/Stmt>/.exec(x)![0];
    const both = one.replace(stmt(one), `${stmt(one)}\n${stmt(other)}`);
    const read = parseCamt053Statements(both);
    expect(read.map((s) => [s.accountNumber, s.transactions.length, s.closingBalanceMinor])).toEqual([
      ['GB29THMS20150912342208', 2, 410_000],
      ['GB11THMS20150900007777', 1, 9_900],
    ]);
  });

  it('TO-M5: a statement whose entries do not take the opening balance to the closing balance is refused', () => {
    expect(() => parseCamt053Statements(writeCamt053({ ...camt, closingMinor: 411_000 }))).toThrow(/opening balance 500000 \+ entries -90000 does not equal the closing balance 411000/);
    expect(() => parseBai2Statements(bai2(1_245_400))).toThrow(/opening balance 1000000 \+ transactions 245500 does not equal the closing balance 1245400/);
  });

  it('TO-M5: a line with an unreadable amount or date rejects the file instead of being dropped', () => {
    const xml = writeCamt053(camt);
    expect(() => parseCamt053Statements(xml.replace('<Amt Ccy="GBP">1200.00</Amt>', '<Amt Ccy="GBP">12-34</Amt>'))).toThrow(ImportRejected);
    expect(() => parseCamt053Statements(xml.replace('<BookgDt><Dt>2026-09-05</Dt>', '<BookgDt><Dt>2026-13-45</Dt>'))).toThrow(/line 1: invalid date "2026-13-45"/);
    expect(() => parseBai2Statements(bai2().replace('16,195,250000,', '16,195,25O000,'))).toThrow(/invalid amount "25O000"/);
    expect(() => parseBai2Statements(bai2().replace('16,698,', '16,798,'))).toThrow(/type code 798 is not a credit or debit transaction code/);
    const ofx = adapter('bank:ofx').sample();
    expect(() => parseOfxStatements(ofx.replace('<TRNAMT>275.00', '<TRNAMT>--5'))).toThrow(/line 1: invalid amount "--5"/);
    expect(() => parseOfxStatements(ofx.replace('<DTPOSTED>20261001', '<DTPOSTED>20261345'))).toThrow(/invalid date/);
    const csv = adapter('bank:csv');
    expect(() => csv.parse('account,date,description,amount,reference,bank_ref\n4417,2026-10-01,ACH CREDIT,12-34,INV-1,FH-1\n4417,2026-10-01,ACH CREDIT,275.00,INV-2,FH-2')).toThrow(/line 2: invalid amount "12-34"/);
    expect(() => adapter('card:csv').parse('transaction_id,card_last4,transaction_date,post_date,merchant,mcc,amount,currency,memo\nK-1,4471,13/45/2026,,Tessera,4816,214.90,USD,')).toThrow(/invalid date "13\/45\/2026"/);
  });

  it('TO-M5: a BAI2 file with two accounts gives two statements, never one merged account', () => {
    const a = bai2();
    const b = writeBai2({ senderId: '021000021', receiverId: 'BRAMBLEWOOD', fileDate: '2026-09-30', accountNumber: '000009999', currency: 'USD', openingMinor: 5_000, closingMinor: 4_000, transactions: [{ date: '2026-09-12', amountMinor: -1_000, typeCode: '475', bankRef: 'CK1', customerRef: '1001', text: 'CHECK 1001' }] });
    const accountOf = (f: string) => f.split('\n').filter((l) => /^(03|16|88|49),/.test(l));
    const merged = [...a.split('\n').filter((l) => /^(01|02),/.test(l)), ...accountOf(a), ...accountOf(b), '98,0,2,0/', '99,0,1,0/'].join('\n');
    const read = parseBai2Statements(merged);
    expect(read.map((s) => [s.accountNumber, s.transactions.map((t) => t.amountMinor), s.openingBalanceMinor, s.closingBalanceMinor])).toEqual([
      ['000004417', [250_000, -4_500], 1_000_000, 1_245_500],
      ['000009999', [-1_000], 5_000, 4_000],
    ]);
  });

  it('TO-M5: an OFX file full of unclosed tags is refused quickly (no quadratic scan)', () => {
    const hostile = `OFXHEADER:100\n<OFX><STMTRS><CURDEF>USD<BANKACCTFROM><ACCTID>4417</BANKACCTFROM>${'<STMTTRN><TRNAMT>1.00'.repeat(32_000)}</STMTRS></OFX>`;
    const t0 = performance.now();
    expect(() => parseOfxStatements(hostile)).toThrow(/<STMTTRN> is not closed/);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('CSV fields are read strictly', () => {
  it('TO-M5: amounts with a stray or doubled minus, or misplaced separators, are refused', () => {
    for (const bad of ['12-34', '--5', '-12-', '(-5)', '1,23', '1.2.3', '12.345', '1e3', '0x10']) expect(() => parseAmountMinor(bad), bad).toThrow(/invalid amount/);
    expect(parseAmountMinor('1,234.56')).toBe(123_456);
    expect(parseAmountMinor('1234.56-')).toBe(-123_456);
    expect(parseAmountMinor('-$5')).toBe(-500);
  });

  it('TO-M5: dates that do not exist are refused, not rearranged into "2026-13-45"', () => {
    for (const bad of ['13/45/2026', '2026-13-45', '2026-02-30', '02/30/2026', '20261345']) expect(() => parseDate(bad), bad).toThrow(/invalid date/);
    expect(parseDate('02/29/2028')).toBe('2028-02-29');
  });
});
