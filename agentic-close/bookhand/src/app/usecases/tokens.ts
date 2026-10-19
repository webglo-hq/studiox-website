import { appendAudit } from '../../audit/audit';
import type { Tx } from '../../persistence/db';
import type { Row } from '../../persistence/schema';
import { can, type Principal } from '../../security/principal';
import { DomainError } from '../../shared/errors';
import { sha256Hex } from '../../shared/hash';
import { randomToken } from '../../shared/ids';
import type { App, RequestMeta } from '../app';

/**
 * Personal access tokens for the API and the MCP server. A token acts as its owner, with the owner's current
 * roles, limits and SoD rules (nothing is copied at creation), and adds a scope ceiling: "read" tokens can
 * never change anything. Only a SHA-256 hash is stored; the token is shown once. Tokens always expire, stop
 * working when the owner is disabled, and are refused on sign-in, account and administration endpoints.
 */

export const TOKEN_PREFIX = 'bh_pat_';
export const TOKEN_LIFETIMES_DAYS = [7, 30, 90, 365] as const;
const MAX_ACTIVE_TOKENS = 10;

export type TokenScope = 'read' | 'write';

function view(t: Row<'api_tokens'>, now: string) {
  const status = t.revoked_at ? 'revoked' : t.expires_at && t.expires_at <= now ? 'expired' : 'active';
  return { id: t.id, name: t.name, scopes: t.scopes, createdAt: t.created_at, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at, status };
}

export async function listApiTokens(app: App, p: Principal) {
  const now = app.clock.now();
  const rows = await app.read((tx) => tx.find('api_tokens', { tenant_id: p.tenantId, user_id: p.user.id }, { orderBy: [['created_at', 'desc']] }));
  return { tokens: rows.map((t) => view(t, now)), lifetimes: TOKEN_LIFETIMES_DAYS, canWrite: !p.readOnly };
}

export async function createApiToken(app: App, p: Principal, input: { name: string; scope: TokenScope; expiresInDays: number }, meta: RequestMeta = {}) {
  const name = String(input.name ?? '').trim();
  if (name.length < 2 || name.length > 60) throw new DomainError('VALIDATION', 'Name the token (2 to 60 characters), e.g. "Claude Desktop".');
  if (!(TOKEN_LIFETIMES_DAYS as readonly number[]).includes(input.expiresInDays)) throw new DomainError('VALIDATION', `Choose a lifetime of ${TOKEN_LIFETIMES_DAYS.join(', ')} days.`);
  if (input.scope === 'write' && p.readOnly) throw new DomainError('VALIDATION', 'Your role is read-only, so your tokens are read-only too.');
  const scopes = input.scope === 'write' ? ['read', 'write'] : ['read'];
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  const now = app.clock.now();
  const expiresAt = new Date(Date.parse(now) + input.expiresInDays * 86_400_000).toISOString();
  const row = await app.tx(async (tx) => {
    const active = (await tx.find('api_tokens', { user_id: p.user.id, revoked_at: null })).filter((t) => !t.expires_at || t.expires_at > now);
    if (active.length >= MAX_ACTIVE_TOKENS) throw new DomainError('CONFLICT', `You already have ${MAX_ACTIVE_TOKENS} active tokens; revoke one first.`);
    const t = await tx.insert('api_tokens', { tenant_id: p.tenantId, user_id: p.user.id, name, token_hash: sha256Hex(token), scopes, expires_at: expiresAt });
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'api_token.create', objectType: 'api_token', objectId: t.id, summary: `Created access token "${name}" (${scopes.join('+')}, expires ${expiresAt.slice(0, 10)})` }, now);
    return t;
  });
  return { ...view(row, now), token };
}

export async function revokeApiToken(app: App, p: Principal, tokenId: string, meta: RequestMeta = {}) {
  return app.tx(async (tx) => {
    const t = await tx.get('api_tokens', tokenId);
    if (!t || t.tenant_id !== p.tenantId || (t.user_id !== p.user.id && !can(p, 'admin.users'))) throw new DomainError('NOT_FOUND', 'Token not found.');
    if (t.revoked_at) return view(t, app.clock.now());
    const now = app.clock.now();
    const updated = await tx.update('api_tokens', t.id, { revoked_at: now });
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'api_token.revoke', objectType: 'api_token', objectId: t.id, summary: `Revoked access token "${t.name}"` }, now);
    return view(updated, now);
  });
}

/** The live token row for a presented bearer token, or null (unknown, revoked, expired, owner disabled). */
export async function resolveApiToken(tx: Tx, token: string, now: string): Promise<Row<'api_tokens'> | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const row = await tx.findOne('api_tokens', { token_hash: sha256Hex(token) });
  if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now)) return null;
  const user = await tx.get('users', row.user_id);
  if (!user || user.status !== 'active' || user.tenant_id !== row.tenant_id) return null;
  if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) > 60_000) return tx.update('api_tokens', row.id, { last_used_at: now });
  return row;
}
