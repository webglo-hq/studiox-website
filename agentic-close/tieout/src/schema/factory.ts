/** Store construction for every runtime (browser demo, tests, server). */
import { MemoryStore } from '../core/store/memory';
import { PgStore } from '../core/store/postgres';
import { coreHooks } from '../core/store/core-hooks';
import type { SqlDriver } from '../core/store/sql';
import { accountingHooks } from '../packs/accounting/store-hooks';
import { ID_PREFIX, MEMORY_INDEX_HINTS, tableMeta, type Db, type DbInserts, type DbTables } from './index';

export function createMemoryDb(opts: { now?: () => string } = {}): Db {
  return new MemoryStore<DbTables, DbInserts>({
    meta: tableMeta,
    idPrefix: ID_PREFIX,
    hooks: [coreHooks, accountingHooks],
    indexHints: MEMORY_INDEX_HINTS,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

export function createPgDb(driver: SqlDriver): Db {
  return new PgStore<DbTables, DbInserts>({ driver, meta: tableMeta, idPrefix: ID_PREFIX });
}
