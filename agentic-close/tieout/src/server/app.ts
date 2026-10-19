/**
 * HTTP API (Hono). Isomorphic: the Node server and the zero-install browser demo run this same
 * app (the demo calls `app.fetch` in-page with an in-memory cookie jar).
 *
 * Security: strict security headers and CSP, HttpOnly SameSite=Strict session cookie, CSRF
 * double-submit token bound to the session + Origin check on every mutation, per-IP and per-user
 * rate limits, body size limits, parameterised storage only, generic 500s (no stack traces).
 */
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { DomainError, fromStorageError, validation } from '../core/util/errors';
import { PEOPLE, SCENARIO } from '../packs/accounting/seed/company';
import * as admin from '../app/admin';
import { authenticate, authenticateApiToken, changePassword, checkCsrf, createApiToken, csrfFor, login, logout, mfaEnroll, mfaVerify, oidcCallback, oidcStart, oidcStatus, regenerateRecoveryCodes, revokeApiToken, type Authenticated } from '../app/auth';
import * as close from '../app/close';
import type { AppContext, RequestUser } from '../app/context';
import { importFile } from '../app/imports';
import * as ledger from '../app/ledger';
import * as proposals from '../app/proposals';
import * as q from '../app/queries';
import * as recs from '../app/recs';
import * as skills from '../app/skills';
import { writeFluxExplanation } from '../app/flux';

export const SESSION_COOKIE = 'tieout_session';
const OIDC_COOKIE = 'tieout_oidc';
const OIDC_PATH = '/api/auth/oidc';
/** The web app root, relative to `${OIDC_PATH}/callback` (so it also works under a path prefix). */
const APP_ROOT_FROM_CALLBACK = '../../../';
/**
 * The only routes a session that has not finished two-factor verification may call. Everything
 * else (password change, API tokens, data) needs a verified session, so a password alone never
 * yields a token or a changed credential.
 */
const PENDING_MFA_ROUTES = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/mfa/enroll', '/api/auth/mfa/verify']);

type Env = { Variables: { auth: Authenticated | null; user: RequestUser; token: string | null } };

const STATUS: Record<string, number> = { validation: 400, not_found: 404, conflict: 409, forbidden: 403, unauthenticated: 401, sod_violation: 403, invariant_violation: 422, rate_limited: 429, budget_exceeded: 422, precondition_failed: 409, internal: 500 };

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Client address as resolved by the Node entry (socket, or a trusted proxy header when TRUST_PROXY=true). */
function ipOf(c: Context): string | null {
  return c.req.header('x-tieout-client-ip') ?? null;
}

async function body<T = Record<string, unknown>>(c: Context, max = 1_000_000): Promise<T> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > max) throw validation('Request body too large.');
  const text = await c.req.text();
  if (text.length > max) throw validation('Request body too large.');
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw validation('Request body must be JSON.');
  }
}

export interface ServerOptions {
  /** register static asset routes (Node server) */
  static?: (app: Hono<Env>) => void;
  /**
   * In-page demo only: browsers drop Set-Cookie from script-constructed Responses, so the session
   * is also handed to the in-page cookie jar in a custom header. Never enable on a network server.
   */
  cookieBridge?: boolean;
}

export const SESSION_BRIDGE_HEADER = 'x-tieout-session';

