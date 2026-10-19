/**
 * Authentication use cases: password login with lockout and rate limits, server-side sessions
 * (only a SHA-256 of the token is stored), CSRF tokens, idle/absolute expiry, TOTP MFA with
 * replay protection and session rotation, API tokens for the MCP server, and an OIDC seam.
 */
import { resolveUserActor } from '../core/auth/actor';
import { decryptSecret, encryptSecret, newTotpSecret, otpauthUri, verifyTotp } from '../core/auth/totp';
import { hashRecoveryCode, newRecoveryCodes, normalizeRecoveryCode } from '../core/auth/recovery';
import { audit } from '../core/audit/audit';
import { conflict, DomainError, forbidden, notFound, precondition, validation } from '../core/util/errors';
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from '../core/util/hash';
import { secureToken } from '../core/util/random';
import { addMinutes } from '../core/util/time';
import type { DbTx, SessionRow, UserRow } from '../schema';
import type { AppContext, RequestUser } from './context';

const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  mfa: 'not_required' | 'pending' | 'enroll';
  /** a temporary password: choose a new one before anything else */
  passwordChange: boolean;
  user: { id: string; name: string; email: string };
}

function unauthenticated(msg = 'Please sign in.') {
  return new DomainError('unauthenticated', msg);
}

/** Sign-in emails are unique across tenants: the directory names the tenant, the row is read inside it. */
export async function userByEmail(ctx: AppContext, email: string): Promise<UserRow | undefined> {
  const tenantId = await ctx.db.tenantOf('user_email', email);
  return tenantId ? ctx.db.tx(tenantId, (tx) => tx.findOne('users', { email })) : undefined;
}

export async function login(ctx: AppContext, email: string, password: string, meta: { ip: string | null; userAgent: string | null }): Promise<LoginResult> {
  const normalized = String(email ?? '').trim().toLowerCase();
  const ipGate = ctx.limiter.check(`login:ip:${meta.ip ?? '-'}`, 20, 60_000);
  const userGate = ctx.limiter.check(`login:user:${normalized}`, 8, 60_000);
  if (!ipGate.ok || !userGate.ok) throw new DomainError('rate_limited', 'Too many sign-in attempts. Wait a minute and try again.', { retryAfterSec: Math.max(ipGate.retryAfterSec, userGate.retryAfterSec) });
  const user = await userByEmail(ctx, normalized);
  const now = ctx.clock.now();
  const generic = 'Email or password is incorrect, or the account is temporarily locked.';
  const ok = await ctx.hasher.verify(String(password ?? ''), user?.password_hash ?? null);
  if (!user || user.status !== 'active' || user.kind !== 'human' || (user.locked_until && user.locked_until > now.toISOString()) || !ok) {
    if (user) {
      await ctx.db.tx(user.tenant_id, async (tx) => {
        const fails = user.failed_logins + 1;
        await tx.update('users', user.id, { failed_logins: fails, locked_until: fails >= LOCK_AFTER ? addMinutes(now.toISOString(), LOCK_MINUTES) : user.locked_until });
        await audit(tx, { type: 'user', id: user.id, label: user.display_name }, ctx.clock, { action: 'auth.login.failed', subjectType: 'user', subjectId: user.id, summary: `Failed sign-in (${fails} in a row)${fails >= LOCK_AFTER ? '; account locked for 15 minutes' : ''}`, data: {} }, meta.ip);
      });
    }
    throw unauthenticated(generic);
  }
  return ctx.db.tx(user.tenant_id, async (tx) => {
    const patch: Partial<UserRow> = { failed_logins: 0, locked_until: null, last_login_at: now.toISOString() };
    if (user.password_hash && ctx.hasher.needsRehash(user.password_hash)) patch.password_hash = await ctx.hasher.hash(password);
    await tx.update('users', user.id, patch);
    const actor = await resolveUserActor(tx, user.id);
    const tenant = await tx.get('tenants', user.tenant_id);
    const mfaRequired = (tenant?.settings.mfaRequiredRoles ?? []).some((r) => actor.roles.includes(r));
    const mfa: LoginResult['mfa'] = user.mfa_enabled ? 'pending' : mfaRequired ? 'enroll' : 'not_required';
    const { token, csrf } = await createSession(ctx, tx, user, mfa === 'not_required' ? 'not_required' : 'pending', meta, null);
    await audit(tx, actor, ctx.clock, { action: 'auth.login', subjectType: 'user', subjectId: user.id, summary: `Signed in${mfa !== 'not_required' ? ' (MFA required)' : ''}`, data: { mfa } }, meta.ip);
    return { sessionToken: token, csrfToken: csrf, mfa, passwordChange: user.must_change_password, user: { id: user.id, name: user.display_name, email: user.email } };
  });
}

