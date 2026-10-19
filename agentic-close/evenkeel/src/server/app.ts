import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { AppEnv } from '../app/methods';
import type { MessagesClient } from '../framework/llm/anthropic-brain';
import { setStoreClock } from '../framework/store/defaults';
import { AnchoredClock, SystemClock, type Clock } from '../framework/util/clock';
import { AgentEngine } from '../packs/accounting/agents/engine';
import { isSeeded } from '../packs/accounting/seed/load';
import { SCENARIO } from '../packs/accounting/seed/scenario';
import type { EkDb } from '../packs/accounting/store';
import { SecretBox } from './auth/secrets';
import type { ServerConfig } from './config';
import { migrate, openDatabase } from './db';
import { createHandler } from './http';
import { fromRoot } from './paths';
import { DEFAULT_RULES, RateLimiter, scaleRules } from './rate-limit';
import { readCredentials, seedDemo, type DemoCredentialsFile } from './seed';
import { loadSkillsFromDisk } from './skills-fs';

/**
 * Composition root for the server: database (embedded PGlite or Postgres), migrations,
 * first-run seed, business clock, agent engine (offline playbooks or Claude), crash
 * recovery of interrupted agent runs, and the HTTP handler.
 */
export interface ServerApp {
  env: AppEnv;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  dbKind: 'pglite' | 'postgres';
  seededNow: DemoCredentialsFile | 'password-from-env' | null;
  credentialsFile: string;
  resumedRuns: number;
  close(): Promise<void>;
}

/** Business time: pinned to the scenario's WD+2 (never earlier than the newest audit event). */
export async function businessClock(db: EkDb, tenantId: string, mode: 'scenario' | 'system'): Promise<Clock> {
  if (mode === 'system') return new SystemClock();
  const last = await db.find('audit_log', { tenant_id: tenantId }, { orderBy: [['seq', 'desc']], limit: 1 });
  const lastMs = last[0] ? Date.parse(last[0].occurred_at) + 1000 : 0;
  return new AnchoredClock(new Date(Math.max(Date.parse(SCENARIO.asOf), lastMs)).toISOString());
}

export async function createServerApp(
  config: ServerConfig,
  opts: { log?: (msg: string) => void; messages?: MessagesClient | null; staticDir?: string | null } = {},
): Promise<ServerApp> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dataDir = config.dataDir ?? fromRoot('.data');
  mkdirSync(dataDir, { recursive: true });
  const handle = await openDatabase({ url: config.databaseUrl, dataDir: join(dataDir, 'pglite') });
  try {
    const mig = await migrate(handle.driver);
    if (mig.applied.length) log(`Applied migrations: ${mig.applied.join(', ')}`);
    const skills = loadSkillsFromDisk();
    const credentialsFile = join(dataDir, 'demo-credentials.json');
    let seededNow: ServerApp['seededNow'] = null;
    if (!(await isSeeded(handle.db))) {
      log('First run: loading the fictional Kitewell Labs scenario (this takes a little while once)…');
      const t0 = Date.now();
      const r = await seedDemo(handle.db, { skills, demoPassword: config.demoPassword, credentialsFile, progress: (s) => log(`  · ${s}`) });
      log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
      seededNow = r.credentials ?? 'password-from-env';
    }
    const tenant = (await handle.db.findOne('tenant', { slug: SCENARIO.tenant.slug })) ?? (await handle.db.find('tenant', {}, { limit: 1 }))[0];
    if (!tenant) throw new Error('No tenant found after seeding.');
    const clock = await businessClock(handle.db, tenant.id, config.clock);
    setStoreClock(clock);

    let messages: MessagesClient | null = opts.messages !== undefined ? opts.messages : null;
    if (opts.messages === undefined && config.engine !== 'offline' && config.anthropicApiKey) messages = new Anthropic({ apiKey: config.anthropicApiKey }).beta.messages;
    if (config.engine === 'live' && !messages) throw new Error('EVENKEEL_ENGINE=live needs ANTHROPIC_API_KEY.');
    const engine = new AgentEngine({
      db: handle.db,
      tenantId: tenant.id,
      clock,
      skills,
      mode: config.engine,
      messages,
      env: config.modelEnv,
      onBackgroundError: (e) => log(`[agents] background run failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`),
    });
    const resumed = await engine.resumeInterrupted();
    if (resumed.length) log(`Resumed ${resumed.length} interrupted agent run(s).`);

    const env: AppEnv = { db: handle.db, tenantId: tenant.id, clock, engine, skills, mode: 'server', backgroundAgents: true };
    const limiter = new RateLimiter(scaleRules(DEFAULT_RULES, config.rateLimitScale));
    const secrets = SecretBox.fromEnvOrFile(config.secretKey ?? undefined, join(dataDir, 'secret.key'));
    const handler = createHandler({
      env,
      config,
      limiter,
      secrets,
      staticDir: opts.staticDir !== undefined ? opts.staticDir : fromRoot('dist'),
      demoCredentials: () => readCredentials(credentialsFile),
      log: (m) => log(m),
    });
    const close = async () => {
      // Let in-flight agent work reach a durable step boundary, but never hang shutdown.
      await Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 10_000))]);
      await handle.close();
    };
    return { env, handler, dbKind: handle.kind, seededNow, credentialsFile, resumedRuns: resumed.length, close };
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e;
  }
}
