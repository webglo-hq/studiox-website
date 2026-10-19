/**
 * Balance-sheet footing from the presented lines: total assets against total liabilities plus equity (current-year
 * earnings included). Pure and dependency-free, so the domain and every screen that renders a balance sheet run the
 * same check on the very lines they show. Lines are classified by their statement-line key (BS.CA.* and BS.NCA.*
 * are assets, BS.CL.* and BS.NCL.* liabilities, BS.EQ.* equity); a line that fits none of them fails the footing.
 */

export interface FootingLine {
  key: string;
  label?: string;
  amount: number;
}

export interface Footing {
  assets: number;
  liabilities: number;
  equity: number;
  liabilitiesAndEquity: number;
  /** assets - (liabilities + equity); 0 when the statement foots. */
  difference: number;
  /** Lines that are not an asset, liability or equity line (each one makes the footing fail). */
  unclassified: string[];
  foots: boolean;
}

export type BalanceSheetSide = 'assets' | 'liabilities' | 'equity';

export function sideOf(lineKey: string): BalanceSheetSide | null {
  if (/^BS\.N?CA\./.test(lineKey)) return 'assets';
  if (/^BS\.N?CL\./.test(lineKey)) return 'liabilities';
  if (/^BS\.EQ\./.test(lineKey)) return 'equity';
  return null;
}

export function footBalanceSheet(sections: ReadonlyArray<{ lines: ReadonlyArray<FootingLine> }>): Footing {
  const totals = { assets: 0, liabilities: 0, equity: 0 };
  const unclassified: string[] = [];
  for (const s of sections) {
    for (const l of s.lines) {
      const side = sideOf(l.key);
      if (side) totals[side] += l.amount;
      else unclassified.push(l.label ?? l.key);
    }
  }
  const liabilitiesAndEquity = totals.liabilities + totals.equity;
  const difference = totals.assets - liabilitiesAndEquity;
  return { ...totals, liabilitiesAndEquity, difference, unclassified, foots: difference === 0 && unclassified.length === 0 };
}