async function createSession(ctx: AppContext, tx: DbTx, user: UserRow, mfaState: SessionRow['mfa_state'], meta: { ip: string | null; userAgent: string | null }, rotatedFrom: string | null) {
  const token = secureToken(32);
  const csrf = csrfFor(token);
  const now = ctx.clock.now().toISOString();
  const tenant = await tx.get('tenants', user.tenant_id);
  const idle = tenant?.settings.sessionIdleMinutes ?? ctx.config.sessionIdleMinutes;
  const abs = tenant?.settings.sessionAbsoluteHours ?? ctx.config.sessionAbsoluteHours;
  await tx.insert('sessions', { id: sha256Hex(token), user_id: user.id, csrf_hash: sha256Hex(csrf), mfa_state: mfaState, created_at: now, last_seen_at: now, idle_expires_at: addMinutes(now, idle), absolute_expires_at: addMinutes(now, abs * 60), rotated_from: rotatedFrom, revoked_at: null, revoked_reason: null, ip: meta.ip, user_agent: meta.userAgent?.slice(0, 300) ?? null });
  return { token, csrf };
}

export interface Authenticated {
  user: RequestUser;
  session: SessionRow;
}

// ------------------------------------------------------------------ OpenID Connect (SSO)
const OIDC_TTL_MS = 10 * 60_000;
/** Authentication methods (RFC 8176 `amr`) that count as multi-factor at the identity provider. */
const MFA_AMR = new Set(['mfa', 'otp', 'hwk', 'swk', 'sms', 'fpt', 'face', 'iris', 'pop', 'sc']);

/** Start SSO: where to send the browser, and the sealed (encrypted) values to keep in a short-lived cookie. */
export async function oidcStart(ctx: AppContext): Promise<{ url: string; sealed: string }> {
  if (!ctx.oidc) throw precondition('Single sign-on is not configured.');
  const { url, pending } = await ctx.oidc.authorizationUrl();
  const sealed = await encryptSecret(JSON.stringify({ ...pending, exp: Date.now() + OIDC_TTL_MS }), ctx.config.encryptionKey);
  return { url, sealed };
}

/**
 * Finish SSO: validate the provider's answer, map the verified email to an existing, active
 * account (no self-registration: an admin invites people first) and open a session. MFA is
 * accepted from the provider (`amr`); when a role requires MFA and the provider did not do it,
 * the session waits for the account's own TOTP code.
 */
