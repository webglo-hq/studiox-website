/**
 * Connector adapters: typed parsers for each source-system format. Bank statements are real
 * standard parsers (BAI2, ISO 20022 camt.053, OFX, CSV); card, GL, AP and payroll adapters parse
 * documented CSV/JSON layouts that mirror common exports, with realistic sample payloads.
 */
import { parseBai2 } from './bai2';
import { parseCamt053, writeCamt053 } from './camt053';
import { parseAmountMinor, parseCsvObjects, parseDate } from './csv';
import { parseOfx } from './ofx';
import type { ConnectorFormat, ConnectorKind, ImportError, ParseResult, ParsedBill, ParsedCardTransaction, ParsedGlLine, ParsedPayrollRun } from './types';

export interface ConnectorAdapter {
  id: string;
  kind: ConnectorKind;
  format: ConnectorFormat;
  name: string;
  description: string;
  mime: string;
  fileExtension: string;
  sample(): string;
  parse(content: string): ParseResult;
}

function req(values: Record<string, string>, key: string, line: number): string {
  const v = values[key];
  if (v === undefined || v === '') throw new Error(`line ${line}: missing ${key}`);
  return v;
}

const cardCsv: ConnectorAdapter = {
  id: 'card:csv',
  kind: 'card_feed',
  format: 'csv',
  name: 'Corporate card feed (CSV)',
  description: 'Daily card transaction export: transaction_id, card_last4, transaction_date, post_date, merchant, mcc, amount, currency, memo.',
  mime: 'text/csv',
  fileExtension: '.csv',
  sample: () =>
    [
      'transaction_id,card_last4,transaction_date,post_date,merchant,mcc,amount,currency,memo',
      'KCU-20261001-551203,4471,2026-10-01,2026-10-02,Tessera Cloud Storage,4816,214.90,USD,',
      'KCU-20261001-551204,2290,2026-10-01,2026-10-02,Bistro Nine,5812,186.40,USD,Client dinner – Saltmarsh Ports',
    ].join('\n'),
  parse(content) {
    const { records } = parseCsvObjects(content);
    const warnings: ImportError[] = [];
    const transactions: ParsedCardTransaction[] = [];
    for (const { line, values } of records) {
      try {
        transactions.push({
          externalId: req(values, 'transaction_id', line),
          cardLast4: req(values, 'card_last4', line),
          txnDate: parseDate(req(values, 'transaction_date', line)),
          postDate: parseDate(values.post_date || values.transaction_date || ''),
          merchantName: req(values, 'merchant', line),
          mcc: values.mcc || null,
          amountMinor: parseAmountMinor(req(values, 'amount', line)),
          currency: values.currency || 'USD',
          memo: values.memo || null,
          sourceLine: line,
        });
      } catch (e) {
        warnings.push({ line, message: (e as Error).message });
      }
    }
    return { kind: 'card_transactions', transactions, warnings };
  },
};

const bankCsv: ConnectorAdapter = {
  id: 'bank:csv',
  kind: 'bank_feed',
  format: 'csv',
  name: 'Bank statement (CSV)',
  description: 'Generic bank CSV: account, date, description, amount (signed), reference, bank_ref; optional opening/closing balance rows.',
  mime: 'text/csv',
  fileExtension: '.csv',
  sample: () => ['account,date,description,amount,reference,bank_ref', '4417,2026-10-01,ACH CREDIT ALDERGROVE UTIL,27500.00,INV-US-202609-014,FH-0001'].join('\n'),
  parse(content) {
    const { records } = parseCsvObjects(content);
    const warnings: ImportError[] = [];
    const transactions = [];
    let account = '';
    for (const { line, values } of records) {
      try {
        account = values.account || account;
        transactions.push({
          externalId: values.bank_ref || `${values.date}-${line}`,
          bookingDate: parseDate(req(values, 'date', line)),
          valueDate: null,
          amountMinor: parseAmountMinor(req(values, 'amount', line)),
          description: req(values, 'description', line),
          counterparty: values.counterparty || null,
          reference: values.reference || null,
          typeCode: null,
          sourceLine: line,
        });
      } catch (e) {
        warnings.push({ line, message: (e as Error).message });
      }
    }
    const net = transactions.reduce((s, t) => s + t.amountMinor, 0);
    const date = transactions.map((t) => t.bookingDate).sort().pop() ?? '';
    return { kind: 'bank_statement', statement: { format: 'csv', accountNumber: account, currency: 'USD', statementDate: date, openingBalanceMinor: 0, closingBalanceMinor: net, transactions, warnings } };
  },
};

