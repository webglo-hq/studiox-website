import { describe, expect, it } from 'vitest';
import { ADAPTERS, detectAdapter } from '../adapters';
import { parseBai2, writeBai2 } from './bai2';
import { parseCamt053, writeCamt053 } from './camt053';
import { parseCsv, parseCsvRecords, toCsv } from './csv';
import { parseOfx, writeOfx } from './ofx';
import { statementControlCheck } from './statement';

describe('CSV', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
    const rows = parseCsv('﻿a,b,c\r\n1,"two, ""2""",3\r\n4,"multi\nline",6\n');
    expect(rows).toEqual([
      { line: 1, values: ['a', 'b', 'c'] },
      { line: 2, values: ['1', 'two, "2"', '3'] },
      { line: 3, values: ['4', 'multi\nline', '6'] },
    ]);
  });

  it('maps headers and rejects ragged rows', () => {
    expect(parseCsvRecords('Transaction ID,Amount\nT1,10.00\n')[0]).toEqual({ line: 2, record: { transaction_id: 'T1', amount: '10.00' } });
    expect(() => parseCsvRecords('a,b\n1\n')).toThrow(/line 2/);
    expect(() => parseCsv('a,"b\n')).toThrow(/unterminated/);
  });

  it('round-trips through toCsv', () => {
    const data = [['x', 'y, z'], ['he said "hi"', 3]];
    expect(parseCsv(toCsv(data)).map((r) => r.values)).toEqual([['x', 'y, z'], ['he said "hi"', '3']]);
  });
});

describe('BAI2', () => {
  const file = writeBai2({
    sender: '121000358',
    receiver: 'BRAMBLEWAY',
    fileId: '20260930',
    createdAt: '2026-10-01',
    accountNumber: '000004417',
    currency: 'USD',
    days: [
      {
        date: '2026-09-29',
        opening: 240_000_000,
        closing: 236_816_000,
        lines: [
          { typeCode: '455', amount: 3_184_000, bankRef: 'BR1001', customerRef: 'NC-2026-08', text: 'ACH DEBIT NIMBUS CLOUD SVCS INVOICE NC-2026-08 AUGUST HOSTING USAGE' },
        ],
      },
      {
        date: '2026-09-30',
        opening: 236_816_000,
        closing: 238_026_000,
        lines: [{ typeCode: '195', amount: 1_210_000, bankRef: 'BR1002', customerRef: 'INV-31544', text: 'INCOMING WIRE ORCHARD ANALYTICS' }],
      },
    ],
  });

  it('parses records, continuations, signs and balances; verifies trailers', () => {
    const s = parseBai2(file);
    expect(s.accountId).toBe('000004417');
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]).toMatchObject({ bookingDate: '2026-09-29', amount: -3_184_000, typeCode: '455', bankReference: 'BR1001', reference: 'NC-2026-08' });
    expect(s.lines[0]!.description).toBe('ACH DEBIT NIMBUS CLOUD SVCS INVOICE NC-2026-08 AUGUST HOSTING USAGE');
    expect(s.lines[1]!.amount).toBe(1_210_000);
    expect(s.openingBalance).toBe(240_000_000);
    expect(s.closingBalance).toBe(238_026_000);
    expect(statementControlCheck(s)).toBeNull();
  });

  it('detects tampered amounts via the 49 control total', () => {
    expect(() => parseBai2(file.replace('16,455,3184000', '16,455,3184900'))).toThrow(/control total/);
  });

  it('requires a file header and trailer', () => {
    expect(() => parseBai2('16,455,100,Z,a,b,x/')).toThrow(/01 file header/);
    expect(() => parseBai2(file.replace(/^99,.*$/m, ''))).toThrow(/99 file trailer/);
  });
});

