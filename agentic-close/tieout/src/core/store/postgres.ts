/**
 * PgStore: the production adapter. Works against real Postgres (node-postgres pool) or the
 * embedded PGlite build. All values are bound parameters; identifiers come exclusively from the
 * generated table metadata (never from caller strings), which is why dynamic SQL here is safe.
 */
import { newId } from '../util/random';
import { sealAuditRecord } from '../audit/chain';
import type { SqlDriver, SqlQueryable, SqlRow } from './sql';
import {
  StoreError,
  type AuditAppend,
  type AuditRecord,
  type ColumnMeta,
  type Condition,
  type FindOptions,
  type LineSum,
  type LineSumQuery,
  type Store,
  type SystemTx,
  type TableMeta,
  type TableMetaMap,
  type Tx,
} from './types';

interface TableInfo {
  meta: TableMeta;
  cols: Map<string, ColumnMeta>;
  /** canonical quoted identifiers, keyed by column name */
  ident: Map<string, string>;
  quoted: string;
}

const GROUP_SQL: Record<LineSumQuery['groupBy'][number], string> = {
  account_id: 'jl.account_id',
  entity_id: 'je.entity_id',
  department: 'jl.department',
  period: "to_char(je.posting_date, 'YYYY-MM')",
  counterparty_entity_id: 'jl.counterparty_entity_id',
  txn_currency: 'jl.txn_currency',
};

export interface PgStoreOptions {
  driver: SqlDriver;
  meta: TableMetaMap;
  idPrefix: Record<string, string>;
}

export class PgStore<M, I = M> implements Store<M, I> {
  readonly kind = 'postgres' as const;
  readonly driver: SqlDriver;
  private readonly tables = new Map<string, TableInfo>();
  private readonly idPrefix: Record<string, string>;

  constructor(opts: PgStoreOptions) {
    this.driver = opts.driver;
    this.idPrefix = opts.idPrefix;
    for (const meta of Object.values(opts.meta)) {
      if (!/^[a-z_][a-z0-9_]*$/.test(meta.name)) throw new Error(`unsafe table name ${meta.name}`);
      const ident = new Map<string, string>();
      for (const c of meta.columns) {
        if (!/^[a-z_][a-z0-9_]*$/.test(c.name)) throw new Error(`unsafe column name ${c.name}`);
        ident.set(c.name, `"${c.name}"`);
      }
      this.tables.set(meta.name, { meta, cols: new Map(meta.columns.map((c) => [c.name, c])), ident, quoted: `"${meta.name}"` });
    }
  }

  private info(table: string): TableInfo {
    const t = this.tables.get(table);
    if (!t) throw new StoreError('42P01', `relation "${table}" does not exist`);
    return t;
  }

  private col(t: TableInfo, name: string): string {
    const id = t.ident.get(name);
    if (!id) throw new StoreError('42703', `column "${name}" of relation "${t.meta.name}" does not exist`);
    return id;
  }

  async tx<R>(tenantId: string, fn: (tx: Tx<M, I>) => Promise<R>): Promise<R> {
    try {
      return await this.driver.transaction(async (q) => {
        // row-level security (migration 0003) checks every row against this setting
        await q.query("SELECT set_config('tieout.tenant_id', $1, true)", [tenantId]);
        return fn(this.makeTx(q, tenantId));
      });
    } catch (e) {
      throw normaliseError(e);
    }
  }

