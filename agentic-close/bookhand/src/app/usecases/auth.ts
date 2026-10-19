import { encode as encodeQr } from 'uqr';
import { appendAudit } from '../../audit/audit';
import type { Row } from '../../persistence/schema';
import { hashPassword, passwordProblems, verifyPassword } from '../../security/passwords';
import { loadPrincipal, type Principal } from '../../security/principal';
import { createSession, revokeSession, revokeUserSessions, rotateSession, type SessionPolicy } from '../../security/sessions';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../security/totp';
import { DomainError } from '../../shared/errors';
import type { App, RequestMeta } from '../app';
import { queueMessage } from '../outbox';

/**
 * Authentication: password (scrypt), optional TOTP second factor, server-side sessions. Errors never reveal
 * whether an email exists, not even for a locked account. Accounts lock for 15 minutes after 5 consecutive
 * failures, and the account holder (not the person guessing) is told by message.
 */

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export function sessionPolicy(app: App): SessionPolicy {
  return { idleMinutes: app.config.sessionIdleMinutes, absoluteHours: app.config.sessionAbsoluteHours, rotateMinutes: 15, graceSeconds: 60 };
}

export interface LoginResult {
  token: string;
  csrfToken: string;
  mfaRequired: boolean;
  user: { id: string; name: string; email: string };
}

const GENERIC = 'Email or password is incorrect.';

export async function login(app: App, email: string, password: string, meta: RequestMeta = {}): Promise<LoginResult> {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized || !password || normalized.length > 200 || password.length > 256) throw new DomainError('UNAUTHENTICATED', GENERIC);
  const user = (await app.read((tx) => tx.find('users', { email: normalized }))).find((u) => u.identity_provider === 'password');
  const now = app.clock.now();
  if (!user) {
    await verifyPassword(password, null); // equalize timing
    throw new DomainError('UNAUTHENTICATED', GENERIC);
  }
  if (user.status !== 'active') {
    await verifyPassword(password, null);
    throw new DomainError('UNAUTHENTICATED', GENERIC);
  }
  if (user.locked_until && user.locked_until > now) {
    // Same answer and timing as a wrong password: a lock message would tell a guesser the account exists.
    await verifyPassword(password, null);
    throw new DomainError('UNAUTHENTICATED', GENERIC);
  }
  const check = await verifyPassword(password, user.password_hash);
  if (!check.ok) {
    await app.tx(async (tx) => {
      const failures = user.failed_login_count + 1;
      await tx.update('users', user.id, { failed_login_count: failures, locked_until: failures >= MAX_FAILURES ? new Date(Date.parse(now) + LOCK_MINUTES * 60_000).toISOString() : user.locked_until, updated_at: now });
      await appendAudit(tx, user.tenant_id, { type: 'user', userId: user.id, label: user.display_name, ip: meta.ip, requestId: meta.requestId }, { action: failures >= MAX_FAILURES ? 'auth.locked' : 'auth.login_failed', objectType: 'user', objectId: user.id, summary: failures >= MAX_FAILURES ? `Account locked after ${failures} failed sign-ins` : `Failed sign-in (${failures} in a row)` }, now);
      if (failures === MAX_FAILURES) {
        const tenant = (await tx.get('tenants', user.tenant_id))!;
        await queueMessage(tx, tenant, app.config.outbox ?? null, {
          tenantId: tenant.id,
          toUserId: user.id,
          toEmail: user.email,
          kind: 'account_locked',
          subject: 'Your Bookhand account is locked for 15 minutes',
          body: `Hello ${user.display_name.split(' ')[0]}, after ${failures} failed sign-ins in a row (the last from ${meta.ip ?? 'an unknown address'}) your account is locked until ${new Date(Date.parse(now) + LOCK_MINUTES * 60_000).toISOString().slice(11, 16)} UTC. If that was not you, tell your administrator.`,
        }, now);
      }
    });
    throw new DomainError('UNAUTHENTICATED', GENERIC);
  }
  const rehash = check.needsRehash ? await hashPassword(password) : null;
  return app.tx(async (tx) => {
    await tx.update('users', user.id, { failed_login_count: 0, locked_until: null, last_login_at: now, updated_at: now, ...(rehash ? { password_hash: rehash } : {}) });
    const issued = await createSession(tx, { tenantId: user.tenant_id, userId: user.id, authMethod: 'password', state: user.mfa_enabled ? 'mfa_pending' : 'active', mfaVerified: false, ip: meta.ip, userAgent: meta.userAgent, now, policy: sessionPolicy(app) });
    await appendAudit(tx, user.tenant_id, { type: 'user', userId: user.id, label: user.display_name, ip: meta.ip, requestId: meta.requestId }, { action: user.mfa_enabled ? 'auth.password_ok' : 'auth.login', objectType: 'session', objectId: issued.session.id, summary: user.mfa_enabled ? 'Password accepted; waiting for the authenticator code' : 'Signed in' }, now);
    return { token: issued.token, csrfToken: issued.session.csrf_token, mfaRequired: user.mfa_enabled, user: { id: user.id, name: user.display_name, email: user.email } };
  });
}

