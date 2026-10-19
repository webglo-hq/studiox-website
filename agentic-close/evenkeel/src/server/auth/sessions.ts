import { timingSafeEqual } from 'node:crypto';
import type { Row } from '../../framework/store/schema';
import { randomToken } from '../../framework/util/ids';
import { sha256Hex } from '../../framework/util/sha256';
import type { EkDb, EkSchema } from '../../packs/accounting/store';

/**
 * Server sessions. The browser holds an opaque random token in an HttpOnly cookie; the
 * database stores only its SHA-256, so a database leak does not reveal live sessions.
 * Sessions expire on idle and absolute timeouts and rotate on privilege change and on a
 * timer. Each session also carries a random CSRF seed; the CSRF token the page sends back
 * is HMAC(server key, seed), so it can be re-derived on every page load (several tabs keep
 * working) and a database leak alone cannot forge it.
 */

export type SessionRow = Row<EkSchema, 'session'>;

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
  rotateMinutes: number;
}

/** Anything that can MAC a value with a server-held key (SecretBox in production). */
export interface Signer {
  mac(purpose: string, data: string): string;
}

export const DEFAULT_POLICY: SessionPolicy = { idleMinutes: 30, absoluteHours: 12, rotateMinutes: 15 };

const addMinutes = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

export async function createSession(
  db: EkDb,
  input: {
    tenantId: string;
    userId: string;
    ip: string | null;
    userAgent: string | null;
    mfaVerified: boolean;
    now: string;
    policy?: SessionPolicy;
    rotatedFrom?: string | null;
    absoluteExpiry?: string;
    /** keep the CSRF seed of the session being rotated */
    csrfSeed?: string;
  },
): Promise<{ token: string; row: SessionRow }> {
  const policy = input.policy ?? DEFAULT_POLICY;
  const token = randomToken(32);
  const row = await db.insert('session', {
    id: sha256Hex(token),
    tenant_id: input.tenantId,
    user_id: input.userId,
    created_at: input.now,
    expires_at: input.absoluteExpiry ?? addMinutes(input.now, policy.absoluteHours * 60),
    idle_expires_at: addMinutes(input.now, policy.idleMinutes),
    last_seen_at: input.now,
    rotated_from: input.rotatedFrom ?? null,
    csrf_hash: input.csrfSeed ?? sha256Hex(randomToken(32)),
    mfa_verified: input.mfaVerified,
    ip: input.ip,
    user_agent: input.userAgent ? input.userAgent.slice(0, 300) : null,
    revoked_at: null,
  });
  return { token, row };
}

export type SessionCheck = { ok: true; row: SessionRow } | { ok: false; reason: 'missing' | 'revoked' | 'expired' | 'idle' };

export async function loadSession(db: EkDb, token: string | null | undefined, now: string, policy: SessionPolicy = DEFAULT_POLICY): Promise<SessionCheck> {
  if (!token || token.length < 20 || token.length > 200) return { ok: false, reason: 'missing' };
  const row = await db.get('session', sha256Hex(token));
  if (!row) return { ok: false, reason: 'missing' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at <= now) return { ok: false, reason: 'expired' };
  if (row.idle_expires_at <= now) return { ok: false, reason: 'idle' };
  // Sliding idle window, written at most once a minute.
  if (Date.parse(now) - Date.parse(row.last_seen_at) > 60_000) {
    const next = { last_seen_at: now, idle_expires_at: addMinutes(now, policy.idleMinutes) };
    await db.update('session', row.id, next);
    return { ok: true, row: { ...row, ...next } };
  }
  return { ok: true, row };
}

export function dueForRotation(row: SessionRow, now: string, policy: SessionPolicy = DEFAULT_POLICY): boolean {
  return Date.parse(now) - Date.parse(row.created_at) > policy.rotateMinutes * 60_000;
}

/**
 * Replace a session with a fresh token (same absolute expiry) and revoke the old one.
 * A timed rotation keeps the CSRF seed so open tabs keep working; a privilege change
 * (MFA step-up, password change) passes `newCsrf` to start a fresh one.
 */
export async function rotateSession(
  db: EkDb,
  row: SessionRow,
  now: string,
  opts: { mfaVerified?: boolean; ip?: string | null; userAgent?: string | null; policy?: SessionPolicy; newCsrf?: boolean } = {},
): Promise<{ token: string; row: SessionRow }> {
  const next = await createSession(db, {
    tenantId: row.tenant_id,
    userId: row.user_id,
    ip: opts.ip ?? row.ip,
    userAgent: opts.userAgent ?? row.user_agent,
    mfaVerified: opts.mfaVerified ?? row.mfa_verified,
    now,
    policy: opts.policy,
    rotatedFrom: row.id,
    absoluteExpiry: row.expires_at,
    csrfSeed: opts.newCsrf ? undefined : row.csrf_hash,
  });
  await db.update('session', row.id, { revoked_at: now });
  return next;
}

export async function revokeSession(db: EkDb, id: string, now: string): Promise<void> {
  await db.update('session', id, { revoked_at: now });
}

/** The CSRF token for a session: stable for the session's lifetime, never stored. */
export function csrfTokenFor(row: SessionRow, signer: Signer): string {
  return signer.mac('csrf', row.csrf_hash);
}

export function csrfMatches(row: SessionRow, provided: string | null | undefined, signer: Signer): boolean {
  if (!provided || provided.length > 200) return false;
  const a = Buffer.from(sha256Hex(provided), 'hex');
  const b = Buffer.from(sha256Hex(csrfTokenFor(row, signer)), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
