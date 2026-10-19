/** Test harness: the real app (use cases + HTTP API) on a seeded store, and per-user HTTP clients. */
import { createAppContext, type AppConfig, type AppContext } from '../../src/app/context';
import { DEMO_SCRYPT, nobleScrypt, PasswordHasher } from '../../src/core/auth/password';
import { bytesToBase64 } from '../../src/core/util/base64';
import { scenarioClock } from '../../src/core/util/time';
import { inPageFetch } from '../../src/demo/inpage-fetch';
import type { Db } from '../../src/schema';
import { bramblewoodFixture, DEMO_PASSWORD_FOR_EVALS, type EvalFixture } from '../../src/packs/accounting/evals/harness';
import { PEOPLE, SCENARIO } from '../../src/packs/accounting/seed/company';
import { createServerApp } from '../../src/server/app';

export const TEST_PASSWORD = DEMO_PASSWORD_FOR_EVALS;
export const TEST_ORIGIN = 'https://tieout.test';
export const TEST_KEY = bytesToBase64(new Uint8Array(32).fill(7));

export interface TestApp {
  ctx: AppContext;
  app: ReturnType<typeof createServerApp>;
  fx: EvalFixture;
  client(origin?: string): HttpClient;
}

export async function testApp(over: Partial<AppConfig> = {}, db?: Db): Promise<TestApp> {
  const fx = await bramblewoodFixture();
  const config: AppConfig = { publicOrigin: null, secureCookies: false, encryptionKey: TEST_KEY, sessionIdleMinutes: 30, sessionAbsoluteHours: 12, demoMode: true, demoPassword: null, oidc: null, version: 'test', ...over };
  const ctx = createAppContext({ db: db ?? fx.db, clock: scenarioClock(SCENARIO.businessDate), config, hasher: new PasswordHasher(nobleScrypt, DEMO_SCRYPT) });
  const app = createServerApp(ctx);
  return { ctx, app, fx, client: (origin = TEST_ORIGIN) => new HttpClient(app, origin) };
}

export interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export class HttpClient {
  readonly fetch: ReturnType<typeof inPageFetch>;
  csrf: string | null = null;
  constructor(app: { fetch(r: Request): Response | Promise<Response> }, origin: string) {
    this.fetch = inPageFetch(app, origin);
  }

  async login(personKey: string, password = TEST_PASSWORD): Promise<Reply> {
    const p = PEOPLE.find((x) => x.key === personKey);
    if (!p) throw new Error(`no persona ${personKey}`);
    const r = await this.post('/api/auth/login', { email: p.email, password });
    if (r.status === 200) this.csrf = String(r.body.csrfToken);
    return r;
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
    const h: Record<string, string> = { accept: 'application/json', ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (method !== 'GET' && this.csrf && !('x-csrf-token' in headers)) h['x-csrf-token'] = this.csrf;
    const res = await this.fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }

  get<T = Record<string, unknown>>(path: string) {
    return this.call<T>('GET', path);
  }
  post<T = Record<string, unknown>>(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
    return this.call<T>('POST', path, body, headers);
  }
  del<T = Record<string, unknown>>(path: string) {
    return this.call<T>('DELETE', path);
  }
}
