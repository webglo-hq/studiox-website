/**
 * Application context: everything a use case needs, wired once per process (server) or per page
 * (browser demo). No Node-only imports here; the same code runs in both.
 */
import { AgentRuntime } from '../core/agent/runtime';
import { resolveUserActor, type UserActor } from '../core/auth/actor';
import type { PasswordHasher } from '../core/auth/password';
import type { LlmProvider } from '../core/llm/types';
import type { SkillRegistry } from '../core/skills/skillmd';
import { forbidden } from '../core/util/errors';
import type { Clock } from '../core/util/time';
import type { Db, DbTx } from '../schema';
import { accountingPack } from '../packs/accounting/agent/pack';
import { AccountingServices } from '../packs/accounting/services';
import { accountingSkills } from '../packs/accounting/skills/install';
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
  oidc: { issuer: string; clientId: string; redirectUri: string } | null;
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
  log: (msg: string, data?: Record<string, unknown>) => void;
  /** optional hook to restore demo data (browser demo / demo server) */
  resetDemo?: () => Promise<void>;
}

export function createAppContext(opts: { db: Db; clock: Clock; config: AppConfig; hasher: PasswordHasher; llm?: LlmProvider | null; log?: AppContext['log']; resetDemo?: () => Promise<void> }): AppContext {
  const skills = accountingSkills();
  const llm = opts.llm ?? null;
  const runtime = new AgentRuntime<AccountingServices>({ db: opts.db, clock: opts.clock, pack: accountingPack, skills, llm, resolveActor: resolveUserActor });
  return { db: opts.db, clock: opts.clock, config: opts.config, hasher: opts.hasher, llm, skills, runtime, limiter: new RateLimiter(), log: opts.log ?? (() => undefined), resetDemo: opts.resetDemo };
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

/** Run a unit of work as the user, with services bound to their actor. */
export async function asUser<R>(ctx: AppContext, u: RequestUser, fn: (svc: AccountingServices, tx: DbTx) => Promise<R>): Promise<R> {
  return ctx.db.tx(u.tenantId, async (tx) => fn(new AccountingServices(tx, u.actor, ctx.clock), tx));
}
