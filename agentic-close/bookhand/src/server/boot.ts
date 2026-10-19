import { scrypt as scryptCb } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiKernel } from '../api/kernel';
import { ROUTES } from '../api/routes';
import { App, type AppConfig } from '../app/app';
import { llmFromEnv } from '../agents/llm/anthropic';
import { registerSkills } from '../packs/accounting/pack';
import { DEMO_PASSWORD_DEFAULT, seedScenario } from '../packs/accounting/seed/loader';
import type { Db } from '../persistence/db';
import { openDatabase } from '../persistence/node';
import type { SqlDriver } from '../persistence/sql';
import { configurePasswordHashing, SERVER_SCRYPT } from '../security/passwords';
import { randomToken } from '../shared/ids';

/** Server bootstrap: configuration from the environment, database, seed-on-first-run, app and API kernel. */

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string | null;
  dataDir: string;
  publicOrigin: string | null;
  secureCookies: boolean;
  trustProxy: boolean;
  demoPassword: string;
  log: (line: string) => void;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    databaseUrl: env.DATABASE_URL?.trim() || null,
    dataDir: env.BOOKHAND_DATA_DIR ?? join(ROOT, '.data', 'pglite'),
    publicOrigin: env.PUBLIC_ORIGIN ?? null,
    secureCookies: env.BOOKHAND_SECURE_COOKIES === 'true' || (env.PUBLIC_ORIGIN ?? '').startsWith('https://'),
    trustProxy: env.BOOKHAND_TRUST_PROXY === 'true',
    demoPassword: env.BOOKHAND_DEMO_PASSWORD || DEMO_PASSWORD_DEFAULT,
    log: env.BOOKHAND_QUIET === 'true' ? () => undefined : (line) => console.log(line),
  };
}

/** Deployment secret: BOOKHAND_SECRET_KEY, else generated once into .data/secret.key (never committed). */
export function secretKey(env: Record<string, string | undefined> = process.env): string {
  if (env.BOOKHAND_SECRET_KEY && env.BOOKHAND_SECRET_KEY.length >= 32) return env.BOOKHAND_SECRET_KEY;
  const file = join(ROOT, '.data', 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const key = randomToken(32);
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

export function enableNativeScrypt(): void {
  configurePasswordHashing({
    params: SERVER_SCRYPT,
    impl: (password, salt, params, dkLen) =>
      new Promise((res, rej) =>
        scryptCb(password, salt, dkLen, { N: 2 ** params.ln, r: params.r, p: params.p, maxmem: 2 ** (params.ln + 8) * params.r * 2 }, (err, key) => (err ? rej(err) : res(new Uint8Array(key)))),
      ),
  });
}

export async function openDb(cfg: ServerConfig): Promise<{ db: Db; driver: SqlDriver }> {
  if (!cfg.databaseUrl) mkdirSync(cfg.dataDir, { recursive: true });
  const { db, driver, migrations } = await openDatabase({ databaseUrl: cfg.databaseUrl ?? undefined, dataDir: cfg.databaseUrl ? undefined : cfg.dataDir, migrationsDir: join(ROOT, 'db', 'migrations'), log: cfg.log });
  if (migrations.applied.length) cfg.log(`migrations applied: ${migrations.applied.join(', ')}`);
  return { db, driver };
}

export function appConfig(cfg: ServerConfig): AppConfig {
  // The sign-in page may show the documented dev-only default password; a password you chose stays secret.
  return { mode: 'server', secretKey: secretKey(), publicOrigin: cfg.publicOrigin, sessionIdleMinutes: 30, sessionAbsoluteHours: 12, secureCookies: cfg.secureCookies, demoPassword: cfg.demoPassword === DEMO_PASSWORD_DEFAULT ? cfg.demoPassword : null };
}

/** Seed the fictional demo company when the database is empty; returns the demo logins when it seeded. */
export async function seedIfEmpty(app: App, cfg: ServerConfig): Promise<{ seeded: boolean; logins: Array<{ email: string; name: string; role: string }> }> {
  const tenants = await app.read((tx) => tx.count('tenants'));
  if (tenants > 0) return { seeded: false, logins: [] };
  cfg.log('seeding the Brambleway demo company (fictional)...');
  const result = await seedScenario(app.db, { demoPassword: cfg.demoPassword, log: (m) => cfg.log(`  seed: ${m}`), extend: async (tx, ctx) => void (await registerSkills(tx, ctx.tenantId, app.runtime.listSkills(), ctx.clock.now())) });
  cfg.log(`seeded in ${(result.timings.total / 1000).toFixed(1)} s`);
  return { seeded: true, logins: result.logins.map((l) => ({ email: l.email, name: l.name, role: l.role })) };
}

export async function bootApp(cfg: ServerConfig, env: Record<string, string | undefined> = process.env) {
  enableNativeScrypt();
  const { db, driver } = await openDb(cfg);
  const app = new App(db, appConfig(cfg), { llm: llmFromEnv(env), log: cfg.log });
  const seed = await seedIfEmpty(app, cfg);
  await app.syncBusinessDate();
  const businessDate = env.BOOKHAND_BUSINESS_DATE?.trim();
  if (businessDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || Number.isNaN(Date.parse(businessDate))) throw new Error(`BOOKHAND_BUSINESS_DATE must be YYYY-MM-DD, got "${businessDate}"`);
    app.setBusinessDate(businessDate);
  }
  await app.ensureRoles();
  await app.ensureSkills();
  const kernel = new ApiKernel(app, ROUTES, { allowedOrigins: cfg.publicOrigin ? [cfg.publicOrigin] : [], log: env.BOOKHAND_LOG_REQUESTS === 'true' ? cfg.log : undefined });
  return { app, kernel, db, driver, seed };
}
