import type { Row } from '../../../framework/store/schema';
import { AppError } from '../../../framework/util/errors';
import { randomToken } from '../../../framework/util/ids';
import { sha256Hex } from '../../../framework/util/sha256';
import { audit } from '../domain/audit';
import type { ServiceContext } from '../domain/context';
import type { EkDb, EkSchema } from '../store';

/**
 * Personal API tokens, used by the MCP server and scripts. A token acts as the person who
 * created it, with that person's roles, entity scope and segregation-of-duties rules; it can
 * be read-only or allowed to make changes. Only the SHA-256 of a token is stored, and the
 * value is shown once. Tokens expire and can be revoked; every use is audited as the person
 * "via API token".
 */

export const API_TOKEN_PREFIX = 'ekt_';
const MAX_ACTIVE = 10;

export type ApiTokenScope = 'read' | 'write';

export interface ApiTokenView {
  id: string;
  name: string;
  scopes: ApiTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
}

type TokenRow = Row<EkSchema, 'api_token'>;

function view(r: TokenRow, now: string): ApiTokenView {
  return {
    id: r.id,
    name: r.name,
    scopes: r.scopes as ApiTokenScope[],
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    active: !r.revoked_at && (!r.expires_at || r.expires_at > now),
  };
}

function requireUser(ctx: ServiceContext): string {
  if (ctx.actor.type !== 'user' || !ctx.actor.userId) throw new AppError('FORBIDDEN', 'Only a signed-in person can manage API tokens.');
  return ctx.actor.userId;
}

export async function listMyTokens(ctx: ServiceContext): Promise<ApiTokenView[]> {
  const userId = requireUser(ctx);
  const rows = await ctx.db.find('api_token', { tenant_id: ctx.tenantId, user_id: userId }, { orderBy: [['created_at', 'desc']] });
  return rows.map((r) => view(r, ctx.clock.nowIso()));
}

export async function createToken(ctx: ServiceContext, input: { name: string; write: boolean; days: number }): Promise<{ token: string; view: ApiTokenView }> {
  const userId = requireUser(ctx);
  const now = ctx.clock.nowIso();
  const name = input.name.trim();
  if (name.length < 3) throw new AppError('VALIDATION', 'Give the token a name you will recognise (at least 3 characters).');
  const active = (await ctx.db.find('api_token', { tenant_id: ctx.tenantId, user_id: userId, revoked_at: { isNull: true } })).filter((r) => !r.expires_at || r.expires_at > now);
  if (active.length >= MAX_ACTIVE) throw new AppError('CONFLICT', `You already have ${MAX_ACTIVE} active tokens. Revoke one first.`);
  const token = `${API_TOKEN_PREFIX}${randomToken(32)}`;
  const scopes: ApiTokenScope[] = input.write ? ['read', 'write'] : ['read'];
  const expiresAt = new Date(Date.parse(now) + input.days * 86_400_000).toISOString();
  const row = await ctx.db.insert('api_token', { tenant_id: ctx.tenantId, user_id: userId, name, token_hash: sha256Hex(token), scopes, created_at: now, expires_at: expiresAt });
  await audit(ctx, { action: 'auth.token.created', subjectType: 'api_token', subjectId: row.id, data: { name, scopes, expiresAt } });
  return { token, view: view(row, now) };
}

export async function revokeToken(ctx: ServiceContext, id: string): Promise<ApiTokenView> {
  const userId = requireUser(ctx);
  const row = await ctx.db.get('api_token', id);
  if (!row || row.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Token not found');
  if (row.user_id !== userId && !ctx.actor.permissions.has('admin.users')) throw new AppError('FORBIDDEN', 'You can only revoke your own tokens.');
  if (row.revoked_at) return view(row, ctx.clock.nowIso());
  const updated = await ctx.db.update('api_token', id, { revoked_at: ctx.clock.nowIso() });
  await audit(ctx, { action: 'auth.token.revoked', subjectType: 'api_token', subjectId: id, data: { name: row.name } });
  return view(updated, ctx.clock.nowIso());
}

export interface VerifiedToken {
  tokenId: string;
  userId: string;
  name: string;
  scopes: ApiTokenScope[];
}

/** Resolve a presented token. Returns null for anything malformed, unknown, revoked or expired. */
export async function verifyApiToken(db: EkDb, tenantId: string, presented: string, now: string): Promise<VerifiedToken | null> {
  if (!presented.startsWith(API_TOKEN_PREFIX) || !/^ekt_[A-Za-z0-9_-]{40,60}$/.test(presented)) return null;
  const row = await db.findOne('api_token', { token_hash: sha256Hex(presented) });
  if (!row || row.tenant_id !== tenantId || row.revoked_at || (row.expires_at && row.expires_at <= now)) return null;
  // Record use at most once a minute to keep writes low.
  if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) > 60_000) await db.update('api_token', row.id, { last_used_at: now });
  return { tokenId: row.id, userId: row.user_id, name: row.name, scopes: row.scopes as ApiTokenScope[] };
}
