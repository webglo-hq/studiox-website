import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MemoryDb } from '../../src/persistence/memory';
import type { Db } from '../../src/persistence/db';
import { openDatabase } from '../../src/persistence/node';
import { randomToken } from '../../src/shared/ids';

export const migrationsDir = fileURLToPath(new URL('../../db/migrations', import.meta.url));

export interface AdapterCase {
  name: string;
  open: () => Promise<{ db: Db; close: () => Promise<void> }>;
}

/** A fresh, empty database on the test server (each suite gets its own so seeded tenants never collide). */
async function freshDatabase(baseUrl: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `bh_${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: baseUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export function adapterCases(opts: { memory?: boolean; pglite?: boolean; server?: boolean } = {}): AdapterCase[] {
  const cases: AdapterCase[] = [];
  if (opts.memory !== false) cases.push({ name: 'MemoryDb', open: async () => ({ db: new MemoryDb(), close: async () => undefined }) });
  if (opts.pglite !== false) {
    cases.push({
      name: 'PGlite',
      open: async () => {
        const { db, driver } = await openDatabase({ migrationsDir });
        return { db, close: () => driver.close() };
      },
    });
  }
  const url = process.env.DATABASE_URL;
  if (url && opts.server !== false) {
    cases.push({
      name: 'PostgreSQL server',
      open: async () => {
        const fresh = await freshDatabase(url);
        const { db, driver } = await openDatabase({ migrationsDir, databaseUrl: fresh.url });
        return {
          db,
          close: async () => {
            await driver.close();
            await fresh.drop();
          },
        };
      },
    });
  }
  return cases;
}
