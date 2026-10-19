/**
 * Tamper-evident audit chain (AX-AUD-01).
 *
 *   hash_n = SHA-256( hash_{n-1} || "\n" || canonical_json(event_n without hash fields) )
 *
 * Any edit, deletion, insertion or reordering of a past event breaks every later link.
 * Postgres additionally forbids UPDATE/DELETE/TRUNCATE and re-checks seq/prev_hash on insert.
 */
import { canonicalJson } from '../util/json';
import { sha256Hex, ZERO_HASH } from '../util/hash';
import type { AuditAppend, AuditRecord } from '../store/types';

export function auditPayload(tenantId: string, seq: number, e: AuditAppend): Record<string, unknown> {
  return {
    id: e.id,
    tenant_id: tenantId,
    seq,
    at: e.at,
    actor_type: e.actor_type,
    actor_id: e.actor_id,
    actor_label: e.actor_label,
    on_behalf_of: e.on_behalf_of,
    action: e.action,
    subject_type: e.subject_type,
    subject_id: e.subject_id,
    entity_id: e.entity_id,
    summary: e.summary,
    data: e.data,
    ip: e.ip,
  };
}

export function computeAuditHash(prevHash: string, tenantId: string, seq: number, e: AuditAppend): string {
  return sha256Hex(`${prevHash}\n${canonicalJson(auditPayload(tenantId, seq, e))}`);
}

export function sealAuditRecord(tenantId: string, last: { seq: number; hash: string } | undefined, e: AuditAppend): AuditRecord {
  const seq = (last?.seq ?? 0) + 1;
  const prev_hash = last?.hash ?? ZERO_HASH;
  return { ...e, tenant_id: tenantId, seq, prev_hash, hash: computeAuditHash(prev_hash, tenantId, seq, e) };
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
  reason: string | null;
  headHash: string;
}

/** Verify an ordered (by seq ascending) slice of a tenant's chain, starting at genesis. */
export function verifyAuditChain(records: readonly AuditRecord[]): ChainVerification {
  let prev = ZERO_HASH;
  let expectedSeq = 1;
  for (const r of records) {
    if (r.seq !== expectedSeq) return bad(records, r.seq, `sequence gap: expected ${expectedSeq}, found ${r.seq}`, prev);
    if (r.prev_hash !== prev) return bad(records, r.seq, 'prev_hash does not match the previous record', prev);
    const recomputed = computeAuditHash(prev, r.tenant_id, r.seq, r);
    if (recomputed !== r.hash) return bad(records, r.seq, 'record content was altered (hash mismatch)', prev);
    prev = r.hash;
    expectedSeq++;
  }
  return { ok: true, checked: records.length, firstBadSeq: null, reason: null, headHash: prev };
}

function bad(records: readonly AuditRecord[], seq: number, reason: string, head: string): ChainVerification {
  return { ok: false, checked: records.findIndex((r) => r.seq === seq), firstBadSeq: seq, reason, headHash: head };
}
