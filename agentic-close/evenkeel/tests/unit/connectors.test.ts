import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv, parseCsvRecords, toCsv } from '../../src/framework/connectors/csv';
import { parseXml, textAt, XmlError } from '../../src/framework/connectors/xml';
import { BankFormatError, detectBankFormat, parseBai2, parseBankCsv, parseCamt053, parseOfx, writeBai2, writeCamt053, writeOfx } from '../../src/packs/accounting/connectors/bank-formats';
import { parseBillsCsv, parseCardCsv, parseErpGlJson, parsePayrollCsv, writeBillsCsv, writeCardCsv, writePayrollCsv } from '../../src/packs/accounting/connectors/records';

describe('CSV', () => {
  it('handles quotes, embedded commas, escaped quotes, CRLF and a BOM', () => {
    const recs = parseCsvRecords('﻿a,b,c\r\n1,"two, 2","say ""hi"""\r\n');
    expect(recs.map((r) => r.fields)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'two, 2', 'say "hi"'],
    ]);
  });
  it('maps rows by header, requires columns and round-trips', () => {
    const csv = toCsv(['date', 'description', 'amount'], [['2026-09-01', 'Coffee, "large"', '4.50']]);
    const t = parseCsv(csv, { required: ['date', 'amount'] });
    expect(t.rows[0]).toEqual({ date: '2026-09-01', description: 'Coffee, "large"', amount: '4.50' });
    expect(() => parseCsv('x,y\n1,2', { required: ['amount'] })).toThrow(CsvError);
  });
  it('rejects unterminated quotes', () => {
    expect(() => parseCsvRecords('a,b\n"open,1\n')).toThrow(CsvError);
  });
});

describe('XML', () => {
  it('parses namespaces, attributes and entities, and refuses DTDs', () => {
    const doc = parseXml('<?xml version="1.0"?><d:Doc xmlns:d="urn:x"><A k="v">x &amp; y</A></d:Doc>');
    expect(doc.local).toBe('Doc');
    expect(textAt(doc, 'A')).toBe('x & y');
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')).toThrow(XmlError);
  });
});

