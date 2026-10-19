import { c, check, table } from '../dsl';

export const auditLog = table(
  'audit_log',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    /** Per-tenant contiguous sequence (1, 2, 3, ...). */
    seq: c.bigint().check('> 0', (v) => v > 0),
    occurred_at: c.timestamp(),
    actor_type: c.enum(['user', 'agent', 'system'] as const),
    actor_id: c.text().nullable(),
    actor_label: c.text(),
    action: c.text(),
    object_type: c.text(),
    object_id: c.text().nullable(),
    summary: c.text(),
    /** Canonical JSON of the whole event (the hashed material). */
    record: c.text(),
    prev_hash: c.text(),
    hash: c.text().unique(),
    request_id: c.text().nullable(),
    ip: c.text().nullable(),
  },
  {
    area: 'Audit',
    description:
      'Tamper-evident, append-only event log. hash = sha256(prev_hash || "\\n" || record); the database rejects UPDATE/DELETE and any insert that breaks the chain.',
    ontologyClass: 'bh:AuditEvent',
    appendOnly: true,
    uniques: [['tenant_id', 'seq']],
    indexes: [['tenant_id', 'object_type', 'object_id'], ['tenant_id', 'occurred_at']],
    checks: [
      check('audit_hash_format', "hash ~ '^[0-9a-f]{64}$' AND prev_hash ~ '^[0-9a-f]{64}$'", (r) => /^[0-9a-f]{64}$/.test(String(r.hash)) && /^[0-9a-f]{64}$/.test(String(r.prev_hash)), 'hashes must be 64 hex chars'),
    ],
  },
);
