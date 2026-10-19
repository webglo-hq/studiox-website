/** Exchange-rate lookups (tie:SpotRate, tie:ClosingRate, tie:AverageRate, tie:HistoricalRate). */
import { notFound } from '../../../core/util/errors';
import { periodEnd, periodKeyOf } from '../../../core/util/time';
import type { DbTx } from '../../../schema';

export type RateType = 'spot' | 'closing' | 'average';

export async function fxRate(tx: DbTx, from: string, to: string, date: string, type: RateType): Promise<number> {
  if (from === to) return 1;
  const direct = await lookup(tx, from, to, date, type);
  if (direct !== null) return direct;
  const inverse = await lookup(tx, to, from, date, type);
  if (inverse !== null) return 1 / inverse;
  throw notFound('Exchange rate', `${type} ${from}/${to} at ${date}`);
}

async function lookup(tx: DbTx, from: string, to: string, date: string, type: RateType): Promise<number | null> {
  if (type === 'average') {
    const r = await tx.findOne('fx_rates', { from_currency: from, to_currency: to, rate_type: 'average', period_key: periodKeyOf(date) });
    return r ? r.rate : null;
  }
  if (type === 'closing') {
    const r = await tx.findOne('fx_rates', { from_currency: from, to_currency: to, rate_type: 'closing', rate_date: periodEnd(periodKeyOf(date)) });
    if (r) return r.rate;
  }
  const rows = await tx.find('fx_rates', { from_currency: from, to_currency: to, rate_type: 'spot', rate_date: { lte: date } }, { orderBy: [['rate_date', 'desc']], limit: 1 });
  return rows[0]?.rate ?? null;
}
