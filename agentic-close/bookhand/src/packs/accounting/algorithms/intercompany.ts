import { convertMinor } from '../../../shared/money';

/**
 * Intercompany matching (by reference and amount, after FX), elimination drafting and FX remeasurement.
 */

export interface IcTransaction {
  entityCode: string;
  counterpartyCode: string;
  reference: string;
  date: string;
  /** Receivable/revenue side positive, payable/expense side positive too; side says which. */
  side: 'receivable' | 'payable';
  /** Amount in the transaction currency of the IC agreement (USD here). */
  amountTxn: number;
  txnCurrency: string;
  journalEntryId: string;
  description: string;
}

export interface IcPairResult {
  reference: string;
  receivable: IcTransaction | null;
  payable: IcTransaction | null;
  difference: number;
  status: 'matched' | 'amount_mismatch' | 'missing_payable' | 'missing_receivable';
}

export function matchIntercompany(transactions: IcTransaction[]): IcPairResult[] {
  const refs = new Map<string, { r: IcTransaction | null; p: IcTransaction | null }>();
  for (const t of transactions) {
    const key = t.reference.toUpperCase();
    const e = refs.get(key) ?? { r: null, p: null };
    if (t.side === 'receivable') e.r = t;
    else e.p = t;
    refs.set(key, e);
  }
  return Array.from(refs.entries())
    .map(([reference, { r, p }]) => {
      const difference = (r?.amountTxn ?? 0) - (p?.amountTxn ?? 0);
      const status: IcPairResult['status'] = !p ? 'missing_payable' : !r ? 'missing_receivable' : difference !== 0 ? 'amount_mismatch' : 'matched';
      return { reference, receivable: r, payable: p, difference, status };
    })
    .sort((a, b) => a.reference.localeCompare(b.reference));
}

export interface MonetaryBalance {
  accountNumber: string;
  accountName: string;
  /** Balance in the foreign (transaction) currency, debit-positive. */
  txnBalance: number;
  txnCurrency: string;
  /** Carrying amount in functional currency, debit-positive. */
  functionalBalance: number;
}

export interface RevaluationLine {
  accountNumber: string;
  accountName: string;
  txnBalance: number;
  txnCurrency: string;
  carrying: number;
  remeasured: number;
  adjustment: number;
  rate: number;
}

/** Remeasure foreign-currency monetary balances at the closing rate (functional per 1 foreign unit). */
export function remeasure(balances: MonetaryBalance[], closingRate: number): RevaluationLine[] {
  return balances
    .map((b) => {
      const remeasured = convertMinor(b.txnBalance, closingRate);
      return { accountNumber: b.accountNumber, accountName: b.accountName, txnBalance: b.txnBalance, txnCurrency: b.txnCurrency, carrying: b.functionalBalance, remeasured, adjustment: remeasured - b.functionalBalance, rate: closingRate };
    })
    .filter((l) => l.adjustment !== 0);
}
