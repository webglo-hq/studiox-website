import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/server/auth/secrets';
import { base32Decode, totp } from '../../src/server/auth/totp';
import { loadConfig } from '../../src/server/config';
import { createHandler } from '../../src/server/http';
import { DEFAULT_RULES, RateLimiter } from '../../src/server/rate-limit';
import { loadTestScenario, TEST_PASSWORD, type Scenario } from '../shared/scenario';

/**
 * The HTTP surface against the real application on the in-memory store: sign-in with lockout,
 * cookies, Origin and CSRF protection, rate limits, TOTP with replay protection, session
 * rotation and expiry, role checks, security headers and static-file safety.
 */
let s: Scenario;
let server: Server;
let base = '';
let realNow = 1_800_000_000_000;

interface Client {
  cookie: string | null;
  csrf: string | null;
}

async function call(c: Client, path: string, body?: unknown, opts: { origin?: string | null; csrf?: string | null; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const origin = opts.origin === undefined ? base : opts.origin;
  if (origin) headers.origin = origin;
  if (c.cookie) headers.cookie = c.cookie;
  const csrf = opts.csrf === undefined ? c.csrf : opts.csrf;
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(base + path, { method: opts.method ?? (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) c.cookie = set.split(';')[0]!.endsWith('=') ? null : set.split(';')[0]!;
  const json = (await res.json().catch(() => null)) as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (json?.csrfToken) c.csrf = json.csrfToken;
  return { status: res.status, json, headers: res.headers };
}

async function signIn(email: string, password = TEST_PASSWORD): Promise<Client> {
  const c: Client = { cookie: null, csrf: null };
  const r = await call(c, '/api/auth/login', { email, password });
  expect(r.status).toBe(200);
  return c;
}

beforeAll(async () => {
  s = await loadTestScenario({ passwords: true });
  const staticDir = mkdtempSync(join(tmpdir(), 'ek-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Evenkeel</title>');
  const handler = createHandler({
    env: s.env,
    config: loadConfig({ DEMO_LOGIN_HELPER: '1' }),
    limiter: new RateLimiter({ ...DEFAULT_RULES, login_ip: { capacity: 60, refillPerSecond: 0.001 }, login_account: { capacity: 6, refillPerSecond: 0.001 } }),
    secrets: SecretBox.forTests(),
    staticDir,
    realNow: () => realNow,
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('HTTP surface', () => {
  it('sends strict security headers', async () => {
    const r = await call({ cookie: null, csrf: null }, '/healthz');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('lists demo personas only to this machine and only with the helper on', async () => {
    const r = await call({ cookie: null, csrf: null }, '/api/auth/session');
    expect(r.json!.authenticated).toBe(false);
    expect(r.json!.personas.length).toBe(8);
  });

  it('signs in with an HttpOnly, SameSite cookie and rejects cross-site posts', async () => {
    const c: Client = { cookie: null, csrf: null };
    const bad = await call(c, '/api/auth/login', { email: 'casey@kitewell.example', password: TEST_PASSWORD }, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    const none = await call(c, '/api/auth/login', { email: 'casey@kitewell.example', password: TEST_PASSWORD }, { origin: null });
    expect(none.status).toBe(403);
    const ok = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: 'casey@kitewell.example', password: TEST_PASSWORD }) });
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^ek_session=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  });

  it('locks an account after five failed attempts and records every attempt', async () => {
    const c: Client = { cookie: null, csrf: null };
    for (let i = 0; i < 5; i++) expect((await call(c, '/api/auth/login', { email: 'dana@kitewell.example', password: 'wrong-password-123' })).status).toBe(401);
    const locked = await call(c, '/api/auth/login', { email: 'dana@kitewell.example', password: TEST_PASSWORD });
    expect(locked.status).toBe(423);
    const attempts = await s.db.find('login_attempt', { email: 'dana@kitewell.example' });
    expect(attempts.filter((a) => a.reason === 'bad_credentials')).toHaveLength(5);
    expect(attempts.some((a) => a.reason === 'locked')).toBe(true);
    const unknown = await call(c, '/api/auth/login', { email: 'nobody@kitewell.example', password: 'whatever-123456' });
    expect(unknown.status).toBe(401);
    expect(unknown.json!.error.message).toBe('Email or password is incorrect.');
  });

  it('requires a session for the API and the CSRF token for changes', async () => {
    const anon = await call({ cookie: null, csrf: null }, '/api/rpc/home.myClose', {});
    expect(anon.status).toBe(401);
    const c = await signIn('casey@kitewell.example');
    expect((await call(c, '/api/rpc/home.myClose', {})).status).toBe(200);
    const noCsrf = await call(c, '/api/rpc/close.updateTask', { taskId: '00000000-0000-4000-8000-000000000000', action: 'start' }, { csrf: null });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json!.error.code).toBe('CSRF');
    const wrong = await call(c, '/api/rpc/close.updateTask', { taskId: '00000000-0000-4000-8000-000000000000', action: 'start' }, { csrf: 'forged' });
    expect(wrong.status).toBe(403);
    const invalid = await call(c, '/api/rpc/inbox.decide', { ids: [], decision: 'approve' });
    expect(invalid.status).toBe(400);
    expect(invalid.json!.error.code).toBe('VALIDATION');
    const unknown = await call(c, '/api/rpc/nope.nothing', {});
    expect(unknown.status).toBe(404);
  });

  it('enforces roles: the auditor can read but not change anything', async () => {
    const c = await signIn('alex@auditfirm.example');
    expect((await call(c, '/api/rpc/audit.list', { limit: 5 })).status).toBe(200);
    const run = await call(c, '/api/rpc/close.orchestrate', {});
    expect(run.status).toBe(403);
    const users = await call(c, '/api/rpc/admin.users', {});
    expect(users.status).toBe(403);
  });

  it('rotates sessions on a timer, expires them when idle, and signs out', async () => {
    const c = await signIn('priya@kitewell.example');
    const first = c.cookie;
    s.clock.advance(16 * 60_000);
    const r = await call(c, '/api/rpc/session.me', {});
    expect(r.status).toBe(200);
    expect(c.cookie).not.toBe(first);
    const old: Client = { cookie: first, csrf: c.csrf };
    expect((await call(old, '/api/rpc/session.me', {})).status).toBe(401);
    expect((await call(c, '/api/rpc/close.updateTask', { taskId: '00000000-0000-4000-8000-000000000000', action: 'start' })).json!.error.code).not.toBe('CSRF');
    s.clock.advance(31 * 60_000);
    const idle = await call(c, '/api/rpc/session.me', {});
    expect(idle.status).toBe(401);
    expect(idle.json!.error.message).toMatch(/inactivity/);
    const c2 = await signIn('priya@kitewell.example');
    expect((await call(c2, '/api/auth/logout', {})).status).toBe(200);
    expect((await call(c2, '/api/rpc/session.me', {})).status).toBe(401);
  });

  it('turns on TOTP, then requires it at sign-in and refuses replayed codes', async () => {
    const c = await signIn('jordan@kitewell.example');
    const setup = await call(c, '/api/auth/mfa/setup', {});
    expect(setup.status).toBe(200);
    const secret = base32Decode(setup.json!.secret as string);
    const enable = await call(c, '/api/auth/mfa/enable', { code: totp(secret, realNow) });
    expect(enable.status).toBe(200);
    await call(c, '/api/auth/logout', {});

    realNow += 60_000;
    const c2: Client = { cookie: null, csrf: null };
    const login = await call(c2, '/api/auth/login', { email: 'jordan@kitewell.example', password: TEST_PASSWORD });
    expect(login.json!.mfaRequired).toBe(true);
    const blocked = await call(c2, '/api/rpc/home.myClose', {});
    expect(blocked.status).toBe(401);
    expect(blocked.json!.error.code).toBe('MFA_REQUIRED');
    expect((await call(c2, '/api/auth/mfa', { code: '000000' })).status).toBe(401);
    const code = totp(secret, realNow);
    expect((await call(c2, '/api/auth/mfa', { code })).status).toBe(200);
    expect((await call(c2, '/api/rpc/home.myClose', {})).status).toBe(200);

    const c3: Client = { cookie: null, csrf: null };
    await call(c3, '/api/auth/login', { email: 'jordan@kitewell.example', password: TEST_PASSWORD });
    expect((await call(c3, '/api/auth/mfa', { code })).status).toBe(401); // replay of a used step
  });

  it('rate-limits sign-in attempts per account', async () => {
    const c: Client = { cookie: null, csrf: null };
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      const r = await call(c, '/api/auth/login', { email: 'miguel@kitewell.example', password: `wrong-password-${i}-x` });
      if (r.status === 429) {
        limited = true;
        expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
      }
    }
    expect(limited).toBe(true);
  });

  it('serves the app shell without exposing files outside the build', async () => {
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<title>Evenkeel</title>');
    const trav = await fetch(`${base}/..%2f..%2fpackage.json`);
    expect(await trav.text()).not.toContain('"name": "evenkeel"');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/api/rpc/home.myClose`, { method: 'GET' })).status).toBe(405);
  });
});
