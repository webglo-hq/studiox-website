import type { Materiality } from '../../agents/framework/types';
import type { Tx } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import type { DomainContext } from '../../shared/context';
import type { BusinessCalendar } from '../../shared/dates';
import { DomainError } from '../../shared/errors';
import { convertMinor } from '../../shared/money';
import { businessCalendar } from './domain/close';
import { FxTable } from './domain/fx';
import { LedgerLookups } from './domain/lookups';

/** Per-call context for accounting tools and proposal handlers. */
export interface AccountingScope {
  tenant: Row<'tenants'>;
  lookups: LedgerLookups;
  calendar: BusinessCalendar;
  reportingCurrency: string;
  fx(): Promise<FxTable>;
  /** Convert a functional amount of an entity into the reporting currency at the month's closing (or latest spot) rate. */
  toReporting(entityId: string, amountMinor: number, date: string): Promise<number>;
}

export async function buildAccountingScope(tx: Tx, ctx: DomainContext): Promise<AccountingScope> {
  const tenant = await tx.get('tenants', ctx.tenantId);
  if (!tenant) throw new DomainError('NOT_FOUND', 'tenant not found');
  const lookups = await LedgerLookups.load(tx, ctx.tenantId);
  const calendar = await businessCalendar(tx, ctx.tenantId);
  let fx: FxTable | null = null;
  const loadFx = async () => (fx ??= await FxTable.load(tx, ctx.tenantId));
  return {
    tenant,
    lookups,
    calendar,
    reportingCurrency: tenant.reporting_currency,
    fx: loadFx,
    async toReporting(entityId, amountMinor, date) {
      const entity = lookups.entitiesById.get(entityId);
      if (!entity || entity.functional_currency === tenant.reporting_currency) return amountMinor;
      const table = await loadFx();
      const type = table.has(entity.functional_currency, tenant.reporting_currency, date, 'closing') ? 'closing' : 'spot';
      return convertMinor(amountMinor, table.rate(entity.functional_currency, tenant.reporting_currency, date, type));
    },
  };
}

export async function materialityFor(tx: Tx, tenantId: string, fiscalYear: number): Promise<Materiality> {
  const rows = await tx.find('materiality_settings', { tenant_id: tenantId, fiscal_year: fiscalYear }, { orderBy: [['version', 'desc']] });
  const m = rows[0];
  if (!m) return { overallMinor: 10_000_000, performanceMinor: 7_500_000, trivialMinor: 500_000, source: 'default (no materiality set for this year)' };
  return { overallMinor: m.overall_minor, performanceMinor: m.performance_minor, trivialMinor: m.trivial_minor, source: `FY${fiscalYear} materiality v${m.version} (${m.benchmark}, ${(m.overall_pct * 100).toFixed(1)}%)` };
}