const glCsv: ConnectorAdapter = {
  id: 'erp_gl:csv',
  kind: 'erp_gl',
  format: 'csv',
  name: 'ERP journal export (CSV)',
  description: 'Journal lines from an external ERP: entry_number, posting_date, account, debit, credit, memo, department. Imported as entries awaiting approval.',
  mime: 'text/csv',
  fileExtension: '.csv',
  sample: () =>
    ['entry_number,posting_date,account,debit,credit,memo,department', 'ERP-7781,2026-09-30,6150,1200.00,,Annual design tool renewal true-up,MKTG', 'ERP-7781,2026-09-30,2110,,1200.00,Annual design tool renewal true-up,'].join('\n'),
  parse(content) {
    const { records } = parseCsvObjects(content);
    const warnings: ImportError[] = [];
    const lines: ParsedGlLine[] = [];
    for (const { line, values } of records) {
      try {
        const debit = values.debit ? parseAmountMinor(values.debit) : 0;
        const credit = values.credit ? parseAmountMinor(values.credit) : 0;
        if ((debit > 0) === (credit > 0)) throw new Error(`line ${line}: exactly one of debit/credit must be positive`);
        lines.push({ externalId: `${req(values, 'entry_number', line)}:${line}`, entryNumber: values.entry_number!, postingDate: parseDate(req(values, 'posting_date', line)), accountCode: req(values, 'account', line), debitMinor: debit, creditMinor: credit, memo: values.memo || '', department: values.department || null, sourceLine: line });
      } catch (e) {
        warnings.push({ line, message: (e as Error).message });
      }
    }
    return { kind: 'gl_lines', lines, warnings };
  },
};

const apJson: ConnectorAdapter = {
  id: 'ap:json',
  kind: 'ap',
  format: 'json',
  name: 'AP inbox (JSON)',
  description: 'Bills captured by the AP inbox (OCR/e-invoicing): vendor code, number, dates, service period, lines.',
  mime: 'application/json',
  fileExtension: '.json',
  sample: () =>
    JSON.stringify(
      [
        { id: 'APX-90121', vendor_code: 'V-REDWOOD', bill_number: 'RF-2610-77', bill_date: '2026-10-01', due_date: '2026-10-21', service_period_start: '2026-10-01', service_period_end: '2026-10-31', currency: 'USD', total: '2380.00', description: 'Fiber internet – October', lines: [{ description: 'Fiber internet – October', amount: '2380.00', account: '6650', department: 'GA' }] },
      ],
      null,
      2,
    ),
  parse(content) {
    const warnings: ImportError[] = [];
    let arr: unknown;
    try {
      arr = JSON.parse(content);
    } catch {
      throw new Error('AP JSON: invalid JSON');
    }
    if (!Array.isArray(arr)) throw new Error('AP JSON: expected an array of bills');
    const bills: ParsedBill[] = [];
    arr.forEach((raw, i) => {
      const b = raw as Record<string, unknown>;
      try {
        const lines = Array.isArray(b.lines) ? (b.lines as Record<string, unknown>[]) : [];
        bills.push({
          externalId: String(b.id ?? `bill-${i + 1}`),
          vendorCode: String(b.vendor_code ?? ''),
          billNumber: String(b.bill_number ?? ''),
          billDate: parseDate(String(b.bill_date ?? '')),
          dueDate: parseDate(String(b.due_date ?? b.bill_date ?? '')),
          servicePeriodStart: b.service_period_start ? parseDate(String(b.service_period_start)) : null,
          servicePeriodEnd: b.service_period_end ? parseDate(String(b.service_period_end)) : null,
          totalMinor: parseAmountMinor(String(b.total ?? '')),
          currency: String(b.currency ?? 'USD'),
          description: String(b.description ?? ''),
          lines: lines.map((l) => ({ description: String(l.description ?? ''), amountMinor: parseAmountMinor(String(l.amount ?? '0')), accountCode: l.account ? String(l.account) : null, department: l.department ? String(l.department) : null })),
          sourceLine: i + 1,
        });
      } catch (e) {
        warnings.push({ line: i + 1, message: (e as Error).message });
      }
    });
    return { kind: 'bills', bills, warnings };
  },
};

