/* `npm run db:seed`: load the fictional Kitewell Labs scenario into an empty database. */
import { join } from 'node:path';
import { isSeeded } from '../src/packs/accounting/seed/load';
import { loadConfig } from '../src/server/config';
import { migrate, openDatabase } from '../src/server/db';
import { fromRoot } from '../src/server/paths';
import { seedDemo } from '../src/server/seed';
import { loadSkillsFromDisk } from '../src/server/skills-fs';

const config = loadConfig();
const dataDir = config.dataDir ?? fromRoot('.data');
const handle = await openDatabase({ url: config.databaseUrl, dataDir: join(dataDir, 'pglite') });
try {
  await migrate(handle.driver);
  if (await isSeeded(handle.db)) {
    console.log('The database already holds the demo data. Delete .data/ (or drop the database) to re-seed.');
  } else {
    const t0 = Date.now();
    const { info, credentials } = await seedDemo(handle.db, { skills: loadSkillsFromDisk(), demoPassword: config.demoPassword, credentialsFile: join(dataDir, 'demo-credentials.json'), progress: (s) => console.log(`  · ${s}`) });
    console.log(`Seeded Kitewell Labs (fictional) in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, info.counts);
    if (credentials) {
      console.log('\nDemo accounts (saved to .data/demo-credentials.json, mode 0600):');
      for (const u of credentials.users) console.log(`  ${u.title.padEnd(30)} ${u.email.padEnd(28)} ${u.password}`);
    } else {
      console.log('Demo accounts use DEMO_PASSWORD.');
    }
  }
} finally {
  await handle.close();
}
