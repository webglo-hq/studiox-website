import { isCondObject, type Db, type FindOptions, type NamedQuery, type Where } from './db';
import { materializeInsert, primaryKey, type ColKind, type Insert, type Row, type Schema, type TableName, type TableSpec } from './schema';

/** Minimal driver contract implemented for node-postgres and PGlite. */
export interface SqlDriver {
  readonly kind: 'pglite' | 'postgres';
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }>;
  exec(sql: string): Promise<void>;
  /** Run fn on a single connection inside BEGIN/COMMIT (ROLLBACK on throw). */
  transaction<R>(fn: (conn: SqlDriver) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

function q(ident: string): string {
  if (!IDENT.test(ident)) throw new Error(`illegal identifier ${ident}`);
  return `"${ident}"`;
}

const ARRAY_CAST: Record<ColKind, string> = {
  uuid: 'uuid[]',
  text: 'text[]',
  int: 'int[]',
  bigint: 'bigint[]',
  numeric: 'numeric[]',
  bool: 'boolean[]',
  date: 'date[]',
  timestamptz: 'timestamptz[]',
  json: 'jsonb[]',
};

function encode(kind: ColKind, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (kind === 'json') return JSON.stringify(v);
  return v;
}

function decode(kind: ColKind, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case 'int':
    case 'bigint':
    case 'numeric': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) throw new Error(`cannot decode numeric ${String(v)}`);
      return n;
    }
    case 'date':
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v).slice(0, 10);
    case 'timestamptz':
      return (v instanceof Date ? v : new Date(String(v))).toISOString();
    case 'json':
      return typeof v === 'string' ? JSON.parse(v) : v;
    default:
      return v;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * SQL adapter of the store port. Every identifier comes from the schema registry (whitelist)
 * and every value is a bound parameter, so no request data can alter query structure.
 */
export class SqlStore<S extends Schema> implements Db<S> {
  readonly kind: 'pglite' | 'postgres';
  private savepointSeq = 0;

  constructor(
    private readonly schema: S,
    private readonly driver: SqlDriver,
    private readonly depth = 0,
    private readonly sequenceTable = 'je_sequence',
  ) {
    this.kind = driver.kind;
    if (!IDENT.test(sequenceTable)) throw new Error('illegal sequence table');
  }

  private spec(table: string): TableSpec {
    const s = this.schema[table];
    if (!s) throw new Error(`unknown table ${table}`);
    return s;
  }

  private colKind(spec: TableSpec, col: string): ColKind {
    const c = spec.columns[col];
    if (!c) throw new Error(`unknown column ${spec.name}.${col}`);
    return c.spec.kind;
  }