export function createServerApp(ctx: AppContext, opts: ServerOptions = {}) {
  const issueSession = (c: Context, token: string) => {
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Strict', secure: ctx.config.secureCookies, path: '/', maxAge: ctx.config.sessionAbsoluteHours * 3600 });
    if (opts.cookieBridge) c.header(SESSION_BRIDGE_HEADER, token);
  };
  const clearSession = (c: Context) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    if (opts.cookieBridge) c.header(SESSION_BRIDGE_HEADER, '');
  };
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    if (ctx.config.secureCookies) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  });

  app.onError((err, c) => {
    const e = err instanceof DomainError ? err : fromStorageError(err);
    const status = STATUS[e.code] ?? 500;
    if (status >= 500) ctx.log('error', { path: c.req.path, message: (err as Error).message });
    if (e.code === 'rate_limited') c.header('Retry-After', String(e.details.retryAfterSec ?? 60));
    const safeDetails = status >= 500 ? {} : Object.fromEntries(Object.entries(e.details).filter(([k]) => !['cause', 'stack'].includes(k)));
    return c.json({ error: { code: e.code, message: status >= 500 ? 'Something went wrong on our side. The error was logged.' : e.message, details: safeDetails } }, status as 400);
  });

  // global API rate limit per client
  app.use('/api/*', async (c, next) => {
    const d = ctx.limiter.check(`api:${ipOf(c) ?? 'local'}`, 600, 60_000);
    if (!d.ok) throw new DomainError('rate_limited', 'Too many requests.', { retryAfterSec: d.retryAfterSec });
    await next();
  });

  // ------------------------------------------------------------------ public
  app.get('/api/health', (c) => c.json({ ok: true, version: ctx.config.version, store: ctx.db.kind, liveAgents: !!ctx.llm }));

  app.get('/api/auth/options', async (c) => {
    const personas = ctx.config.demoMode ? PEOPLE.map((p) => ({ email: p.email, name: p.name, title: p.title, role: p.roles[0] })) : [];
    return c.json({ demo: ctx.config.demoMode, personas, demoPassword: ctx.config.demoMode ? ctx.config.demoPassword : null, demoPasswordHint: ctx.config.demoMode ? 'Every fictional demo user shares one documented, dev-only password.' : null, oidc: oidcStatus(ctx), scenarioDate: ctx.config.demoMode ? SCENARIO.businessDate : null });
  });

  app.post('/api/auth/login', async (c) => {
    if (!sameOrigin(c, ctx)) throw new DomainError('forbidden', 'Cross-site sign-in blocked.');
    const b = await body<{ email: string; password: string }>(c, 10_000);
    const r = await login(ctx, b.email, b.password, { ip: ipOf(c), userAgent: c.req.header('user-agent') ?? null });
    issueSession(c, r.sessionToken);
    return c.json({ user: r.user, csrfToken: r.csrfToken, mfa: r.mfa });
  });

  // ------------------------------------------------------------------ single sign-on (OpenID Connect)
  const page = (title: string, body: string, refresh?: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="0;url=${refresh}">` : ''}<title>${title}</title></head><body style="font:16px system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#1c1b18;background:#f5f3ec">${body}</body></html>`;
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  app.get(`${OIDC_PATH}/start`, async (c) => {
    const gate = ctx.limiter.check(`oidc:${ipOf(c) ?? '-'}`, 30, 60_000);
    if (!gate.ok) throw new DomainError('rate_limited', 'Too many sign-in attempts.', { retryAfterSec: gate.retryAfterSec });
    const { url, sealed } = await oidcStart(ctx);
    // Lax: the provider sends the browser back with a top-level cross-site GET
    setCookie(c, OIDC_COOKIE, sealed, { httpOnly: true, sameSite: 'Lax', secure: ctx.config.secureCookies, path: OIDC_PATH, maxAge: 600 });
    return c.redirect(url, 302);
  });
  app.get(`${OIDC_PATH}/callback`, async (c) => {
    const gate = ctx.limiter.check(`oidc:${ipOf(c) ?? '-'}`, 30, 60_000);
    if (!gate.ok) throw new DomainError('rate_limited', 'Too many sign-in attempts.', { retryAfterSec: gate.retryAfterSec });
    const sealed = getCookie(c, OIDC_COOKIE) ?? null;
    deleteCookie(c, OIDC_COOKIE, { path: OIDC_PATH });
    try {
      const r = await oidcCallback(ctx, { code: c.req.query('code') ?? null, state: c.req.query('state') ?? null, error: c.req.query('error') ?? null }, sealed, { ip: ipOf(c), userAgent: c.req.header('user-agent') ?? null });
      issueSession(c, r.sessionToken);
      // continue with a same-site navigation so the SameSite=Strict session cookie is sent
      return c.html(page('Signing in', `<p>Signing you in…</p><p><a href="${APP_ROOT_FROM_CALLBACK}">Continue</a></p>`, APP_ROOT_FROM_CALLBACK));
    } catch (e) {
      const msg = e instanceof DomainError ? e.message : 'Single sign-on failed.';
      if (!(e instanceof DomainError)) ctx.log('error', { path: c.req.path, message: (e as Error).message });
      return c.html(page('Sign-in failed', `<h1 style="font-weight:600">Sign-in failed</h1><p>${esc(msg)}</p><p><a href="${APP_ROOT_FROM_CALLBACK}">Back to sign in</a></p>`), e instanceof DomainError && e.code === 'forbidden' ? 403 : 401);
    }
  });

  // ------------------------------------------------------------------ auth gate
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/health' || path === '/api/auth/options' || path === '/api/auth/login' || path === `${OIDC_PATH}/start` || path === `${OIDC_PATH}/callback`) return next();
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(tko_[A-Za-z0-9_-]+)$/)?.[1];
    if (bearer) {
      if (c.req.method !== 'GET' && !path.startsWith('/api/runs')) throw new DomainError('forbidden', 'API tokens are read-only (plus starting agent runs).');
      c.set('user', await authenticateApiToken(ctx, bearer));
      c.set('auth', null);
      c.set('token', null);
      return next();
    }
    const token = getCookie(c, SESSION_COOKIE) ?? (opts.cookieBridge ? c.req.header(SESSION_BRIDGE_HEADER) || undefined : undefined) ?? null;
    const allowPending = PENDING_MFA_ROUTES.has(path);
    const a = await authenticate(ctx, token, { ip: ipOf(c), allowPendingMfa: allowPending });
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!sameOrigin(c, ctx)) throw new DomainError('forbidden', 'Cross-site request blocked.');
      checkCsrf(a.session, c.req.header('x-csrf-token') ?? null);
      const d = ctx.limiter.check(`mut:${a.user.actor.id}`, 240, 60_000);
      if (!d.ok) throw new DomainError('rate_limited', 'Too many changes in a short time.', { retryAfterSec: d.retryAfterSec });
    }
    c.set('auth', a);
    c.set('user', a.user);
    c.set('token', token);
    await next();
  });

  const U = (c: Context<Env>) => c.get('user');

  app.get('/api/auth/me', async (c) => {
    const a = c.get('auth');
    if (a?.session.mfa_state === 'pending') return c.json({ mfa: 'pending', user: { id: a.user.actor.id, name: a.user.actor.label }, csrfToken: c.get('token') ? csrfFor(c.get('token')!) : null });
    return c.json(await q.me(ctx, U(c), c.get('token')));
  });
  app.post('/api/auth/logout', async (c) => {
    await logout(ctx, U(c));
    clearSession(c);
    return c.json({ ok: true });
  });
  app.post('/api/auth/mfa/enroll', async (c) => c.json(await mfaEnroll(ctx, c.get('auth')!)));
  app.post('/api/auth/mfa/verify', async (c) => {
    const b = await body<{ code: string }>(c, 1000);
    const r = await mfaVerify(ctx, c.get('auth')!, b.code, { ip: ipOf(c), userAgent: c.req.header('user-agent') ?? null });
    issueSession(c, r.sessionToken);
    return c.json({ ok: true, csrfToken: r.csrfToken, recoveryCodes: r.recoveryCodes, recoveryCodesLeft: r.recoveryCodesLeft });
  });
  app.post('/api/auth/mfa/recovery-codes', async (c) => c.json(await regenerateRecoveryCodes(ctx, U(c))));
  app.post('/api/auth/password', async (c) => {
    const b = await body<{ current: string; next: string }>(c, 2000);
    await changePassword(ctx, U(c), b.current, b.next);
    return c.json({ ok: true });
  });
  app.post('/api/auth/tokens', async (c) => {
    const b = await body<{ name: string; days?: number }>(c, 2000);
    return c.json(await createApiToken(ctx, U(c), b.name, Math.min(Math.max(Number(b.days ?? 30), 1), 90)));
  });
  app.delete('/api/auth/tokens/:id', async (c) => c.json(await revokeApiToken(ctx, U(c), c.req.param('id'))));

  // ------------------------------------------------------------------ home & close
  const period = (c: Context<Env>) => {
    const p = c.req.query('period') ?? c.req.param('period') ?? SCENARIO.closeKey;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) throw validation('period must be YYYY-MM');
    return p;
  };
  app.get('/api/home', async (c) => c.json(await q.home(ctx, U(c), period(c))));
  app.get('/api/close/:period', async (c) => c.json(await q.closeView(ctx, U(c), period(c))));
  app.post('/api/close/:period/run-agents', async (c) => {
    const b = await body<{ only?: string[] }>(c, 5000);
    return c.json(await close.startCloseAgents(ctx, U(c), period(c), { only: Array.isArray(b.only) ? b.only.map(String).slice(0, 20) : undefined }));
  });
  app.post('/api/close/:period/lock', async (c) => c.json(await close.lockPeriod(ctx, U(c), period(c))));
  app.post('/api/close/:period/reopen', async (c) => {
    const b = await body<{ entityId?: string; reason?: string }>(c, 2000);
    return c.json(await close.reopenPeriod(ctx, U(c), period(c), String(b.entityId ?? ''), String(b.reason ?? '')));
  });
  app.post('/api/close/tasks/:id/complete', async (c) => c.json(await close.completeTask(ctx, U(c), c.req.param('id'), (await body<{ note?: string }>(c, 5000)).note)));
  app.post('/api/close/tasks/:id/signoff', async (c) => c.json(await close.signOffTask(ctx, U(c), c.req.param('id'))));
  app.get('/api/packages/:id', async (c) => c.json(await q.closePackage(ctx, U(c), c.req.param('id'))));
  app.post('/api/packages/:id/finalize', async (c) => c.json(await close.finalizePackage(ctx, U(c), c.req.param('id'))));

  // ------------------------------------------------------------------ proposals
  app.get('/api/proposals', async (c) => c.json(await q.listProposals(ctx, U(c), { status: c.req.query('status'), kind: c.req.query('kind'), skill: c.req.query('skill'), entity: c.req.query('entity'), period: c.req.query('period'), text: c.req.query('q'), run: c.req.query('run') })));
  app.get('/api/proposals/:id', async (c) => c.json(await q.proposalDetail(ctx, U(c), c.req.param('id'))));
  app.post('/api/proposals/:id/approve', async (c) => c.json(await proposals.approveProposal(ctx, U(c), c.req.param('id'), (await body<{ note?: string }>(c, 5000)).note)));
  app.post('/api/proposals/:id/reject', async (c) => c.json(await proposals.rejectProposal(ctx, U(c), c.req.param('id'), String((await body<{ reason?: string }>(c, 5000)).reason ?? ''))));
  app.post('/api/proposals/:id/review', async (c) => c.json(await proposals.reviewProposal(ctx, U(c), c.req.param('id'), (await body<{ note?: string }>(c, 5000)).note)));
  app.post('/api/proposals/:id/edit', async (c) => {
    const b = await body<{ accountCode: string; department: string | null }>(c, 5000);
    return c.json(await proposals.editCoding(ctx, U(c), c.req.param('id'), { accountCode: String(b.accountCode ?? ''), department: b.department ? String(b.department) : null }));
  });
  app.post('/api/proposals/bulk-approve', async (c) => {
    const b = await body<{ ids: string[]; note?: string }>(c, 50_000);
    return c.json({ results: await proposals.bulkApprove(ctx, U(c), Array.isArray(b.ids) ? b.ids.map(String) : [], b.note) });
  });

  // ------------------------------------------------------------------ reconciliations
  app.get('/api/recs', async (c) => c.json(await q.recsList(ctx, U(c), period(c))));
  app.get('/api/recs/bank/:id', async (c) => c.json(await q.bankWorkbench(ctx, U(c), c.req.param('id'), period(c))));
  app.post('/api/recs/bank/:id/certify', async (c) => c.json(await recs.certifyBankRec(ctx, U(c), c.req.param('id'), period(c), (await body<{ note?: string }>(c, 5000)).note)));
  app.post('/api/recs/subledger/:entity/:kind/certify', async (c) => {
    const kind = c.req.param('kind');
    if (kind !== 'ap' && kind !== 'ar') throw validation('kind must be ap or ar');
    return c.json(await recs.certifySubledger(ctx, U(c), c.req.param('entity'), kind, period(c), (await body<{ note?: string }>(c, 5000)).note));
  });
  app.post('/api/recs/:id/review', async (c) => c.json(await recs.reviewRec(ctx, U(c), c.req.param('id'), (await body<{ note?: string }>(c, 5000)).note)));

  // ------------------------------------------------------------------ flux, ledger, reports
  app.get('/api/flux', async (c) => c.json(await q.fluxView(ctx, U(c), c.req.query('entity') ?? '', period(c))));
  app.post('/api/flux/explanations', async (c) => {
    const b = await body<{ entityId?: string; periodKey?: string; accountCode?: string; text?: string }>(c, 10_000);
    return c.json(await writeFluxExplanation(ctx, U(c), { entityId: String(b.entityId ?? ''), periodKey: String(b.periodKey ?? ''), accountCode: String(b.accountCode ?? ''), text: String(b.text ?? '') }));
  });
  app.get('/api/journal', async (c) => c.json(await q.journalList(ctx, U(c), { entity: c.req.query('entity'), period: c.req.query('period'), status: c.req.query('status'), source: c.req.query('source'), text: c.req.query('q') })));
  app.get('/api/journal/:id', async (c) => c.json(await q.journalDetail(ctx, U(c), c.req.param('id'))));
  app.post('/api/journal', async (c) => c.json(await ledger.prepareJournal(ctx, U(c), await body(c, 200_000))));
  app.post('/api/journal/:id/approve', async (c) => c.json(await ledger.approveJournal(ctx, U(c), c.req.param('id'), (await body<{ reason?: string }>(c, 5000)).reason)));
  app.post('/api/journal/:id/reject', async (c) => c.json(await ledger.rejectJournal(ctx, U(c), c.req.param('id'), String((await body<{ reason?: string }>(c, 5000)).reason ?? ''))));
  app.post('/api/journal/:id/reverse', async (c) => {
    const b = await body<{ reason: string; postingDate: string }>(c, 5000);
    return c.json(await ledger.requestReversal(ctx, U(c), c.req.param('id'), String(b.reason ?? ''), String(b.postingDate ?? '')));
  });
  app.get('/api/reports/tb', async (c) => c.json(await q.trialBalance(ctx, U(c), c.req.query('entity') ?? '', period(c))));
  app.get('/api/reports/statements', async (c) => c.json(await q.statements(ctx, U(c), c.req.query('entity') ?? 'consolidated', period(c))));
  app.get('/api/documents/:id', async (c) => c.json(await q.sourceDocument(ctx, U(c), c.req.param('id'))));

  // ------------------------------------------------------------------ agents & skills
  app.get('/api/runs', async (c) => c.json(await q.runsList(ctx, U(c), { period: c.req.query('period'), skill: c.req.query('skill') })));
  app.get('/api/runs/:id', async (c) => c.json(await q.runDetail(ctx, U(c), c.req.param('id'))));
  app.post('/api/runs', async (c) => {
    const b = await body<{ skillKey: string; entityId: string | null; periodKey: string; mode?: 'offline' | 'live' }>(c, 5000);
    return c.json(await skills.startRun(ctx, U(c), { skillKey: String(b.skillKey ?? ''), entityId: b.entityId ? String(b.entityId) : null, periodKey: String(b.periodKey ?? SCENARIO.closeKey), mode: b.mode === 'live' || b.mode === 'offline' ? b.mode : undefined }));
  });
  app.post('/api/runs/:id/resume', async (c) => c.json(await skills.resumeRun(ctx, U(c), c.req.param('id'))));
  app.get('/api/skills', async (c) => c.json(await q.skillsCatalog(ctx, U(c))));
  app.get('/api/skills/:key', async (c) => c.json(await q.skillDetail(ctx, U(c), c.req.param('key'))));
  app.post('/api/skills/:key/policy', async (c) => {
    const b = await body<{ autonomy?: 'L0' | 'L1' | 'L2' | 'L3'; thresholds?: Record<string, number>; enabled?: boolean; note: string; scopeEntityId?: string | null }>(c, 20_000);
    return c.json(await skills.setPolicy(ctx, U(c), c.req.param('key'), { autonomy: b.autonomy, thresholds: b.thresholds, enabled: b.enabled, note: String(b.note ?? ''), scopeEntityId: b.scopeEntityId ?? null }));
  });
  app.post('/api/skills/:key/rules/preview', async (c) => c.json(await skills.previewRule(ctx, U(c), String((await body<{ text: string }>(c, 2000)).text ?? ''))));
  app.post('/api/skills/:key/rules', async (c) => c.json(await skills.addRule(ctx, U(c), c.req.param('key'), String((await body<{ text: string }>(c, 2000)).text ?? ''))));
  app.delete('/api/skills/:key/rules/:ruleId', async (c) => c.json(await skills.removeRule(ctx, U(c), c.req.param('key'), c.req.param('ruleId'))));
  app.post('/api/skills/:key/evals', async (c) => c.json(await skills.runSkillEvals(ctx, U(c), c.req.param('key'))));

  // ------------------------------------------------------------------ ontology, audit, admin, imports
  app.get('/api/ontology', (c) => c.json(q.ontologyView()));
  app.get('/api/ontology/explain/:term', (c) => c.json(q.ontologyExplain(decodeURIComponent(c.req.param('term')))));
  app.get('/api/ontology/export.jsonld', (c) => c.body(q.ontologyExport('jsonld'), 200, { 'Content-Type': 'application/ld+json; charset=utf-8', 'Content-Disposition': 'attachment; filename="tieout-ontology.jsonld"' }));
  app.get('/api/ontology/export.ttl', (c) => c.body(q.ontologyExport('ttl'), 200, { 'Content-Type': 'text/turtle; charset=utf-8', 'Content-Disposition': 'attachment; filename="tieout-ontology.ttl"' }));
  app.get('/api/audit', async (c) => c.json(await q.auditList(ctx, U(c), { limit: Number(c.req.query('limit') ?? 100), before: c.req.query('before') ? Number(c.req.query('before')) : undefined, action: c.req.query('action'), subject: c.req.query('subject') })));
  app.post('/api/audit/verify', async (c) => c.json(await q.auditVerify(ctx, U(c))));
  app.get('/api/audit/export', async (c) => {
    const doc = await q.auditExport(ctx, U(c));
    return c.body(JSON.stringify(doc, null, 1), 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="tieout-audit-chain.json"' });
  });
  app.get('/api/admin', async (c) => c.json(await q.adminView(ctx, U(c))));
  app.post('/api/admin/users', async (c) => c.json(await admin.inviteUser(ctx, U(c), await body(c, 5000))));
  app.post('/api/admin/users/:id/roles', async (c) => {
    const b = await body<{ roles?: unknown[]; entityIds?: unknown[] | null }>(c, 5000);
    // a missing or malformed role list fails validation instead of silently removing every role
    const roles = Array.isArray(b.roles) ? b.roles.map(String) : (null as unknown as string[]);
    return c.json(await admin.assignRoles(ctx, U(c), c.req.param('id'), roles, Array.isArray(b.entityIds) ? b.entityIds.map(String) : null));
  });
  app.post('/api/admin/users/:id/mfa-reset', async (c) => c.json(await admin.resetMfa(ctx, U(c), c.req.param('id'), String((await body<{ reason?: string }>(c, 2000)).reason ?? ''))));
  app.post('/api/admin/users/:id/password-reset', async (c) => c.json(await admin.resetPassword(ctx, U(c), c.req.param('id'))));
  app.post('/api/admin/users/:id/status', async (c) => {
    const b = await body<{ status?: string; reason?: string }>(c, 2000);
    return c.json(await admin.setUserStatus(ctx, U(c), c.req.param('id'), b.status === 'active' ? 'active' : 'disabled', String(b.reason ?? '')));
  });
  app.post('/api/admin/sod/:code', async (c) => {
    const b = await body<{ enabled: boolean; reason: string }>(c, 5000);
    return c.json(await admin.setSodRule(ctx, U(c), c.req.param('code'), !!b.enabled, String(b.reason ?? '')));
  });
  app.post('/api/admin/settings', async (c) => c.json(await admin.updateSettings(ctx, U(c), await body(c, 5000))));
  app.post('/api/admin/entities/:id/materiality', async (c) => c.json(await admin.updateMateriality(ctx, U(c), c.req.param('id'), await body(c, 5000))));
  app.get('/api/imports', async (c) => c.json(await q.importsView(ctx, U(c))));
  app.post('/api/imports', async (c) => {
    const b = await body<{ connectorKey: string; filename: string; content: string }>(c, 2_600_000);
    return c.json(await importFile(ctx, U(c), String(b.connectorKey ?? ''), String(b.filename ?? 'upload'), String(b.content ?? '')));
  });
  if (ctx.resetDemo && ctx.config.demoMode) {
    app.post('/api/demo/reset', async (c) => {
      await ctx.resetDemo!();
      clearSession(c);
      return c.json({ ok: true });
    });
  }

  app.all('/api/*', () => {
    throw new DomainError('not_found', 'No such API endpoint.');
  });
  opts.static?.(app);
  return app;
}

/** Mutations must come from our own origin (defence in depth next to the CSRF token). */
function sameOrigin(c: Context, ctx: AppContext): boolean {
  const origin = c.req.header('origin');
  if (!origin) return true; // same-origin fetches from older browsers / non-browser clients carry no Origin
  if (ctx.config.publicOrigin) return origin === ctx.config.publicOrigin;
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}

export type ServerApp = ReturnType<typeof createServerApp>;
