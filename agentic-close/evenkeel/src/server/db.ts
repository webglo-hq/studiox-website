import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createPgDriver } from '../framework/store/drivers/pg';
import { createPgliteDriver } from '../framework/store/drivers/pglite';
import { SqlStore, type SqlDriver } from '../framework/store/sql';
import { sha256Hex } from '../framework/util/sha256';
import { schema, type EkDb, type EkSchema } from '../packs/accounting/store';
import { fromRoot } from './paths';

export interface DbHandle {
  db: EkDb;
  driver: SqlDriver;
  kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

/** DATABASE_URL → node-postgres; otherwise embedded PGlite persisted under .data/pglite. */
export async function openDatabase(opts: { url?: string | null; dataDir?: string | null; memory?: boolean } = {}): Promise<DbHandle> {
  const url = opts.url ?? process.env.DATABASE_URL ?? '';
  let driver: SqlDriver;
  if (url) {
    driver = createPgDriver(url);
  } else if (opts.memory) {
    driver = await createPgliteDriver();
  } else {
    const dir = opts.dataDir ?? process.env.EVENKEEL_PGLITE_DIR ?? fromRoot('.data', 'pglite');
    mkdirSync(dir, { recursive: true });
    driver = await createPgliteDriver(dir);
  }
  const db = new SqlStore<EkSchema>(schema, driver);
  return { db, driver, kind: driver.kind, close: () => db.close() };
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(driver: SqlDriver, dir = fromRoot('db', 'migrations')): Promise<MigrationResult> {
  await driver.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const done = new Map((await driver.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [String(r.version), String(r.checksum)]));
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const f of files) {
    const sql = readFileSync(`${dir}/${f}`, 'utf8');
    const checksum = sha256Hex(sql);
    const version = f.replace(/\.sql$/, '');
    if (done.has(version)) {
      if (done.get(version) !== checksum) throw new Error(`Migration ${version} was modified after it was applied (checksum mismatch).`);
      result.skipped.push(version);
      continue;
    }
    await driver.transaction(async (conn) => {
      await conn.exec(sql);
      await conn.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
    });
    result.applied.push(version);
  }
  return result;
}
