import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';
import { generateSchemaSql } from './ddl';
import { createPgDriver } from './drivers/pg';
import { createPgliteDriver } from './drivers/pglite';
import { parseMigrationFilename, runMigrations, type MigrationFile, type MigrationResult } from './migrate';
import { SqlDb, type SqlDriver } from './sql';

/** Node-only persistence bootstrap (never imported by the browser bundle). */

export function loadMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .map((f) => ({ f, parsed: parseMigrationFilename(f) }))
    .filter((x): x is { f: string; parsed: { version: string; name: string } } => x.parsed !== null)
    .map(({ f, parsed }) => ({ ...parsed, sql: readFileSync(join(dir, f), 'utf8') }));
}

export interface OpenDbOptions {
  /** postgres://... for a server; otherwise embedded PGlite. */
  databaseUrl?: string;
  /** PGlite data directory; omit for in-memory. */
  dataDir?: string;
  migrationsDir: string;
  clock?: () => string;
  log?: (msg: string) => void;
}

export async function openSqlDriver(opts: Pick<OpenDbOptions, 'databaseUrl' | 'dataDir'>): Promise<SqlDriver> {
  return opts.databaseUrl ? createPgDriver(opts.databaseUrl) : createPgliteDriver(opts.dataDir);
}

export async function openDatabase(opts: OpenDbOptions): Promise<{ db: Db; driver: SqlDriver; migrations: MigrationResult }> {
  const driver = await openSqlDriver(opts);
  const files = loadMigrationFiles(opts.migrationsDir);
  const schemaFile = files.find((f) => f.version === '0001');
  if (schemaFile && schemaFile.sql !== generateSchemaSql()) {
    opts.log?.('warning: db/migrations/0001_schema.sql differs from the schema generator output (run npm run db:generate)');
  }
  const migrations = await runMigrations(driver, files, opts.log);
  return { db: new SqlDb(driver, { clock: opts.clock }), driver, migrations };
}
