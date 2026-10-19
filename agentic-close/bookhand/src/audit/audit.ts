import type { Tx } from '../persistence/db';
import type { Row } from '../persistence/schema';
import { canonicalJson } from '../shared/canonical-json';
import type { Actor } from '../shared/context';
import { GENESIS_HASH, sha256Hex } from '../shared/hash';

/**
 * Tamper-evident audit log. Each event's hash covers the previous event's hash and the canonical JSON of the
 * event itself, so editing or deleting any past event breaks every hash after it. The database independently
 * rejects UPDATE/DELETE/TRUNCATE and any insert that does not continue the chain (0002_invariants.sql).
 */

export interface AuditInput {
  action: string;
  objectType: string;
  objectId?: string | null;
  summary: string;
  details?: unknown;
}

export async function appendAudit(tx: Tx, tenantId: string, actor: Actor, input: AuditInput, occurredAt: string): Promise<Row<'audit_log'>> {
  await tx.lockAuditChain(tenantId);
  const [last] = await tx.find('audit_log', { tenant_id: tenantId }, { orderBy: [['seq', 'desc']], limit: 1 });
  const seq = last ? last.seq + 1 : 1;
  const prevHash = last ? last.hash : GENESIS_HASH;
  const event = {
    seq,
    tenant_id: tenantId,
    occurred_at: occurredAt,
    actor_type: actor.type,
    actor_id: actor.userId ?? actor.runId ?? null,
    actor_label: actor.label,
    action: input.action,
    object_type: input.objectType,
    object_id: input.objectId ?? null,
    summary: input.summary,
    details: input.details ?? null,
    request_id: actor.requestId ?? null,
    ip: actor.ip ?? null,
  };
  const record = canonicalJson(event);
  const hash = sha256Hex(`${prevHash}\n${record}`);
  return tx.insert('audit_log', {
    tenant_id: tenantId,
    seq,
    occurred_at: occurredAt,
    actor_type: actor.type,
    actor_id: event.actor_id,
    actor_label: actor.label,
    action: input.action,
    object_type: input.objectType,
    object_id: event.object_id,
    summary: input.summary,
    record,
    prev_hash: prevHash,
    hash,
    request_id: event.request_id,
    ip: event.ip,
  });
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  headHash: string;
  firstBadSeq?: number;
  reason?: string;
}

/** Recompute the whole chain; also checks that structured columns agree with the hashed record. */
export async function verifyAuditChain(tx: Tx, tenantId: string): Promise<ChainVerification> {
  const rows = await tx.find('audit_log', { tenant_id: tenantId }, { orderBy: [['seq', 'asc']] });
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of rows) {
    if (row.seq !== expectedSeq) return { ok: false, checked: expectedSeq - 1, headHash: prev, firstBadSeq: row.seq, reason: `sequence gap: expected ${expectedSeq}` };
    if (row.prev_hash !== prev) return { ok: false, checked: expectedSeq - 1, headHash: prev, firstBadSeq: row.seq, reason: 'prev_hash does not match previous event' };
    const hash = sha256Hex(`${row.prev_hash}\n${row.record}`);
    if (hash !== row.hash) return { ok: false, checked: expectedSeq - 1, headHash: prev, firstBadSeq: row.seq, reason: 'hash does not match record' };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.record) as Record<string, unknown>;
    } catch {
      return { ok: false, checked: expectedSeq - 1, headHash: prev, firstBadSeq: row.seq, reason: 'record is not valid JSON' };
    }
    if (parsed.action !== row.action || parsed.object_id !== row.object_id || parsed.summary !== row.summary || parsed.actor_label !== row.actor_label) {
      return { ok: false, checked: expectedSeq - 1, headHash: prev, firstBadSeq: row.seq, reason: 'structured columns disagree with the hashed record' };
    }
    prev = row.hash;
    expectedSeq++;
  }
  return { ok: true, checked: rows.length, headHash: prev };
}
