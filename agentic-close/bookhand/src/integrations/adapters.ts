import { parseDecimalToMinor } from '../shared/money';
import { parseBai2 } from './parsers/bai2';
import { parseCamt053 } from './parsers/camt053';
import { CsvError, parseCsvRecords } from './parsers/csv';
import { parseOfx } from './parsers/ofx';
import { type NormalizedStatement, StatementParseError } from './parsers/statement';

/**
 * Connector adapters: one typed contract per source-system kind. Real parsers back the bank formats (BAI2,
 * CAMT.053, OFX, CSV); card, ERP, AP and payroll adapters parse realistic CSV/JSON exports.
 */

export type ConnectorKind = 'bank_feed' | 'erp_gl' | 'card_feed' | 'ap' | 'ar' | 'payroll';
export type ImportFormat = 'csv' | 'bai2' | 'camt053' | 'ofx' | 'json';

export interface CardFeedLine {
  externalId: string;
  cardLast4: string;
  transactionDate: string;
  postedDate: string;
  merchant: string;
  mcc: string | null;
  amount: number;
  currency: string;
  memo: string | null;
  locator: string;
}

export interface ErpJournal {
  externalRef: string;
  entityCode: string;
  date: string;
  type: string;
  description: string;
  preparedBy: string | null;
  approvedBy: string | null;
  lines: Array<{ account: string; debit: number; credit: number; department: string | null; memo: string | null }>;
  locator: string;
}

export interface PayrollRunPayload {
  externalId: string;
  entityCode: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  currency: string;
  headcount: number;
  gross: number;
  employerTaxes: number;
  benefits: number;
  withholdings: number;
  net: number;
  departments: Array<{ code: string; wages: number; employerTaxes: number; benefits: number }>;
  locator: string;
}

export interface ApBillPayload {
  vendorCode: string;
  billNumber: string;
  entityCode: string;
  billDate: string;
  receivedDate: string;
  dueDate: string;
  currency: string;
  description: string;
  serviceStart: string | null;
  serviceEnd: string | null;
  lines: Array<{ account: string; department: string | null; amount: number; description: string }>;
  locator: string;
}

export type ParsedImport =
  | { kind: 'bank_feed'; statement: NormalizedStatement }
  | { kind: 'card_feed'; lines: CardFeedLine[] }
  | { kind: 'erp_gl'; journals: ErpJournal[] }
  | { kind: 'payroll'; provider: string; runs: PayrollRunPayload[] }
  | { kind: 'ap'; bills: ApBillPayload[] };

export interface AdapterDescriptor {
  key: string;
  kind: ConnectorKind;
  label: string;
  format: ImportFormat;
  documentKind: 'bank_statement' | 'card_feed' | 'erp_export' | 'ap_export' | 'payroll_report';
  description: string;
  parse(content: string): ParsedImport;
}

export class ImportParseError extends Error {
  constructor(
    message: string,
    readonly locator?: string,
  ) {
    super(message);
  }
}

function money(v: string | undefined, locator: string): number {
  const m = parseDecimalToMinor(v ?? '');
  if (m === null) throw new ImportParseError(`invalid amount "${v}"`, locator);
  return m;
}

function iso(v: string | undefined, locator: string): string {
  const s = (v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  throw new ImportParseError(`invalid date "${v}"`, locator);
}

function csvSafe<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CsvError) throw new ImportParseError(e.message, `line ${e.line}`);
    if (e instanceof StatementParseError) throw new ImportParseError(e.message, e.locator);
    throw e;
  }
}

