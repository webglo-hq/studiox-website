import { ApiKernel, type ApiRequest } from '../../api/kernel';
import { ROUTES } from '../../api/routes';
import { App } from '../../app/app';
import { registerSkills } from '../../packs/accounting/pack';
import { DEMO_PASSWORD_DEFAULT, seedScenario } from '../../packs/accounting/seed/loader';
import { SCENARIO } from '../../packs/accounting/seed/scenario';
import { MemoryDb } from '../../persistence/memory';
import { configurePasswordHashing, DEMO_SCRYPT } from '../../security/passwords';
import { randomToken } from '../../shared/ids';
import type { Transport, TransportResponse } from './api';

/**
 * The zero-install demo's backend: the real application (domain, agent runtime, API kernel) running inside
 * the page against the in-memory constraint engine. Nothing leaves the browser; reloading starts over.
 */
class DemoTransport implements Transport {
  readonly kind = 'demo' as const;
  private readonly cookies = new Map<string, string>();

  constructor(private readonly kernel: ApiKernel) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<TransportResponse> {
    const url = new URL(path, 'http://demo.local');
    const req: ApiRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      cookies: Object.fromEntries(this.cookies),
      // Round-trip through JSON like a network hop would (no shared object references).
      body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)),
      ip: 'in-browser-demo',
    };
    const res = await this.kernel.handle(req);
    for (const c of res.cookies) {
      if (c.maxAgeSeconds <= 0 || c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return { status: res.status, body: JSON.parse(JSON.stringify(res.body ?? null)) };
  }
}

export async function startDemoBackend(onProgress: (message: string) => void): Promise<Transport> {
  configurePasswordHashing({ params: DEMO_SCRYPT });
  const db = new MemoryDb();
  const app = new App(db, { mode: 'demo', secretKey: randomToken(32), sessionIdleMinutes: 240, sessionAbsoluteHours: 24, secureCookies: false, demoPassword: DEMO_PASSWORD_DEFAULT }, { businessDate: SCENARIO.businessDate });
  onProgress('Generating twelve months of books for Brambleway Software (fictional)...');
  await new Promise((r) => setTimeout(r, 16));
  await seedScenario(db, {
    log: (m) => onProgress(m === 'reference data' ? 'Creating the chart of accounts, entities and people...' : m.startsWith('journals') ? `Posting ${m.split(': ')[1]} journal entries through the ledger's checks...` : m.startsWith('importing') ? 'Importing September bank, card and payroll files...' : m),
    extend: async (tx, ctx) => void (await registerSkills(tx, ctx.tenantId, app.runtime.listSkills(), ctx.clock.now())),
  });
  await app.syncBusinessDate();
  onProgress('Ready.');
  return new DemoTransport(new ApiKernel(app, ROUTES));
}
