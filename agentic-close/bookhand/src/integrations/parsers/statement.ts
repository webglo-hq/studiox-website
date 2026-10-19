/** Normalized bank statement produced by every bank-format parser (BAI2, CAMT.053, OFX, CSV). */

export interface NormalizedStatementLine {
  bookingDate: string;
  valueDate: string | null;
  /** Signed minor units: + credit to the account (money in), - debit (money out). */
  amount: number;
  description: string;
  counterparty: string | null;
  reference: string | null;
  bankReference: string;
  typeCode: string | null;
  /** Where in the source this came from, e.g. "16 record at line 14" or "Ntry[3]". */
  locator: string;
}

export interface NormalizedStatement {
  format: 'bai2' | 'camt053' | 'ofx' | 'csv';
  accountId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  statementDate: string;
  openingBalance: number | null;
  closingBalance: number | null;
  lines: NormalizedStatementLine[];
  warnings: string[];
}

export class StatementParseError extends Error {
  constructor(
    message: string,
    readonly locator?: string,
  ) {
    super(locator ? `${locator}: ${message}` : message);
  }
}

export function statementControlCheck(s: NormalizedStatement): string | null {
  if (s.openingBalance === null || s.closingBalance === null) return null;
  const net = s.lines.reduce((t, l) => t + l.amount, 0);
  const diff = s.openingBalance + net - s.closingBalance;
  return diff === 0 ? null : `opening ${s.openingBalance} + activity ${net} != closing ${s.closingBalance} (off by ${diff})`;
}
