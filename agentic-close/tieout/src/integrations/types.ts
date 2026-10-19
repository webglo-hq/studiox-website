/**
 * Integration layer contracts. A connector turns a raw source document (bank statement, card
 * feed, GL export, AP/AR extract, payroll register) into typed records with provenance:
 * every record carries the source document id, its line/record number and a stable external id,
 * so re-importing the same file is a no-op (idempotency) and every number traces back to source.
 */

export type ConnectorKind = 'bank_feed' | 'card_feed' | 'erp_gl' | 'ap' | 'ar' | 'payroll';
export type ConnectorFormat = 'bai2' | 'camt053' | 'ofx' | 'csv' | 'json';

export interface ImportError {
  line: number | null;
  message: string;
}

/** Normalised bank statement, independent of BAI2 / CAMT.053 / OFX / CSV. */
export interface ParsedBankStatement {
  format: ConnectorFormat;
  accountNumber: string;
  currency: string;
  statementDate: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  transactions: ParsedBankTransaction[];
  warnings: ImportError[];
}

export interface ParsedBankTransaction {
  externalId: string;
  bookingDate: string;
  valueDate: string | null;
  /** signed: + money in, - money out */
  amountMinor: number;
  description: string;
  counterparty: string | null;
  reference: string | null;
  typeCode: string | null;
  sourceLine: number;
}

export interface ParsedCardTransaction {
  externalId: string;
  cardLast4: string;
  txnDate: string;
  postDate: string;
  merchantName: string;
  mcc: string | null;
  amountMinor: number;
  currency: string;
  memo: string | null;
  sourceLine: number;
}

export interface ParsedGlLine {
  externalId: string;
  entryNumber: string;
  postingDate: string;
  accountCode: string;
  debitMinor: number;
  creditMinor: number;
  memo: string;
  department: string | null;
  sourceLine: number;
}

export interface ParsedBill {
  externalId: string;
  vendorCode: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  totalMinor: number;
  currency: string;
  description: string;
  lines: { description: string; amountMinor: number; accountCode: string | null; department: string | null }[];
  sourceLine: number;
}

export interface ParsedPayrollRun {
  externalId: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  grossMinor: number;
  employerTaxesMinor: number;
  benefitsMinor: number;
  withholdingsMinor: number;
  netPayMinor: number;
  byDepartment: Record<string, number>;
  sourceLine: number;
}

export type ParseResult =
  | { kind: 'bank_statement'; statement: ParsedBankStatement }
  | { kind: 'card_transactions'; transactions: ParsedCardTransaction[]; warnings: ImportError[] }
  | { kind: 'gl_lines'; lines: ParsedGlLine[]; warnings: ImportError[] }
  | { kind: 'bills'; bills: ParsedBill[]; warnings: ImportError[] }
  | { kind: 'payroll_runs'; runs: ParsedPayrollRun[]; warnings: ImportError[] };
