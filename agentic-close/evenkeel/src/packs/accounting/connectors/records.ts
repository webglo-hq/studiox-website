import { z } from 'zod';
import { parseCsv, toCsv } from '../../../framework/connectors/csv';
import { centsToDecimalString, toCents } from '../../../framework/util/money';

/** Typed adapters for non-bank source systems (card feed, AP, payroll, legacy ERP GL). */

export interface CardRecord {
  externalId: string;
  cardLast4: string;
  cardholder: string;
  cardholderEmail: string;
  cardholderDepartment: string | null;
  merchant: string;
  mcc: string | null;
  amount: number;
  currency: string;
  txnDate: string;
  postedDate: string;
  memo: string | null;
  receipt: boolean;
  suggestedAccount: string | null;
  sourceLine: string;
}

const CARD_COLUMNS = ['transaction_id', 'card_last4', 'cardholder', 'cardholder_email', 'cardholder_department', 'merchant', 'mcc', 'amount', 'currency', 'transaction_date', 'posted_date', 'memo', 'receipt', 'suggested_account'];

export function parseCardCsv(text: string): CardRecord[] {
  const t = parseCsv(text, { required: ['transaction_id', 'merchant', 'amount', 'transaction_date'] });
  return t.rows.map((r, i) => ({
    externalId: r.transaction_id!,
    cardLast4: r.card_last4 || '0000',
    cardholder: r.cardholder || 'Unknown',
    cardholderEmail: (r.cardholder_email || '').toLowerCase(),
    cardholderDepartment: r.cardholder_department || null,
    merchant: r.merchant!,
    mcc: r.mcc || null,
    amount: toCents(r.amount!),
    currency: r.currency || 'USD',
    txnDate: r.transaction_date!,
    postedDate: r.posted_date || r.transaction_date!,
    memo: r.memo || null,
    receipt: /^(y|yes|true|1)$/i.test(r.receipt || ''),
    suggestedAccount: r.suggested_account || null,
    sourceLine: `line ${t.lines[i]}`,
  }));
}

export function writeCardCsv(rows: Omit<CardRecord, 'sourceLine'>[]): string {
  return toCsv(
    CARD_COLUMNS,
    rows.map((r) => [r.externalId, r.cardLast4, r.cardholder, r.cardholderEmail, r.cardholderDepartment ?? '', r.merchant, r.mcc ?? '', centsToDecimalString(r.amount), r.currency, r.txnDate, r.postedDate, r.memo ?? '', r.receipt ? 'yes' : 'no', r.suggestedAccount ?? '']),
  );
}

export interface BillRecord {
  billNumber: string;
  vendor: string;
  billDate: string;
  dueDate: string;
  amount: number;
  currency: string;
  serviceStart: string | null;
  serviceEnd: string | null;
  poNumber: string | null;
  accountCode: string | null;
  department: string | null;
  memo: string | null;
  sourceLine: string;
}

const BILL_COLUMNS = ['bill_number', 'vendor', 'bill_date', 'due_date', 'amount', 'currency', 'service_start', 'service_end', 'po_number', 'account_code', 'department', 'memo'];

export function parseBillsCsv(text: string): BillRecord[] {
  const t = parseCsv(text, { required: ['bill_number', 'vendor', 'bill_date', 'amount'] });
  return t.rows.map((r, i) => ({
    billNumber: r.bill_number!,
    vendor: r.vendor!,
    billDate: r.bill_date!,
    dueDate: r.due_date || r.bill_date!,
    amount: toCents(r.amount!),
    currency: r.currency || 'USD',
    serviceStart: r.service_start || null,
    serviceEnd: r.service_end || null,
    poNumber: r.po_number || null,
    accountCode: r.account_code || null,
    department: r.department || null,
    memo: r.memo || null,
    sourceLine: `line ${t.lines[i]}`,
  }));
}

export function writeBillsCsv(rows: Omit<BillRecord, 'sourceLine'>[]): string {
  return toCsv(
    BILL_COLUMNS,
    rows.map((r) => [r.billNumber, r.vendor, r.billDate, r.dueDate, centsToDecimalString(r.amount), r.currency, r.serviceStart ?? '', r.serviceEnd ?? '', r.poNumber ?? '', r.accountCode ?? '', r.department ?? '', r.memo ?? '']),
  );
}

export interface PayrollRecord {
  payDate: string;
  periodStart: string;
  periodEnd: string;
  department: string;
  headcount: number;
  grossWages: number;
  employerTaxes: number;
  benefits: number;
  withholdings: number;
  netPay: number;
  sourceLine: string;
}

const PAYROLL_COLUMNS = ['pay_date', 'period_start', 'period_end', 'department', 'headcount', 'gross_wages', 'employer_taxes', 'benefits', 'withholdings', 'net_pay'];

export function parsePayrollCsv(text: string): PayrollRecord[] {
  const t = parseCsv(text, { required: PAYROLL_COLUMNS });
  return t.rows.map((r, i) => {
    const rec = {
      payDate: r.pay_date!,
      periodStart: r.period_start!,
      periodEnd: r.period_end!,
      department: r.department!,
      headcount: Number(r.headcount),
      grossWages: toCents(r.gross_wages!),
      employerTaxes: toCents(r.employer_taxes!),
      benefits: toCents(r.benefits!),
      withholdings: toCents(r.withholdings!),
      netPay: toCents(r.net_pay!),
      sourceLine: `line ${t.lines[i]}`,
    };
    if (rec.netPay !== rec.grossWages - rec.withholdings) throw new Error(`payroll line ${t.lines[i]}: net pay must equal gross − withholdings`);
    return rec;
  });
}

export function writePayrollCsv(rows: Omit<PayrollRecord, 'sourceLine'>[]): string {
  return toCsv(
    PAYROLL_COLUMNS,
    rows.map((r) => [r.payDate, r.periodStart, r.periodEnd, r.department, r.headcount, centsToDecimalString(r.grossWages), centsToDecimalString(r.employerTaxes), centsToDecimalString(r.benefits), centsToDecimalString(r.withholdings), centsToDecimalString(r.netPay)]),
  );
}

const Money = z.union([z.string(), z.number()]).transform((v) => toCents(v));

export const ErpGlExport = z.object({
  source: z.string().max(100),
  exported_at: z.string(),
  entries: z
    .array(
      z.object({
        erp_id: z.string().min(1).max(64),
        entity: z.string().min(1).max(16),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        memo: z.string().min(1).max(500),
        type: z.enum(['standard', 'adjusting', 'accrual', 'reclass']).default('standard'),
        prepared_by: z.string().max(64).nullable().default(null),
        approved_by: z.string().max(64).nullable().default(null),
        posted_at: z.string().nullable().default(null),
        lines: z
          .array(
            z.object({
              account: z.string().min(1).max(16),
              debit: Money.default(0),
              credit: Money.default(0),
              department: z.string().max(32).nullable().default(null),
              memo: z.string().max(300).nullable().default(null),
            }),
          )
          .min(2)
          .max(200),
      }),
    )
    .max(5000),
});
export type ErpGlExport = z.infer<typeof ErpGlExport>;

export function parseErpGlJson(text: string): ErpGlExport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('ERP export is not valid JSON');
  }
  return ErpGlExport.parse(raw);
}
