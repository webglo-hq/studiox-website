import { jsonbText } from '../util/canonical';
import { sha256Hex } from '../util/sha256';

/**
 * Tamper-evident audit chain. Each event's hash covers the previous hash and the event's
 * canonical content, so altering, deleting or reordering any event breaks every later link.
 * The same function is implemented in SQL (ek_audit_hash) — the canonical text uses
 * Postgres jsonb text rules so the database and this code agree byte for byte.
 */
export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEventContent {
  seq: number;
  tenantId: string;
  occurredAt: string; // ISO-8601 UTC with milliseconds
  actorType: string;
  actorId: string | null;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  data: unknown;
}

export function normalizeInstant(iso: string): string {
  return new Date(Date.parse(iso)).toISOString();
}

export function auditHash(prevHash: string, e: AuditEventContent): string {
  const text = [
    prevHash,
    String(e.seq),
    e.tenantId,
    normalizeInstant(e.occurredAt),
    e.actorType,
    e.actorId ?? '',
    e.action,
    e.subjectType ?? '',
    e.subjectId ?? '',
    jsonbText(e.data ?? null),
  ].join('|');
  return sha256Hex(text);
}

export interface ChainRow extends AuditEventContent {
  prevHash: string;
  hash: string;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
  reason?: string;
  headHash: string;
}

/** Verify a tenant's chain from genesis (rows must be ordered by seq). */
export function verifyChain(rows: Iterable<ChainRow>): ChainVerification {
  let prev = GENESIS_HASH;
  let n = 0;
  for (const r of rows) {
    n++;
    if (r.seq !== n) return { ok: false, checked: n, firstBadSeq: r.seq, reason: `sequence gap: expected ${n}, found ${r.seq}`, headHash: prev };
    if (r.prevHash !== prev) return { ok: false, checked: n, firstBadSeq: r.seq, reason: 'previous-hash link broken', headHash: prev };
    const h = auditHash(prev, r);
    if (h !== r.hash) return { ok: false, checked: n, firstBadSeq: r.seq, reason: 'content does not match its hash', headHash: prev };
    prev = h;
  }
  return { ok: true, checked: n, firstBadSeq: null, headHash: prev };
}
