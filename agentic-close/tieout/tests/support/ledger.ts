/**
 * The ledger read directly, without the statements module: posted journal lines of income and
 * expense accounts, summed per entity and month. Tests compare every presented figure to this.
 */
import type { DbTx } from '../../src/schema';
import { fxRate } from '../../src/packs/accounting/fx/rates';
import { convert } from '../../src/packs/accounting/ledger/money';

export const lastDay = (pk: string) => new Date(Date.UTC(Number(pk.slice(0, 4)), Number(pk.slice(5)), 0)).toISOString().slice(0, 10);

export async function readLedger(tx: DbTx) {
  const accounts = new Map((await tx.find('accounts', {})).map((a) => [a.id, a]));
  const entities = await tx.find('entities', {});
  const entries = new Map((await tx.find('journal_entries', { status: 'posted' })).map((j) => [j.id, j]));
  const lines = await tx.find('journal_lines', {});
  /** −Σ(debit − credit) of income and expense lines in the month; the year-end close (YEC-…) is not activity of the month */
  const pnl = (entityId: string, pk: string, opts: { codes?: string[]; byGrain?: (net: number) => number } = {}) => {
    const grains = new Map<string, number>();
    for (const l of lines) {
      const j = entries.get(l.journal_entry_id);
      const a = accounts.get(l.account_id)!;
      if (!j || j.entity_id !== entityId || j.posting_date < `${pk}-01` || j.posting_date > lastDay(pk)) continue;
      if (String(j.source_ref ?? '').startsWith('YEC-')) continue;
      if (a.account_class !== 'revenue' && a.account_class !== 'expense') continue;
      if (opts.codes && !opts.codes.includes(a.code)) continue;
      const k = `${l.account_id}|${l.department ?? ''}`;
      grains.set(k, (grains.get(k) ?? 0) + l.debit_minor - l.credit_minor);
    }
    let s = 0;
    for (const v of grains.values()) s -= opts.byGrain ? opts.byGrain(v) : v;
    return s;
  };
  /** The group's month in USD: every entity's activity at the month's average rate (per account and department). */
  const consolidatedPnl = async (pk: string) => {
    let total = 0;
    for (const e of entities) {
      const rate = await fxRate(tx, e.functional_currency, 'USD', lastDay(pk), 'average');
      total += pnl(e.id, pk, { byGrain: (v) => convert(v, rate) });
    }
    return total;
  };
  return { pnl, consolidatedPnl, entries, entities };
}
