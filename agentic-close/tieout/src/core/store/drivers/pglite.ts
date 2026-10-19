/** Embedded Postgres (PGlite, Postgres 17 compiled to WASM) for zero-install local runs and tests. */
import { PGlite } from '@electric-sql/pglite';
import { PG_OID, parsePgTimestamp, type SqlDriver, type SqlQueryable, type SqlRow } from '../sql';

export async function createPgliteDriver(dataDir?: string): Promise<SqlDriver> {
  const db = new PGlite({
    ...(dataDir ? { dataDir } : {}),
    parsers: {
      [PG_OID.INT8]: (v: string) => Number(v),
      [PG_OID.NUMERIC]: (v: string) => Number(v),
      [PG_OID.DATE]: (v: string) => v,
      [PG_OID.TIMESTAMPTZ]: (v: string) => parsePgTimestamp(v),
      [PG_OID.TIMESTAMP]: (v: string) => parsePgTimestamp(v),
    },
  });
  await db.waitReady;
  await db.exec("SET TIME ZONE 'UTC'");
  const wrap = (q: { query: PGlite['query']; exec: PGlite['exec'] }): SqlQueryable => ({
    query: async (text, params) => {
      const r = await q.query<SqlRow>(text, params ? [...params] : undefined);
      return { rows: r.rows };
    },
    exec: async (sql) => {
      await q.exec(sql);
    },
  });
  const base = wrap(db);
  return {
    name: 'pglite',
    ...base,
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx as unknown as PGlite))),
    close: () => db.close(),
  };
}