const payrollCsv: ConnectorAdapter = {
  id: 'payroll:csv',
  kind: 'payroll',
  format: 'csv',
  name: 'Payroll register (CSV)',
  description: 'Payroll provider register: run_id, pay_date, period_start, period_end, currency, gross, employer_taxes, benefits, withholdings, net_pay, dept_<CODE> columns.',
  mime: 'text/csv',
  fileExtension: '.csv',
  sample: () =>
    ['run_id,pay_date,period_start,period_end,currency,gross,employer_taxes,benefits,withholdings,net_pay,dept_RND,dept_GA', 'PR-US-20261009,2026-10-09,2026-09-19,2026-10-02,USD,10000.00,720.00,900.00,2800.00,7200.00,6000.00,4000.00'].join('\n'),
  parse(content) {
    const { records } = parseCsvObjects(content);
    const warnings: ImportError[] = [];
    const runs: ParsedPayrollRun[] = [];
    for (const { line, values } of records) {
      try {
        const byDepartment: Record<string, number> = {};
        for (const [k, v] of Object.entries(values)) if (k.startsWith('dept_') && v) byDepartment[k.slice(5).toUpperCase()] = parseAmountMinor(v);
        const gross = parseAmountMinor(req(values, 'gross', line));
        const withholdings = parseAmountMinor(req(values, 'withholdings', line));
        const net = parseAmountMinor(req(values, 'net_pay', line));
        if (net !== gross - withholdings) throw new Error(`line ${line}: net pay must equal gross − withholdings`);
        runs.push({ externalId: req(values, 'run_id', line), payDate: parseDate(req(values, 'pay_date', line)), periodStart: parseDate(req(values, 'period_start', line)), periodEnd: parseDate(req(values, 'period_end', line)), currency: values.currency || 'USD', grossMinor: gross, employerTaxesMinor: parseAmountMinor(values.employer_taxes || '0'), benefitsMinor: parseAmountMinor(values.benefits || '0'), withholdingsMinor: withholdings, netPayMinor: net, byDepartment, sourceLine: line });
      } catch (e) {
        warnings.push({ line, message: (e as Error).message });
      }
    }
    return { kind: 'payroll_runs', runs, warnings };
  },
};

const BAI2_SAMPLE = `01,FHBANK,BRAMBLEWOOD,261002,0600,1,80,,2/
02,BRAMBLEWOOD,FHBANK,1,261002,2400,USD,2/
03,000123454417,USD,010,100000,,,015,127500,,/
16,165,27500,V,261001,,FH-SAMPLE-1,INV-US-202609-014,ACH CREDIT ALDERGROVE UTILITIES/
49,255000,4/
98,255000,1,6/
99,255000,1,8/
`;

/** A small, fictional October statement for the UK account (sample for the import screen). */
const CAMT_SAMPLE = () =>
  writeCamt053({
    messageId: 'THMS-SAMPLE-0001',
    createdAt: '2026-10-02T06:05:00Z',
    iban: 'GB29THMS20150912342208',
    currency: 'GBP',
    from: '2026-10-01',
    to: '2026-10-01',
    openingMinor: 389_471_612,
    closingMinor: 389_471_612 + 1_250_000 - 48_000,
    entries: [
      { ref: 'THMS-S-1', bookingDate: '2026-10-01', amountMinor: 1_250_000, info: 'Invoice UK-5521 settlement', counterparty: 'Northgate Labs Ltd', endToEnd: 'NGL-5521', subFamily: 'RCDT' },
      { ref: 'THMS-S-2', bookingDate: '2026-10-01', amountMinor: -48_000, info: 'Courier services September', counterparty: 'Swiftline Couriers', endToEnd: null, subFamily: 'DMCT' },
    ],
  });

export const ADAPTERS: ConnectorAdapter[] = [
  { id: 'bank:bai2', kind: 'bank_feed', format: 'bai2', name: 'Bank statement (BAI2)', description: 'BAI2 cash management balance report: 01/02/03/16/88/49/98/99 records; 010/015 ledger balances.', mime: 'text/plain', fileExtension: '.bai', sample: () => BAI2_SAMPLE, parse: (c) => ({ kind: 'bank_statement', statement: parseBai2(c) }) },
  { id: 'bank:camt053', kind: 'bank_feed', format: 'camt053', name: 'Bank statement (ISO 20022 camt.053)', description: 'BankToCustomerStatement XML with OPBD/CLBD balances and Ntry entries.', mime: 'application/xml', fileExtension: '.xml', sample: () => CAMT_SAMPLE(), parse: (c) => ({ kind: 'bank_statement', statement: parseCamt053(c) }) },
  { id: 'bank:ofx', kind: 'bank_feed', format: 'ofx', name: 'Bank statement (OFX)', description: 'Open Financial Exchange STMTRS with STMTTRN entries.', mime: 'application/x-ofx', fileExtension: '.ofx', sample: () => 'OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><ACCTID>4417</BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261001<TRNAMT>275.00<FITID>OFX-1<NAME>ALDERGROVE</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>275.00<DTASOF>20261001</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>', parse: (c) => ({ kind: 'bank_statement', statement: parseOfx(c) }) },
  bankCsv,
  cardCsv,
  glCsv,
  apJson,
  payrollCsv,
];

export function adapter(id: string): ConnectorAdapter {
  const a = ADAPTERS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown connector adapter ${id}`);
  return a;
}