export async function oidcCallback(ctx: AppContext, params: { code: string | null; state: string | null; error: string | null }, sealed: string | null, meta: { ip: string | null; userAgent: string | null }): Promise<LoginResult> {
  if (!ctx.oidc) throw precondition('Single sign-on is not configured.');
  if (!sealed) throw unauthenticated('This sign-in link has expired. Start again.');
  let pending: { state: string; nonce: string; verifier: string; exp: number };
  try {
    pending = JSON.parse(await decryptSecret(sealed, ctx.config.encryptionKey)) as typeof pending;
  } catch {
    throw unauthenticated('This sign-in link is not valid. Start again.');
  }
  if (pending.exp < Date.now()) throw unauthenticated('This sign-in link has expired. Start again.');
  let claims;
  try {
    claims = await ctx.oidc.complete(params, pending);
  } catch (e) {
    throw unauthenticated(`Single sign-on failed: ${(e as Error).message}.`);
  }
  const email = String(claims.email ?? '').trim().toLowerCase();
  if (!email || claims.email_verified !== true) throw unauthenticated('Your identity provider did not confirm a verified email address.');
  const user = await userByEmail(ctx, email);
  if (!user || (user.status !== 'active' && user.status !== 'invited') || user.kind !== 'human') throw unauthenticated('There is no active Tieout account for that email. Ask an administrator to invite you.');
  return ctx.db.tx(user.tenant_id, async (tx) => {
    const now = ctx.clock.now().toISOString();
    // signing in through the identity provider retires any temporary Tieout password, and it
    // completes an invitation: the account becomes active and the invitation link stops working
    const retire = user.must_change_password ? { must_change_password: false, password_hash: await ctx.hasher.hash(`${secureToken(24)}-retired`) } : {};
    await tx.update('users', user.id, { failed_logins: 0, locked_until: null, last_login_at: now, ...retire, ...(user.status === 'invited' ? { status: 'active' as const } : {}) });
    if (user.status === 'invited') for (const l of await tx.find('credential_links', { user_id: user.id, purpose: 'enrolment', used_at: { isNull: true }, revoked_at: { isNull: true } })) await tx.update('credential_links', l.id, { revoked_at: now });
    const actor = await resolveUserActor(tx, user.id);
    const tenant = await tx.get('tenants', user.tenant_id);
    const mfaRequired = (tenant?.settings.mfaRequiredRoles ?? []).some((r) => actor.roles.includes(r));
    const idpMfa = (claims.amr ?? []).some((m) => MFA_AMR.has(m));
    if (mfaRequired && !idpMfa && !user.mfa_enabled) throw forbidden('Your role requires multi-factor sign-in, and your identity provider did not report one. Sign in with MFA at your provider, or set up an authenticator in Tieout.');
    const state: SessionRow['mfa_state'] = mfaRequired && !idpMfa ? 'pending' : 'not_required';
    const { token, csrf } = await createSession(ctx, tx, user, state, meta, null);
    await audit(tx, actor, ctx.clock, { action: 'auth.login', subjectType: 'user', subjectId: user.id, summary: `Signed in with single sign-on${state === 'pending' ? ' (Tieout MFA required)' : ''}`, data: { method: 'oidc', issuer: claims.iss, amr: claims.amr ?? [] } }, meta.ip);
    return { sessionToken: token, csrfToken: csrf, mfa: state === 'pending' ? 'pending' : 'not_required', passwordChange: false, user: { id: user.id, name: user.display_name, email: user.email } };
  });
}

/** Validate a session token from the cookie (or a bearer API token for the MCP server). */
export async function authenticate(ctx: AppContext, token: string | null, opts: { ip: string | null; allowPendingMfa?: boolean; allowPasswordChange?: boolean }): Promise<Authenticated> {
  if (!token || token.length < 20 || token.length > 200) throw unauthenticated();
  const id = sha256Hex(token);
  const tenantId = await ctx.db.tenantOf('session', id);
  const s = tenantId ? await ctx.db.tx(tenantId, (tx) => tx.get('sessions', id)) : undefined;
  const now = ctx.clock.now().toISOString();
  if (!s || s.revoked_at || s.idle_expires_at < now || s.absolute_expires_at < now) throw unauthenticated('Your session has ended. Please sign in again.');
  if (s.mfa_state === 'pending' && !opts.allowPendingMfa) throw new DomainError('unauthenticated', 'Finish two-factor verification first.', { mfa: 'pending' });
  return ctx.db.tx(s.tenant_id, async (tx) => {
    let session = s;
    // sliding idle expiry, written at most once a minute
    if (Date.parse(now) - Date.parse(s.last_seen_at) > 60_000) {
      const tenant = await tx.get('tenants', s.tenant_id);
      session = await tx.update('sessions', s.id, { last_seen_at: now, idle_expires_at: addMinutes(now, tenant?.settings.sessionIdleMinutes ?? ctx.config.sessionIdleMinutes) });
    }
    const actor = await resolveUserActor(tx, s.user_id);
    if (actor.mustChangePassword && !opts.allowPasswordChange) throw new DomainError('unauthenticated', 'Choose a new password first.', { passwordChange: true });
    return { user: { actor, tenantId: s.tenant_id, sessionId: s.id, ip: opts.ip }, session };
  });
}

