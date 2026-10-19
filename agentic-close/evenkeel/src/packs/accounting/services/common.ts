import { addMonths, periodEnd } from '../../../framework/util/dates';
import { AppError } from '../../../framework/util/errors';
import { convertCents } from '../../../framework/util/money';
import { BusinessCalendar } from '../../../framework/util/workdays';
import { memo, type ServiceContext } from '../domain/context';
import { entityById, fxRate, tenantRow, usersById } from '../domain/refdata';

/** Shared helpers for application services (settings, calendar, currency, people). */

export interface TenantSettings {
  timezone: string;
  reportingCurrency: string;
  materiality: { overall: number; performance: number; clearlyTrivial: number };
  capitalizationThreshold: number;
  prepaidThreshold: number;
  closeTargetWorkday: number;
  autoContinue: boolean;
}

export async function settings(ctx: ServiceContext): Promise<TenantSettings> {
  return memo(ctx, 'settings', async () => {
    const t = await tenantRow(ctx);
    const s = (t.settings ?? {}) as Record<string, unknown>;
    const m = (s.materiality ?? {}) as Record<string, number>;
    return {
      timezone: t.timezone,
      reportingCurrency: t.reporting_currency,
      materiality: { overall: m.overall ?? 30_000_000, performance: m.performance ?? 22_500_000, clearlyTrivial: m.clearlyTrivial ?? 1_500_000 },
      capitalizationThreshold: Number(s.capitalizationThreshold ?? 250_000),
      prepaidThreshold: Number(s.prepaidThreshold ?? 500_000),
      closeTargetWorkday: Number(s.closeTargetWorkday ?? 5),
      autoContinue: s.autoContinue === undefined ? true : Boolean(s.autoContinue),
    };
  });
}

export async function calendar(ctx: ServiceContext): Promise<BusinessCalendar> {
  return memo(ctx, 'calendar', async () => {
    const hs = await ctx.db.find('holiday', { tenant_id: ctx.tenantId });
    return new BusinessCalendar(hs.map((h) => h.date));
  });
}

/** The period currently being closed: the earliest cycle that is not closed. */
export async function currentPeriodKey(ctx: ServiceContext): Promise<string> {
  return memo(ctx, 'currentPeriod', async () => {
    const cycles = await ctx.db.find('close_cycle', { tenant_id: ctx.tenantId }, { orderBy: [['period_key', 'asc']] });
    if (!cycles.length) throw new AppError('NOT_FOUND', 'No close cycles exist yet.');
    // The close people are working on: the earliest unfinished cycle that has a calendar.
    // Once a month is locked and the next one has no calendar yet (it opens after month end),
    // the locked month stays current so its final state can be reviewed.
    const withTasks = new Set((await ctx.db.find('close_task', { tenant_id: ctx.tenantId, close_cycle_id: { in: cycles.map((c) => c.id) } })).map((t) => t.close_cycle_id));
    const open = cycles.find((c) => c.status !== 'closed' && withTasks.has(c.id));
    if (open) return open.period_key;
    const lastClosed = [...cycles].reverse().find((c) => c.status === 'closed');
    if (lastClosed) return lastClosed.period_key;
    return cycles.find((c) => c.status !== 'closed')?.period_key ?? addMonths(cycles[cycles.length - 1]!.period_key, 1);
  });
}

/** Convert an amount in an entity's functional currency into reporting currency (closing rate). */
export async function toReporting(ctx: ServiceContext, amount: number, currency: string, periodKey: string): Promise<number> {
  const s = await settings(ctx);
  if (currency === s.reportingCurrency) return amount;
  const rate = await fxRate(ctx, currency, s.reportingCurrency, periodEnd(periodKey), 'closing');
  return convertCents(amount, rate);
}

export async function entityCurrency(ctx: ServiceContext, entityId: string | null | undefined): Promise<string> {
  if (!entityId) return (await settings(ctx)).reportingCurrency;
  return (await entityById(ctx, entityId)).functional_currency;
}

export type MaterialityBand = 'trivial' | 'below_performance' | 'material';

export async function materialityBand(ctx: ServiceContext, amountReporting: number): Promise<{ band: MaterialityBand; performance: number }> {
  const m = (await settings(ctx)).materiality;
  const a = Math.abs(amountReporting);
  return { band: a < m.clearlyTrivial ? 'trivial' : a < m.performance ? 'below_performance' : 'material', performance: m.performance };
}

export interface PersonRef {
  id: string;
  name: string;
  title: string | null;
}

export async function person(ctx: ServiceContext, id: string | null | undefined): Promise<PersonRef | null> {
  if (!id) return null;
  const u = (await usersById(ctx)).get(id);
  return u ? { id: u.id, name: u.display_name, title: u.title } : { id, name: 'Unknown user', title: null };
}

export async function peopleMap(ctx: ServiceContext): Promise<Map<string, PersonRef>> {
  const users = await usersById(ctx);
  return new Map([...users.values()].map((u) => [u.id, { id: u.id, name: u.display_name, title: u.title }]));
}

export function sum(xs: Iterable<number>): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function groupBy<T, K>(xs: Iterable<T>, key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}
