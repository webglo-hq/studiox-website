import pg from 'pg';
import type { SqlDriver } from '../sql';

// Parse types consistently with the PGlite driver: int8/numeric → number, date → 'YYYY-MM-DD'.
const typeParsers: Record<number, (v: string) => unknown> = {
  20: (v) => Number(v), // INT8
  1700: (v) => Number(v), // NUMERIC
  1082: (v) => v, // DATE
  1184: (v) => new Date(v).toISOString(), // TIMESTAMPTZ
};

const customTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    const p = typeParsers[oid];
    if (p) return p;
    return pg.types.getTypeParser(oid, format ?? 'text');
  },
};

class PgClientConn implements SqlDriver {
  readonly kind = 'postgres' as const;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly client: pg.PoolClient) {}
  /**
   * A transaction is one connection, which runs one statement at a time. Code inside a
   * transaction may still fan out with Promise.all, so statements queue here in order.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
  query(text: string, values: unknown[] = []) {
    return this.serial(async () => {
      const res = await this.client.query({ text, values, types: customTypes });
      return { rows: res.rows as Record<string, unknown>[], affectedRows: res.rowCount ?? undefined };
    });
  }
  exec(sql: string): Promise<void> {
    return this.serial(async () => {
      await this.client.query(sql);
    });
  }
  async transaction<R>(fn: (conn: SqlDriver) => Promise<R>): Promise<R> {
    return fn(this);
  }
  async close(): Promise<void> {
    /* released by owner */
  }
}

class PgPoolDriver implements SqlDriver {
  readonly kind = 'postgres' as const;
  constructor(private readonly pool: pg.Pool) {}

  async query(text: string, values: unknown[] = []) {
    const res = await this.pool.query({ text, values, types: customTypes });
    return { rows: res.rows as Record<string, unknown>[], affectedRows: res.rowCount ?? undefined };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<R>(fn: (conn: SqlDriver) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(new PgClientConn(client));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPgDriver(connectionString: string, max = 10): SqlDriver {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, application_name: 'evenkeel' });
  return new PgPoolDriver(pool);
}
