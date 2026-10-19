/** MemoryStore emulation of the core schema's triggers and checks (mirrors migrations/0001_core.sql, 0009 and 0012). */
import { computeAuditHash } from '../audit/chain';
import { ZERO_HASH } from '../util/hash';
import type { MemoryHooks } from './memory';
import { StoreError, type AuditAppend } from './types';

const forbid = (table: string, op: string) => () => {
  throw new StoreError('23514', `AX-AUD-01: ${op} on ${table} is not allowed (append-only)`);
};

export const coreHooks: MemoryHooks = {
  beforeInsert: {
    audit_log: (row, db) => {
      const rows = db.find('audit_log', { tenant_id: row.tenant_id });
      let last: { seq: number; hash: string } | undefined;
      for (const r of rows) if (!last || (r.seq as number) > last.seq) last = { seq: r.seq as number, hash: r.hash as string };
      if (!last) {
        if (row.seq !== 1 || row.prev_hash !== ZERO_HASH) throw new StoreError('23514', 'AX-AUD-01: audit chain genesis must be seq 1 with zero prev_hash');
      } else if (row.seq !== last.seq + 1 || row.prev_hash !== last.hash) {
        throw new StoreError('23514', `AX-AUD-01: audit chain link broken at seq ${String(row.seq)}`);
      }
      if (!/^[0-9a-f]{64}$/.test(String(row.hash))) throw new StoreError('23514', 'audit hash must be a SHA-256 hex digest');
      // the hash is recomputed from the event itself (migration 0009), so a forged link is refused
      if (row.hash !== computeAuditHash(row.prev_hash as string, row.tenant_id as string, row.seq as number, row as unknown as AuditAppend)) throw new StoreError('23514', `AX-AUD-01: audit event ${String(row.seq)} does not match its hash`);
    },
    skill_policies: (row, db) => oneCurrentPolicy(row, db),
    proposals: (row) => proposalChecks(row),
    sessions: (row) => {
      if (!/^[0-9a-f]{64}$/.test(String(row.id))) throw new StoreError('23514', 'session id must be a SHA-256 digest');
    },
    tenants: (row) => {
      if (!/^[a-z0-9-]{2,40}$/.test(String(row.slug))) throw new StoreError('23514', 'invalid tenant slug');
    },
    users: (row) => {
      if (String(row.email) !== String(row.email).toLowerCase()) throw new StoreError('23514', 'email must be lower-case');
    },
    access_requests: (row) => twoPeople(row),
  },
  beforeUpdate: {
    audit_log: forbid('audit_log', 'UPDATE'),
    access_requests: (_old, next) => twoPeople(next),
    skill_policies: (_old, next, db) => oneCurrentPolicy(next, db),
    proposals: (_old, next) => proposalChecks(next),
  },
  beforeDelete: {
    audit_log: forbid('audit_log', 'DELETE'),
  },
};

function oneCurrentPolicy(row: Record<string, unknown>, db: { find(t: string, w: Record<string, unknown>): Record<string, unknown>[] }) {
  if (!row.is_current) return;
  const others = db.find('skill_policies', { skill_id: row.skill_id, is_current: true }).filter((r) => r.id !== row.id && (r.scope_entity_id ?? '*') === (row.scope_entity_id ?? '*'));
  if (others.length) throw new StoreError('23505', 'duplicate key value violates unique constraint "skill_policies_one_current"');
}

function proposalChecks(row: Record<string, unknown>) {
  const c = Number(row.confidence);
  if (!(c >= 0 && c <= 1)) throw new StoreError('23514', 'AX-AGT-01: confidence must be between 0 and 1');
  if (String(row.why ?? '').length < 12) throw new StoreError('23514', 'AX-AGT-01: proposal needs a plain-English why');
  if (Number(row.amount_minor) < 0) throw new StoreError('23514', 'proposal amount must be non-negative');
  if (row.status === 'rejected' && !row.decision_reason) throw new StoreError('23514', 'a rejection needs a reason');
  if (row.decided_by && row.decided_by === row.prepared_by) throw new StoreError('23514', 'AX-SOD-01: a proposal cannot be decided by its preparer');
}

/** migrations/0012: an access request is never decided by its requester, nor by the person it is for. */
function twoPeople(row: Record<string, unknown>) {
  if (row.decided_by && row.decided_by === row.requested_by) throw new StoreError('23514', 'new row for relation "access_requests" violates check constraint: decided by its requester');
  if (row.decided_by && row.subject_user_id && row.decided_by === row.subject_user_id) throw new StoreError('23514', 'new row for relation "access_requests" violates check constraint: decided by the person it grants access to');
  if (row.status === 'approved' && !row.decided_by) throw new StoreError('23514', 'new row for relation "access_requests" violates check constraint: approved without an approver');
}