function parseBankCsv(content: string): NormalizedStatement {
  const rows = parseCsvRecords(content);
  if (!rows.length) throw new ImportParseError('empty CSV');
  const first = rows[0]!.record;
  const lines = rows.map(({ line, record }) => {
    const loc = `row ${line}`;
    const amount =
      record.amount !== undefined
        ? money(record.amount, loc)
        : (record.credit ? money(record.credit, loc) : 0) - (record.debit ? money(record.debit, loc) : 0);
    return {
      bookingDate: iso(record.date ?? record.booking_date, loc),
      valueDate: record.value_date ? iso(record.value_date, loc) : null,
      amount,
      description: record.description ?? record.memo ?? '',
      counterparty: record.counterparty || null,
      reference: record.reference || record.check_number || null,
      bankReference: record.bank_reference || record.transaction_id || `${record.date}-${line}`,
      typeCode: record.type || null,
      locator: loc,
    };
  });
  const dates = lines.map((l) => l.bookingDate).sort();
  return {
    format: 'csv',
    accountId: first.account ?? first.account_number ?? '',
    currency: first.currency ?? 'USD',
    periodStart: dates[0]!,
    periodEnd: dates[dates.length - 1]!,
    statementDate: dates[dates.length - 1]!,
    openingBalance: first.opening_balance ? money(first.opening_balance, 'row 2') : null,
    closingBalance: first.closing_balance ? money(first.closing_balance, 'row 2') : null,
    lines,
    warnings: [],
  };
}

