import { sha256Hex } from '../shared/hash';
import type { SqlDriver } from './sql';

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Forward-only migration runner with checksum drift detection: an already-applied migration whose file
 * content changed is an error (never silently re-run or skipped).
 */
export async function runMigrations(driver: SqlDriver, files: MigrationFile[], log: (msg: string) => void = () => {}): Promise<MigrationResult> {
  await driver.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await driver.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  const ordered = [...files].sort((a, b) => a.version.localeCompare(b.version));
  for (const file of ordered) {
    const checksum = sha256Hex(file.sql);
    const existing = applied.get(file.version);
    if (existing) {
      if (existing !== checksum) {
        throw new Error(`Migration ${file.version}_${file.name} was modified after it was applied (checksum drift). Write a new migration instead.`);
      }
      result.alreadyApplied.push(file.version);
      continue;
    }
    log(`applying migration ${file.version}_${file.name}`);
    await driver.applyScript(file.sql, {
      text: 'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      params: [file.version, file.name, checksum],
    });
    result.applied.push(file.version);
  }
  return result;
}

/** Parse "0002_invariants.sql" style names. */
export function parseMigrationFilename(filename: string): { version: string; name: string } | null {
  const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(filename);
  return m ? { version: m[1]!, name: m[2]! } : null;
}
