import { beforeAll, describe, expect, it } from 'vitest';
import { ApiKernel, type ApiRequest, type ApiResponse, SESSION_COOKIE } from '../../src/api/kernel';
import { ROUTES } from '../../src/api/routes';
import { App } from '../../src/app/app';
import { registerSkills } from '../../src/packs/accounting/pack';
import { seedScenario, type SeedResult } from '../../src/packs/accounting/seed/loader';
import { MemoryDb } from '../../src/persistence/memory';
import { configurePasswordHashing, DEMO_SCRYPT, hashPassword } from '../../src/security/passwords';
import { totp } from '../../src/security/totp';

configurePasswordHashing({ params: DEMO_SCRYPT });

/** Drives the kernel the way the browser does: cookie jar, CSRF header, JSON bodies. */
class Client {
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
  async login(email: string, password: string) {
    const r = await this.call('POST', '/api/auth/login', { email, password });
    if (r.status === 200) await this.call('GET', '/api/session');
    return r;
  }
}

describe('API kernel: authentication, CSRF, RBAC and errors', () => {
  let kernel: ApiKernel;
  let app: App;
  let seed: SeedResult;
  const email = (key: string) => seed.logins.find((l) => l.key === key)!.email;

  beforeAll(async () => {
    const db = new MemoryDb();
    app = new App(db, { mode: 'demo', secretKey: 'test'.repeat(8), sessionIdleMinutes: 30, sessionAbsoluteHours: 12, secureCookies: true, demoPassword: 'bookhand-demo' }, { businessDate: '2026-10-02' });
    seed = await seedScenario(db, { extend: async (tx, ctx) => void (await registerSkills(tx, ctx.tenantId, app.runtime.listSkills(), ctx.clock.now())) });
    kernel = new ApiKernel(app, ROUTES);
  }, 120_000);

  it('rejects anonymous access and unknown routes with JSON errors', async () => {
    const c = new Client(kernel);
    expect((await c.call('GET', '/api/home')).status).toBe(401);
    const nf = await c.call('GET', '/api/nope');
    expect(nf.status).toBe(404);
    expect((nf.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect(nf.headers['cache-control']).toBe('no-store');
  });

  it('answers every read endpoint for every role without hanging or failing', async () => {
    const admin = new Client(kernel, '10.0.1.1');
    await admin.login(email('hannah'), 'bookhand-demo');
    const anyRec = ((await admin.call('GET', '/api/recs')).body as { recs: Array<{ id: string | null }> }).recs.find((r) => r.id)?.id;
    const anyEntry = ((await admin.call('GET', '/api/journal-entries?limit=1')).body as { entries: Array<{ id: string }> }).entries[0]!.id;
    const paths = [
      '/api/session', '/api/home', '/api/reference', '/api/closes', '/api/closes/current', `/api/closes/${seed.closeId}`, `/api/closes/${seed.closeId}/package`,
      '/api/proposals', '/api/proposals?view=decided', '/api/recs', ...(anyRec ? [`/api/recs/${anyRec}`] : []), '/api/flux', '/api/journal-entries?period=2026-09', `/api/journal-entries/${anyEntry}`,
      '/api/reports/trial-balance', '/api/reports/trial-balance?entity=BW-UK&mode=activity', '/api/reports/statements', '/api/reports/activity?account=1010',
      '/api/runs', '/api/skills', '/api/skills/bank-reconciliation', '/api/ontology', '/api/ontology/terms/bh%3ADepositInTransit', '/api/ontology/graph?module=flux', '/api/ontology/lookup?q=DIT',
      '/api/audit', '/api/imports', '/api/admin/users', '/api/admin/sod-rules', '/api/admin/sessions',
    ];
    const timeout = <T,>(p: Promise<T>, label: string) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} did not answer within 10 s`)), 10_000))]);
    for (const [i, who] of ['maya', 'daniel', 'hannah', 'marcus', 'priya', 'diego', 'sofia', 'tom'].entries()) {
      const c = new Client(kernel, `10.0.2.${i + 1}`);
      expect((await c.login(email(who), 'bookhand-demo')).status).toBe(200);
      for (const path of paths) {
        const res = await timeout(c.call('GET', path), `${who} GET ${path}`);
        expect([200, 403], `${who} GET ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`).toContain(res.status);
      }
    }
  });

  it('signs in with an httpOnly, SameSite, Secure session cookie and never reveals which part was wrong', async () => {
    const c = new Client(kernel);
    const bad = await c.call('POST', '/api/auth/login', { email: email('maya'), password: 'nope' });
    expect(bad.status).toBe(401);
    const unknown = await c.call('POST', '/api/auth/login', { email: 'nobody@brambleway.example', password: 'nope' });
    expect((unknown.body as { error: { message: string } }).error.message).toBe((bad.body as { error: { message: string } }).error.message);
    const ok = await c.call('POST', '/api/auth/login', { email: email('maya'), password: 'bookhand-demo' });
    expect(ok.status).toBe(200);
    const cookie = ok.cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.secure).toBe(true);
    const me = await c.call('GET', '/api/session');
    expect((me.body as { user: { name: string } }).user.name).toBe('Maya Chen');
  });

  it('requires the CSRF token on every mutation and the custom header on login', async () => {
    const c = new Client(kernel);
    await c.login(email('daniel'), 'bookhand-demo');
    const token = c.csrf;
    c.csrf = '';
    const res = await c.call('POST', '/api/audit/verify', {});
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('CSRF');
    c.csrf = token;
    const cross = await c.call('POST', '/api/closes/x/review-all', {}, { origin: 'https://evil.example' });
    expect((cross.body as { error: { code: string } }).error.code).toBe('CSRF');
    const anon = new Client(kernel);
    const noHeader = await anon.call('POST', '/api/auth/login', { email: email('maya'), password: 'bookhand-demo' }, { 'x-requested-with': '' });
    expect(noHeader.status).toBe(403);
  });

  it('enforces RBAC: auditors read but cannot decide, staff cannot lock, admins cannot approve', async () => {
    const auditor = new Client(kernel, '10.0.0.2');
    await auditor.login(email('sofia'), 'bookhand-demo');
    expect((await auditor.call('GET', '/api/audit')).status).toBe(200);
    expect((await auditor.call('POST', `/api/closes/${seed.closeId}/run`, {})).status).toBe(403);
    const maya = new Client(kernel, '10.0.0.3');
    await maya.login(email('maya'), 'bookhand-demo');
    expect((await maya.call('POST', `/api/closes/${seed.closeId}/lock`, {})).status).toBe(403);
    const tom = new Client(kernel, '10.0.0.4');
    await tom.login(email('tom'), 'bookhand-demo');
    expect((await tom.call('GET', '/api/admin/users')).status).toBe(200);
    expect((await tom.call('GET', '/api/proposals')).status).toBe(403);
  });

  it('runs the close agents through the API and lets the right person approve', async () => {
    const maya = new Client(kernel, '10.0.0.5');
    await maya.login(email('maya'), 'bookhand-demo');
    const run = await maya.call('POST', `/api/closes/${seed.closeId}/run`, {});
    expect(run.status).toBe(202);
    await app.queue.idle();
    const inbox = await maya.call('GET', '/api/proposals?view=pending&limit=200');
    const items = (inbox.body as { items: Array<{ id: string; title: string; canApprove: boolean; blocks: string[]; amount: number }> }).items;
    expect(items.length).toBeGreaterThan(5);
    const accrual = items.find((i) => i.title.startsWith('Accrue Fieldnote'))!;
    expect(accrual.canApprove).toBe(false); // $24,000 is above Maya's $5,000 limit
    const daniel = new Client(kernel, '10.0.0.6');
    await daniel.login(email('daniel'), 'bookhand-demo');
    const approve = await daniel.call('POST', `/api/proposals/${accrual.id}/approve`, { note: 'PO-1042 receipt confirmed' });
    expect(approve.status).toBe(200);
    const again = await daniel.call('POST', `/api/proposals/${accrual.id}/approve`, {});
    expect(again.status).toBe(409);
    const reject = await daniel.call('POST', `/api/proposals/${items.find((i) => i.id !== accrual.id)!.id}/reject`, { reason: '' });
    expect(reject.status).toBe(400);
  });

  it('supports TOTP two-step sign-in and rejects code replay', async () => {
    const c = new Client(kernel, '10.0.0.7');
    await c.login(email('marcus'), 'bookhand-demo');
    const setup = await c.call('POST', '/api/me/mfa/setup', {});
    const secret = (setup.body as { secret: string }).secret;
    const enable = await c.call('POST', '/api/me/mfa/enable', { code: totp(secret, Date.now()) });
    expect(enable.status).toBe(200);
    await c.call('POST', '/api/auth/logout', {});
    const c2 = new Client(kernel, '10.0.0.8');
    const step1 = await c2.call('POST', '/api/auth/login', { email: email('marcus'), password: 'bookhand-demo' });
    expect((step1.body as { mfaRequired: boolean }).mfaRequired).toBe(true);
    expect((await c2.call('GET', '/api/home')).status).toBe(401);
    const code = totp(secret, Date.now());
    const step2 = await c2.call('POST', '/api/auth/mfa', { code });
    expect(step2.status).toBe(200);
    expect((await c2.call('GET', '/api/home')).status).toBe(200);
    const c3 = new Client(kernel, '10.0.0.9');
    await c3.call('POST', '/api/auth/login', { email: email('marcus'), password: 'bookhand-demo' });
    expect((await c3.call('POST', '/api/auth/mfa', { code })).status).toBe(401);
  });

  it('isolates tenants: another organization sees none of this one and cannot act on it', async () => {
    // A second fictional organization with its own Controller (same role, different tenant).
    await app.db.tx(async (tx) => {
      const t = await tx.insert('tenants', { name: 'Quillmark Studio (fictional)', slug: 'quillmark', reporting_currency: 'USD' });
      const role = (await tx.findOne('roles', { key: 'controller' }))!;
      const u = await tx.insert('users', { tenant_id: t.id, email: 'ada.quill@quillmark.example', display_name: 'Ada Quill', password_hash: await hashPassword('quillmark-only') });
      await tx.insert('user_roles', { tenant_id: t.id, user_id: u.id, role_id: role.id });
    });
    const hannah = new Client(kernel, '10.0.3.1');
    await hannah.login(email('hannah'), 'bookhand-demo');
    const entry = ((await hannah.call('GET', '/api/journal-entries?limit=1')).body as { entries: Array<{ id: string }> }).entries[0]!.id;
    const rec = ((await hannah.call('GET', '/api/recs')).body as { recs: Array<{ id: string | null }> }).recs.find((r) => r.id)!.id!;
    const proposal = ((await hannah.call('GET', '/api/proposals?view=all&limit=1')).body as { items: Array<{ id: string }> }).items[0]!.id;
    const run = ((await hannah.call('GET', '/api/runs')).body as Array<{ id: string }>)[0]!.id;

    const ada = new Client(kernel, '10.0.3.2');
    expect((await ada.login('ada.quill@quillmark.example', 'quillmark-only')).status).toBe(200);
    for (const path of [`/api/closes/${seed.closeId}`, `/api/closes/${seed.closeId}/package`, `/api/journal-entries/${entry}`, `/api/recs/${rec}`, `/api/proposals/${proposal}`, `/api/runs/${run}`]) {
      expect((await ada.call('GET', path)).status, `GET ${path}`).toBe(404);
    }
    expect(((await ada.call('GET', '/api/proposals?view=all')).body as { items: unknown[] }).items).toEqual([]);
    expect((await ada.call('GET', '/api/runs')).body).toEqual([]);
    expect(((await ada.call('GET', '/api/journal-entries')).body as { entries: unknown[] }).entries).toEqual([]);
    const audit = (await ada.call('GET', '/api/audit')).body as { events: Array<{ actor: string }> };
    expect(audit.events.every((e) => e.actor === 'Ada Quill')).toBe(true);
    // Acting on the other organization's objects by id is refused as if they did not exist.
    expect((await ada.call('POST', `/api/proposals/${proposal}/approve`, {})).status).toBe(404);
    expect((await ada.call('POST', `/api/journal-entries/${entry}/reverse`, { reason: 'cross-tenant attempt' })).status).toBe(404);
    expect((await ada.call('POST', `/api/closes/${seed.closeId}/lock`, {})).status).toBe(404);
    // The same email cannot be registered in two organizations (sign-in identifies people by email).
    const tom = new Client(kernel, '10.0.3.3');
    await tom.login(email('tom'), 'bookhand-demo');
    const dup = await tom.call('POST', '/api/admin/users', { email: 'ada.quill@quillmark.example', name: 'Ada Again', roles: ['staff_accountant'] });
    expect(dup.status).toBe(409);
  });

  it('rate-limits password guessing and locks the account after five failures', async () => {
    // Switching between accounts on one machine is free: only failures are charged.
    const office = new Client(kernel, '10.0.0.12');
    for (let i = 0; i < 12; i++) expect((await office.call('POST', '/api/auth/login', { email: email(i % 2 ? 'maya' : 'daniel'), password: 'bookhand-demo' })).status).toBe(200);
    const c = new Client(kernel, '10.0.0.10');
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await c.call('POST', '/api/auth/login', { email: email('priya'), password: `wrong-${i}` })).status);
    expect(statuses).toContain(429);
    // The account is locked: even the right password is refused, with the same answer as a wrong one (SEC-1), so
    // the response does not tell a guesser that the account exists.
    const fresh = new Client(kernel, '10.0.0.11');
    const locked = await fresh.call('POST', '/api/auth/login', { email: email('priya'), password: 'bookhand-demo' });
    expect(locked.status).toBe(401);
    expect((locked.body as { error: { message: string } }).error.message).toBe('Email or password is incorrect.');
  });
});