/**
 * CSRF token bound to the session: HMAC(session token, "csrf"). The server stores only its hash
 * and can recompute it from the HttpOnly cookie, so a reloaded page can fetch it again via /me,
 * while another origin can neither read the cookie nor the response (double-submit, OWASP).
 */
export function csrfFor(sessionToken: string): string {
  return hmacSha256Hex(new TextEncoder().encode(sessionToken), 'tieout.csrf.v1');
}

export function checkCsrf(session: SessionRow, header: string | null) {
  if (!header || !timingSafeEqual(sha256Hex(header), session.csrf_hash)) throw forbidden('Security check failed (CSRF). Reload the page and try again.');
}

export async function logout(ctx: AppContext, u: RequestUser) {
  await ctx.db.tx(u.tenantId, async (tx) => {
    await tx.update('sessions', u.sessionId, { revoked_at: ctx.clock.now().toISOString(), revoked_reason: 'logout' });
    await audit(tx, u.actor, ctx.clock, { action: 'auth.logout', subjectType: 'user', subjectId: u.actor.id, summary: 'Signed out', data: {} }, u.ip);
  });
}

/** Start TOTP enrolment: a pending factor with an encrypted secret. */
export async function mfaEnroll(ctx: AppContext, a: Authenticated): Promise<{ secret: string; otpauth: string }> {
  return ctx.db.tx(a.user.tenantId, async (tx) => {
    const user = await tx.get('users', a.user.actor.id);
    if (!user) throw unauthenticated();
    // Replacing an active factor is an administrative reset, never self-service from a session.
    if (await tx.findOne('mfa_factors', { user_id: user.id, status: 'active' })) throw conflict('Two-factor authentication is already on for this account.');
    for (const f of await tx.find('mfa_factors', { user_id: user.id, status: 'pending' })) await tx.update('mfa_factors', f.id, { status: 'revoked' });
    const secret = newTotpSecret();
    await tx.insert('mfa_factors', { user_id: user.id, type: 'totp', secret_ciphertext: await encryptSecret(secret, ctx.config.encryptionKey), status: 'pending', last_used_step: null, created_at: ctx.clock.now().toISOString(), activated_at: null });
    await audit(tx, a.user.actor, ctx.clock, { action: 'auth.mfa.enroll', subjectType: 'user', subjectId: user.id, summary: 'Started two-factor enrolment', data: {} }, a.user.ip);
    return { secret, otpauth: otpauthUri(secret, user.email) };
  });
}

export interface MfaVerifyResult {
  sessionToken: string;
  csrfToken: string;
  /** shown once, when two-factor authentication is switched on */
  recoveryCodes: string[] | null;
  /** unused recovery codes left, when one was just used */
  recoveryCodesLeft: number | null;
}

/** Replace a user's recovery codes with a fresh set (stored as hashes); returns the plain codes once. */
async function issueRecoveryCodes(tx: DbTx, userId: string): Promise<string[]> {
  for (const r of await tx.find('mfa_recovery_codes', { user_id: userId })) await tx.delete('mfa_recovery_codes', r.id);
  const codes = newRecoveryCodes();
  for (const c of codes) await tx.insert('mfa_recovery_codes', { user_id: userId, code_hash: hashRecoveryCode(normalizeRecoveryCode(c)!) });
  return codes;
}

/**
 * Verify a TOTP code (or, once two-factor is on, a one-time recovery code); activates a pending
 * factor (issuing recovery codes) and rotates the session. A failed attempt is audited in its own
 * committed transaction before the error is returned.
 */
