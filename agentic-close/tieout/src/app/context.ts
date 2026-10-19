/**
 * Application context: everything a use case needs, wired once per process (server) or per page
 * (browser demo). No Node-only imports here; the same code runs in both.
 */
import { AgentRuntime } from '../core/agent/runtime';
import { resolveUserActor, type UserActor } from '../core/auth/actor';
import { OidcClient } from '../core/auth/oidc';
import type { PasswordHasher } from '../core/auth/password';
import type { LlmProvider } from '../core/llm/types';
import type { SkillRegistry } from '../core/skills/skillmd';
import { forbidden } from '../core/util/errors';
import type { Clock } from '../core/util/time';
import type { Db, DbTx } from '../schema';
import { accountingPack } from '../packs/accounting/agent/pack';
import { AccountingServices } from '../packs/accounting/services';
import { accountingSkills } from '../packs/accounting/skills/install';
import { demoMailboxDelivery, emailRelayDelivery, type OutboxDelivery } from './outbox';
import { RateLimiter } from './rate-limit';

export interface AppConfig {
  /** Expected browser origin for CSRF origin checks (null = same-host check only). */
  publicOrigin: string | null;
  secureCookies: boolean;
  /** base64 32-byte key for encrypting MFA secrets at rest */
  encryptionKey: string;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  /** demo affordances: persona picker, reset; never enable for real tenants */
  demoMode: boolean;
  /** the documented dev-only demo password, shown on the sign-in page only when it is the default */
  demoPassword: string | null;
  oidc: { issuer: string; clientId: string; redirectUri: string; clientSecret?: string | null } | null;
  version: string;
}

export interface AppContext {
  db: Db;
  clock: Clock;
  config: AppConfig;
  hasher: PasswordHasher;
  llm: LlmProvider | null;
  skills: SkillRegistry;
  runtime: AgentRuntime<AccountingServices>;
  limiter: RateLimiter;
  /** OpenID Connect relying party when single sign-on is configured */
  oidc: OidcClient | null;
  log: (msg: string, data?: Record<string, unknown>) => void;
  /** optional hook to restore demo data (browser demo / demo server) */
  resetDemo?: () => Promise<void>;
  /** how messages to people (invitations, password-reset links) are delivered */
  outbox: OutboxDelivery;
}

export function createAppContext(opts: { db: Db; clock: Clock; config: AppConfig; hasher: PasswordHasher; llm?: LlmProvider | null; log?: AppContext['log']; resetDemo?: () => Promise<void>; oidcFetch?: typeof fetch; outbox?: OutboxDelivery }): AppContext {
  const skills = accountingSkills();
  const llm = opts.llm ?? null;
  const runtime = new AgentRuntime<AccountingServices>({ db: opts.db, clock: opts.clock, pack: accountingPack, skills, llm, resolveActor: resolveUserActor });
  // token lifetimes are checked against real time (the demo's business clock is shifted)
  const oidc = opts.config.oidc ? new OidcClient(opts.config.oidc, opts.oidcFetch) : null;
  const outbox = opts.outbox ?? (opts.config.demoMode ? demoMailboxDelivery : emailRelayDelivery);
  return { db: opts.db, clock: opts.clock, config: opts.config, hasher: opts.hasher, llm, skills, runtime, limiter: new RateLimiter(), oidc, log: opts.log ?? (() => undefined), resetDemo: opts.resetDemo, outbox };
}

/** A request's identity after authentication. */
export interface RequestUser {
  actor: UserActor;
  tenantId: string;
  sessionId: string;
  ip: string | null;
}

export function requirePermission(u: RequestUser, permission: string) {
  if (!u.actor.permissions.has(permission)) throw forbidden(`This needs the “${permission}” permission.`);
}

/**
 * Entity scope (role grants limited to some legal entities; `null` scope = the whole group).
 * Reads: rows of an entity outside the scope are hidden; group-level rows (no entity) stay
 * visible. Writes: entity rows need the entity in scope, group-level actions need group access.
 */
export function inScope(u: RequestUser, entityId: string | null | undefined): boolean {
  return !u.actor.entityScope || !entityId || u.actor.entityScope.includes(entityId);
}

export function assertInScope(u: RequestUser, entityId: string | null | undefined) {
  if (!inScope(u, entityId)) throw forbidden('That entity is outside your access scope.');
}

/** Group-level work (consolidation, the close package, locking every entity) needs unscoped access. */
export function requireGroupAccess(u: RequestUser, what: string) {
  if (u.actor.entityScope) throw forbidden(`${what} covers every entity, and your access is limited to some of them.`);
}

/** Acting on an item: its entity must be in scope; a group-level item needs group access. */
export function assertCanActOn(u: RequestUser, entityId: string | null | undefined, what: string) {
  if (entityId) assertInScope(u, entityId);
  else requireGroupAccess(u, what);
}

/** Run a unit of work as the user, with services bound to their actor. */
export async function asUser<R>(ctx: AppContext, u: RequestUser, fn: (svc: AccountingServices, tx: DbTx) => Promise<R>): Promise<R> {
  return ctx.db.tx(u.tenantId, async (tx) => fn(new AccountingServices(tx, u.actor, ctx.clock), tx));
}