/** Second factor. Rotates the session token on success (privilege change). */
export async function verifyMfa(app: App, session: Row<'sessions'>, code: string, meta: RequestMeta = {}): Promise<{ token: string; csrfToken: string }> {
  if (session.state !== 'mfa_pending') throw new DomainError('CONFLICT', 'No second factor is pending for this session.');
  const user = await app.read((tx) => tx.get('users', session.user_id));
  if (!user?.mfa_secret_enc) throw new DomainError('UNAUTHENTICATED', 'MFA is not set up for this account.');
  const secret = app.secrets.open(user.mfa_secret_enc, user.id);
  const step = verifyTotp(secret, String(code ?? '').replace(/\s/g, ''), Date.parse(app.clock.now()));
  const now = app.clock.now();
  if (step === null) {
    await app.tx((tx) => appendAudit(tx, user.tenant_id, { type: 'user', userId: user.id, label: user.display_name, ip: meta.ip }, { action: 'auth.mfa_failed', objectType: 'session', objectId: session.id, summary: 'Wrong authenticator code' }, now));
    throw new DomainError('UNAUTHENTICATED', 'That code is not valid. Codes change every 30 seconds.');
  }
  return app.tx(async (tx) => {
    const used = await tx.findOne('idempotency_keys', { tenant_id: user.tenant_id, scope: 'totp', key: `${user.id}:${step}` });
    if (used) throw new DomainError('UNAUTHENTICATED', 'That code was already used. Wait for the next one.');
    await tx.insert('idempotency_keys', { tenant_id: user.tenant_id, scope: 'totp', key: `${user.id}:${step}`, request_hash: 'totp', status_code: 200, response: {} });
    const rotated = await rotateSession(tx, session, now, sessionPolicy(app), { state: 'active', mfa_verified: true, auth_method: 'password+totp' });
    await appendAudit(tx, user.tenant_id, { type: 'user', userId: user.id, label: user.display_name, ip: meta.ip, requestId: meta.requestId }, { action: 'auth.login', objectType: 'session', objectId: rotated.session.id, summary: 'Signed in with password and authenticator code' }, now);
    return { token: rotated.token, csrfToken: rotated.session.csrf_token };
  });
}

export async function logout(app: App, session: Row<'sessions'>, meta: RequestMeta = {}): Promise<void> {
  await app.tx(async (tx) => {
    await revokeSession(tx, session.id, 'logout', app.clock.now());
    const user = await tx.get('users', session.user_id);
    if (user) await appendAudit(tx, session.tenant_id, { type: 'user', userId: user.id, label: user.display_name, ip: meta.ip }, { action: 'auth.logout', objectType: 'session', objectId: session.id, summary: 'Signed out' }, app.clock.now());
  });
}

export async function me(app: App, p: Principal, session: Row<'sessions'>) {
  const tenant = await app.read((tx) => tx.get('tenants', p.tenantId));
  return {
    user: { id: p.user.id, name: p.user.display_name, email: p.user.email, title: p.user.title, hue: p.user.avatar_hue, mfaEnabled: p.user.mfa_enabled },
    roles: p.roles.map((r) => ({ key: r.key, name: r.name, entity: r.entityId })),
    permissions: [...p.permissions].sort(),
    approvalLimit: p.approvalLimitMinor,
    readOnly: p.readOnly,
    tenant: tenant ? { id: tenant.id, name: tenant.name, reportingCurrency: tenant.reporting_currency, isDemo: tenant.is_demo, businessDate: app.clock.businessDate() } : null,
    session: { id: session.id, method: session.auth_method, mfaVerified: session.mfa_verified, expiresAt: session.idle_expires_at, absoluteExpiresAt: session.absolute_expires_at },
    csrfToken: session.csrf_token,
    mode: { app: app.config.mode, live: !!app.liveModel, model: app.liveModel },
  };
}

