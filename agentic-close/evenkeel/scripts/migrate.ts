/* `npm run db:migrate`: apply db/migrations/*.sql to DATABASE_URL or the embedded PGlite database. */
import { join } from 'node:path';
import { loadConfig } from '../src/server/config';
import { migrate, openDatabase } from '../src/server/db';
import { fromRoot } from '../src/server/paths';

const config = loadConfig();
const handle = await openDatabase({ url: config.databaseUrl, dataDir: join(config.dataDir ?? fromRoot('.data'), 'pglite') });
try {
  const r = await migrate(handle.driver);
  console.log(`Migrations (${handle.kind}): applied ${r.applied.length ? r.applied.join(', ') : 'none'}; already applied ${r.skipped.length}.`);
} finally {
  await handle.close();
}