export async function mfaVerify(ctx: AppContext, a: Authenticated, code: string, meta: { ip: string | null; userAgent: string | null }): Promise<MfaVerifyResult> {
  const gate = ctx.limiter.check(`mfa:${a.user.actor.id}`, 6, 60_000);
  if (!gate.ok) throw new DomainError('rate_limited', 'Too many codes tried. Wait a minute.', { retryAfterSec: gate.retryAfterSec });
  const input = String(code ?? '').trim();
  const outcome = await ctx.db.tx(a.user.tenantId, async (tx): Promise<{ ok: false; message: string } | ({ ok: true } & MfaVerifyResult)> => {
    const user = (await tx.get('users', a.user.actor.id))!;
    const factor = (await tx.findOne('mfa_factors', { user_id: user.id, status: 'active' })) ?? (await tx.findOne('mfa_factors', { user_id: user.id, status: 'pending' }));
    if (!factor) throw validation('Set up two-factor authentication first.');
    const now = ctx.clock.now().toISOString();
    const fail = async (summary: string, message: string) => {
      await audit(tx, a.user.actor, ctx.clock, { action: 'auth.mfa.failed', subjectType: 'user', subjectId: user.id, summary, data: {} }, a.user.ip);
      return { ok: false as const, message };
    };
    let action: string;
    let summary: string;
    let recoveryCodes: string[] | null = null;
    let recoveryCodesLeft: number | null = null;
    const recovery = factor.status === 'active' ? normalizeRecoveryCode(input) : null;
    if (recovery) {
      const row = await tx.findOne('mfa_recovery_codes', { user_id: user.id, code_hash: hashRecoveryCode(recovery) });
      if (!row || row.used_at) return fail('Wrong or already used recovery code', 'That recovery code is not valid or has already been used.');
      await tx.update('mfa_recovery_codes', row.id, { used_at: now });
      recoveryCodesLeft = await tx.count('mfa_recovery_codes', { user_id: user.id, used_at: { isNull: true } });
      action = 'auth.mfa.recovery_used';
      summary = `Signed in with a recovery code (${recoveryCodesLeft} left)`;
    } else {
      const secret = await decryptSecret(factor.secret_ciphertext, ctx.config.encryptionKey);
      // authenticator apps run on wall-clock time (the demo's business clock is shifted)
      const step = verifyTotp(secret, input, Date.now(), factor.last_used_step);
      if (step === null) return fail('Wrong or reused two-factor code', 'That code is not valid. Codes change every 30 seconds and can be used once.');
      await tx.update('mfa_factors', factor.id, { status: 'active', last_used_step: step, activated_at: factor.activated_at ?? now });
      if (factor.status === 'pending') recoveryCodes = await issueRecoveryCodes(tx, user.id);
      action = factor.status === 'pending' ? 'auth.mfa.activated' : 'auth.mfa.verified';
      summary = factor.status === 'pending' ? 'Two-factor authentication turned on; recovery codes issued' : 'Two-factor code verified';
    }
    if (!user.mfa_enabled) await tx.update('users', user.id, { mfa_enabled: true });
    await tx.update('sessions', a.session.id, { revoked_at: now, revoked_reason: 'rotated after MFA' });
    const s = await createSession(ctx, tx, user, 'verified', meta, a.session.id);
    await audit(tx, a.user.actor, ctx.clock, { action, subjectType: 'user', subjectId: user.id, summary, data: {} }, a.user.ip);
    return { ok: true, sessionToken: s.token, csrfToken: s.csrf, recoveryCodes, recoveryCodesLeft };
  });
  if (!outcome.ok) throw validation(outcome.message);
  const { ok: _ok, ...result } = outcome;
  return result;
}

/** A fresh set of recovery codes (the old ones stop working); needs two-factor to be on. */
export async function regenerateRecoveryCodes(ctx: AppContext, u: RequestUser): Promise<{ recoveryCodes: string[] }> {
  return ctx.db.tx(u.tenantId, async (tx) => {
    if (!(await tx.findOne('mfa_factors', { user_id: u.actor.id, status: 'active' }))) throw precondition('Turn on two-factor authentication first.');
    const recoveryCodes = await issueRecoveryCodes(tx, u.actor.id);
    await audit(tx, u.actor, ctx.clock, { action: 'auth.mfa.recovery_regenerated', subjectType: 'user', subjectId: u.actor.id, summary: 'New two-factor recovery codes issued; the old ones no longer work', data: {} }, u.ip);
    return { recoveryCodes };
  });
}

