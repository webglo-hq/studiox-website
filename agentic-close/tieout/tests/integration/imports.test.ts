/**
 * Imports through the application fail closed (independent review, 2026-10-19): a statement is
 * booked only to the bank account it names and its connector feeds, and a file with a bad line or
 * a record the importer cannot place imports nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { adapter } from '../../src/integrations/adapters';
import { writeCamt053 } from '../../src/integrations/camt053';
import { testApp, type HttpClient, type TestApp } from '../support/app';

let t: TestApp;
let jordan: HttpClient;
const count = (table: 'bank_transactions' | 'card_transactions' | 'source_documents') => t.fx.db.tx(t.fx.tenantId, (tx) => tx.count(table, {}));
const upload = (connectorKey: string, filename: string, content: string) => jordan.post<{ created: number; error?: { message: string; details: { problems?: { line: number | null; message: string }[] } } }>('/api/imports', { connectorKey, filename, content });

beforeAll(async () => {
  t = await testApp();
  jordan = t.client();
  expect((await jordan.login('jordan')).status).toBe(200);
}, 120_000);

const statement = (iban: string, currency = 'GBP') =>
  writeCamt053({ messageId: `MSG-${iban.slice(-4)}-${currency}`, createdAt: '2026-10-02T06:05:00Z', iban, currency, from: '2026-10-01', to: '2026-10-01', openingMinor: 100_000, closingMinor: 100_000 - 48_000, entries: [{ ref: `REF-${iban.slice(-4)}-${currency}`, bookingDate: '2026-10-01', amountMinor: -48_000, info: 'Courier services September', counterparty: 'Swiftline Couriers', endToEnd: null, subFamily: 'DMCT' }] });

describe('imports fail closed', () => {
  it('TO-M5: a statement for an account the connector does not feed is refused, not booked to the first bank account', async () => {
    const before = await count('bank_transactions');
    const unknown = await upload('thameside-camt053', 'unknown.xml', statement('GB11THMS20150900009999'));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error!.message).toMatch(/^Nothing was imported: the statement is for account …9999, which is not one of this connector's bank accounts/);
    // the US operating account is real, but not the account this UK connector feeds
    const otherEntity = await upload('thameside-camt053', 'us.xml', statement('US00FHBK000123454417', 'USD'));
    expect(otherEntity.status).toBe(400);
    const wrongCurrency = await upload('thameside-camt053', 'eur.xml', statement('GB29THMS20150912342208', 'EUR'));
    expect(wrongCurrency.status).toBe(400);
    expect(wrongCurrency.body.error!.message).toContain('the statement is in EUR; account …2208 is in GBP');
    expect(await count('bank_transactions')).toBe(before);
    // the statement for the right account goes in
    expect((await upload('thameside-camt053', 'ok.xml', statement('GB29THMS20150912342208'))).body.created).toBe(1);
  });

  it('TO-M5: a file with one unreadable line, or one record that has no home, imports nothing', async () => {
    const bank = await count('bank_transactions');
    const cards = await count('card_transactions');
    const docs = await count('source_documents');
    const badLine = await upload('generic-bank-csv', 'bad.csv', 'account,date,description,amount,reference,bank_ref\n4417,2026-10-01,ACH CREDIT,275.00,INV-1,FH-OK-1\n4417,2026-10-01,ACH CREDIT,12-34,INV-2,FH-OK-2');
    expect(badLine.status).toBe(400);
    expect(badLine.body.error!.details.problems).toEqual([{ line: 3, message: 'invalid amount "12-34"' }]);
    const sample = adapter('card:csv').sample();
    const unknownCard = await upload('keystone-card-csv', 'cards.csv', `${sample}\nKCU-20261001-551299,9999,2026-10-01,2026-10-02,Stray Cafe,5812,12.00,USD,`);
    expect(unknownCard.status).toBe(400);
    expect(unknownCard.body.error!.message).toContain('line 4: no card ending 9999');
    expect([await count('bank_transactions'), await count('card_transactions'), await count('source_documents')]).toEqual([bank, cards, docs]);
  });
});
