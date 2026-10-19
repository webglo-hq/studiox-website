/**
 * Identity lifecycle over the HTTP API: switching on two-factor issues one-time recovery codes;
 * a session that has not finished two-factor can only finish it; administrators reset a lost
 * authenticator or a forgotten password (audited, the person signed out everywhere).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { totpAt, TOTP_PERIOD } from '../../src/core/auth/totp';
import { PEOPLE } from '../../src/packs/accounting/seed/company';
import { testApp, TEST_PASSWORD, type HttpClient, type TestApp } from '../support/app';

interface AdminView {
  users: { id: string; name: string; mfa: boolean }[];
  account: { recoveryCodesLeft: number };
}

let t: TestApp;
const emailOf = (key: string) => PEOPLE.find((p) => p.key === key)!.email;
// TOTP runs on wall-clock time, like the authenticator app on a phone
const step = () => Math.floor(Date.now() / 1000 / TOTP_PERIOD);

async function signIn(c: HttpClient, key: string, password = TEST_PASSWORD) {
  const r = await c.post<{ csrfToken: string; mfa: string; passwordChange?: boolean }>('/api/auth/login', { email: emailOf(key), password }, { 'x-tieout-client-ip': '198.51.100.20' });
  if (r.status === 200) c.csrf = r.body.csrfToken;
  return r;
}

async function signedIn(key: string): Promise<HttpClient> {
  const c = t.client();
  expect((await signIn(c, key)).status).toBe(200);
  return c;
}

beforeAll(async () => {
  t = await testApp();
}, 120_000);

describe('two-factor recovery codes', () => {
  let codes: string[] = [];
  let rileySession: HttpClient;

  it('issues ten one-time codes when two-factor is switched on', async () => {
    const riley = await signedIn('riley');
    const enrol = await riley.post<{ secret: string }>('/api/auth/mfa/enroll', {});
    expect(enrol.status).toBe(200);
    const v = await riley.post<{ csrfToken: string; recoveryCodes: string[] }>('/api/auth/mfa/verify', { code: totpAt(enrol.body.secret, step()) });
    expect(v.status).toBe(200);
    codes = v.body.recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-km-np-z2-9]{5}-[a-km-np-z2-9]{5}$/);
    riley.csrf = v.body.csrfToken;
    expect((await riley.get<AdminView>('/api/admin')).body.account.recoveryCodesLeft).toBe(10);
  });

  it('lets a session that has not finished two-factor do nothing but finish it', async () => {
    const c = t.client();
    expect((await signIn(c, 'riley')).body.mfa).toBe('pending');
    expect((await c.get<{ mfa: string }>('/api/auth/me')).body.mfa).toBe('pending');
    expect((await c.get('/api/home')).status).toBe(401);
    // a password alone never yields an API token or a changed credential
    expect((await c.post('/api/auth/tokens', { name: 'sneaky', days: 7 })).status).toBe(401);
    expect((await c.post('/api/auth/password', { current: TEST_PASSWORD, next: 'an-entirely-new-password-42' })).status).toBe(401);
    expect((await c.post('/api/auth/mfa/recovery-codes', {})).status).toBe(401);
  });

  it('accepts each recovery code once, in place of the authenticator', async () => {
    rileySession = t.client();
    await signIn(rileySession, 'riley');
    const used = await rileySession.post<{ csrfToken: string; recoveryCodesLeft: number }>('/api/auth/mfa/verify', { code: codes[0]!.toUpperCase() });
    expect(used.status).toBe(200);
    expect(used.body.recoveryCodesLeft).toBe(9);
    rileySession.csrf = used.body.csrfToken;
    expect((await rileySession.get('/api/home')).status).toBe(200);

    const other = t.client();
    await signIn(other, 'riley');
    expect((await other.post('/api/auth/mfa/verify', { code: codes[0] })).status).toBe(400);
    // a new set replaces the old one
    const fresh = await rileySession.post<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes', {});
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    expect((await other.post('/api/auth/mfa/verify', { code: codes[1] })).status).toBe(400);
    expect((await other.post('/api/auth/mfa/verify', { code: fresh.body.recoveryCodes[3] })).status).toBe(200);
  });

  it('keeps failed attempts on the audit trail (the error does not roll the record back)', async () => {
    const alex = await signedIn('alex');
    const log = await alex.get<{ items: { action: string; summary: string }[] }>('/api/audit?limit=300&action=auth.mfa');
    const actions = log.body.items.map((i) => i.action);
    for (const a of ['auth.mfa.activated', 'auth.mfa.failed', 'auth.mfa.recovery_used', 'auth.mfa.recovery_regenerated']) expect(actions, a).toContain(a);
    expect(log.body.items.find((i) => i.action === 'auth.mfa.recovery_used')!.summary).toMatch(/recovery code \(\d+ left\)/);
  });

  it('lets an administrator reset a lost authenticator, with a reason, signing the person out everywhere', async () => {
    const avery = await signedIn('avery');
    const users = (await avery.get<AdminView>('/api/admin')).body.users;
    const riley = users.find((u) => u.name === 'Riley Chen')!;
    expect(riley.mfa).toBe(true);
    expect((await avery.post(`/api/admin/users/${riley.id}/mfa-reset`, { reason: 'lost it' })).status).toBe(400);
    expect((await avery.post(`/api/admin/users/${riley.id}/mfa-reset`, { reason: 'Lost phone; identity confirmed on a video call' })).status).toBe(200);
    expect((await rileySession.get('/api/home')).status).toBe(401);
    const back = t.client();
    expect((await signIn(back, 'riley')).body.mfa).toBe('not_required');
    expect((await back.get<AdminView>('/api/admin')).body.account.recoveryCodesLeft).toBe(0);
    // nobody resets their own second factor, and only administrators reset anyone's
    const self = users.find((u) => u.name === 'Avery Stone')!;
    expect((await avery.post(`/api/admin/users/${self.id}/mfa-reset`, { reason: 'resetting my own factor' })).status).toBe(403);
    const casey = await signedIn('casey');
    expect((await casey.post(`/api/admin/users/${riley.id}/mfa-reset`, { reason: 'controller trying an admin task' })).status).toBe(403);
  });
});

describe('administrator password resets and account changes', () => {
  it('issues a temporary password: the old one stops working and sessions end', async () => {
    const sam = await signedIn('sam');
    const avery = await signedIn('avery');
    const samId = (await avery.get<AdminView>('/api/admin')).body.users.find((u) => u.name === 'Sam Rivera')!.id;
    const r = await avery.post<{ tempPassword: string }>(`/api/admin/users/${samId}/password-reset`, {});
    expect(r.status).toBe(200);
    expect(r.body.tempPassword.length).toBeGreaterThanOrEqual(24);
    expect((await sam.get('/api/home')).status).toBe(401);
    expect((await signIn(t.client(), 'sam')).status).toBe(401);

    // the temporary password only lets Sam choose a new one
    const fresh = t.client();
    const login = await signIn(fresh, 'sam', r.body.tempPassword);
    expect(login.status).toBe(200);
    expect(login.body.passwordChange).toBe(true);
    expect((await fresh.get<{ passwordChange: boolean }>('/api/auth/me')).body.passwordChange).toBe(true);
    const blocked = await fresh.get<{ error: { details: { passwordChange: boolean } } }>('/api/home');
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.details.passwordChange).toBe(true);
    expect((await fresh.post('/api/auth/tokens', { name: 'sneaky', days: 7 })).status).toBe(401);
    expect((await fresh.post('/api/auth/password', { current: r.body.tempPassword, next: r.body.tempPassword })).status).toBe(400);
    expect((await fresh.post('/api/auth/password', { current: r.body.tempPassword, next: 'sam-picks-a-long-passphrase' })).status).toBe(200);
    expect((await fresh.get('/api/home')).status).toBe(200);
    expect((await signIn(t.client(), 'sam', r.body.tempPassword)).status).toBe(401);
    expect((await signIn(t.client(), 'sam', 'sam-picks-a-long-passphrase')).body.passwordChange).toBe(false);

    const casey = await signedIn('casey');
    expect((await casey.post(`/api/admin/users/${samId}/password-reset`, {})).status).toBe(403);
  });

  it('retires the person’s API tokens with a password reset', async () => {
    const riley = await signedIn('riley');
    const token = await riley.post<{ token: string }>('/api/auth/tokens', { name: 'Riley laptop (MCP)', days: 7 });
    expect(token.status).toBe(200);
    const viaToken = () => t.app.fetch(new Request('https://tieout.test/api/home', { headers: { authorization: `Bearer ${token.body.token}` } }));
    expect((await viaToken()).status).toBe(200);
    const avery = await signedIn('avery');
    const rileyId = (await avery.get<AdminView>('/api/admin')).body.users.find((u) => u.name === 'Riley Chen')!.id;
    expect((await avery.post(`/api/admin/users/${rileyId}/password-reset`, {})).status).toBe(200);
    expect((await viaToken()).status).toBe(401);
  });

  it('records why an account was disabled', async () => {
    const avery = await signedIn('avery');
    const devon = (await avery.get<AdminView>('/api/admin')).body.users.find((u) => u.name === 'Devon Park')!;
    expect((await avery.post(`/api/admin/users/${devon.id}/status`, { status: 'disabled' })).status).toBe(400);
    expect((await avery.post(`/api/admin/users/${devon.id}/status`, { status: 'disabled', reason: 'Left the company on 30 September' })).status).toBe(200);
    expect((await signIn(t.client(), 'devon')).status).toBe(401);
    const log = await avery.get<{ items: { action: string; summary: string }[] }>(`/api/audit?subject=${devon.id}`);
    expect(log.body.items.find((i) => i.action === 'admin.user.disable')!.summary).toContain('Left the company on 30 September');
    expect((await avery.post(`/api/admin/users/${devon.id}/status`, { status: 'active' })).status).toBe(200);
    expect((await signIn(t.client(), 'devon')).status).toBe(200);
  });
});
