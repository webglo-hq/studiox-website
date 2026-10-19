import { PGlite } from '@electric-sql/pglite';
import { toIsoTimestamp } from '../rows';
import { mapPgError, type Queryable, type SqlDriver } from '../sql';

const PARSERS = {
  1082: (v: string) => v, // date stays YYYY-MM-DD
  1114: (v: string) => toIsoTimestamp(`${v}+00`),
  1184: (v: string) => toIsoTimestamp(v),
  20: (v: string) => Number(v), // int8: values are validated to the safe-integer range
  1700: (v: string) => Number(v), // numeric
};

/**
 * Embedded Postgres (PGlite: the Postgres engine compiled to WASM, running in-process). `dataDir` persists to
 * disk (e.g. .data/pglite); omit it for an in-memory database (tests).
 */
export async function createPgliteDriver(dataDir?: string): Promise<SqlDriver> {
  const db = dataDir ? new PGlite(dataDir, { parsers: PARSERS }) : new PGlite({ parsers: PARSERS });
  await db.waitReady;
  const wrap = (exec: Pick<PGlite, 'query'>): Queryable => ({
    async query<R>(text: string, params?: unknown[]) {
      const result = await exec.query<R>(text, params ?? []);
      return { rows: result.rows };
    },
  });
  return {
    label: dataDir ? 'PGlite (embedded Postgres 17, on disk)' : 'PGlite (embedded Postgres 17, in-memory)',
    async transaction(fn, opts) {
      return db.transaction(async (tx) => {
        if (opts?.readOnly) await tx.query('SET TRANSACTION READ ONLY');
        return fn(wrap(tx));
      });
    },
    async exec(sql) {
      try {
        await db.exec(sql);
      } catch (e) {
        throw mapPgError(e);
      }
    },
    async applyScript(script, record) {
      await db.transaction(async (tx) => {
        await tx.exec(script);
        await tx.query(record.text, record.params);
      });
    },
    async query(text, params) {
      const result = await db.query<never>(text, params ?? []);
      return { rows: result.rows };
    },
    async close() {
      await db.close();
    },
  };
}