describe('CAMT.053', () => {
  const xml = writeCamt053({
    messageId: 'BWUK-2026-09',
    createdAt: '2026-10-01T06:00:00',
    iban: 'GB29NWBK60161331926819',
    currency: 'GBP',
    from: '2026-09-01',
    to: '2026-09-30',
    opening: 41_200_000,
    closing: 40_861_250,
    entries: [
      { amount: -338_750, bookingDate: '2026-09-03', valueDate: '2026-09-03', ref: 'E2E-1', svcrRef: 'NWB-77810', party: 'Tessellate Studio Ltd', remittance: 'INV TS-4410 & design retainer', family: 'ICDT', sub: 'ESCT' },
    ],
  });

  it('parses balances, booked entries, parties and remittance information', () => {
    const s = parseCamt053(xml);
    expect(s).toMatchObject({ format: 'camt053', accountId: 'GB29NWBK60161331926819', currency: 'GBP', periodStart: '2026-09-01', periodEnd: '2026-09-30', openingBalance: 41_200_000, closingBalance: 40_861_250 });
    expect(s.lines[0]).toMatchObject({ amount: -338_750, counterparty: 'Tessellate Studio Ltd', bankReference: 'NWB-77810', reference: 'E2E-1', typeCode: 'PMNT-ICDT-ESCT' });
    expect(s.lines[0]!.description).toContain('INV TS-4410 & design retainer');
    expect(statementControlCheck(s)).toBeNull();
  });

  it('rejects DOCTYPE/ENTITY (XXE) and non-camt documents', () => {
    expect(() => parseCamt053('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><Document>&e;</Document>')).toThrow(/DOCTYPE/);
    expect(() => parseCamt053('<Document><Other/></Document>')).toThrow(/camt.053/);
  });
});

describe('OFX', () => {
  const ofx = writeOfx({
    accountId: '000009921',
    routing: '121000358',
    currency: 'USD',
    start: '2026-09-01',
    end: '2026-09-30',
    closing: 5_000_000,
    transactions: [
      { type: 'DEBIT', date: '2026-09-15', amount: -2_000_000, fitid: 'F1', name: 'GUSTO NET PAY', memo: 'Payroll 09/15' },
      { type: 'CREDIT', date: '2026-09-14', amount: 2_000_000, fitid: 'F2', name: 'TRANSFER FROM OPERATING' },
      { type: 'CHECK', date: '2026-09-20', amount: -45_000, fitid: 'F3', name: 'CHECK', check: '1077' },
    ],
  });

  it('parses SGML OFX statements', () => {
    const s = parseOfx(ofx);
    expect(s.accountId).toBe('000009921');
    expect(s.lines.map((l) => [l.bankReference, l.amount])).toEqual([
      ['F1', -2_000_000],
      ['F2', 2_000_000],
      ['F3', -45_000],
    ]);
    expect(s.lines[2]!.reference).toBe('1077');
    expect(s.closingBalance).toBe(5_000_000);
    expect(s.openingBalance).toBe(5_045_000);
  });
});

describe('adapter registry', () => {
  it('detects formats from content', () => {
    expect(detectAdapter('x.bai', '01,121000358,X,260930,0600,1,,,2/')?.key).toBe('bank-bai2');
    expect(detectAdapter('x.xml', '<Document><BkToCstmrStmt>')?.key).toBe('bank-camt053');
    expect(detectAdapter('x.ofx', 'OFXHEADER:100')?.key).toBe('bank-ofx');
    expect(detectAdapter('cards.csv', 'transaction_id,card_last4,amount')?.key).toBe('card-csv');
    expect(detectAdapter('gl.csv', 'journal_id,entity,date')?.key).toBe('erp-gl-csv');
    expect(ADAPTERS.map((a) => a.kind)).toEqual(expect.arrayContaining(['bank_feed', 'card_feed', 'erp_gl', 'payroll', 'ap']));
  });

  it('parses card and ERP exports with locators for provenance', () => {
    const card = ADAPTERS.find((a) => a.key === 'card-csv')!.parse('transaction_id,card_last4,transaction_date,posted_date,merchant,mcc,amount,currency,memo\nC1,4242,2026-09-02,2026-09-03,FIGMA INC,5734,45.00,USD,\n');
    expect(card).toMatchObject({ kind: 'card_feed', lines: [{ externalId: 'C1', amount: 4_500, locator: 'row 2' }] });
    const erp = ADAPTERS.find((a) => a.key === 'erp-gl-csv')!.parse('journal_id,entity,date,type,description,account,debit,credit,department,memo,created_by,approved_by\nJ-9,BW-US,2026-09-27,standard,Rev adj,1100,25000.00,,,,jlarsen,jlarsen\nJ-9,BW-US,2026-09-27,standard,Rev adj,4000,,25000.00,,,jlarsen,jlarsen\n');
    expect(erp).toMatchObject({ kind: 'erp_gl', journals: [{ externalRef: 'J-9', preparedBy: 'jlarsen', approvedBy: 'jlarsen', lines: [{ debit: 2_500_000 }, { credit: 2_500_000 }] }] });
  });
});
