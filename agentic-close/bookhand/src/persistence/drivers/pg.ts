import pg from 'pg';
import { toIsoTimestamp } from '../rows';
import { mapPgError, type SqlDriver } from '../sql';

/** node-postgres driver for a real Postgres server (DATABASE_URL). */
export async function createPgDriver(connectionString: string, opts: { max?: number } = {}): Promise<SqlDriver> {
  const custom: Record<number, (v: string) => unknown> = {
    1082: (v) => v,
    1114: (v) => toIsoTimestamp(`${v}+00`),
    1184: (v) => toIsoTimestamp(v),
    20: (v) => Number(v),
    1700: (v) => Number(v),
  };
  const types = {
    getTypeParser(oid: number, format?: 'text' | 'binary') {
      return custom[oid] ?? pg.types.getTypeParser(oid, format as 'text');
    },
  };
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10, types: types as pg.CustomTypesConfig });
  pool.on('error', (err) => console.error('[db] idle client error', err.message));
  const safeHost = (() => {
    try {
      const u = new URL(connectionString);
      return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
    } catch {
      return 'server';
    }
  })();

  return {
    label: `PostgreSQL (${safeHost})`,
    prepareParam(value) {
      if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      return value;
    },
    async transaction(fn, txOpts) {
      const client = await pool.connect();
      // One connection runs one statement at a time. Callers may issue reads concurrently inside a transaction
      // (Promise.all), so statements are chained here explicitly instead of relying on node-postgres' implicit
      // client queue (deprecated, removed in pg 9); COMMIT/ROLLBACK wait for anything still in flight.
      let inFlight: Promise<unknown> = Promise.resolve();
      try {
        await client.query(txOpts?.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
        const result = await fn({
          async query<R>(text: string, params?: unknown[]) {
            const run = inFlight.then(() => client.query(text, params));
            inFlight = run.catch(() => undefined);
            const r = await run;
            return { rows: r.rows as R[] };
          },
        });
        await inFlight;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await inFlight;
        await client.query('ROLLBACK').catch(() => undefined);
        throw mapPgError(error);
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      try {
        await pool.query(sql);
      } catch (e) {
        throw mapPgError(e);
      }
    },
    async applyScript(script, record) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(script);
        await client.query(record.text, record.params);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw mapPgError(error);
      } finally {
        client.release();
      }
    },
    async query(text, params) {
      const r = await pool.query(text, params);
      return { rows: r.rows };
    },
    async close() {
      await pool.end();
    },
  };
}
