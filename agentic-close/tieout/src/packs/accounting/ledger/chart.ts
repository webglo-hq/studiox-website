/** Per-transaction cache of the chart of accounts, entities and periods (small, hot lookups). */
import type { AccountRow, DbTx, EntityRow, PeriodRow } from '../../../schema';
import { notFound } from '../../../core/util/errors';

export class Chart {
  private constructor(
    readonly accounts: AccountRow[],
    readonly byCode: Map<string, AccountRow>,
    readonly byId: Map<string, AccountRow>,
    readonly entities: EntityRow[],
  ) {}

  static async load(tx: DbTx): Promise<Chart> {
    const accounts = await tx.find('accounts', {}, { orderBy: [['code', 'asc']] });
    const entities = await tx.find('entities', {}, { orderBy: [['sort_order', 'asc']] });
    return new Chart(accounts, new Map(accounts.map((a) => [a.code, a])), new Map(accounts.map((a) => [a.id, a])), entities);
  }

  account(codeOrId: string): AccountRow {
    const a = this.byCode.get(codeOrId) ?? this.byId.get(codeOrId);
    if (!a) throw notFound('Account', codeOrId);
    return a;
  }

  tryAccount(codeOrId: string): AccountRow | undefined {
    return this.byCode.get(codeOrId) ?? this.byId.get(codeOrId);
  }

  entity(idOrCode: string): EntityRow {
    const e = this.entities.find((x) => x.id === idOrCode || x.code === idOrCode);
    if (!e) throw notFound('Entity', idOrCode);
    return e;
  }

  legalEntities(): EntityRow[] {
    return this.entities.filter((e) => e.kind === 'legal');
  }

  shortCode(entityId: string): string {
    return this.entity(entityId).code.replace(/^[A-Z]+-/, '');
  }
}

export async function findPeriod(tx: DbTx, entityId: string, periodKey: string): Promise<PeriodRow> {
  const p = await tx.findOne('periods', { entity_id: entityId, period_key: periodKey });
  if (!p) throw notFound('Period', `${periodKey} for entity ${entityId}`);
  return p;
}
