/** Forward-only, checksum-verified migrations. A changed, already-applied migration is an error. */
import { sha256Hex } from '../util/hash';
import type { SqlDriver } from './sql';

export interface Migration {
  id: string;
  sql: string;
}

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

export async function migrate(driver: SqlDriver, migrations: readonly Migration[]): Promise<MigrationReport> {
  await driver.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const existing = await driver.query('SELECT id, checksum FROM schema_migrations');
  const done = new Map(existing.rows.map((r) => [String(r.id), String(r.checksum)]));
  const report: MigrationReport = { applied: [], skipped: [] };
  for (const m of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
    const checksum = sha256Hex(m.sql);
    const prior = done.get(m.id);
    if (prior) {
      if (prior !== checksum) throw new Error(`migration ${m.id} was modified after being applied (checksum drift)`);
      report.skipped.push(m.id);
      continue;
    }
    await driver.transaction(async (q) => {
      await q.exec(m.sql);
      await q.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [m.id, checksum]);
    });
    report.applied.push(m.id);
  }
  return report;
}
