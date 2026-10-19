import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { verifyAuditChain } from '../audit/audit';
import { createHttpServer } from './http';
import { bootApp, loadConfig, openDb, ROOT } from './boot';

/**
 * Bookhand server CLI.
 *   start   (default) migrate, seed the demo company on first run, recover interrupted agent runs, serve
 *   setup   migrate and seed if empty, then exit
 *   migrate apply database migrations
 *   seed    same as setup
 *   reset   wipe the database (embedded data dir or the DATABASE_URL schema) and seed again
 *   verify-audit  verify every tenant's audit hash chain
 */

async function main(): Promise<void> {
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const command = process.argv[2] ?? 'start';
  const cfg = loadConfig();
  if (command === 'migrate') {
    const { driver } = await openDb(cfg);
    await driver.close();
    cfg.log('database is up to date');
    return;
  }
  if (command === 'reset') {
    if (cfg.databaseUrl) {
      const { driver } = await openDb(cfg);
      await driver.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await driver.close();
    } else if (existsSync(cfg.dataDir)) {
      rmSync(cfg.dataDir, { recursive: true, force: true });
    }
    cfg.log('database wiped');
  }
  if (command === 'setup' || command === 'seed' || command === 'reset') {
    const { driver, seed } = await bootApp(cfg);
    await driver.close();
    cfg.log(seed.seeded ? 'demo company seeded' : 'database already has data; nothing to seed');
    return;
  }
  if (command === 'verify-audit') {
    const { db, driver } = await openDb(cfg);
    const tenants = await db.read((tx) => tx.find('tenants', {}));
    let ok = true;
    for (const t of tenants) {
      const r = await db.read((tx) => verifyAuditChain(tx, t.id));
      ok &&= r.ok;
      cfg.log(`${t.name}: ${r.ok ? `audit chain intact (${r.checked} events, head ${r.headHash.slice(0, 16)}...)` : `BROKEN at seq ${r.firstBadSeq}: ${r.reason}`}`);
    }
    await driver.close();
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (command !== 'start') throw new Error(`unknown command "${command}"`);

  const { app, kernel, driver, seed } = await bootApp(cfg);
  const resumed = await app.runtime.recover(60_000);
  if (resumed.length) cfg.log(`resumed ${resumed.length} interrupted agent run(s)`);
  const webRoot = join(ROOT, 'dist', 'web');
  const server = createHttpServer({ kernel, webRoot: existsSync(join(webRoot, 'index.html')) ? webRoot : null, secure: cfg.secureCookies, trustProxy: cfg.trustProxy });
  server.listen(cfg.port, cfg.host, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
    const url = `http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${port}`;
    cfg.log('');
    cfg.log(`Bookhand is running at ${url}`);
    cfg.log(`  database: ${app.db.label}`);
    cfg.log(`  agents:   ${app.liveModel ? `live (${app.liveModel}) with offline fallback` : 'offline deterministic engine (set ANTHROPIC_API_KEY for live Claude)'}`);
    if (seed.seeded) {
      // Passwords are never written to logs; the sign-in page offers the demo users.
      cfg.log(`  demo company: Brambleway Software (fictional). Sign in as any demo user from the sign-in page${app.config.demoPassword ? ' (dev-only password in the README)' : ' with the password set in BOOKHAND_DEMO_PASSWORD'}.`);
      for (const l of seed.logins) cfg.log(`    ${l.role.padEnd(18)} ${l.email}`);
    }
    if (!existsSync(join(webRoot, 'index.html'))) cfg.log('  note: web bundle not built (npm run build:web); API only');
    cfg.log(`READY ${url}`);
  });
  const shutdown = async () => {
    server.close();
    await app.queue.idle().catch(() => undefined);
    await driver.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
