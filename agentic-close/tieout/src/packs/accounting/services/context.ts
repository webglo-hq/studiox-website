/**
 * Per-transaction service context for the accounting pack: the store handle, the acting
 * principal (user, agent or policy), the clock and small cached lookups (chart, entities,
 * materiality). Every domain service takes one of these; nothing reaches the store any other way.
 */
import type { Actor } from '../../../core/agent/types';
import { forbidden, notFound } from '../../../core/util/errors';
import { addDays, periodEnd, type Clock } from '../../../core/util/time';
import type { TenantSettings } from '../../../core/tenancy';
import type { DbTx, EntityRow, PeriodRow } from '../../../schema';
import { Chart } from '../ledger/chart';
import type { LedgerCtx } from '../ledger/journal';
import type { MaterialitySettings } from '../model/types';

export class AcctContext {
  private chartCache?: Chart;
  private settingsCache?: TenantSettings;

  constructor(
    readonly tx: DbTx,
    readonly actor: Actor,
    readonly clock: Clock,
  ) {}

  async chart(): Promise<Chart> {
    if (!this.chartCache) this.chartCache = await Chart.load(this.tx);
    return this.chartCache;
  }

  /** Forget cached reference data (after creating accounts or entities in the same unit of work). */
  invalidate() {
    this.chartCache = undefined;
  }

  async ledger(): Promise<LedgerCtx> {
    return { tx: this.tx, actor: this.actor, clock: this.clock, chart: await this.chart() };
  }

  async entity(idOrCode: string): Promise<EntityRow> {
    return (await this.chart()).entity(idOrCode);
  }

  async legalEntities(): Promise<EntityRow[]> {
    const all = (await this.chart()).legalEntities();
    return this.actor.entityScope ? all.filter((e) => this.actor.entityScope!.includes(e.id)) : all;
  }

  assertEntityInScope(entityId: string | null) {
    if (entityId && this.actor.entityScope && !this.actor.entityScope.includes(entityId)) throw forbidden('That entity is outside your access scope.');
  }

  async materiality(entityId: string): Promise<MaterialitySettings> {
    return (await this.entity(entityId)).materiality;
  }

  async period(entityId: string, periodKey: string): Promise<PeriodRow> {
    const p = await this.tx.findOne('periods', { entity_id: entityId, period_key: periodKey });
    if (!p) throw notFound('Period', `${periodKey} for ${entityId}`);
    return p;
  }

  async settings(): Promise<TenantSettings> {
    if (!this.settingsCache) {
      const t = await this.tx.get('tenants', this.tx.tenantId);
      this.settingsCache = t?.settings ?? {};
    }
    return this.settingsCache;
  }

  /** Business date: the scenario clock for demo tenants, otherwise today. */
  async businessDate(): Promise<string> {
    const s = await this.settings();
    return s.businessDate ?? this.clock.now().toISOString().slice(0, 10);
  }

  /** The latest date with data visible for "subsequent events" checks (business date, capped). */
  async subsequentWindowEnd(periodKey: string, days = 10): Promise<string> {
    const bd = await this.businessDate();
    const cap = addDays(periodEnd(periodKey), days);
    return bd < cap ? bd : cap;
  }
}
