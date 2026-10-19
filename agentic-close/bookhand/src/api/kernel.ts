import { z } from 'zod';
import type { App, RequestMeta } from '../app/app';
import { principalFor } from '../app/usecases/auth';
import { resolveApiToken } from '../app/usecases/tokens';
import { isDbConstraintError } from '../persistence/db';
import type { Row } from '../persistence/schema';
import type { Permission } from '../security/permissions';
import { loadPrincipal, requirePermission, type Principal } from '../security/principal';
import { RATE_LIMITS, RateLimiter, type RateLimitRule } from '../security/ratelimit';
import { resolveSession } from '../security/sessions';
import { DomainError, httpStatusFor, isDomainError } from '../shared/errors';
import { timingSafeEqual } from '../shared/hash';
import { randomToken } from '../shared/ids';

/**
 * Transport-agnostic API kernel. The Node HTTP server and the in-browser demo transport both translate their
 * requests into ApiRequest and call handle(); authentication, CSRF, rate limiting, RBAC and error mapping live
 * here once. Responses are JSON; cookies are returned as structured values the transport serializes.
 */

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body: unknown;
  ip: string;
}

export interface CookieSpec {
  name: string;
  value: string;
  maxAgeSeconds: number;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax';
  secure: boolean;
  path: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  cookies: CookieSpec[];
  body: unknown;
}

export const SESSION_COOKIE = 'bh_session';
/** Sign-in, account and administration endpoints accept the browser session only, never an access token. */
const SESSION_ONLY = /^\/api\/(?:auth|me|admin)\/|^\/api\/session$/;

export interface RouteContext {
  app: App;
  req: ApiRequest;
  params: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  meta: RequestMeta;
  principal: Principal;
  session: Row<'sessions'>;
  setSessionCookie(token: string): void;
  clearSessionCookie(): void;
}

export type PublicRouteContext = Omit<RouteContext, 'principal' | 'session'> & { principal: Principal | null; session: Row<'sessions'> | null };

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** public: no session; mfa: session in mfa_pending allowed; session (default): fully signed in. */
  auth?: 'public' | 'mfa' | 'session';
  permission?: Permission;
  rate?: keyof typeof RATE_LIMITS;
  /** Charged only when the handler fails with 400/401/429 (wrong password or code); checked before it runs. */
  rateOnFailure?: keyof typeof RATE_LIMITS;
  /** Scope an access token needs. Default: "read" for GET, "write" for anything else. */
  tokenScope?: 'read' | 'write';
  body?: z.ZodType;
  handler(ctx: RouteContext & PublicRouteContext): Promise<unknown> | unknown;
}

interface CompiledRoute extends RouteDef {
  regex: RegExp;
  keys: string[];
}

export interface KernelOptions {
  allowedOrigins?: string[];
  log?: (line: string) => void;
}

export class ApiKernel {
  private readonly routes: CompiledRoute[];
  readonly limiter = new RateLimiter();

