import type { Row } from '../../../framework/store/schema';
import { AppError } from '../../../framework/util/errors';
import type { AccountInfo, EntityInfo, PeriodInfo } from '../ontology/axioms';
import type { EkSchema } from '../store';
import { memo, type ServiceContext } from './context';

export type AccountRow = Row<EkSchema, 'account'>;
export type EntityRow = Row<EkSchema, 'entity'>;
export type PeriodRow = Row<EkSchema, 'fiscal_period'>;
export type DimensionValueRow = Row<EkSchema, 'dimension_value'>;
export type UserRow = Row<EkSchema, 'app_user'>;

export function toAccountInfo(a: AccountRow): AccountInfo {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    accountClass: a.account_class,
    normalBalance: a.normal_balance,
    isPostable: a.is_postable,
    isActive: a.is_active,
    requiresDepartment: a.requires_department,
    isControlAccount: a.is_control_account,
    subledger: a.subledger,
    isIntercompany: a.is_intercompany,
    isMonetary: a.is_monetary,
    concept: a.concept,
  };
}

export function toEntityInfo(e: EntityRow): EntityInfo {
  return { id: e.id, code: e.code, functionalCurrency: e.functional_currency, isElimination: e.is_elimination };
}

export function toPeriodInfo(p: PeriodRow): PeriodInfo {
  return { key: p.period_key, status: p.status, startDate: p.start_date, endDate: p.end_date };
}

export async function tenantRow(ctx: ServiceContext) {
  return memo(ctx, 'tenant', async () => {
    const t = await ctx.db.get('tenant', ctx.tenantId);
    if (!t) throw new AppError('NOT_FOUND', 'Tenant not found');
    return t;
  });
}

export async function accounts(ctx: ServiceContext): Promise<Map<string, AccountRow>> {
  return memo(ctx, 'accounts', async () => {
    const rows = await ctx.db.find('account', { tenant_id: ctx.tenantId }, { orderBy: [['code', 'asc']] });
    return new Map(rows.map((r) => [r.id, r]));
  });
}

export async function accountInfoMap(ctx: ServiceContext): Promise<Map<string, AccountInfo>> {
  return memo(ctx, 'accounts:info', async () => new Map([...(await accounts(ctx)).values()].map((a) => [a.id, toAccountInfo(a)])));
}

export async function accountByCode(ctx: ServiceContext, code: string): Promise<AccountRow> {
  for (const a of (await accounts(ctx)).values()) if (a.code === code) return a;
  throw new AppError('NOT_FOUND', `Account ${code} not found`);
}

export async function accountById(ctx: ServiceContext, id: string): Promise<AccountRow> {
  const a = (await accounts(ctx)).get(id);
  if (!a) throw new AppError('NOT_FOUND', `Account ${id} not found`);
  return a;
}

export async function entities(ctx: ServiceContext): Promise<Map<string, EntityRow>> {
  return memo(ctx, 'entities', async () => {
    const rows = await ctx.db.find('entity', { tenant_id: ctx.tenantId }, { orderBy: [['code', 'asc']] });
    return new Map(rows.map((r) => [r.id, r]));
  });
}

export async function entityById(ctx: ServiceContext, id: string): Promise<EntityRow> {
  const e = (await entities(ctx)).get(id);
  if (!e) throw new AppError('NOT_FOUND', 'Entity not found');
  return e;
}

export async function entityByCode(ctx: ServiceContext, code: string): Promise<EntityRow> {
  for (const e of (await entities(ctx)).values()) if (e.code === code) return e;
  throw new AppError('NOT_FOUND', `Entity ${code} not found`);
}

export async function operatingEntities(ctx: ServiceContext): Promise<EntityRow[]> {
  return [...(await entities(ctx)).values()].filter((e) => !e.is_elimination);
}

export async function eliminationEntity(ctx: ServiceContext): Promise<EntityRow | undefined> {
  return [...(await entities(ctx)).values()].find((e) => e.is_elimination);
}

export async function periodOf(ctx: ServiceContext, entityId: string, periodKey: string): Promise<PeriodRow> {
  // Not memoised: period status changes during a request (soft/hard close).
  const p = await ctx.db.findOne('fiscal_period', { tenant_id: ctx.tenantId, entity_id: entityId, period_key: periodKey });
  if (!p) throw new AppError('NOT_FOUND', `No fiscal period ${periodKey} for this entity`);
  return p;
}

export async function dimensionValues(ctx: ServiceContext, typeCode: 'department' | 'location' | 'class' | 'project'): Promise<DimensionValueRow[]> {
  return memo(ctx, `dims:${typeCode}`, async () => {
    const type = await ctx.db.findOne('dimension_type', { tenant_id: ctx.tenantId, code: typeCode });
    if (!type) return [];
    return ctx.db.find('dimension_value', { tenant_id: ctx.tenantId, dimension_type_id: type.id }, { orderBy: [['code', 'asc']] });
  });
}

export async function dimensionById(ctx: ServiceContext): Promise<Map<string, DimensionValueRow>> {
  return memo(ctx, 'dims:all', async () => {
    const rows = await ctx.db.find('dimension_value', { tenant_id: ctx.tenantId });
    return new Map(rows.map((r) => [r.id, r]));
  });
}

export async function departmentByCode(ctx: ServiceContext, code: string): Promise<DimensionValueRow> {
  const d = (await dimensionValues(ctx, 'department')).find((x) => x.code === code);
  if (!d) throw new AppError('NOT_FOUND', `Department ${code} not found`);
  return d;
}

export async function usersById(ctx: ServiceContext): Promise<Map<string, UserRow>> {
  return memo(ctx, 'users', async () => {
    const rows = await ctx.db.find('app_user', { tenant_id: ctx.tenantId });
    return new Map(rows.map((r) => [r.id, r]));
  });
}

export async function userName(ctx: ServiceContext, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  return (await usersById(ctx)).get(id)?.display_name ?? null;
}

/**
 * Exchange rate lookup: the latest rate of the requested type on or before `date`.
 * Returns 1 for same-currency conversions.
 */
export async function fxRate(ctx: ServiceContext, from: string, to: string, date: string, type: 'spot' | 'average' | 'closing' | 'historical'): Promise<number> {
  if (from === to) return 1;
  const key = `fx:${from}:${to}:${type}`;
  const rows = await memo(ctx, key, () => ctx.db.find('fx_rate', { tenant_id: ctx.tenantId, from_ccy: from, to_ccy: to, rate_type: type }, { orderBy: [['rate_date', 'asc']] }));
  let best: number | undefined;
  for (const r of rows) {
    if (r.rate_date <= date) best = r.rate;
    else break;
  }
  if (best !== undefined) return best;
  // Try inverse
  const inv = await memo(ctx, `fx:${to}:${from}:${type}`, () => ctx.db.find('fx_rate', { tenant_id: ctx.tenantId, from_ccy: to, to_ccy: from, rate_type: type }, { orderBy: [['rate_date', 'asc']] }));
  let bestInv: number | undefined;
  for (const r of inv) {
    if (r.rate_date <= date) bestInv = r.rate;
    else break;
  }
  if (bestInv !== undefined) return 1 / bestInv;
  throw new AppError('NOT_FOUND', `No ${type} ${from}/${to} rate on or before ${date}`);
}
