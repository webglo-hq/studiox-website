import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { invoke, isMethod, methodInfo, type AppEnv } from '../app/methods';
import { isAppError } from '../framework/util/errors';
import { audit } from '../packs/accounting/domain/audit';
import { makeContext, systemActor } from '../packs/accounting/domain/context';
import { loadActor } from '../packs/accounting/domain/rbac';
import { whoAmI } from '../packs/accounting/services/admin';
import { identityProviders } from './auth/identity';
import { hashPassword, needsRehash, passwordProblems, verifyPassword } from './auth/password';
import type { SecretBox } from './auth/secrets';
import { createSession, csrfMatches, csrfTokenFor, dueForRotation, loadSession, revokeSession, rotateSession, type SessionRow } from './auth/sessions';
import { newTotpSecret, otpauthUri, verifyTotp } from './auth/totp';
import type { ServerConfig } from './config';
import type { RateLimiter } from './rate-limit';

/**
 * HTTP surface: authentication (password + TOTP, sessions with rotation and expiry), the
 * typed RPC API with CSRF protection, Origin checks and rate limits, and the built web app
 * with strict security headers. No framework: every route is explicit.
 */

export interface HttpDeps {
  env: AppEnv;
  config: ServerConfig;
  limiter: RateLimiter;
  secrets: SecretBox;
  staticDir: string | null;
  /** Development helper: demo users' generated passwords (email → password), or null. */
  demoCredentials?: () => Record<string, string> | null;
  /** Wall-clock milliseconds for TOTP (the business clock may be pinned to the scenario). */
  realNow?: () => number;
  log?: (msg: string) => void;
}

const MAX_BODY = 6 * 1024 * 1024;
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

