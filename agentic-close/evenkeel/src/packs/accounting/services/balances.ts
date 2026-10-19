import { periodEnd } from '../../../framework/util/dates';
import type { ServiceContext } from '../domain/context';
import { ledgerBalances, ledgerLines, type LedgerLineRow } from '../domain/queries';
import { accountById } from '../domain/refdata';

/** Ledger balance (debit − credit) of one account for one entity, cumulative through a period. */
export async function ledgerBalance(ctx: ServiceContext, entityId: string, accountId: string, throughPeriod: string): Promise<number> {
  const rows = await ctx.db.query(ledgerBalances, { tenantId: ctx.tenantId, entityIds: [entityId], accountIds: [accountId], periodTo: throughPeriod });
  return rows.reduce((s, r) => s + r.debit - r.credit, 0);
}

/** Same, in the account's natural sign (credit-normal accounts positive when in credit). */
export async function naturalBalance(ctx: ServiceContext, entityId: string, accountId: string, throughPeriod: string): Promise<number> {
  const a = await accountById(ctx, accountId);
  const net = await ledgerBalance(ctx, entityId, accountId, throughPeriod);
  return a.normal_balance === 'debit' ? net : -net;
}

export async function periodLines(ctx: ServiceContext, entityId: string, accountIds: string[], periodKey: string, until?: string): Promise<LedgerLineRow[]> {
  const rows = await ctx.db.query(ledgerLines, { tenantId: ctx.tenantId, entityIds: [entityId], accountIds, periodFrom: periodKey, periodTo: until ?? periodKey });
  return rows;
}

export function asOfDate(periodKey: string): string {
  return periodEnd(periodKey);
}
