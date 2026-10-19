/**
 * Balance queries over posted journal lines. One aggregate query per call (the store does the
 * heavy lifting); callers never loop per account.
 */
import { periodEnd, periodStart } from '../../../core/util/time';
import type { DbTx, JournalEntryRow, JournalLineRow } from '../../../schema';
import { naturalBalance } from './money';
import type { Chart } from './chart';

export interface Balance {
  debitMinor: number;
  creditMinor: number;
  /** debit - credit */
  netMinor: number;
}

export type BalanceMap = Map<string, Balance>;

/**
 * Entry types that are not activity of the period they are dated in: the year-end close moves
 * income and expense into retained earnings. Period income statements and flux leave them out;
 * balances (and so the balance sheet) keep them.
 */
export const NOT_PERIOD_ACTIVITY: readonly string[] = ['closing'];

function toMap(rows: { account_id?: string; debit_minor: number; credit_minor: number }[]): BalanceMap {
  const m: BalanceMap = new Map();
  for (const r of rows) {
    const id = r.account_id!;
    const prev = m.get(id) ?? { debitMinor: 0, creditMinor: 0, netMinor: 0 };
    prev.debitMinor += r.debit_minor;
    prev.creditMinor += r.credit_minor;
    prev.netMinor = prev.debitMinor - prev.creditMinor;
    m.set(id, prev);
  }
  return m;
}

/** Cumulative balances up to and including `asOfDate` (balance sheet + since-last-close P&L). */
export async function balancesAsOf(tx: DbTx, entityIds: readonly string[], asOfDate: string, statuses: readonly string[] = ['posted']): Promise<BalanceMap> {
  return toMap(await tx.sumLines({ entityIds, toDate: asOfDate, groupBy: ['account_id'], statuses }));
}

/** Activity (movement) between two dates inclusive. */
export async function activityBetween(tx: DbTx, entityIds: readonly string[], fromDate: string, toDate: string): Promise<BalanceMap> {
  return toMap(await tx.sumLines({ entityIds, fromDate, toDate, groupBy: ['account_id'] }));
}

export async function periodActivity(tx: DbTx, entityIds: readonly string[], periodKey: string): Promise<BalanceMap> {
  return activityBetween(tx, entityIds, periodStart(periodKey), periodEnd(periodKey));
}

/** Monthly activity by account for a range of periods: period -> account -> net. */
export async function activityByPeriod(tx: DbTx, entityIds: readonly string[], fromKey: string, toKey: string): Promise<Map<string, Map<string, number>>> {
  const rows = await tx.sumLines({ entityIds, fromDate: periodStart(fromKey), toDate: periodEnd(toKey), groupBy: ['period', 'account_id'] });
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = out.get(r.period!) ?? new Map<string, number>();
    m.set(r.account_id!, (m.get(r.account_id!) ?? 0) + r.debit_minor - r.credit_minor);
    out.set(r.period!, m);
  }
  return out;
}

export async function activityByDepartment(tx: DbTx, entityIds: readonly string[], fromDate: string, toDate: string) {
  const rows = await tx.sumLines({ entityIds, fromDate, toDate, groupBy: ['account_id', 'department'] });
  return rows.map((r) => ({ accountId: r.account_id!, department: r.department ?? null, netMinor: r.debit_minor - r.credit_minor }));
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  accountClass: string;
  debitMinor: number;
  creditMinor: number;
  naturalMinor: number;
}

export function trialBalanceRows(chart: Chart, balances: BalanceMap): { rows: TrialBalanceRow[]; totalDebitMinor: number; totalCreditMinor: number } {
  const rows: TrialBalanceRow[] = [];
  let td = 0;
  let tc = 0;
  for (const a of chart.accounts) {
    const b = balances.get(a.id);
    if (!b || b.netMinor === 0) continue;
    const debit = b.netMinor > 0 ? b.netMinor : 0;
    const credit = b.netMinor < 0 ? -b.netMinor : 0;
    td += debit;
    tc += credit;
    rows.push({ accountId: a.id, code: a.code, name: a.name, accountClass: a.account_class, debitMinor: debit, creditMinor: credit, naturalMinor: naturalBalance(b.debitMinor, b.creditMinor, a.normal_balance) });
  }
  return { rows, totalDebitMinor: td, totalCreditMinor: tc };
}

/** GL detail (drill-down) for one account and date range. */
export async function accountActivity(
  tx: DbTx,
  entityId: string,
  accountId: string,
  fromDate: string,
  toDate: string,
  limit = 500,
): Promise<{ line: JournalLineRow; entry: JournalEntryRow }[]> {
  const headers = await tx.find('journal_entries', { entity_id: entityId, status: 'posted', posting_date: { gte: fromDate, lte: toDate } });
  if (!headers.length) return [];
  const byId = new Map(headers.map((h) => [h.id, h]));
  const lines = await tx.find('journal_lines', { account_id: accountId });
  const out: { line: JournalLineRow; entry: JournalEntryRow }[] = [];
  for (const l of lines) {
    const h = byId.get(l.journal_entry_id);
    if (h) out.push({ line: l, entry: h });
  }
  return out
    .sort((a, b) => (a.entry.posting_date < b.entry.posting_date ? -1 : a.entry.posting_date > b.entry.posting_date ? 1 : a.entry.je_number.localeCompare(b.entry.je_number)))
    .slice(0, limit);
}