type AttemptReason = 'ok' | 'bad_credentials' | 'locked' | 'disabled' | 'rate_limited' | 'mfa_required' | 'mfa_failed' | 'mfa_ok';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function securityHeaders(res: ServerResponse, secure: boolean): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'Request body is not valid JSON.');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      /* ignore malformed cookie values */
    }
  }
  return out;
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function isLoopback(req: IncomingMessage): boolean {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');

export function createHandler(deps: HttpDeps) {
  const { env, config, limiter, secrets } = deps;
  const log = deps.log ?? (() => undefined);
  const realNow = deps.realNow ?? (() => Date.now());
  const now = () => env.clock.nowIso();
  const policy = config.session;

  const isSecure = (req: IncomingMessage) => (config.cookieSecure === 'auto' ? (config.publicOrigin ?? '').startsWith('https://') || req.headers['x-forwarded-proto'] === 'https' : config.cookieSecure);
  const cookieName = (secure: boolean) => (secure ? '__Host-ek_session' : 'ek_session');
  const setSessionCookie = (req: IncomingMessage, res: ServerResponse, token: string | null) => {
    const secure = isSecure(req);
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])];
    res.setHeader('Set-Cookie', token ? `${cookieName(secure)}=${token}; ${attrs.join('; ')}; Max-Age=${policy.absoluteHours * 3600}` : `${cookieName(secure)}=; ${attrs.join('; ')}; Max-Age=0`);
  };
  const tokenFrom = (req: IncomingMessage) => {
    const c = parseCookies(req.headers.cookie);
    return c['__Host-ek_session'] ?? c.ek_session ?? null;
  };

  /** Cross-site request protection for every state-changing request (in addition to CSRF tokens). */
  const checkOrigin = (req: IncomingMessage) => {
    const origin = (req.headers.origin as string | undefined) ?? null;
    const referer = (req.headers.referer as string | undefined) ?? null;
    const host = req.headers.host;
    const expected = config.publicOrigin ?? (host ? `${isSecure(req) ? 'https' : 'http'}://${host}` : null);
    let source = origin;
    if (!source && referer) {
      try {
        source = new URL(referer).origin;
      } catch {
        source = null;
      }
    }
    if (!source || !expected || source !== expected) throw new HttpError(403, 'CSRF', 'Cross-site request blocked.');
  };
  const requireCsrf = (req: IncomingMessage, row: SessionRow) => {
    if (!csrfMatches(row, req.headers['x-csrf-token'] as string | undefined, secrets)) throw new HttpError(403, 'CSRF', 'Missing or invalid CSRF token. Reload the page.');
  };

  const requireSession = async (req: IncomingMessage, opts: { mfa: boolean }): Promise<SessionRow> => {
    const check = await loadSession(env.db, tokenFrom(req), now(), policy);
    if (!check.ok) throw new HttpError(401, 'UNAUTHENTICATED', check.reason === 'idle' ? 'You were signed out after a period of inactivity. Please sign in again.' : 'Please sign in.');
    if (opts.mfa && !check.row.mfa_verified) throw new HttpError(401, 'MFA_REQUIRED', 'Enter your two-step code to continue.');
    return check.row;
  };

  const recordAttempt = async (email: string, userId: string | null, ok: boolean, reason: AttemptReason, req: IncomingMessage) => {
    await env.db.insert('login_attempt', { tenant_id: env.tenantId, email: email.slice(0, 200), user_id: userId, ok, reason, ip: clientIp(req), user_agent: str(req.headers['user-agent']), occurred_at: now() });
  };

  const sysCtx = (label: string, userId: string | null = null) => makeContext(env.db, env.tenantId, { ...systemActor(label), type: userId ? 'user' : 'system', userId }, env.clock);
  const me = async (userId: string) => whoAmI(makeContext(env.db, env.tenantId, await loadActor(env.db, env.tenantId, userId), env.clock));

  async function login(req: IncomingMessage, res: ServerResponse) {
    checkOrigin(req);
    const body = (await readJson(req)) as { email?: unknown; password?: unknown };
    const email = str(body.email, 200).trim().toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) throw new HttpError(400, 'VALIDATION', 'Enter your email and password.');
    const ipWait = limiter.take('login_ip', clientIp(req));
    const accWait = limiter.take('login_account', email);
    if (ipWait || accWait) {
      await recordAttempt(email, null, false, 'rate_limited', req);
      throw new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Wait a moment and try again.', { retryAfter: Math.max(ipWait, accWait) });
    }
    const user = await env.db.findOne('app_user', { tenant_id: env.tenantId, email });
    const valid = await verifyPassword(password, user?.password_hash);
    if (!user || !valid) {
      if (user) {
        const failed = user.failed_logins + 1;
        await env.db.update('app_user', user.id, { failed_logins: failed, locked_until: failed >= LOCK_AFTER ? new Date(Date.parse(now()) + LOCK_MINUTES * 60_000).toISOString() : user.locked_until });
      }
      await recordAttempt(email, user?.id ?? null, false, 'bad_credentials', req);
      throw new HttpError(401, 'UNAUTHENTICATED', 'Email or password is incorrect.');
    }
    if (user.locked_until && user.locked_until > now()) {
      await recordAttempt(email, user.id, false, 'locked', req);
      throw new HttpError(423, 'LOCKED', `Too many failed attempts. Try again after ${user.locked_until.slice(11, 16)} UTC.`);
    }
    if (user.status !== 'active') {
      await recordAttempt(email, user.id, false, 'disabled', req);
      throw new HttpError(403, 'FORBIDDEN', 'This account is disabled.');
    }
    const patch: Record<string, unknown> = { failed_logins: 0, locked_until: null, last_login_at: now() };
    if (user.password_hash && needsRehash(user.password_hash)) patch.password_hash = await hashPassword(password);
    await env.db.update('app_user', user.id, patch);
    const mfaRequired = user.mfa_enabled;
    const s = await createSession(env.db, { tenantId: env.tenantId, userId: user.id, ip: clientIp(req), userAgent: str(req.headers['user-agent']), mfaVerified: !mfaRequired, now: now(), policy });
    await recordAttempt(email, user.id, true, mfaRequired ? 'mfa_required' : 'ok', req);
    await audit(sysCtx('Sign-in', user.id), { action: 'auth.login', subjectType: 'app_user', subjectId: user.id, data: { mfaRequired, ip: clientIp(req) } });
    setSessionCookie(req, res, s.token);
    sendJson(res, 200, { ok: true, mfaRequired, csrfToken: csrfTokenFor(s.row, secrets), user: mfaRequired ? null : await me(user.id) });
  }

  async function verifyMfa(req: IncomingMessage, res: ServerResponse) {
    checkOrigin(req);
    const row = await requireSession(req, { mfa: false });
    requireCsrf(req, row);
    const body = (await readJson(req)) as { code?: unknown };
    const code = str(body.code, 20).replace(/\s/g, '');
    const wait = limiter.take('mfa', row.id);
    if (wait) throw new HttpError(429, 'RATE_LIMITED', 'Too many codes. Wait a moment.', { retryAfter: wait });
    const user = (await env.db.get('app_user', row.user_id))!;
    if (!user.mfa_enabled || !user.mfa_secret_enc) throw new HttpError(400, 'VALIDATION', 'Two-step sign-in is not enabled for this account.');
    const step = verifyTotp(secrets.open(user.mfa_secret_enc, user.id), code, realNow());
    if (step === null || (user.mfa_last_step !== null && step <= user.mfa_last_step)) {
      await recordAttempt(user.email, user.id, false, 'mfa_failed', req);
      throw new HttpError(401, 'MFA_FAILED', 'That code did not work. Check your authenticator app and try again.');
    }
    await env.db.update('app_user', user.id, { mfa_last_step: step });
    // Privilege change: new session token and a fresh CSRF seed.
    const next = await rotateSession(env.db, row, now(), { mfaVerified: true, policy, newCsrf: true });
    await recordAttempt(user.email, user.id, true, 'mfa_ok', req);
    await audit(sysCtx('Sign-in', user.id), { action: 'auth.mfa.verified', subjectType: 'app_user', subjectId: user.id, data: {} });
    setSessionCookie(req, res, next.token);
    sendJson(res, 200, { ok: true, csrfToken: csrfTokenFor(next.row, secrets), user: await me(user.id) });
  }

  async function sessionInfo(req: IncomingMessage, res: ServerResponse) {
    const check = await loadSession(env.db, tokenFrom(req), now(), policy);
    const helper = config.demoLoginHelper && !config.production && isLoopback(req);
    let personas: Array<{ email: string; name: string; title: string | null; password: string | null }> = [];
    if (helper) {
      const creds = deps.demoCredentials?.() ?? null;
      const users = await env.db.find('app_user', { tenant_id: env.tenantId, status: 'active' }, { orderBy: [['display_name', 'asc']] });
      personas = users.map((u) => ({ email: u.email, name: u.display_name, title: u.title, password: creds?.[u.email] ?? config.demoPassword ?? null }));
    }
    const base = { mode: 'server' as const, personas, providers: identityProviders().map((p) => ({ id: p.id, label: p.label })), engine: env.engine.mode, liveAvailable: env.engine.liveAvailable };
    if (!check.ok) return sendJson(res, 200, { ...base, authenticated: false });
    const csrfToken = csrfTokenFor(check.row, secrets);
    if (!check.row.mfa_verified) return sendJson(res, 200, { ...base, authenticated: true, mfaRequired: true, csrfToken });
    sendJson(res, 200, { ...base, authenticated: true, mfaRequired: false, csrfToken, user: await me(check.row.user_id), session: { expiresAt: check.row.expires_at, idleExpiresAt: check.row.idle_expires_at } });
  }

  async function logout(req: IncomingMessage, res: ServerResponse) {
    checkOrigin(req);
    const check = await loadSession(env.db, tokenFrom(req), now(), policy);
    if (check.ok) {
      requireCsrf(req, check.row);
      await revokeSession(env.db, check.row.id, now());
      await audit(sysCtx('Sign-out', check.row.user_id), { action: 'auth.logout', subjectType: 'app_user', subjectId: check.row.user_id, data: {} });
    }
    setSessionCookie(req, res, null);
    sendJson(res, 200, { ok: true });
  }

  async function mfaSetup(req: IncomingMessage, res: ServerResponse, action: 'setup' | 'enable' | 'disable') {
    checkOrigin(req);
    const row = await requireSession(req, { mfa: true });
    requireCsrf(req, row);
    const user = (await env.db.get('app_user', row.user_id))!;
    const body = (await readJson(req)) as { code?: unknown };
    if (action === 'setup') {
      if (user.mfa_enabled) throw new HttpError(409, 'CONFLICT', 'Two-step sign-in is already on.');
      const secret = newTotpSecret();
      await env.db.update('app_user', user.id, { mfa_secret_enc: secrets.seal(secret, user.id), mfa_last_step: null });
      return sendJson(res, 200, { ok: true, secret, otpauthUri: otpauthUri(secret, user.email) });
    }
    const code = str(body.code, 20).replace(/\s/g, '');
    const wait = limiter.take('mfa', row.id);
    if (wait) throw new HttpError(429, 'RATE_LIMITED', 'Too many codes. Wait a moment.', { retryAfter: wait });
    if (!user.mfa_secret_enc) throw new HttpError(400, 'VALIDATION', 'Start the setup first.');
    if (action === 'enable' && user.mfa_enabled) throw new HttpError(409, 'CONFLICT', 'Two-step sign-in is already on.');
    if (action === 'disable' && !user.mfa_enabled) throw new HttpError(409, 'CONFLICT', 'Two-step sign-in is already off.');
    const step = verifyTotp(secrets.open(user.mfa_secret_enc, user.id), code, realNow());
    if (step === null || (user.mfa_last_step !== null && step <= user.mfa_last_step)) throw new HttpError(401, 'MFA_FAILED', 'That code did not work.');
    await env.db.update('app_user', user.id, action === 'enable' ? { mfa_enabled: true, mfa_last_step: step } : { mfa_enabled: false, mfa_secret_enc: null, mfa_last_step: null });
    await audit(sysCtx('Security', user.id), { action: action === 'enable' ? 'auth.mfa.enabled' : 'auth.mfa.disabled', subjectType: 'app_user', subjectId: user.id, data: {} });
    const next = await rotateSession(env.db, row, now(), { mfaVerified: true, policy, newCsrf: true });
    setSessionCookie(req, res, next.token);
    sendJson(res, 200, { ok: true, mfaEnabled: action === 'enable', csrfToken: csrfTokenFor(next.row, secrets) });
  }

  async function changePassword(req: IncomingMessage, res: ServerResponse) {
    checkOrigin(req);
    const row = await requireSession(req, { mfa: true });
    requireCsrf(req, row);
    const body = (await readJson(req)) as { current?: unknown; next?: unknown };
    const wait = limiter.take('login_account', `pw:${row.user_id}`);
    if (wait) throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts.', { retryAfter: wait });
    const user = (await env.db.get('app_user', row.user_id))!;
    if (typeof body.current !== 'string' || !(await verifyPassword(body.current, user.password_hash))) throw new HttpError(401, 'UNAUTHENTICATED', 'Your current password is incorrect.');
    const next = typeof body.next === 'string' ? body.next : '';
    const problems = passwordProblems(next, [user.email.split('@')[0] ?? '', user.display_name]);
    if (problems.length) throw new HttpError(400, 'VALIDATION', problems.join(' '));
    await env.db.update('app_user', user.id, { password_hash: await hashPassword(next) });
    // Sign out every other session.
    await env.db.updateWhere('session', { user_id: user.id, revoked_at: { isNull: true }, id: { ne: row.id } }, { revoked_at: now() });
    await audit(sysCtx('Security', user.id), { action: 'auth.password.changed', subjectType: 'app_user', subjectId: user.id, data: {} });
    const rotated = await rotateSession(env.db, row, now(), { policy, newCsrf: true });
    setSessionCookie(req, res, rotated.token);
    sendJson(res, 200, { ok: true, csrfToken: csrfTokenFor(rotated.row, secrets) });
  }

  async function rpc(req: IncomingMessage, res: ServerResponse, name: string) {
    checkOrigin(req);
    if (!isMethod(name)) throw new HttpError(404, 'NOT_FOUND', `Unknown method ${name}`);
    const info = methodInfo(name);
    let row = await requireSession(req, { mfa: true });
    if (info.mutates) requireCsrf(req, row);
    const wait = limiter.take(info.expensive ? 'expensive' : 'api', row.user_id);
    if (wait) throw new HttpError(429, 'RATE_LIMITED', 'You are going a little fast. Try again in a moment.', { retryAfter: wait });
    if (dueForRotation(row, now(), policy)) {
      const next = await rotateSession(env.db, row, now(), { policy });
      row = next.row;
      setSessionCookie(req, res, next.token);
    }
    const input = await readJson(req);
    const data = await invoke(env, { userId: row.user_id, ip: clientIp(req) }, name, input);
    sendJson(res, 200, { ok: true, data });
  }

  const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm' };

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    const root = deps.staticDir;
    if (!root || !existsSync(root)) return false;
    const base = resolve(root);
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'BAD_REQUEST', 'Malformed path.');
    }
    if (rel.includes('\0')) throw new HttpError(400, 'BAD_REQUEST', 'Malformed path.');
    rel = normalize(rel).replace(/^([/\\])+/, '');
    let file = join(base, rel);
    if (!file.startsWith(base + sep) && file !== base) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // Unknown asset paths are real 404s; everything else is the single-page app.
      if (rel.startsWith('assets/') || extname(rel)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
      file = join(base, 'index.html');
    }
    if (!existsSync(file)) return false;
    const ext = extname(file);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://local').pathname;
    } catch {
      path = '/';
    }
    securityHeaders(res, isSecure(req));
    try {
      if (path === '/healthz') return sendJson(res, 200, { ok: true, engine: env.engine.mode, db: env.db.kind });
      if (path.startsWith('/api/')) {
        if (path === '/api/auth/session') {
          if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
          return await sessionInfo(req, res);
        }
        if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
        if (path === '/api/auth/login') return await login(req, res);
        if (path === '/api/auth/mfa') return await verifyMfa(req, res);
        if (path === '/api/auth/logout') return await logout(req, res);
        if (path === '/api/auth/mfa/setup') return await mfaSetup(req, res, 'setup');
        if (path === '/api/auth/mfa/enable') return await mfaSetup(req, res, 'enable');
        if (path === '/api/auth/mfa/disable') return await mfaSetup(req, res, 'disable');
        if (path === '/api/auth/password') return await changePassword(req, res);
        const m = /^\/api\/rpc\/([a-zA-Z]+\.[a-zA-Z]+)$/.exec(path);
        if (m) return await rpc(req, res, m[1]!);
        throw new HttpError(404, 'NOT_FOUND', 'Not found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      if (serveStatic(req, res, path)) return;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>Evenkeel</title><p>The web app is not built yet. Run <code>npm run build:web</code>, or use <code>npm run dev</code>.</p>');
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 429) res.setHeader('Retry-After', String(e.extra.retryAfter ?? 30));
        return sendJson(res, e.status, { ok: false, error: { code: e.code, message: e.message, ...e.extra } });
      }
      if (isAppError(e)) return sendJson(res, e.httpStatus, { ok: false, error: { code: e.code, message: e.message, details: e.details ?? null } });
      log(`[error] ${req.method} ${path}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong on our side. The error was logged.' } });
    }
  };
}