  async system<R>(fn: (sys: SystemTx<M>) => Promise<R>): Promise<R> {
    try {
      return await this.driver.transaction(async (q) => {
        // cross-tenant system lookups (sign-in, session/token resolution) bypass RLS for this transaction only
        await q.query("SELECT set_config('tieout.bypass', 'on', true)");
        return fn({
          findGlobal: (table, where, opts) => this.find(q, table, where as Record<string, Condition>, opts as FindOptions<SqlRow>, null) as never,
          insertGlobal: (table, row) => this.insert(q, table, row as SqlRow, null) as never,
          updateGlobal: (table, id, patch) => this.update(q, table, id, patch as SqlRow, null) as never,
        });
      });
    } catch (e) {
      throw normaliseError(e);
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  private makeTx(q: SqlQueryable, tenantId: string): Tx<M, I> {
    return {
      tenantId,
      insert: (table, row) => this.insert(q, table, row as SqlRow, tenantId) as never,
      insertMany: (table, rows) => this.insertMany(q, table, rows as readonly SqlRow[], tenantId),
      update: (table, id, patch) => this.update(q, table, id, patch as SqlRow, tenantId) as never,
      updateWhere: (table, where, patch) => this.updateWhere(q, table, where as Record<string, Condition>, patch as SqlRow, tenantId),
      delete: (table, id) => this.remove(q, table, id, tenantId),
      get: async (table, id) => (await this.find(q, table, { id } as Record<string, Condition>, { limit: 1 }, tenantId))[0] as never,
      find: (table, where, opts) => this.find(q, table, (where ?? {}) as Record<string, Condition>, opts as FindOptions<SqlRow>, tenantId) as never,
      findOne: async (table, where) => (await this.find(q, table, where as Record<string, Condition>, { limit: 1 }, tenantId))[0] as never,
      count: (table, where) => this.count(q, table, (where ?? {}) as Record<string, Condition>, tenantId),
      sumLines: (query) => this.sumLines(q, query, tenantId),
      appendAudit: (e) => this.appendAudit(q, e, tenantId),
      nextCounter: (name) => this.nextCounter(q, name, tenantId),
    };
  }

  private encode(c: ColumnMeta, v: unknown): unknown {
    if (v === undefined || v === null) return null;
    if (c.type === 'jsonb') return JSON.stringify(v);
    return v;
  }

  private decode(t: TableInfo, row: SqlRow): SqlRow {
    for (const c of t.meta.columns) {
      const v = row[c.name];
      if (v === undefined || v === null) continue;
      if ((c.type === 'bigint' || c.type === 'int' || c.type === 'numeric') && typeof v !== 'number') row[c.name] = Number(v);
      else if (c.type === 'date' && v instanceof Date) row[c.name] = v.toISOString().slice(0, 10);
      else if (c.type === 'timestamptz' && v instanceof Date) row[c.name] = v.toISOString();
    }
    return row;
  }

  private where(t: TableInfo, where: Record<string, Condition>, params: unknown[], tenantId: string | null, alias = ''): string {
    const parts: string[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (tenantId !== null && t.meta.tenantScoped) parts.push(`${alias}"tenant_id" = ${p(tenantId)}`);
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      const c = alias + this.col(t, key);
      if (cond === null) parts.push(`${c} IS NULL`);
      else if (typeof cond !== 'object') parts.push(`${c} = ${p(cond)}`);
      else if ('in' in cond) parts.push(cond.in.length ? `${c} = ANY(${p([...cond.in])})` : 'FALSE');
      else if ('notIn' in cond) parts.push(cond.notIn.length ? `NOT (${c} = ANY(${p([...cond.notIn])}))` : `${c} IS NOT NULL`);
      else if ('ne' in cond) parts.push(`${c} <> ${p(cond.ne)}`);
      else if ('isNull' in cond) parts.push(cond.isNull ? `${c} IS NULL` : `${c} IS NOT NULL`);
      else if ('ilike' in cond) parts.push(`${c} ILIKE ${p('%' + cond.ilike.replace(/[\\%_]/g, (m) => '\\' + m) + '%')}`);
      else {
        const r = cond as { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown };
        if (r.gt !== undefined) parts.push(`${c} > ${p(r.gt)}`);
        if (r.gte !== undefined) parts.push(`${c} >= ${p(r.gte)}`);
        if (r.lt !== undefined) parts.push(`${c} < ${p(r.lt)}`);
        if (r.lte !== undefined) parts.push(`${c} <= ${p(r.lte)}`);
      }
    }
    return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  }

  private prepareInsert(t: TableInfo, input: SqlRow, tenantId: string | null): SqlRow {
    const row: SqlRow = { ...input };
    for (const k of Object.keys(row)) if (!t.cols.has(k)) throw new StoreError('42703', `column "${k}" of relation "${t.meta.name}" does not exist`);
    if (row.id === undefined) row.id = newId(this.idPrefix[t.meta.name] ?? t.meta.name.slice(0, 3));
    if (t.meta.tenantScoped && tenantId !== null) {
      if (row.tenant_id !== undefined && row.tenant_id !== tenantId) throw new StoreError('42501', 'cross-tenant write rejected');
      row.tenant_id = tenantId;
    }
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    return row;
  }

  private async insert(q: SqlQueryable, table: string, input: SqlRow, tenantId: string | null): Promise<SqlRow> {
    const t = this.info(table);
    const row = this.prepareInsert(t, input, tenantId);
    const keys = Object.keys(row);
    const params = keys.map((k) => this.encode(t.cols.get(k)!, row[k]));
    const sql = `INSERT INTO ${t.quoted} (${keys.map((k) => this.col(t, k)).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
    const res = await q.query(sql, params);
    return this.decode(t, res.rows[0]!);
  }

  private async insertMany(q: SqlQueryable, table: string, inputs: readonly SqlRow[], tenantId: string | null): Promise<number> {
    if (!inputs.length) return 0;
    const t = this.info(table);
    const rows = inputs.map((r) => this.prepareInsert(t, r, tenantId));
    // group rows by their key set so every statement has a uniform column list
    const groups = new Map<string, SqlRow[]>();
    for (const r of rows) {
      const k = Object.keys(r).sort().join(',');
      const g = groups.get(k) ?? [];
      g.push(r);
      groups.set(k, g);
    }
    for (const [k, group] of groups) {
      const keys = k.split(',');
      const chunk = Math.max(1, Math.floor(30000 / keys.length));
      for (let i = 0; i < group.length; i += chunk) {
        const slice = group.slice(i, i + chunk);
        const params: unknown[] = [];
        const tuples = slice.map((r) => `(${keys.map((key) => {
          params.push(this.encode(t.cols.get(key)!, r[key]));
          return `$${params.length}`;
        }).join(', ')})`);
        await q.query(`INSERT INTO ${t.quoted} (${keys.map((key) => this.col(t, key)).join(', ')}) VALUES ${tuples.join(', ')}`, params);
      }
    }
    return rows.length;
  }

  private setClause(t: TableInfo, patch: SqlRow, params: unknown[]): string {
    const sets: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'id' || k === 'tenant_id') throw new StoreError('42501', `${k} is immutable`);
      const c = this.col(t, k);
      params.push(this.encode(t.cols.get(k)!, v));
      sets.push(`${c} = $${params.length}`);
    }
    if (!sets.length) throw new StoreError('42601', 'empty update');
    return sets.join(', ');
  }

  private async update(q: SqlQueryable, table: string, id: string, patch: SqlRow, tenantId: string | null): Promise<SqlRow> {
    const t = this.info(table);
    const params: unknown[] = [];
    const set = this.setClause(t, patch, params);
    const where = this.where(t, { id }, params, tenantId);
    const res = await q.query(`UPDATE ${t.quoted} SET ${set} ${where} RETURNING *`, params);
    if (!res.rows.length) throw new StoreError('P0002', `${table} ${id} not found`);
    return this.decode(t, res.rows[0]!);
  }

  private async updateWhere(q: SqlQueryable, table: string, where: Record<string, Condition>, patch: SqlRow, tenantId: string | null): Promise<number> {
    const t = this.info(table);
    const params: unknown[] = [];
    const set = this.setClause(t, patch, params);
    const w = this.where(t, where, params, tenantId);
    const res = await q.query(`UPDATE ${t.quoted} SET ${set} ${w} RETURNING "id"`, params);
    return res.rows.length;
  }

  private async remove(q: SqlQueryable, table: string, id: string, tenantId: string | null): Promise<void> {
    const t = this.info(table);
    const params: unknown[] = [];
    const res = await q.query(`DELETE FROM ${t.quoted} ${this.where(t, { id }, params, tenantId)} RETURNING "id"`, params);
    if (!res.rows.length) throw new StoreError('P0002', `${table} ${id} not found`);
  }

  private async find(q: SqlQueryable, table: string, where: Record<string, Condition>, opts: FindOptions<SqlRow> | undefined, tenantId: string | null): Promise<SqlRow[]> {
    const t = this.info(table);
    const params: unknown[] = [];
    let sql = `SELECT * FROM ${t.quoted} ${this.where(t, where, params, tenantId)}`;
    if (opts?.orderBy?.length) sql += ` ORDER BY ${opts.orderBy.map(([c, d]) => `${this.col(t, c)} ${d === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`;
    if (opts?.limit !== undefined) {
      params.push(Math.max(0, Math.floor(opts.limit)));
      sql += ` LIMIT $${params.length}`;
    }
    if (opts?.offset) {
      params.push(Math.max(0, Math.floor(opts.offset)));
      sql += ` OFFSET $${params.length}`;
    }
    const res = await q.query(sql, params);
    return res.rows.map((r) => this.decode(t, r));
  }

  private async count(q: SqlQueryable, table: string, where: Record<string, Condition>, tenantId: string | null): Promise<number> {
    const t = this.info(table);
    const params: unknown[] = [];
    const res = await q.query(`SELECT count(*)::int AS n FROM ${t.quoted} ${this.where(t, where, params, tenantId)}`, params);
    return Number(res.rows[0]!.n);
  }

  private async sumLines(q: SqlQueryable, query: LineSumQuery, tenantId: string): Promise<LineSum[]> {
    const params: unknown[] = [tenantId, [...(query.statuses ?? ['posted'])]];
    const conds = ['je."tenant_id" = $1', 'je."status" = ANY($2)'];
    if (query.entityIds) {
      params.push([...query.entityIds]);
      conds.push(`je."entity_id" = ANY($${params.length})`);
    }
    if (query.accountIds) {
      params.push([...query.accountIds]);
      conds.push(`jl."account_id" = ANY($${params.length})`);
    }
    if (query.fromDate) {
      params.push(query.fromDate);
      conds.push(`je."posting_date" >= $${params.length}`);
    }
    if (query.toDate) {
      params.push(query.toDate);
      conds.push(`je."posting_date" <= $${params.length}`);
    }
    const groups = query.groupBy.map((g) => {
      const expr = GROUP_SQL[g];
      if (!expr) throw new StoreError('42703', `cannot group by ${String(g)}`);
      return { g, expr };
    });
    const select = [
      ...groups.map(({ g, expr }) => `${expr} AS "${g}"`),
      'COALESCE(sum(jl."debit_minor"), 0)::bigint AS debit_minor',
      'COALESCE(sum(jl."credit_minor"), 0)::bigint AS credit_minor',
      'COALESCE(sum(jl."txn_amount_minor"), 0)::bigint AS txn_amount_minor',
      'count(*)::int AS line_count',
    ];
    const sql = `SELECT ${select.join(', ')} FROM "journal_lines" jl JOIN "journal_entries" je ON je."id" = jl."journal_entry_id" WHERE ${conds.join(' AND ')}${groups.length ? ` GROUP BY ${groups.map(({ expr }) => expr).join(', ')}` : ''}`;
    const res = await q.query(sql, params);
    return res.rows.map((r) => ({
      ...r,
      debit_minor: Number(r.debit_minor),
      credit_minor: Number(r.credit_minor),
      txn_amount_minor: Number(r.txn_amount_minor),
      line_count: Number(r.line_count),
    })) as LineSum[];
  }

  private async appendAudit(q: SqlQueryable, e: AuditAppend, tenantId: string): Promise<AuditRecord> {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tieout.audit.${tenantId}`]);
    const last = await q.query('SELECT "seq", "hash" FROM "audit_log" WHERE "tenant_id" = $1 ORDER BY "seq" DESC LIMIT 1', [tenantId]);
    const prev = last.rows[0] ? { seq: Number(last.rows[0].seq), hash: String(last.rows[0].hash) } : undefined;
    const rec = sealAuditRecord(tenantId, prev, e);
    await this.insert(q, 'audit_log', rec as unknown as SqlRow, tenantId);
    return rec;
  }

  private async nextCounter(q: SqlQueryable, name: string, tenantId: string): Promise<number> {
    const res = await q.query(
      'INSERT INTO "counters" ("id", "tenant_id", "name", "value") VALUES ($1, $2, $3, 1) ON CONFLICT ("tenant_id", "name") DO UPDATE SET "value" = "counters"."value" + 1 RETURNING "value"',
      [newId('ctr'), tenantId, name],
    );
    return Number(res.rows[0]!.value);
  }
}

function normaliseError(e: unknown): unknown {
  if (e instanceof StoreError) return e;
  const err = e as { code?: string; message?: string };
  // only database errors (five-character SQLSTATE codes); application errors thrown inside the
  // transaction (forbidden, validation, SoD...) pass through untouched
  if (err && typeof err === 'object' && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) && typeof err.message === 'string') {
    return new StoreError(err.code === '23000' ? '23514' : err.code, err.message);
  }
  return e;
}