export async function changePassword(ctx: AppContext, u: RequestUser, current: string, next: string) {
  await ctx.db.tx(u.tenantId, async (tx) => {
    const user = (await tx.get('users', u.actor.id))!;
    if (!(await ctx.hasher.verify(current, user.password_hash))) throw validation('Your current password is not correct.');
    if (String(next ?? '') === String(current ?? '')) throw validation('Choose a password different from the current one.');
    try {
      await tx.update('users', user.id, { password_hash: await ctx.hasher.hash(next), must_change_password: false });
    } catch (e) {
      throw validation((e as Error).message);
    }
    for (const s of await tx.find('sessions', { user_id: user.id, revoked_at: { isNull: true } })) if (s.id !== u.sessionId) await tx.update('sessions', s.id, { revoked_at: ctx.clock.now().toISOString(), revoked_reason: 'password changed' });
    await audit(tx, u.actor, ctx.clock, { action: 'auth.password.change', subjectType: 'user', subjectId: user.id, summary: 'Password changed; other sessions signed out', data: {} }, u.ip);
  });
}

/** Personal API token (for the MCP server): shown once, stored as a hash, scoped and expiring. */
export async function createApiToken(ctx: AppContext, u: RequestUser, name: string, days = 30): Promise<{ token: string; id: string }> {
  if (!u.actor.permissions.has('mcp.token')) throw forbidden('You cannot create API tokens.');
  if (!name || name.length > 80) throw validation('Give the token a short name.');
  const token = `tko_${secureToken(32)}`;
  return ctx.db.tx(u.tenantId, async (tx) => {
    const now = ctx.clock.now().toISOString();
    const row = await tx.insert('api_tokens', { user_id: u.actor.id, name, token_hash: sha256Hex(token), scopes: ['read', 'agent.run'], created_at: now, last_used_at: null, expires_at: addMinutes(now, days * 24 * 60), revoked_at: null });
    await audit(tx, u.actor, ctx.clock, { action: 'auth.token.create', subjectType: 'api_token', subjectId: row.id, summary: `API token “${name}” created (expires in ${days} days)`, data: {} }, u.ip);
    return { token, id: row.id };
  });
}

/** Revoke one of your own API tokens (immediately unusable). */
export async function revokeApiToken(ctx: AppContext, u: RequestUser, id: string) {
  return ctx.db.tx(u.tenantId, async (tx) => {
    const t = await tx.get('api_tokens', id);
    if (!t || t.user_id !== u.actor.id) throw notFound('API token', id);
    if (t.revoked_at) return { id, revoked: true };
    await tx.update('api_tokens', t.id, { revoked_at: ctx.clock.now().toISOString() });
    await audit(tx, u.actor, ctx.clock, { action: 'auth.token.revoke', subjectType: 'api_token', subjectId: t.id, summary: `API token “${t.name}” revoked`, data: {} }, u.ip);
    return { id, revoked: true };
  });
}

export async function authenticateApiToken(ctx: AppContext, token: string): Promise<RequestUser> {
  if (!token.startsWith('tko_')) throw unauthenticated();
  const hash = sha256Hex(token);
  const tenantId = await ctx.db.tenantOf('api_token', hash);
  const t = tenantId ? await ctx.db.tx(tenantId, (tx) => tx.findOne('api_tokens', { token_hash: hash })) : undefined;
  const now = ctx.clock.now().toISOString();
  if (!t || t.revoked_at || t.expires_at < now) throw unauthenticated('Invalid or expired API token.');
  return ctx.db.tx(t.tenant_id, async (tx) => {
    await tx.update('api_tokens', t.id, { last_used_at: now });
    const actor = await resolveUserActor(tx, t.user_id);
    // API tokens are read + agent.run only, whatever the user's role
    const allowed = new Set([...actor.permissions].filter((p) => p.endsWith('.view') || p.endsWith('.read') || p === 'agent.run'));
    return { actor: { ...actor, permissions: allowed }, tenantId: t.tenant_id, sessionId: `token:${t.id}`, ip: null };
  });
}

/** OIDC seam: configuration is validated here; the code exchange plugs in behind this function. */
export function oidcStatus(ctx: AppContext): { enabled: boolean; issuer: string | null; note: string } {
  if (!ctx.oidc) return { enabled: false, issuer: null, note: 'Single sign-on is not configured. Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI (and OIDC_CLIENT_SECRET for a confidential client) to enable the OpenID Connect authorization-code flow with PKCE.' };
  return { enabled: true, issuer: ctx.oidc.config.issuer, note: 'Sign in with your organization’s identity provider.' };
}