  private decodeRow(spec: TableSpec, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, col] of Object.entries(spec.columns)) out[name] = decode(col.spec.kind, row[name]);
    return out;
  }

  private whereSql(spec: TableSpec, where: Record<string, unknown> | undefined, values: unknown[]): string {
    if (!where) return '';
    const parts: string[] = [];
    const param = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };
    for (const [col, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      const kind = this.colKind(spec, col);
      const c = q(col);
      if (cond === null) {
        parts.push(`${c} IS NULL`);
      } else if (isCondObject(cond)) {
        const o = cond as Record<string, unknown>;
        if ('eq' in o) parts.push(o.eq === null ? `${c} IS NULL` : `${c} = ${param(encode(kind, o.eq))}`);
        if ('ne' in o) parts.push(o.ne === null ? `${c} IS NOT NULL` : `${c} IS DISTINCT FROM ${param(encode(kind, o.ne))}`);
        if ('in' in o) {
          const arr = (o.in as unknown[]).map((v) => encode(kind, v));
          parts.push(arr.length ? `${c} = ANY(${param(arr)}::${ARRAY_CAST[kind]})` : 'FALSE');
        }
        if ('notIn' in o) {
          const arr = (o.notIn as unknown[]).map((v) => encode(kind, v));
          if (arr.length) parts.push(`NOT (${c} = ANY(${param(arr)}::${ARRAY_CAST[kind]}))`);
        }
        if ('gt' in o) parts.push(`${c} > ${param(encode(kind, o.gt))}`);
        if ('gte' in o) parts.push(`${c} >= ${param(encode(kind, o.gte))}`);
        if ('lt' in o) parts.push(`${c} < ${param(encode(kind, o.lt))}`);
        if ('lte' in o) parts.push(`${c} <= ${param(encode(kind, o.lte))}`);
        if ('isNull' in o) parts.push(o.isNull ? `${c} IS NULL` : `${c} IS NOT NULL`);
        if ('contains' in o) parts.push(`${c} ILIKE ${param(`%${escapeLike(String(o.contains))}%`)}`);
      } else {
        parts.push(`${c} = ${param(encode(kind, cond))}`);
      }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  }

  private orderSql(spec: TableSpec, opts: FindOptions<Record<string, unknown>> | undefined, values: unknown[]): string {
    let sql = '';
    if (opts?.orderBy?.length) {
      sql += ` ORDER BY ${opts.orderBy
        .map(([col, dir]) => {
          this.colKind(spec, col);
          return `${q(col)} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
        })
        .join(', ')}`;
    }
    if (opts?.limit !== undefined) {
      values.push(Math.max(0, Math.floor(opts.limit)));
      sql += ` LIMIT $${values.length}`;
    }
    if (opts?.offset) {
      values.push(Math.max(0, Math.floor(opts.offset)));
      sql += ` OFFSET $${values.length}`;
    }
    return sql;
  }

  async insert<T extends TableName<S>>(table: T, row: Insert<S, T>): Promise<Row<S, T>> {
    const spec = this.spec(table);
    const full = materializeInsert(spec, row as Record<string, unknown>);
    const cols = Object.keys(spec.columns);
    const values = cols.map((c) => encode(this.colKind(spec, c), full[c]));
    const res = await this.driver.query(
      `INSERT INTO ${q(spec.name)} (${cols.map(q).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      values,
    );
    return this.decodeRow(spec, res.rows[0]!) as Row<S, T>;
  }

  async insertMany<T extends TableName<S>>(table: T, rows: Insert<S, T>[]): Promise<number> {
    if (!rows.length) return 0;
    const spec = this.spec(table);
    const cols = Object.keys(spec.columns);
    const chunk = Math.max(1, Math.floor(30_000 / cols.length));
    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk);
      const values: unknown[] = [];
      const tuples = slice.map((r) => {
        const full = materializeInsert(spec, r as Record<string, unknown>);
        const ph = cols.map((c) => {
          values.push(encode(this.colKind(spec, c), full[c]));
          return `$${values.length}`;
        });
        return `(${ph.join(', ')})`;
      });
      await this.driver.query(`INSERT INTO ${q(spec.name)} (${cols.map(q).join(', ')}) VALUES ${tuples.join(', ')}`, values);
    }
    return rows.length;
  }

  async update<T extends TableName<S>>(table: T, id: string, patch: Partial<Row<S, T>>): Promise<Row<S, T>> {
    const spec = this.spec(table);
    const entries = Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (!entries.length) {
      const cur = await this.get(table, id);
      if (!cur) throw Object.assign(new Error(`${table} ${id} not found`), { code: 'P0002' });
      return cur;
    }
    const values: unknown[] = [];
    const sets = entries.map(([c, v]) => {
      values.push(encode(this.colKind(spec, c), v));
      return `${q(c)} = $${values.length}`;
    });
    values.push(id);
    const res = await this.driver.query(`UPDATE ${q(spec.name)} SET ${sets.join(', ')} WHERE ${q(primaryKey(spec))} = $${values.length} RETURNING *`, values);
    if (!res.rows[0]) throw Object.assign(new Error(`${table} ${id} not found`), { code: 'P0002' });
    return this.decodeRow(spec, res.rows[0]) as Row<S, T>;
  }

  async updateWhere<T extends TableName<S>>(table: T, where: Where<Row<S, T>>, patch: Partial<Row<S, T>>): Promise<number> {
    const spec = this.spec(table);
    const entries = Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (!entries.length) return 0;
    const values: unknown[] = [];
    const sets = entries.map(([c, v]) => {
      values.push(encode(this.colKind(spec, c), v));
      return `${q(c)} = $${values.length}`;
    });
    const w = this.whereSql(spec, where as Record<string, unknown>, values);
    const res = await this.driver.query(`UPDATE ${q(spec.name)} SET ${sets.join(', ')}${w} RETURNING ${q(primaryKey(spec))}`, values);
    return res.rows.length;
  }

  async get<T extends TableName<S>>(table: T, id: string): Promise<Row<S, T> | null> {
    const spec = this.spec(table);
    const res = await this.driver.query(`SELECT * FROM ${q(spec.name)} WHERE ${q(primaryKey(spec))} = $1`, [id]);
    return res.rows[0] ? (this.decodeRow(spec, res.rows[0]) as Row<S, T>) : null;
  }

  async find<T extends TableName<S>>(table: T, where?: Where<Row<S, T>>, opts?: FindOptions<Row<S, T>>): Promise<Row<S, T>[]> {
    const spec = this.spec(table);
    const values: unknown[] = [];
    const sql = `SELECT * FROM ${q(spec.name)}${this.whereSql(spec, where as Record<string, unknown>, values)}${this.orderSql(spec, opts as FindOptions<Record<string, unknown>>, values)}`;
    const res = await this.driver.query(sql, values);
    return res.rows.map((r) => this.decodeRow(spec, r) as Row<S, T>);
  }

  async findOne<T extends TableName<S>>(table: T, where: Where<Row<S, T>>, opts?: FindOptions<Row<S, T>>): Promise<Row<S, T> | null> {
    const rows = await this.find(table, where, { ...opts, limit: 1 });
    return rows[0] ?? null;
  }

  async count<T extends TableName<S>>(table: T, where?: Where<Row<S, T>>): Promise<number> {
    const spec = this.spec(table);
    const values: unknown[] = [];
    const res = await this.driver.query(`SELECT count(*)::int AS n FROM ${q(spec.name)}${this.whereSql(spec, where as Record<string, unknown>, values)}`, values);
    return Number(res.rows[0]?.n ?? 0);
  }

  async delete<T extends TableName<S>>(table: T, id: string): Promise<void> {
    const spec = this.spec(table);
    if (!spec.deletable) throw Object.assign(new Error(`EK-NO-DELETE: rows in ${table} cannot be deleted`), { code: 'P0001' });
    await this.driver.query(`DELETE FROM ${q(spec.name)} WHERE ${q(primaryKey(spec))} = $1`, [id]);
  }

  async query<P, R>(nq: NamedQuery<S, P, R>, params: P): Promise<R[]> {
    const { text, values } = nq.sql(params);
    const res = await this.driver.query(text, values);
    return res.rows.map((r) => nq.mapRow(r));
  }

  async nextSequence(tenantId: string, key: string): Promise<number> {
    const t = q(this.sequenceTable);
    const res = await this.driver.query(
      `INSERT INTO ${t} (id, tenant_id, next_value) VALUES ($1, $2, 2)
       ON CONFLICT (id) DO UPDATE SET next_value = ${t}.next_value + 1
       RETURNING next_value - 1 AS value`,
      [`${tenantId}:${key}`, tenantId],
    );
    return Number(res.rows[0]!.value);
  }

  async tx<R>(fn: (db: Db<S>) => Promise<R>): Promise<R> {
    if (this.depth === 0) {
      return this.driver.transaction((conn) => fn(new SqlStore(this.schema, conn, 1, this.sequenceTable)));
    }
    const sp = `sp_${this.depth}_${++this.savepointSeq}`;
    await this.driver.query(`SAVEPOINT ${sp}`);
    try {
      const out = await fn(new SqlStore(this.schema, this.driver, this.depth + 1, this.sequenceTable));
      await this.driver.query(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (e) {
      await this.driver.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw e;
    }
  }

  /** Raw access for migrations and integration tests only. */
  raw(): SqlDriver {
    return this.driver;
  }

  async close(): Promise<void> {
    if (this.depth === 0) await this.driver.close();
  }
}
