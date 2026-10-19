import { describe, expect, it } from 'vitest';
import { footBalanceSheet } from './footing';
import { balanceSheet, CURRENT_EARNINGS_LINE, incomeStatement, type TbRow, type TrialBalance } from './reporting';

/** A tiny trial balance: debit-positive nets on accounts mapped to statement lines. */
function tb(rows: Array<[number: string, cls: TbRow['accountClass'], fsLine: string, net: number]>): TrialBalance {
  const out: TbRow[] = rows.map(([number, accountClass, fsLine, net]) => ({
    accountId: `acc-${number}`,
    number,
    name: `Account ${number}`,
    accountClass,
    normalBalance: accountClass === 'asset' || accountClass === 'expense' ? 'debit' : 'credit',
    subtype: 'bh:Test',
    fsLine,
    net,
    debit: net > 0 ? net : 0,
    credit: net < 0 ? -net : 0,
    balance: accountClass === 'asset' || accountClass === 'expense' ? net : -net,
  }));
  return { entityId: null, label: 'Test', currency: 'USD', mode: 'balance', periodId: '', periodName: 'Sep 2026', rows: out, totalDebit: out.reduce((s, r) => s + r.debit, 0), totalCredit: out.reduce((s, r) => s + r.credit, 0) };
}

// Cash 10,000; payables 2,500; capital 5,000; this year's revenue 4,000 less expenses 1,500 = 2,500 profit.
const sample = tb([
  ['1000', 'asset', 'BS.CA.CASH', 1_000_000],
  ['2000', 'liability', 'BS.CL.AP', -250_000],
  ['3000', 'equity', 'BS.EQ.CAPITAL', -500_000],
  ['4000', 'revenue', 'IS.REV.SUBSCRIPTION', -400_000],
  ['6000', 'expense', 'IS.OPEX.SOFTWARE', 150_000],
]);

describe('balance sheet presentation', () => {
  it('B-1: shows current-year earnings inside equity, so the printed statement foots', () => {
    const bs = balanceSheet(sample);
    const equity = bs.sections.find((s) => s.name === 'Equity')!;
    const cye = equity.lines.find((l) => l.key === CURRENT_EARNINGS_LINE)!;
    expect(cye.label).toBe('Current-year earnings');
    expect(cye.amount).toBe(250_000);
    // The Equity section's own total (what the package prints) includes this year's profit.
    expect(equity.total).toBe(750_000);
    expect(bs.totalAssets).toBe(1_000_000);
    expect(bs.totalLiabilities).toBe(250_000);
    expect(bs.totalEquity).toBe(750_000);
    expect(bs.totalLiabilitiesAndEquity).toBe(1_000_000);
    expect(bs.balances).toBe(true);
    expect(footBalanceSheet(bs.sections).foots).toBe(true);
  });

  it('B-1: the footing check fails loudly when the presented lines do not foot', () => {
    const bs = balanceSheet(sample);
    // A rendering that drops current-year earnings (the defect) is caught by re-footing what is shown.
    const withoutCye = bs.sections.map((s) => ({ ...s, lines: s.lines.filter((l) => l.key !== CURRENT_EARNINGS_LINE) }));
    const footing = footBalanceSheet(withoutCye);
    expect(footing.foots).toBe(false);
    expect(footing.difference).toBe(250_000);
    // A line that is neither an asset, a liability nor equity also fails the footing.
    expect(footBalanceSheet([{ lines: [{ key: 'IS.REV.SUBSCRIPTION', label: 'Revenue', amount: 0 }] }])).toMatchObject({ foots: false, unclassified: ['Revenue'] });
  });

  it('B-1: the income statement ends in net income equal to the ledger profit', () => {
    const is = incomeStatement(sample);
    expect(is.netIncome).toBe(250_000);
    expect(is.netIncome).toBe(balanceSheet(sample).currentEarnings);
  });
});
