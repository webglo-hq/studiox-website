/**
 * Database commands against DATABASE_URL (PostgreSQL) or the local PGlite directory.
 *   npm run db:migrate   apply pending migrations (checksum-verified, forward-only)
 *   npm run db:seed      migrate, then seed the fictional demo tenant if it is missing
 *   npm run db:reset     PGlite only: delete the local data directory (then run db:seed)
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate } from '../src/core/store/migrate';
import { migrations } from '../src/schema/migrations.generated';
import { boot } from '../src/server/bootstrap';

const cmd = process.argv[2];
const root = process.cwd();

if (cmd === 'migrate') {
  if (process.env.DATABASE_URL) {
    const { createNodePgDriver } = await import('../src/core/store/drivers/node-pg');
    const driver = createNodePgDriver(process.env.DATABASE_URL);
    const r = await migrate(driver, migrations);
    console.log(`PostgreSQL: applied ${r.applied.length} (${r.applied.join(', ') || 'none'}), already applied ${r.skipped.length}`);
    await driver.close();
  } else {
    const { createPgliteDriver } = await import('../src/core/store/drivers/pglite');
    const dir = resolve(root, process.env.PGLITE_DIR ?? '.data/pglite');
    const driver = await createPgliteDriver(dir);
    const r = await migrate(driver, migrations);
    console.log(`PGlite (${dir}): applied ${r.applied.length} (${r.applied.join(', ') || 'none'}), already applied ${r.skipped.length}`);
    await driver.close();
  }
} else if (cmd === 'seed') {
  const b = await boot({ root, env: { ...process.env, SEED_DEMO: 'true' } });
  console.log(`${b.storeLabel}: ${b.seeded ? 'demo tenant seeded' : 'demo tenant already present'}`);
  await b.close();
} else if (cmd === 'reset') {
  if (process.env.DATABASE_URL) {
    console.error('db:reset only deletes the local PGlite directory. For PostgreSQL, drop and recreate the database yourself.');
    process.exit(1);
  }
  const dir = resolve(root, process.env.PGLITE_DIR ?? '.data/pglite');
  if (!dir.startsWith(resolve(root))) throw new Error('PGLITE_DIR must be inside the project');
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  console.log(`removed ${dir}; run \`npm run db:seed\` (or just start the app) to recreate it`);
} else {
  console.error('usage: tsx scripts/db.ts migrate|seed|reset');
  process.exit(2);
}