function qrMatrix(text: string): boolean[][] {
  return encodeQr(text, { ecc: 'M', border: 2 }).data;
}

export async function setupMfa(app: App, p: Principal, meta: RequestMeta = {}) {
  const secret = generateTotpSecret();
  const url = otpauthUrl(secret, p.user.email, 'Bookhand');
  await app.tx(async (tx) => {
    await tx.update('users', p.user.id, { mfa_pending_secret_enc: app.secrets.seal(secret, p.user.id), updated_at: app.clock.now() });
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'auth.mfa_setup', objectType: 'user', objectId: p.user.id, summary: 'Started authenticator setup' }, app.clock.now());
  });
  return { secret, otpauthUrl: url, qr: qrMatrix(url) };
}

export async function enableMfa(app: App, p: Principal, code: string, meta: RequestMeta = {}) {
  const user = await app.read((tx) => tx.get('users', p.user.id));
  if (!user?.mfa_pending_secret_enc) throw new DomainError('CONFLICT', 'Start authenticator setup first.');
  const secret = app.secrets.open(user.mfa_pending_secret_enc, user.id);
  if (verifyTotp(secret, String(code ?? '').replace(/\s/g, ''), Date.parse(app.clock.now())) === null) throw new DomainError('VALIDATION', 'That code does not match. Check the time on your phone and try the next code.');
  await app.tx(async (tx) => {
    await tx.update('users', user.id, { mfa_enabled: true, mfa_secret_enc: user.mfa_pending_secret_enc, mfa_pending_secret_enc: null, updated_at: app.clock.now() });
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'auth.mfa_enabled', objectType: 'user', objectId: user.id, summary: 'Turned on two-step sign-in (authenticator app)' }, app.clock.now());
  });
  return { enabled: true };
}

export async function disableMfa(app: App, p: Principal, code: string, meta: RequestMeta = {}) {
  const user = await app.read((tx) => tx.get('users', p.user.id));
  if (!user?.mfa_enabled || !user.mfa_secret_enc) throw new DomainError('CONFLICT', 'Two-step sign-in is not on.');
  if (verifyTotp(app.secrets.open(user.mfa_secret_enc, user.id), String(code ?? '').replace(/\s/g, ''), Date.parse(app.clock.now())) === null) throw new DomainError('VALIDATION', 'That code does not match.');
  await app.tx(async (tx) => {
    await tx.update('users', user.id, { mfa_enabled: false, mfa_secret_enc: null, updated_at: app.clock.now() });
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'auth.mfa_disabled', objectType: 'user', objectId: user.id, summary: 'Turned off two-step sign-in' }, app.clock.now());
  });
  return { enabled: false };
}

export async function changePassword(app: App, p: Principal, session: Row<'sessions'>, current: string, next: string, meta: RequestMeta = {}) {
  const user = await app.read((tx) => tx.get('users', p.user.id));
  if (!user || !(await verifyPassword(current, user.password_hash)).ok) throw new DomainError('VALIDATION', 'Your current password is not correct.');
  const problems = passwordProblems(next, { email: user.email, name: user.display_name });
  if (problems.length) throw new DomainError('VALIDATION', problems.join(' '), { problems });
  const hash = await hashPassword(next);
  await app.tx(async (tx) => {
    await tx.update('users', user.id, { password_hash: hash, updated_at: app.clock.now() });
    const revoked = await revokeUserSessions(tx, user.id, 'password_changed', app.clock.now(), session.id);
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'auth.password_changed', objectType: 'user', objectId: user.id, summary: `Changed password; signed out ${revoked} other session(s)` }, app.clock.now());
  });
  return { ok: true };
}

export async function principalFor(app: App, session: Row<'sessions'>): Promise<Principal> {
  return app.read((tx) => loadPrincipal(tx, session.tenant_id, session.user_id));
}
