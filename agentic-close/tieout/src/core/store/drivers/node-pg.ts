/** Real Postgres via node-postgres connection pool (production / integration tests). */
import pg from 'pg';
import { PG_OID, parsePgTimestamp, type SqlDriver, type SqlQueryable, type SqlRow } from '../sql';

let parsersInstalled = false;
function installParsers() {
  if (parsersInstalled) return;
  pg.types.setTypeParser(PG_OID.INT8, (v: string) => Number(v));
  pg.types.setTypeParser(PG_OID.NUMERIC, (v: string) => Number(v));
  pg.types.setTypeParser(PG_OID.DATE, (v: string) => v);
  pg.types.setTypeParser(PG_OID.TIMESTAMPTZ, (v: string) => parsePgTimestamp(v));
  pg.types.setTypeParser(PG_OID.TIMESTAMP, (v: string) => parsePgTimestamp(v));
  parsersInstalled = true;
}

export function createNodePgDriver(connectionString: string, max = 10): SqlDriver {
  installParsers();
  const pool = new pg.Pool({ connectionString, max });
  pool.on('connect', (client) => {
    void client.query("SET TIME ZONE 'UTC'");
  });
  const wrap = (c: pg.Pool | pg.PoolClient): SqlQueryable => ({
    query: async (text, params) => {
      const r = await c.query<SqlRow>(text, params ? [...params] : undefined);
      return { rows: r.rows };
    },
    exec: async (sql) => {
      await c.query(sql);
    },
  });
  return {
    name: 'pg',
    ...wrap(pool),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
