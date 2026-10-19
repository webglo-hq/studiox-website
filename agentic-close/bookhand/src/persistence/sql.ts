import type { ColumnSpec, TableSpec } from './dsl';
import {
  type Db,
  DbConstraintError,
  type DbErrorKind,
  type FindOptions,
  LINE_GROUP_KEYS,
  type LineSum,
  type LineSumsQuery,
  type Tx,
  type Where,
} from './db';
import { q } from './ddl';
import { applyDefaults, coerceRow } from './rows';
import { schema, type Insert, type Row, type TableName } from './schema';

/**
 * Postgres adapter. Every statement is parameterized; identifiers come only from the static schema and are
 * validated by q(). Constraint/trigger failures are mapped onto the same DbConstraintError kinds the memory
 * adapter raises.
 */

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface SqlDriver {
  readonly label: string;
  transaction<T>(fn: (q: Queryable) => Promise<T>, opts?: { readOnly?: boolean }): Promise<T>;
  /** Multi-statement script outside a transaction. */
  exec(sql: string): Promise<void>;
  /** Multi-statement migration script plus its bookkeeping statement, atomically. */
  applyScript(script: string, record: { text: string; params: unknown[] }): Promise<void>;
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  close(): Promise<void>;
  /** Driver-specific parameter preparation (e.g. Uint8Array -> Buffer for node-postgres). */
  prepareParam?(value: unknown): unknown;
}

function spec(table: TableName): TableSpec {
  return schema[table] as unknown as TableSpec;
}

function column(table: TableName, name: string): ColumnSpec {
  const col = spec(table).columns[name];
  if (!col) throw new DbConstraintError('invalid_input', `${table} has no column "${name}"`, { table });
  return col.spec as ColumnSpec;
}

const SQLSTATE: Record<string, DbErrorKind> = {
  '23505': 'unique_violation',
  '23503': 'foreign_key_violation',
  '23514': 'check_violation',
  '23502': 'not_null_violation',
  '22P02': 'invalid_input',
  '22003': 'invalid_input',
  '22007': 'invalid_input',
  '22008': 'invalid_input',
  '23P01': 'check_violation',
  BH001: 'invariant_violation',
  BH002: 'period_locked',
  BH003: 'immutable_row',
  BH004: 'audit_chain',
};

export function mapPgError(error: unknown): unknown {
  if (error instanceof DbConstraintError) return error;
  const e = error as { code?: string; message?: string; constraint?: string; table?: string };
  const kind = e?.code ? SQLSTATE[e.code] : undefined;
  if (!kind) return error;
  return new DbConstraintError(kind, e.message ?? 'database constraint violated', { constraint: e.constraint, table: e.table });
}

class Params {
  readonly values: unknown[] = [];
  constructor(private readonly prepare?: (v: unknown) => unknown) {}
  add(value: unknown, col?: ColumnSpec): string {
    let v = value;
    if (col?.sqlType === 'jsonb' && v !== null && v !== undefined) {
      v = JSON.stringify(v);
      this.values.push(v);
      return `$${this.values.length}::jsonb`;
    }
    if (this.prepare) v = this.prepare(v);
    this.values.push(v === undefined ? null : v);
    return `$${this.values.length}`;
  }
}

