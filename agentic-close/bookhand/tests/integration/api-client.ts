import { ApiKernel, type ApiRequest, type ApiResponse } from '../../src/api/kernel';
import { ROUTES } from '../../src/api/routes';
import { App, type AppConfig } from '../../src/app/app';
import { registerSkills } from '../../src/packs/accounting/pack';
import { seedScenario, type SeedResult } from '../../src/packs/accounting/seed/loader';
import type { Db } from '../../src/persistence/db';
import { MemoryDb } from '../../src/persistence/memory';
import type { Clock } from '../../src/shared/context';

export const DEMO_PASSWORD = 'bookhand-demo';

/** Drives the kernel the way the browser does: cookie jar, CSRF header, JSON bodies. */
export class Client {
  cookies: Record<string, string> = {};
  csrf = '';
  constructor(
    private readonly kernel: ApiKernel,
    readonly ip = '10.0.0.1',
  ) {}

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
    const url = new URL(path, 'http://bookhand.test');
    const req: ApiRequest = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { host: 'bookhand.test', 'x-requested-with': 'bookhand', ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...headers }, cookies: { ...this.cookies }, body, ip: this.ip };
    const res = await this.kernel.handle(req);
    for (const c of res.cookies) {
      if (c.maxAgeSeconds === 0) delete this.cookies[c.name];
      else this.cookies[c.name] = c.value;
    }
    const b = res.body as { csrfToken?: string };
    if (b && typeof b === 'object' && b.csrfToken) this.csrf = b.csrfToken;
    return res;
  }

  async login(email: string, password = DEMO_PASSWORD): Promise<ApiResponse> {
    const r = await this.call('POST', '/api/auth/login', { email, password });
    if (r.status === 200) await this.call('GET', '/api/session');
    return r;
  }

  /** The body of a successful call; throws with the error body otherwise. */
  async ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.call(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  }
}

export function errorOf(res: ApiResponse): { code: string; message: string } {
  return (res.body as { error: { code: string; message: string } }).error;
}

/** A seeded demo company behind a real API kernel (in-memory database unless one is given). */
export async function seededKernel(opts: { db?: Db; clock?: Partial<Clock>; config?: Partial<AppConfig> } = {}): Promise<{ app: App; kernel: ApiKernel; seed: SeedResult; email: (key: string) => string }> {
  const db = opts.db ?? new MemoryDb();
  const app = new App(db, { mode: 'demo', secretKey: 'test'.repeat(8), sessionIdleMinutes: 30, sessionAbsoluteHours: 12, secureCookies: false, demoPassword: DEMO_PASSWORD, ...opts.config }, { businessDate: '2026-10-02', clock: opts.clock });
  const seed = await seedScenario(db, { extend: async (tx, ctx) => void (await registerSkills(tx, ctx.tenantId, app.runtime.listSkills(), ctx.clock.now())) });
  const kernel = new ApiKernel(app, ROUTES);
  return { app, kernel, seed, email: (key: string) => seed.logins.find((l) => l.key === key)!.email };
}