  constructor(
    readonly app: App,
    routes: RouteDef[],
    private readonly opts: KernelOptions = {},
  ) {
    this.routes = routes.map((r) => {
      const keys: string[] = [];
      const pattern = r.path.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
        keys.push(k);
        return '([^/]+)';
      });
      return { ...r, regex: new RegExp(`^${pattern}$`), keys };
    });
  }

  private cookie(name: string, value: string, maxAgeSeconds: number): CookieSpec {
    return { name, value, maxAgeSeconds, httpOnly: true, sameSite: 'Lax', secure: this.app.config.secureCookies, path: '/' };
  }

  private rate(key: string, rule: RateLimitRule): void {
    const d = this.limiter.take(key, rule);
    if (!d.allowed) throw new DomainError('RATE_LIMITED', `Too many requests; try again in ${d.retryAfterSeconds} s.`, { retryAfterSeconds: d.retryAfterSeconds });
  }

  private originOk(req: ApiRequest): boolean {
    const origin = req.headers.origin;
    if (!origin) return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin' || req.headers['sec-fetch-site'] === 'none';
    const allowed = this.opts.allowedOrigins ?? [];
    if (allowed.includes(origin)) return true;
    const host = req.headers.host;
    return !!host && (origin === `http://${host}` || origin === `https://${host}`);
  }

  async handle(req: ApiRequest): Promise<ApiResponse> {
    const requestId = randomToken(9);
    const response: ApiResponse = { status: 200, headers: { 'cache-control': 'no-store', 'x-request-id': requestId }, cookies: [], body: null };
    const started = Date.now();
    let charge: keyof typeof RATE_LIMITS | null = null;
    try {
      const method = req.method.toUpperCase();
      this.rate(`ip:${req.ip}`, RATE_LIMITS.api);
      const mutation = method !== 'GET' && method !== 'HEAD';
      if (mutation) this.rate(`mut:${req.ip}`, RATE_LIMITS.mutation);
      let route: CompiledRoute | undefined;
      let params: Record<string, string> = {};
      let methodMismatch = false;
      for (const r of this.routes) {
        const m = r.regex.exec(req.path);
        if (!m) continue;
        if (r.method !== method) {
          methodMismatch = true;
          continue;
        }
        route = r;
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeParam(m[i + 1]!)]));
        break;
      }
      if (!route) throw new DomainError(methodMismatch ? 'VALIDATION' : 'NOT_FOUND', methodMismatch ? `${method} is not supported here` : `No API route ${req.path}`);
      if (mutation && !this.originOk(req)) throw new DomainError('CSRF', 'Cross-origin request refused.');
      if (route.rate) this.rate(`${route.rate}:${req.ip}`, RATE_LIMITS[route.rate]);
      if (route.rateOnFailure) {
        const gate = this.limiter.peek(`${route.rateOnFailure}:${req.ip}`, RATE_LIMITS[route.rateOnFailure]);
        if (!gate.allowed) throw new DomainError('RATE_LIMITED', `Too many failed attempts; try again in ${gate.retryAfterSeconds} s.`, { retryAfterSeconds: gate.retryAfterSeconds });
        charge = route.rateOnFailure;
      }

      const meta: RequestMeta = { requestId, ip: req.ip, userAgent: req.headers['user-agent'], channel: 'web' };
      let session: Row<'sessions'> | null = null;
      let principal: Principal | null = null;
      let apiToken: Row<'api_tokens'> | null = null;
      const authorization = (req.headers.authorization ?? '').trim();
      const token = authorization ? null : req.cookies[SESSION_COOKIE];
      if (authorization) {
        // Access token (API clients and the MCP server): no cookies, so no CSRF; the owner's roles apply in full.
        const bearer = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(authorization)?.[1];
        if (!bearer) throw new DomainError('UNAUTHENTICATED', 'Malformed Authorization header; send "Bearer <access token>".');
        if (SESSION_ONLY.test(route.path)) throw new DomainError('FORBIDDEN', 'Access tokens cannot be used for sign-in, account or administration endpoints; use the web app.');
        const gate = this.limiter.peek(`tokenfail:${req.ip}`, RATE_LIMITS.login);
        if (!gate.allowed) throw new DomainError('RATE_LIMITED', `Too many invalid tokens; try again in ${gate.retryAfterSeconds} s.`, { retryAfterSeconds: gate.retryAfterSeconds });
        apiToken = await this.app.tx((tx) => resolveApiToken(tx, bearer, this.app.clock.now()));
        if (!apiToken) {
          this.limiter.take(`tokenfail:${req.ip}`, RATE_LIMITS.login);
          throw new DomainError('UNAUTHENTICATED', 'The access token is invalid, expired or revoked.');
        }
        const owner = apiToken;
        principal = await this.app.read((tx) => loadPrincipal(tx, owner.tenant_id, owner.user_id));
        const needs = route.tokenScope ?? (mutation ? 'write' : 'read');
        if (needs === 'write' && !owner.scopes.includes('write')) throw new DomainError('FORBIDDEN', 'This access token is read-only.');
        this.rate(`token:${owner.id}`, RATE_LIMITS.api);
        meta.channel = req.headers['x-bookhand-client'] === 'mcp' ? 'mcp' : 'api';
      }
      if (token) {
        const resolved = await this.app.tx((tx) => resolveSession(tx, token, this.app.clock.now(), { idleMinutes: this.app.config.sessionIdleMinutes, absoluteHours: this.app.config.sessionAbsoluteHours, rotateMinutes: 15, graceSeconds: 60 }));
        if (resolved) {
          session = resolved.session;
          if (resolved.newToken) response.cookies.push(this.cookie(SESSION_COOKIE, resolved.newToken, this.app.config.sessionAbsoluteHours * 3600));
          if (session.state === 'active') principal = await principalFor(this.app, session);
        } else {
          response.cookies.push(this.cookie(SESSION_COOKIE, '', 0));
        }
      }
      const auth = route.auth ?? 'session';
      if (auth === 'session' && !principal) throw new DomainError(session?.state === 'mfa_pending' ? 'MFA_REQUIRED' : 'UNAUTHENTICATED', session?.state === 'mfa_pending' ? 'Enter your authenticator code to finish signing in.' : 'Please sign in.');
      if (auth === 'mfa' && !session) throw new DomainError('UNAUTHENTICATED', 'Please sign in.');
      if (mutation) {
        if (auth === 'public') {
          if (req.headers['x-requested-with'] !== 'bookhand') throw new DomainError('CSRF', 'Missing X-Requested-With header.');
        } else if (!apiToken) {
          const header = req.headers['x-csrf-token'] ?? '';
          if (!session || !timingSafeEqual(header, session.csrf_token)) throw new DomainError('CSRF', 'Security token missing or expired; reload the page.');
        }
      }
      if (route.permission && principal) requirePermission(principal, route.permission);
      if (principal && mutation) this.rate(`user:${principal.user.id}`, RATE_LIMITS.mutation);
      let body: Record<string, unknown> = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      if (route.body) {
        const parsed = route.body.safeParse(req.body ?? {});
        if (!parsed.success) throw new DomainError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
        body = parsed.data as Record<string, unknown>;
      }
      const ctx = {
        app: this.app,
        req,
        params,
        query: req.query,
        body,
        meta,
        principal: principal!,
        session: session!,
        setSessionCookie: (t: string) => response.cookies.push(this.cookie(SESSION_COOKIE, t, this.app.config.sessionAbsoluteHours * 3600)),
        clearSessionCookie: () => response.cookies.push(this.cookie(SESSION_COOKIE, '', 0)),
      };
      const result = await route.handler(ctx);
      response.body = result === undefined ? { ok: true } : result;
      if (method === 'POST' && result && typeof result === 'object' && 'runId' in (result as Record<string, unknown>)) response.status = 202;
    } catch (e) {
      const mapped = toErrorBody(e);
      if (charge && (mapped.status === 400 || mapped.status === 401 || mapped.status === 429)) this.limiter.take(`${charge}:${req.ip}`, RATE_LIMITS[charge]);
      response.status = mapped.status;
      response.body = { error: { ...mapped.error, requestId } };
      if (mapped.status >= 500) this.opts.log?.(`[${requestId}] ${req.method} ${req.path} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      if (mapped.error.code === 'RATE_LIMITED') response.headers['retry-after'] = String((mapped.error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ?? 60);
    }
    this.opts.log?.(`${req.method} ${req.path} ${response.status} ${Date.now() - started}ms`);
    return response;
  }
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new DomainError('VALIDATION', 'Malformed URL parameter.');
  }
}

export function toErrorBody(e: unknown): { status: number; error: { code: string; message: string; details?: unknown } } {
  if (isDomainError(e)) return { status: httpStatusFor[e.code], error: { code: e.code, message: e.message, details: e.details } };
  if (isDbConstraintError(e)) {
    const code = e.kind === 'period_locked' ? 'PERIOD_LOCKED' : e.kind === 'unique_violation' ? 'CONFLICT' : 'INVARIANT';
    return { status: e.kind === 'period_locked' ? 423 : e.kind === 'unique_violation' ? 409 : 422, error: { code, message: e.message, details: { constraint: e.constraint, table: e.table } } };
  }
  if (e instanceof z.ZodError) return { status: 400, error: { code: 'VALIDATION', message: e.issues.map((i) => i.message).join('; ') } };
  return { status: 500, error: { code: 'INTERNAL', message: 'Something went wrong on our side. The error was logged.' } };
}
