/**
 * Node bootstrap: configuration from the environment, store selection (Postgres via DATABASE_URL,
 * embedded PGlite in a local data directory, or in-memory), migrations, first-run demo seed and
 * the application context. Used by the server entry, the MCP server and integration tests.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scrypt as nodeScryptCb, randomBytes } from 'node:crypto';
import { createAppContext, type AppConfig, type AppContext } from '../app/context';
import { DEMO_SCRYPT, PasswordHasher, PRODUCTION_SCRYPT, type ScryptImpl } from '../core/auth/password';
import { AnthropicProvider } from '../core/llm/anthropic';
import type { MemoryStore } from '../core/store/memory';
import { migrate } from '../core/store/migrate';
import type { SqlDriver } from '../core/store/sql';
import { scenarioClock, systemClock, type Clock } from '../core/util/time';
import type { Db } from '../schema';
import { createMemoryDb, createPgDb } from '../schema/factory';
import { migrations } from '../schema/migrations.generated';
import { SCENARIO } from '../packs/accounting/seed/company';
import { DEMO_TENANT_ID, seedScenario } from '../packs/accounting/seed/scenario';
import { installAccountingSkills } from '../packs/accounting/skills/install';

/** Documented dev-only default for the fictional demo users (override with DEMO_PASSWORD). */
export const DEV_DEMO_PASSWORD = 'close-the-books';

export const nodeScrypt: ScryptImpl = (password, salt, params, dkLen) =>
  new Promise((ok, fail) => nodeScryptCb(password, salt, dkLen, { N: 2 ** params.ln, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? fail(err) : ok(new Uint8Array(key)))));

export interface BootOptions {
  env?: NodeJS.ProcessEnv;
  root?: string;
  log?: (msg: string) => void;
}

export interface Booted {
  ctx: AppContext;
  db: Db;
  driver: SqlDriver | null;
  storeLabel: string;
  seeded: boolean;
  close: () => Promise<void>;
}

function encryptionKey(env: NodeJS.ProcessEnv, root: string, log: (m: string) => void): string {
  if (env.APP_ENCRYPTION_KEY) return env.APP_ENCRYPTION_KEY;
  const file = resolve(root, '.data/dev-encryption.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32).toString('base64');
  writeFileSync(file, key, { mode: 0o600 });
  log('APP_ENCRYPTION_KEY not set: generated a development key in .data/dev-encryption.key (set the variable in production).');
  return key;
}

export async function boot(opts: BootOptions = {}): Promise<Booted> {
  const env = opts.env ?? process.env;
  const root = opts.root ?? process.cwd();
  const log = opts.log ?? ((m: string) => console.log(`[tieout] ${m}`));
  const demo = env.SEED_DEMO !== 'false';
  const clock: Clock = demo && env.DEMO_CLOCK !== 'system' ? scenarioClock(SCENARIO.businessDate) : systemClock;
  let driver: SqlDriver | null = null;
  let db: Db;
  let storeLabel: string;
  const mode = env.DATABASE_URL ? 'postgres' : env.STORE === 'memory' ? 'memory' : 'pglite';
  if (mode === 'postgres') {
    const { createNodePgDriver } = await import('../core/store/drivers/node-pg');
    driver = createNodePgDriver(env.DATABASE_URL!);
    db = createPgDb(driver);
    storeLabel = 'PostgreSQL';
  } else if (mode === 'pglite') {
    const { createPgliteDriver } = await import('../core/store/drivers/pglite');
    const dir = resolve(root, env.PGLITE_DIR ?? '.data/pglite');
    mkdirSync(dir, { recursive: true });
    driver = await createPgliteDriver(dir);
    db = createPgDb(driver);
    storeLabel = `PGlite (${env.PGLITE_DIR ?? '.data/pglite'})`;
  } else {
    db = createMemoryDb();
    storeLabel = 'in-memory';
  }
  if (driver) {
    const r = await migrate(driver, migrations);
    if (r.applied.length) log(`migrations applied: ${r.applied.join(', ')}`);
  }
  const demoPassword = env.DEMO_PASSWORD || DEV_DEMO_PASSWORD;
  const seedHasher = new PasswordHasher(nodeScrypt, DEMO_SCRYPT);
  let seeded = false;
  const seedNow = async () => {
    await seedScenario(db, { demoPassword, hashPassword: (p) => seedHasher.hash(p), installSkills: installAccountingSkills, onProgress: () => undefined });
    seeded = true;
  };
  if (demo) {
    const existing = await db.system((sys) => sys.findGlobal('tenants', { id: DEMO_TENANT_ID }));
    if (!existing.length) {
      log('seeding the fictional Bramblewood Labs demo (first run)…');
      const t0 = Date.now();
      await seedNow();
      log(`demo seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
  }
  const snapshot = mode === 'memory' ? (db as unknown as MemoryStore<unknown>).snapshot() : null;
  const config: AppConfig = {
    publicOrigin: env.PUBLIC_ORIGIN || null,
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : (env.PUBLIC_ORIGIN ?? '').startsWith('https://'),
    encryptionKey: encryptionKey(env, root, log),
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 30),
    sessionAbsoluteHours: Number(env.SESSION_ABSOLUTE_HOURS ?? 12),
    demoMode: demo,
    oidc: env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_REDIRECT_URI ? { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, redirectUri: env.OIDC_REDIRECT_URI } : null,
    version: '1.0.0',
  };
  const llm = env.ANTHROPIC_API_KEY ? new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }) : null;
  // demo users keep fast demo hashes; any other account gets production-strength scrypt
  const hasher = new PasswordHasher(nodeScrypt, demo ? DEMO_SCRYPT : PRODUCTION_SCRYPT);
  const ctx = createAppContext({
    db,
    clock,
    config,
    hasher,
    llm,
    log: (m, d) => log(`${m}${d ? ` ${JSON.stringify(d)}` : ''}`),
    resetDemo: snapshot ? async () => (db as unknown as MemoryStore<unknown>).restore(snapshot) : undefined,
  });
  return { ctx, db, driver, storeLabel, seeded, close: async () => db.close() };
}
