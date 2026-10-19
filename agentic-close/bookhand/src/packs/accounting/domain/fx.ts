import type { Tx } from '../../../persistence/db';
import type { Row } from '../../../persistence/schema';
import { DomainError } from '../../../shared/errors';

export type RateType = Row<'fx_rates'>['rate_type'];

/** Rate table for one tenant: 1 base = rate quote; inverse pairs are derived. */
export class FxTable {
  private readonly byKey = new Map<string, Row<'fx_rates'>[]>();

  constructor(rows: Row<'fx_rates'>[]) {
    for (const r of rows) {
      const key = `${r.base_currency}/${r.quote_currency}/${r.rate_type}`;
      const list = this.byKey.get(key) ?? [];
      list.push(r);
      this.byKey.set(key, list);
    }
    for (const list of this.byKey.values()) list.sort((a, b) => a.rate_date.localeCompare(b.rate_date));
  }

  static async load(tx: Tx, tenantId: string): Promise<FxTable> {
    return new FxTable(await tx.find('fx_rates', { tenant_id: tenantId }));
  }

  /** Latest rate on or before `date` (spot), or for the month containing `date` (average/closing). */
  rate(base: string, quote: string, date: string, type: RateType = 'spot'): number {
    if (base === quote) return 1;
    const direct = this.find(base, quote, date, type);
    if (direct) return direct.rate;
    const inverse = this.find(quote, base, date, type);
    if (inverse) return 1 / inverse.rate;
    throw new DomainError('NOT_FOUND', `No ${type} rate for ${base}/${quote} on or before ${date}`);
  }

  has(base: string, quote: string, date: string, type: RateType = 'spot'): boolean {
    return base === quote || !!this.find(base, quote, date, type) || !!this.find(quote, base, date, type);
  }

  private find(base: string, quote: string, date: string, type: RateType): Row<'fx_rates'> | undefined {
    const list = this.byKey.get(`${base}/${quote}/${type}`);
    if (!list?.length) return undefined;
    if (type !== 'spot') {
      const month = date.slice(0, 7);
      const inMonth = list.filter((r) => r.rate_date.slice(0, 7) === month);
      if (inMonth.length) return inMonth[inMonth.length - 1];
    }
    let found: Row<'fx_rates'> | undefined;
    for (const r of list) {
      if (r.rate_date <= date) found = r;
      else break;
    }
    return found;
  }
}
