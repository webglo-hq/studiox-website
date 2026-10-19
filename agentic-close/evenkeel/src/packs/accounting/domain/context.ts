import type { Clock } from '../../../framework/util/clock';
import { AppError } from '../../../framework/util/errors';
import type { EkDb } from '../store';

export type ActorType = 'user' | 'agent' | 'system';

/**
 * Who is acting. Agents act with the intersection of their skill's declared permissions and
 * the permissions of the user who started the run (least privilege, delegated authority).
 */
export interface Actor {
  type: ActorType;
  /** Human user id; for agents, the requesting user. */
  userId: string | null;
  label: string;
  roles: string[];
  permissions: ReadonlySet<string>;
  /** Entities the actor may touch; 'all' for tenant-wide roles. */
  entityScope: readonly string[] | 'all';
  agentRunId?: string;
  skillId?: string;
  ip?: string | null;
}

export interface ServiceContext {
  db: EkDb;
  tenantId: string;
  actor: Actor;
  clock: Clock;
  /** Per-request memo for reference data (accounts, entities…). */
  cache: Map<string, unknown>;
}

export function makeContext(db: EkDb, tenantId: string, actor: Actor, clock: Clock): ServiceContext {
  return { db, tenantId, actor, clock, cache: new Map() };
}

export function withDb(ctx: ServiceContext, db: EkDb): ServiceContext {
  return { ...ctx, db };
}

export function systemActor(label = 'Evenkeel system'): Actor {
  return { type: 'system', userId: null, label, roles: ['system'], permissions: new Set(['*']), entityScope: 'all' };
}

export function hasPermission(actor: Actor, permission: string): boolean {
  return actor.permissions.has('*') || actor.permissions.has(permission);
}

export function requirePermission(ctx: ServiceContext, permission: string): void {
  if (!hasPermission(ctx.actor, permission)) {
    throw new AppError('FORBIDDEN', `Your role does not allow this action (${permission}).`, { permission });
  }
}

export function requireEntity(ctx: ServiceContext, entityId: string | null | undefined): void {
  if (!entityId || ctx.actor.entityScope === 'all') return;
  if (!ctx.actor.entityScope.includes(entityId)) throw new AppError('FORBIDDEN', 'You do not have access to this entity.');
}

export async function memo<T>(ctx: ServiceContext, key: string, load: () => Promise<T>): Promise<T> {
  if (ctx.cache.has(key)) return ctx.cache.get(key) as T;
  const v = await load();
  ctx.cache.set(key, v);
  return v;
}

export function invalidate(ctx: ServiceContext, prefix: string): void {
  for (const k of [...ctx.cache.keys()]) if (k.startsWith(prefix)) ctx.cache.delete(k);
}
