import type { Tx } from '../persistence/db';
import type { Row } from '../persistence/schema';
import { sha256Hex } from '../shared/hash';
import { randomToken } from '../shared/ids';

/**
 * Server-side sessions. The cookie carries an opaque 256-bit random token; only its SHA-256 is stored.
 * Idle and absolute expiry; the token rotates on privilege change (MFA) and every `rotateMinutes`. A rotated
 * token stays valid for a short grace window so in-flight requests from the same tab do not fail.
 */

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
  rotateMinutes: number;
  graceSeconds: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = { idleMinutes: 30, absoluteHours: 12, rotateMinutes: 15, graceSeconds: 60 };

const addMinutes = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

export interface IssuedSession {
  session: Row<'sessions'>;
  token: string;
}

export async function createSession(
  tx: Tx,
  args: { tenantId: string; userId: string; authMethod: Row<'sessions'>['auth_method']; state: Row<'sessions'>['state']; mfaVerified: boolean; ip?: string | null; userAgent?: string | null; now: string; policy?: SessionPolicy; rotatedFromId?: string | null; csrfToken?: string },
): Promise<IssuedSession> {
  const policy = args.policy ?? DEFAULT_SESSION_POLICY;
  const token = randomToken(32);
  const session = await tx.insert('sessions', {
    tenant_id: args.tenantId,
    user_id: args.userId,
    token_hash: sha256Hex(token),
    csrf_token: args.csrfToken ?? randomToken(24),
    auth_method: args.authMethod,
    mfa_verified: args.mfaVerified,
    state: args.state,
    created_at: args.now,
    last_seen_at: args.now,
    idle_expires_at: addMinutes(args.now, args.state === 'mfa_pending' ? 10 : policy.idleMinutes),
    absolute_expires_at: addMinutes(args.now, policy.absoluteHours * 60),
    rotated_at: args.now,
    rotated_from_id: args.rotatedFromId ?? null,
    ip: args.ip ?? null,
    user_agent: args.userAgent ? args.userAgent.slice(0, 300) : null,
  });
  return { session, token };
}

export interface ResolvedSession {
  session: Row<'sessions'>;
  user: Row<'users'>;
  /** Set when the token was rotated during this request: send it back as the new cookie. */
  newToken?: string;
}

export async function resolveSession(tx: Tx, token: string | null | undefined, now: string, policy: SessionPolicy = DEFAULT_SESSION_POLICY): Promise<ResolvedSession | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  let session = await tx.findOne('sessions', { token_hash: sha256Hex(token) });
  if (!session) return null;
  if (session.revoked_at) {
    // Grace window after rotation: follow the chain to the live successor.
    if (session.revoked_reason !== 'rotated' || Date.parse(now) - Date.parse(session.revoked_at) > policy.graceSeconds * 1000) return null;
    let successor = await tx.findOne('sessions', { rotated_from_id: session.id });
    for (let i = 0; i < 5 && successor?.revoked_at && successor.revoked_reason === 'rotated'; i++) successor = await tx.findOne('sessions', { rotated_from_id: successor.id });
    if (!successor || successor.revoked_at) return null;
    session = successor;
  }
  if (now > session.idle_expires_at || now > session.absolute_expires_at) {
    await tx.update('sessions', session.id, { revoked_at: now, revoked_reason: 'expired' });
    return null;
  }
  const user = await tx.get('users', session.user_id);
  if (!user || user.status !== 'active') return null;
  if (Date.parse(now) - Date.parse(session.last_seen_at) > 30_000) {
    session = await tx.update('sessions', session.id, { last_seen_at: now, idle_expires_at: addMinutes(now, session.state === 'mfa_pending' ? 10 : policy.idleMinutes) });
  }
  if (session.state === 'active' && Date.parse(now) - Date.parse(session.rotated_at) > policy.rotateMinutes * 60_000 && sha256Hex(token) === session.token_hash) {
    const rotated = await rotateSession(tx, session, now, policy);
    return { session: rotated.session, user, newToken: rotated.token };
  }
  return { session, user };
}

/** Replace the token (and keep the CSRF token so open tabs keep working). */
export async function rotateSession(tx: Tx, session: Row<'sessions'>, now: string, policy: SessionPolicy = DEFAULT_SESSION_POLICY, patch: Partial<Pick<Row<'sessions'>, 'state' | 'mfa_verified' | 'auth_method'>> = {}): Promise<IssuedSession> {
  const issued = await createSession(tx, {
    tenantId: session.tenant_id,
    userId: session.user_id,
    authMethod: patch.auth_method ?? session.auth_method,
    state: patch.state ?? session.state,
    mfaVerified: patch.mfa_verified ?? session.mfa_verified,
    ip: session.ip,
    userAgent: session.user_agent,
    now,
    policy,
    rotatedFromId: session.id,
    csrfToken: patch.state && patch.state !== session.state ? undefined : session.csrf_token,
  });
  // Preserve the original absolute expiry: rotation never extends a session's lifetime.
  const kept = await tx.update('sessions', issued.session.id, { absolute_expires_at: session.absolute_expires_at, created_at: session.created_at });
  await tx.update('sessions', session.id, { revoked_at: now, revoked_reason: 'rotated' });
  return { session: kept, token: issued.token };
}

export async function revokeSession(tx: Tx, sessionId: string, reason: string, now: string): Promise<void> {
  const s = await tx.get('sessions', sessionId);
  if (s && !s.revoked_at) await tx.update('sessions', sessionId, { revoked_at: now, revoked_reason: reason });
}

export async function revokeUserSessions(tx: Tx, userId: string, reason: string, now: string, exceptSessionId?: string): Promise<number> {
  const sessions = await tx.find('sessions', { user_id: userId });
  let n = 0;
  for (const s of sessions) {
    if (s.revoked_at || s.id === exceptSessionId) continue;
    await tx.update('sessions', s.id, { revoked_at: now, revoked_reason: reason });
    n++;
  }
  return n;
}
