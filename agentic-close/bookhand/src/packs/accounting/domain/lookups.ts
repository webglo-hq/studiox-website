import type { Tx } from '../../../persistence/db';
import type { Row } from '../../../persistence/schema';
import { isUuid } from '../../../shared/ids';

/**
 * Reference data for one tenant, loaded once per unit of work: accounts, entities, dimensions, periods.
 * Resolves human references (account "6420", entity "BW-US", department "MKT") to rows.
 */
export class LedgerLookups {
  readonly accountsById = new Map<string, Row<'accounts'>>();
  readonly accountsByNumber = new Map<string, Row<'accounts'>>();
  readonly entitiesById = new Map<string, Row<'entities'>>();
  readonly entitiesByCode = new Map<string, Row<'entities'>>();
  readonly departments = new Map<string, Row<'departments'>>();
  readonly locations = new Map<string, Row<'locations'>>();
  readonly classes = new Map<string, Row<'classes'>>();
  readonly projects = new Map<string, Row<'projects'>>();
  readonly periodsById = new Map<string, Row<'periods'>>();
  private readonly periodsByEntity = new Map<string, Row<'periods'>[]>();

  constructor(
    readonly tenantId: string,
    data: {
      accounts: Row<'accounts'>[];
      entities: Row<'entities'>[];
      departments: Row<'departments'>[];
      locations: Row<'locations'>[];
      classes: Row<'classes'>[];
      projects: Row<'projects'>[];
      periods: Row<'periods'>[];
    },
  ) {
    for (const a of data.accounts) {
      this.accountsById.set(a.id, a);
      this.accountsByNumber.set(a.number, a);
    }
    for (const e of data.entities) {
      this.entitiesById.set(e.id, e);
      this.entitiesByCode.set(e.code, e);
    }
    const dims = [
      [data.departments, this.departments],
      [data.locations, this.locations],
      [data.classes, this.classes],
      [data.projects, this.projects],
    ] as const;
    for (const [rows, map] of dims) {
      for (const r of rows) {
        (map as Map<string, typeof r>).set(r.id, r);
        (map as Map<string, typeof r>).set(r.code, r);
      }
    }
    for (const p of data.periods) {
      this.periodsById.set(p.id, p);
      const list = this.periodsByEntity.get(p.entity_id) ?? [];
      list.push(p);
      this.periodsByEntity.set(p.entity_id, list);
    }
    for (const list of this.periodsByEntity.values()) list.sort((a, b) => a.start_date.localeCompare(b.start_date));
  }

  static async load(tx: Tx, tenantId: string): Promise<LedgerLookups> {
    const t = { tenant_id: tenantId };
    const [accounts, entities, departments, locations, classes, projects, periods] = await Promise.all([
      tx.find('accounts', t),
      tx.find('entities', t),
      tx.find('departments', t),
      tx.find('locations', t),
      tx.find('classes', t),
      tx.find('projects', t),
      tx.find('periods', t),
    ]);
    return new LedgerLookups(tenantId, { accounts, entities, departments, locations, classes, projects, periods });
  }

  account(ref: string | null | undefined): Row<'accounts'> | undefined {
    if (!ref) return undefined;
    return isUuid(ref) ? this.accountsById.get(ref) : this.accountsByNumber.get(ref.trim());
  }

  entity(ref: string | null | undefined): Row<'entities'> | undefined {
    if (!ref) return undefined;
    return isUuid(ref) ? this.entitiesById.get(ref) : this.entitiesByCode.get(ref.trim());
  }

  department(ref: string | null | undefined) {
    return ref ? this.departments.get(ref) : undefined;
  }

  periodFor(entityId: string, date: string): Row<'periods'> | undefined {
    return this.periodsByEntity.get(entityId)?.find((p) => p.start_date <= date && date <= p.end_date);
  }

  periodsOf(entityId: string): Row<'periods'>[] {
    return this.periodsByEntity.get(entityId) ?? [];
  }

  /** Periods of an entity matching a fiscal year/period number. */
  period(entityId: string, fiscalYear: number, periodNumber: number): Row<'periods'> | undefined {
    return this.periodsOf(entityId).find((p) => p.fiscal_year === fiscalYear && p.period_number === periodNumber);
  }

  nextPeriod(period: Row<'periods'>): Row<'periods'> | undefined {
    const list = this.periodsOf(period.entity_id);
    const idx = list.findIndex((p) => p.id === period.id);
    return idx >= 0 ? list[idx + 1] : undefined;
  }

  previousPeriod(period: Row<'periods'>): Row<'periods'> | undefined {
    const list = this.periodsOf(period.entity_id);
    const idx = list.findIndex((p) => p.id === period.id);
    return idx > 0 ? list[idx - 1] : undefined;
  }

  operatingEntities(): Row<'entities'>[] {
    return Array.from(this.entitiesById.values()).filter((e) => e.kind === 'operating');
  }

  eliminationEntity(): Row<'entities'> | undefined {
    return Array.from(this.entitiesById.values()).find((e) => e.kind === 'elimination');
  }

  accountsBySubtype(subtype: string): Row<'accounts'>[] {
    return Array.from(this.accountsById.values()).filter((a) => a.subtype === subtype && a.is_postable && a.status === 'active');
  }
}
