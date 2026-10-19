import { describe, expect, it } from 'vitest';
import { ADAPTERS, adapter } from '../../src/integrations/adapters';
import { parseBai2, writeBai2 } from '../../src/integrations/bai2';
import { parseCamt053, writeCamt053 } from '../../src/integrations/camt053';
import { parseAmountMinor, parseCsv, parseDate, toCsv } from '../../src/integrations/csv';
import { parseOfx } from '../../src/integrations/ofx';

describe('bank statement formats', () => {
  it('BAI2: round-trips balances and signed transactions', () => {
    const file = writeBai2({
      senderId: '021000021',
      receiverId: 'BRAMBLEWOOD',
      fileDate: '2026-09-30',
      accountNumber: '000004417',
      currency: 'USD',
      openingMinor: 1_000_000,
      closingMinor: 1_000_000 + 250_000 - 4_500,
      transactions: [
        { date: '2026-09-15', amountMinor: 250_000, typeCode: '195', bankRef: 'BR1', customerRef: 'INV-77', text: 'ACH CREDIT ALDERGROVE' },
        { date: '2026-09-30', amountMinor: -4_500, typeCode: '698', bankRef: 'BR2', customerRef: null, text: 'SERVICE CHARGE' },
      ],
    });
    const s = parseBai2(file);
    expect(s).toMatchObject({ format: 'bai2', accountNumber: '000004417', currency: 'USD', openingBalanceMinor: 1_000_000, closingBalanceMinor: 1_245_500 });
    expect(s.transactions.map((t) => [t.bookingDate, t.amountMinor, t.description])).toEqual([
      ['2026-09-15', 250_000, 'ACH CREDIT ALDERGROVE'],
      ['2026-09-30', -4_500, 'SERVICE CHARGE'],
    ]);
    expect(s.warnings).toEqual([]);
    expect(s.openingBalanceMinor + s.transactions.reduce((a, t) => a + t.amountMinor, 0)).toBe(s.closingBalanceMinor);
  });

  it('BAI2: reports structural problems as warnings with line numbers instead of guessing', () => {
    const s = parseBai2('01,A,B,260930,0600,1,80,,2/\n02,B,A,1,260930,2400,USD,2/\n03,000004417,USD,010,100000,,,015,100000,,/\n49,200000,2/\n98,200000,1,4/\n99,200000,1,6/');
    expect(s.warnings.length).toBeGreaterThan(0);
  });

  it('ISO 20022 camt.053: round-trips entries, signs and counterparties', () => {
    const xml = writeCamt053({
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
        { ref: 'E2', bookingDate: '2026-09-20', amountMinor: 30_000, info: 'Invoice 5521 & co <ok>', counterparty: 'Northgate Labs', endToEnd: null, subFamily: 'RCDT' },
      ],
    });
    const s = parseCamt053(xml);
    expect(s).toMatchObject({ format: 'camt053', currency: 'GBP', openingBalanceMinor: 500_000, closingBalanceMinor: 410_000 });
    expect(s.transactions.map((t) => [t.amountMinor, t.counterparty])).toEqual([
      [-120_000, 'Canal Wharf Estates'],
      [30_000, 'Northgate Labs'],
    ]);
    expect(s.transactions[1]!.description).toContain('Invoice 5521 & co <ok>');
  });

  it('OFX: parses SGML-style statements', () => {
    const s = parseOfx(adapter('bank:ofx').sample());
    expect(s).toMatchObject({ format: 'ofx', currency: 'USD', closingBalanceMinor: 27_500 });
    expect(s.transactions).toHaveLength(1);
    expect(s.transactions[0]).toMatchObject({ amountMinor: 27_500, bookingDate: '2026-10-01' });
  });

  it('every connector ships a sample that its own parser accepts', () => {
    for (const a of ADAPTERS) expect(() => a.parse(a.sample()), a.id).not.toThrow();
  });
});

describe('CSV and field parsing', () => {
  it('handles quotes, embedded commas, escaped quotes and newlines', () => {
    const rows = parseCsv('date,merchant,amount\r\n2026-09-03,"Tessera Cloud Storage, Inc.",1240.50\n2026-09-04,"The ""Atrium"" Event Spaces","line1\nline2"\n');
    expect(rows).toEqual([
      ['date', 'merchant', 'amount'],
      ['2026-09-03', 'Tessera Cloud Storage, Inc.', '1240.50'],
      ['2026-09-04', 'The "Atrium" Event Spaces', 'line1\nline2'],
    ]);
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('parses accounting amounts into integer minor units', () => {
    expect(parseAmountMinor('1,234.56')).toBe(123_456);
    expect(parseAmountMinor('(1,234.56)')).toBe(-123_456);
    expect(parseAmountMinor('$12')).toBe(1_200);
    expect(parseAmountMinor('-0.5')).toBe(-50);
    expect(() => parseAmountMinor('12.345')).toThrow();
    expect(() => parseAmountMinor('abc')).toThrow();
  });
  it('parses US, UK and ISO dates', () => {
    expect(parseDate('09/30/2026')).toBe('2026-09-30');
    expect(parseDate('30/09/2026', 'uk')).toBe('2026-09-30');
    expect(parseDate('20260930')).toBe('2026-09-30');
    expect(() => parseDate('Sept 30')).toThrow();
  });
});