export const ADAPTERS: AdapterDescriptor[] = [
  {
    key: 'bank-bai2',
    kind: 'bank_feed',
    label: 'Bank statement (BAI2)',
    format: 'bai2',
    documentKind: 'bank_statement',
    description: 'US cash-management BAI2 file from the bank (prior-day or month statement).',
    parse: (c) => csvSafe(() => ({ kind: 'bank_feed', statement: parseBai2(c) })),
  },
  {
    key: 'bank-camt053',
    kind: 'bank_feed',
    label: 'Bank statement (ISO 20022 camt.053)',
    format: 'camt053',
    documentKind: 'bank_statement',
    description: 'ISO 20022 Bank-to-Customer Statement XML (UK and EU banks).',
    parse: (c) => csvSafe(() => ({ kind: 'bank_feed', statement: parseCamt053(c) })),
  },
  {
    key: 'bank-ofx',
    kind: 'bank_feed',
    label: 'Bank statement (OFX)',
    format: 'ofx',
    documentKind: 'bank_statement',
    description: 'Open Financial Exchange 1.x/2.x statement download.',
    parse: (c) => csvSafe(() => ({ kind: 'bank_feed', statement: parseOfx(c) })),
  },
  {
    key: 'bank-csv',
    kind: 'bank_feed',
    label: 'Bank statement (CSV)',
    format: 'csv',
    documentKind: 'bank_statement',
    description: 'Generic CSV: date, description, amount (or debit/credit), reference, bank_reference.',
    parse: (c) => csvSafe(() => ({ kind: 'bank_feed', statement: parseBankCsv(c) })),
  },
  {
    key: 'card-csv',
    kind: 'card_feed',
    label: 'Corporate card feed (CSV)',
    format: 'csv',
    documentKind: 'card_feed',
    description: 'Card program export: transaction_id, card_last4, dates, merchant, mcc, amount, memo.',
    parse: (c) =>
      csvSafe(() => ({
        kind: 'card_feed',
        lines: parseCsvRecords(c).map(({ line, record }) => {
          const loc = `row ${line}`;
          if (!record.transaction_id) throw new ImportParseError('missing transaction_id', loc);
          return {
            externalId: record.transaction_id,
            cardLast4: record.card_last4 ?? '',
            transactionDate: iso(record.transaction_date, loc),
            postedDate: iso(record.posted_date || record.transaction_date, loc),
            merchant: record.merchant ?? '',
            mcc: record.mcc || null,
            amount: money(record.amount, loc),
            currency: record.currency || 'USD',
            memo: record.memo || null,
            locator: loc,
          };
        }),
      })),
  },
  {
    key: 'erp-gl-csv',
    kind: 'erp_gl',
    label: 'ERP journal export (CSV)',
    format: 'csv',
    documentKind: 'erp_export',
    description: 'Journal lines exported from the ERP with created_by/approved_by audit columns.',
    parse: (c) =>
      csvSafe(() => {
        const byRef = new Map<string, ErpJournal>();
        for (const { line, record } of parseCsvRecords(c)) {
          const loc = `row ${line}`;
          const ref = record.journal_id;
          if (!ref) throw new ImportParseError('missing journal_id', loc);
          let j = byRef.get(ref);
          if (!j) {
            j = {
              externalRef: ref,
              entityCode: record.entity ?? '',
              date: iso(record.date, loc),
              type: record.type || 'standard',
              description: record.description ?? '',
              preparedBy: record.created_by || null,
              approvedBy: record.approved_by || null,
              lines: [],
              locator: loc,
            };
            byRef.set(ref, j);
          }
          j.lines.push({ account: record.account ?? '', debit: record.debit ? money(record.debit, loc) : 0, credit: record.credit ? money(record.credit, loc) : 0, department: record.department || null, memo: record.memo || null });
        }
        return { kind: 'erp_gl', journals: Array.from(byRef.values()) };
      }),
  },
  {
    key: 'payroll-json',
    kind: 'payroll',
    label: 'Payroll provider (JSON)',
    format: 'json',
    documentKind: 'payroll_report',
    description: 'Payroll run summaries by department from the payroll provider API.',
    parse(c) {
      let data: { provider?: string; runs?: Array<Record<string, unknown>> };
      try {
        data = JSON.parse(c) as typeof data;
      } catch {
        throw new ImportParseError('payroll payload is not valid JSON');
      }
      if (!Array.isArray(data.runs)) throw new ImportParseError('payroll payload must contain "runs"');
      return {
        kind: 'payroll',
        provider: String(data.provider ?? 'payroll'),
        runs: data.runs.map((r, i) => {
          const loc = `runs[${i}]`;
          const num = (k: string) => {
            const v = r[k];
            if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new ImportParseError(`${k} must be integer minor units`, loc);
            return v;
          };
          return {
            externalId: String(r.id),
            entityCode: String(r.entity),
            periodStart: iso(String(r.periodStart), loc),
            periodEnd: iso(String(r.periodEnd), loc),
            payDate: iso(String(r.payDate), loc),
            currency: String(r.currency ?? 'USD'),
            headcount: num('headcount'),
            gross: num('gross'),
            employerTaxes: num('employerTaxes'),
            benefits: num('benefits'),
            withholdings: num('withholdings'),
            net: num('net'),
            departments: (r.departments as PayrollRunPayload['departments']) ?? [],
            locator: loc,
          };
        }),
      };
    },
  },
  {
    key: 'ap-json',
    kind: 'ap',
    label: 'AP bills (JSON)',
    format: 'json',
    documentKind: 'ap_export',
    description: 'Vendor bills from the AP inbox / OCR service.',
    parse(c) {
      let data: { bills?: ApBillPayload[] };
      try {
        data = JSON.parse(c) as typeof data;
      } catch {
        throw new ImportParseError('AP payload is not valid JSON');
      }
      if (!Array.isArray(data.bills)) throw new ImportParseError('AP payload must contain "bills"');
      return { kind: 'ap', bills: data.bills.map((b, i) => ({ ...b, locator: `bills[${i}]` })) };
    },
  },
];

export function adapter(key: string): AdapterDescriptor {
  const a = ADAPTERS.find((x) => x.key === key);
  if (!a) throw new ImportParseError(`unknown adapter ${key}`);
  return a;
}

/** Guess an adapter from file name and content (used by drag-and-drop upload). */
export function detectAdapter(filename: string, content: string): AdapterDescriptor | undefined {
  const head = content.slice(0, 2000);
  if (/^01,/.test(head.trim())) return adapter('bank-bai2');
  if (/camt\.053|BkToCstmrStmt/.test(head)) return adapter('bank-camt053');
  if (/OFXHEADER|<OFX>/i.test(head)) return adapter('bank-ofx');
  if (/"runs"\s*:/.test(head)) return adapter('payroll-json');
  if (/"bills"\s*:/.test(head)) return adapter('ap-json');
  const firstLine = head.split(/\r?\n/)[0]!.toLowerCase();
  if (firstLine.includes('journal_id')) return adapter('erp-gl-csv');
  if (firstLine.includes('card_last4')) return adapter('card-csv');
  if (filename.toLowerCase().endsWith('.csv')) return adapter('bank-csv');
  return undefined;
}
