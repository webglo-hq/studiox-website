/**
 * Zero-install demo: the real application (use cases, agent runtime with the offline engine,
 * HTTP API) running entirely in the page on the in-memory store. No backend, no network, no
 * persistence: reloading the page starts the fictional close again from scratch.
 */
import { createAppContext, type AppConfig } from '../app/context';
import { DEMO_SCRYPT, nobleScrypt, PasswordHasher } from '../core/auth/password';
import type { MemoryStore } from '../core/store/memory';
import { bytesToBase64 } from '../core/util/base64';
import { secureRandomBytes } from '../core/util/random';
import { scenarioClock } from '../core/util/time';
import { createMemoryDb } from '../schema/factory';
import { createServerApp } from '../server/app';
import { SCENARIO } from '../packs/accounting/seed/company';
import { seedScenario } from '../packs/accounting/seed/scenario';
import { installAccountingSkills } from '../packs/accounting/skills/install';
import { inPageFetch } from './inpage-fetch';

/** The documented, dev-only password shared by the fictional demo personas. */
export const DEMO_PASSWORD = 'close-the-books';

export async function bootDemo(onProgress: (msg: string) => void = () => undefined) {
  const clock = scenarioClock(SCENARIO.businessDate);
  const db = createMemoryDb();
  const hasher = new PasswordHasher(nobleScrypt, DEMO_SCRYPT);
  await seedScenario(db, { demoPassword: DEMO_PASSWORD, hashPassword: (p) => hasher.hash(p), installSkills: installAccountingSkills, onProgress });
  const store = db as unknown as MemoryStore<unknown>;
  const snapshot = store.snapshot();
  const config: AppConfig = {
    publicOrigin: null,
    secureCookies: false,
    // per-page key: MFA secrets enrolled in the demo live only as long as the tab
    encryptionKey: bytesToBase64(secureRandomBytes(32)),
    sessionIdleMinutes: 240,
    sessionAbsoluteHours: 24,
    demoMode: true,
    demoPassword: DEMO_PASSWORD,
    oidc: null,
    version: '1.0.0',
  };
  const ctx = createAppContext({ db, clock, config, hasher, llm: null, resetDemo: async () => store.restore(snapshot) });
  const app = createServerApp(ctx, { cookieBridge: true });
  return { fetch: inPageFetch(app, 'https://demo.tieout.local'), ctx };
}