describe('bank statement formats', () => {
  const lines = [
    { date: '2026-09-02', amount: 1_716_000, typeCode: '165', bankRef: 'B1', customerRef: 'INV-0547', text: 'ACH CREDIT BLUEFIN LOGISTICS' },
    { date: '2026-09-03', amount: -321_500, typeCode: '475', bankRef: 'B2', customerRef: '10455', text: 'CHECK PAID 10455' },
  ];

  it('round-trips BAI2 with balances, signs and references', () => {
    const text = writeBai2({ sender: 'FMB', receiver: 'KITEWELL', created: '2026-10-01', accountNumber: '4821', currency: 'USD', asOf: '2026-09-30', opening: 100_000_00, closing: 113_945_00, lines });
    expect(detectBankFormat(text)).toBe('BAI2');
    const [st] = parseBai2(text);
    expect(st!.accountNumber).toBe('4821');
    expect(st!.openingBalance).toBe(100_000_00);
    expect(st!.closingBalance).toBe(113_945_00);
    expect(st!.lines.map((l) => [l.postedDate, l.amount, l.reference])).toEqual([
      ['2026-09-02', 1_716_000, 'INV-0547'],
      ['2026-09-03', -321_500, '10455'],
    ]);
  });

  it('detects a broken BAI2 control total', () => {
    const text = writeBai2({ sender: 'FMB', receiver: 'K', created: '2026-10-01', accountNumber: '1', currency: 'USD', asOf: '2026-09-30', opening: 0, closing: 0, lines }).replace(/^49,\d+/m, '49,1');
    const r = (() => {
      try {
        return parseBai2(text)[0]!.warnings;
      } catch (e) {
        return e instanceof BankFormatError ? ['error'] : [];
      }
    })();
    expect(r.length).toBeGreaterThan(0);
  });

  it('round-trips ISO 20022 camt.053', () => {
    const xml = writeCamt053({ msgId: 'M1', created: '2026-10-01', iban: 'GB00HRBL00000000001050', currency: 'GBP', from: '2026-09-01', to: '2026-09-30', opening: 50_000_00, closing: 48_000_00, entries: [{ date: '2026-09-10', amount: -2_000_00, ref: 'E2E-1', svcrRef: 'S1', party: 'Northbank Office <Ltd>', remittance: 'Rent & rates', code: 'PMNT' }] });
    expect(detectBankFormat(xml)).toBe('CAMT053');
    const [st] = parseCamt053(xml);
    expect(st!.currency).toBe('GBP');
    expect(st!.openingBalance).toBe(50_000_00);
    expect(st!.closingBalance).toBe(48_000_00);
    expect(st!.lines[0]).toMatchObject({ postedDate: '2026-09-10', amount: -2_000_00, counterparty: 'Northbank Office <Ltd>' });
  });

  it('round-trips OFX (SGML)', () => {
    const ofx = writeOfx({ bankId: '121000358', accountId: '7730', currency: 'USD', from: '2026-09-01', to: '2026-09-30', closing: 0, txns: [{ date: '2026-09-15', amount: -10_000_000, fitid: 'F1', name: 'PAYWELL PAYROLL', memo: 'Net pay', type: 'DEBIT' }] });
    expect(detectBankFormat(ofx)).toBe('OFX');
    const [st] = parseOfx(ofx);
    expect(st!.accountNumber).toBe('7730');
    expect(st!.lines[0]).toMatchObject({ postedDate: '2026-09-15', amount: -10_000_000, externalId: 'F1' });
  });

  it('parses a simple bank CSV', () => {
    const [st] = parseBankCsv('date,description,amount,reference\n2026-09-01,Fee,-12.50,F1\n2026-09-02,Interest,3.10,\n', '9', 'USD');
    expect(detectBankFormat('date,description,amount\n')).toBe('CSV');
    expect(st!.lines.map((l) => l.amount)).toEqual([-1250, 310]);
    expect(st!.statementStart).toBe('2026-09-01');
  });
});

describe('source-system records', () => {
  it('round-trips card, bill and payroll files', () => {
    const card = { externalId: 'C1', cardLast4: '4242', cardholder: 'Sam Rivera', cardholderEmail: 'sam@kitewell.example', cardholderDepartment: 'Finance', merchant: 'Orbitline Supplies', mcc: '5999', amount: 120_000, currency: 'USD', txnDate: '2026-09-21', postedDate: '2026-09-22', memo: 'Misc, "supplies"', receipt: true, suggestedAccount: null };
    expect(parseCardCsv(writeCardCsv([card]))[0]).toMatchObject({ ...card, sourceLine: 'line 2' });
    const bill = { billNumber: 'HU-2226', vendor: 'Helio Utilities', billDate: '2026-10-01', dueDate: '2026-10-31', amount: 636_080, currency: 'USD', serviceStart: '2026-09-16', serviceEnd: '2026-10-15', poNumber: null, accountCode: '6800', department: 'G&A', memo: 'Electricity' };
    expect(parseBillsCsv(writeBillsCsv([bill]))[0]).toEqual({ ...bill, sourceLine: 'line 2' });
    const run = { payDate: '2026-09-18', periodStart: '2026-09-01', periodEnd: '2026-09-15', department: 'ENG', headcount: 12, grossWages: 100_000, employerTaxes: 7_650, benefits: 1_000, withholdings: 25_000, netPay: 75_000 };
    expect(parsePayrollCsv(writePayrollCsv([run]))[0]).toEqual({ ...run, sourceLine: 'line 2' });
    expect(() => parsePayrollCsv(writePayrollCsv([{ ...run, netPay: 1 }]))).toThrow(/net pay must equal/);
  });
  it('validates the legacy ERP export against its schema', () => {
    expect(() => parseErpGlJson('{"not":"an export"}')).toThrow();
  });
});
