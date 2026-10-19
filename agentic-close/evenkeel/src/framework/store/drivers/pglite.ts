import { PGlite, types, type Transaction } from '@electric-sql/pglite';
import type { SqlDriver } from '../sql';

const parsers = {
  [types.INT8]: (v: string) => Number(v),
  [types.NUMERIC]: (v: string) => Number(v),
  [types.DATE]: (v: string) => v,
  [types.TIMESTAMPTZ]: (v: string) => new Date(v).toISOString(),
};

type Queryable = Pick<PGlite, 'query' | 'exec'> | Transaction;

class PgliteConn implements SqlDriver {
  readonly kind = 'pglite' as const;
  constructor(
    private readonly q: Queryable,
    private readonly root: PGlite | null,
  ) {}

  async query(text: string, values: unknown[] = []) {
    const res = await this.q.query<Record<string, unknown>>(text, values, { parsers });
    return { rows: res.rows, affectedRows: res.affectedRows };
  }

  async exec(sql: string): Promise<void> {
    await this.q.exec(sql);
  }

  async transaction<R>(fn: (conn: SqlDriver) => Promise<R>): Promise<R> {
    if (!this.root) return fn(this);
    return this.root.transaction((tx) => fn(new PgliteConn(tx, null)));
  }

  async close(): Promise<void> {
    if (this.root) await this.root.close();
  }
}

/** Embedded Postgres (WASM). `dataDir` persists to disk; omit for an in-memory database. */
export async function createPgliteDriver(dataDir?: string): Promise<SqlDriver> {
  const db = new PGlite({ dataDir, parsers, relaxedDurability: false });
  await db.waitReady;
  return new PgliteConn(db, db);
}