function isCond(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

function whereSql(table: TableName, where: Record<string, unknown> | undefined, params: Params, alias = ''): string {
  if (!where) return '';
  const parts: string[] = [];
  const prefix = alias ? `${alias}.` : '';
  for (const [name, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const col = column(table, name);
    const ident = `${prefix}${q(name)}`;
    if (cond === null) {
      parts.push(`${ident} IS NULL`);
      continue;
    }
    if (!isCond(cond)) {
      parts.push(`${ident} = ${params.add(cond, col)}`);
      continue;
    }
    if ('in' in cond) {
      const list = cond.in as unknown[];
      parts.push(list.length === 0 ? 'FALSE' : `${ident} IN (${list.map((v) => params.add(v, col)).join(', ')})`);
    }
    if ('notIn' in cond) {
      const list = cond.notIn as unknown[];
      parts.push(list.length === 0 ? `${ident} IS NOT NULL` : `${ident} NOT IN (${list.map((v) => params.add(v, col)).join(', ')})`);
    }
    if ('ne' in cond) parts.push(`${ident} IS DISTINCT FROM ${params.add(cond.ne, col)}`);
    if ('gt' in cond) parts.push(`${ident} > ${params.add(cond.gt, col)}`);
    if ('gte' in cond) parts.push(`${ident} >= ${params.add(cond.gte, col)}`);
    if ('lt' in cond) parts.push(`${ident} < ${params.add(cond.lt, col)}`);
    if ('lte' in cond) parts.push(`${ident} <= ${params.add(cond.lte, col)}`);
    if ('between' in cond) {
      const [lo, hi] = cond.between as [unknown, unknown];
      parts.push(`${ident} BETWEEN ${params.add(lo, col)} AND ${params.add(hi, col)}`);
    }
    if ('contains' in cond) {
      const escaped = String(cond.contains).replace(/[\\%_]/g, (m) => `\\${m}`);
      parts.push(`${ident} ILIKE ${params.add(`%${escaped}%`)}`);
    }
  }
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

function orderSql(table: TableName, opts?: FindOptions<TableName>): string {
  if (!opts?.orderBy?.length) return '';
  const parts = opts.orderBy.map(([name, dir]) => {
    column(table, name);
    if (dir !== 'asc' && dir !== 'desc') throw new DbConstraintError('invalid_input', 'order direction must be asc or desc');
    return `${q(name)} ${dir === 'asc' ? 'ASC' : 'DESC'}`;
  });
  return ` ORDER BY ${parts.join(', ')}`;
}

function pageSql(opts?: FindOptions<TableName>): string {
  let out = '';
  if (opts?.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 0) throw new DbConstraintError('invalid_input', 'limit must be a non-negative integer');
    out += ` LIMIT ${opts.limit}`;
  }
  if (opts?.offset !== undefined) {
    if (!Number.isInteger(opts.offset) || opts.offset < 0) throw new DbConstraintError('invalid_input', 'offset must be a non-negative integer');
    out += ` OFFSET ${opts.offset}`;
  }
  return out;
}

class SqlTx implements Tx {
  readonly kind = 'postgres' as const;
  constructor(
    private readonly qx: Queryable,
    private readonly driver: SqlDriver,
    private readonly clock: () => string,
    private readonly readOnly: boolean,
  ) {}

  private async run<R = Record<string, unknown>>(text: string, params: unknown[]): Promise<R[]> {
    try {
      return (await this.qx.query<R>(text, params)).rows;
    } catch (error) {
      throw mapPgError(error);
    }
  }

  private writable(): void {
    if (this.readOnly) throw new DbConstraintError('invalid_input', 'write attempted in a read-only unit of work');
  }

  async insert<T extends TableName>(table: T, row: Insert<T>): Promise<Row<T>> {
    const [first] = await this.insertMany(table, [row]);
    return first!;
  }

  async insertMany<T extends TableName>(table: T, rows: ReadonlyArray<Insert<T>>): Promise<Row<T>[]> {
    this.writable();
    if (rows.length === 0) return [];
    const s = spec(table);
    const now = this.clock();
    const full = rows.map((r) => applyDefaults(s, r as Record<string, unknown>, now));
    const cols = s.columnNames;
    const chunkSize = Math.max(1, Math.min(500, Math.floor(30000 / cols.length)));
    const out: Row<T>[] = [];
    for (let i = 0; i < full.length; i += chunkSize) {
      const chunk = full.slice(i, i + chunkSize);
      const params = new Params(this.driver.prepareParam?.bind(this.driver));
      const values = chunk.map((r) => `(${cols.map((c) => params.add(r[c], column(table, c))).join(', ')})`);
      const sql = `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES ${values.join(', ')} RETURNING *`;
      const result = await this.run(sql, params.values);
      for (const raw of result) out.push(coerceRow(s, raw) as Row<T>);
    }
    return out;
  }

  async update<T extends TableName>(table: T, id: string, patch: Partial<Row<T>>): Promise<Row<T>> {
    this.writable();
    const s = spec(table);
    const entries = Object.entries(patch as Record<string, unknown>).filter(([k, v]) => k !== 'id' && v !== undefined);
    if ('updated_at' in s.columns && !('updated_at' in (patch as object))) entries.push(['updated_at', this.clock()]);
    if (entries.length === 0) {
      const current = await this.get(table, id);
      if (!current) throw new DbConstraintError('invalid_input', `${table} ${id} does not exist`, { table });
      return current;
    }
    const params = new Params(this.driver.prepareParam?.bind(this.driver));
    const sets = entries.map(([k, v]) => `${q(k)} = ${params.add(v, column(table, k))}`);
    const idParam = params.add(id);
    const rows = await this.run(`UPDATE ${q(table)} SET ${sets.join(', ')} WHERE "id" = ${idParam} RETURNING *`, params.values);
    if (rows.length === 0) throw new DbConstraintError('invalid_input', `${table} ${id} does not exist`, { table });
    return coerceRow(s, rows[0]!) as Row<T>;
  }

  async delete<T extends TableName>(table: T, id: string): Promise<void> {
    this.writable();
    await this.run(`DELETE FROM ${q(table)} WHERE "id" = $1`, [id]);
  }

  async get<T extends TableName>(table: T, id: string, opts?: { forUpdate?: boolean }): Promise<Row<T> | null> {
    const lock = opts?.forUpdate && !this.readOnly ? ' FOR UPDATE' : '';
    const rows = await this.run(`SELECT * FROM ${q(table)} WHERE "id" = $1${lock}`, [id]);
    return rows[0] ? (coerceRow(spec(table), rows[0]) as Row<T>) : null;
  }

  async find<T extends TableName>(table: T, where?: Where<T>, opts?: FindOptions<T>): Promise<Row<T>[]> {
    const params = new Params(this.driver.prepareParam?.bind(this.driver));
    const lock = opts?.forUpdate && !this.readOnly ? ' FOR UPDATE' : '';
    const sql = `SELECT * FROM ${q(table)}${whereSql(table, where as Record<string, unknown>, params)}${orderSql(table, opts as FindOptions<TableName>)}${pageSql(opts as FindOptions<TableName>)}${lock}`;
    const rows = await this.run(sql, params.values);
    const s = spec(table);
    return rows.map((r) => coerceRow(s, r) as Row<T>);
  }

  async findOne<T extends TableName>(table: T, where: Where<T>): Promise<Row<T> | null> {
    const rows = await this.find(table, where, { limit: 1 } as FindOptions<T>);
    return rows[0] ?? null;
  }

  async count<T extends TableName>(table: T, where?: Where<T>): Promise<number> {
    const params = new Params();
    const rows = await this.run<{ n: number | string }>(
      `SELECT count(*) AS n FROM ${q(table)}${whereSql(table, where as Record<string, unknown>, params)}`,
      params.values,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async sumLines(query: LineSumsQuery): Promise<LineSum[]> {
    for (const k of query.groupBy) {
      if (!LINE_GROUP_KEYS.includes(k)) throw new DbConstraintError('invalid_input', `cannot group by ${k}`);
    }
    const params = new Params();
    const conds: string[] = [`l."tenant_id" = ${params.add(query.tenantId)}`];
    const statuses = query.statuses ?? ['posted'];
    conds.push(`e."status" IN (${statuses.map((s) => params.add(s)).join(', ')})`);
    const inList = (col: string, values: readonly string[] | undefined) => {
      if (!values) return;
      conds.push(values.length === 0 ? 'FALSE' : `l.${q(col)} IN (${values.map((v) => params.add(v)).join(', ')})`);
    };
    inList('entity_id', query.entityIds);
    inList('period_id', query.periodIds);
    inList('account_id', query.accountIds);
    if (query.dateFrom) conds.push(`l."entry_date" >= ${params.add(query.dateFrom)}`);
    if (query.dateTo) conds.push(`l."entry_date" <= ${params.add(query.dateTo)}`);
    const groupCols = query.groupBy.map((k) => `l.${q(k)}`);
    const select = [...groupCols, 'SUM(l."debit_minor") AS debit_minor', 'SUM(l."credit_minor") AS credit_minor', 'COUNT(*) AS line_count'];
    const sql = `SELECT ${select.join(', ')} FROM "journal_lines" l JOIN "journal_entries" e ON e."id" = l."journal_entry_id" WHERE ${conds.join(' AND ')}${groupCols.length ? ` GROUP BY ${groupCols.join(', ')}` : ''}`;
    const rows = await this.run<Record<string, unknown>>(sql, params.values);
    return rows
      .filter((r) => Number(r.line_count ?? 0) > 0)
      .map((r) => {
        const key: LineSum['key'] = {};
        for (const k of query.groupBy) key[k] = (r[k] as string | null) ?? null;
        return {
          key,
          debit_minor: Number(r.debit_minor ?? 0),
          credit_minor: Number(r.credit_minor ?? 0),
          line_count: Number(r.line_count ?? 0),
        };
      });
  }

  async lockAuditChain(tenantId: string): Promise<void> {
    await this.run(`SELECT pg_advisory_xact_lock(hashtextextended('bh_audit:' || $1, 0))`, [tenantId]);
  }
}

export class SqlDb implements Db {
  readonly kind = 'postgres' as const;
  readonly label: string;
  private readonly clock: () => string;

  constructor(
    readonly driver: SqlDriver,
    opts: { clock?: () => string } = {},
  ) {
    this.label = driver.label;
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.driver.transaction((qx) => fn(new SqlTx(qx, this.driver, this.clock, false)));
  }

  read<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.driver.transaction((qx) => fn(new SqlTx(qx, this.driver, this.clock, true)), { readOnly: true });
  }

  close(): Promise<void> {
    return this.driver.close();
  }
}
