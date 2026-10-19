import { c, check, table } from '../dsl';

const AREA = 'Integration & documents';

export const connectors = table(
  'connectors',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    kind: c.enum(['bank_feed', 'erp_gl', 'card_feed', 'ap', 'ar', 'payroll'] as const),
    /** Adapter registry key (integrations/registry.ts). */
    adapter: c.text(),
    name: c.text(),
    entity_id: c.uuid().nullable().references('entities'),
    bank_account_id: c.uuid().nullable().references('bank_accounts'),
    /** Non-secret configuration; secrets are referenced by name, never stored here. */
    config: c.json<Record<string, unknown>>().default({}),
    status: c.enum(['active', 'paused', 'error'] as const).default('active'),
    last_sync_at: c.timestamp().nullable(),
    last_sync_status: c.text().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'A configured source system (bank feed, ERP export, card feed, payroll...).', ontologyClass: 'bh:Connector' },
);

export const sourceDocuments = table(
  'source_documents',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    kind: c.enum([
      'bank_statement',
      'card_feed',
      'erp_export',
      'ap_export',
      'ar_export',
      'payroll_report',
      'invoice',
      'receipt',
      'contract',
      'evidence',
      'close_package',
      'other',
    ] as const),
    filename: c.text(),
    media_type: c.text(),
    sha256: c.text(),
    size_bytes: c.int().check('>= 0', (v) => v >= 0),
    content: c.bytes().nullable(),
    /** Extracted text (untrusted data). */
    text_content: c.text().nullable(),
    storage_key: c.text().nullable(),
    connector_id: c.uuid().nullable().references('connectors'),
    uploaded_by: c.uuid().nullable().references('users', 'set null'),
    uploaded_at: c.timestamp().defaultNow(),
    metadata: c.json<Record<string, unknown>>().default({}),
  },
  {
    area: AREA,
    description: 'Immutable source document (file) identified by its SHA-256; every imported record links back to one.',
    ontologyClass: 'bh:SourceDocument',
    uniques: [['tenant_id', 'sha256']],
    checks: [check('doc_sha', "sha256 ~ '^[0-9a-f]{64}$'", (r) => /^[0-9a-f]{64}$/.test(String(r.sha256)), 'sha256 must be 64 hex chars')],
  },
);

export const importBatches = table(
  'import_batches',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    connector_id: c.uuid().nullable().references('connectors'),
    source_document_id: c.uuid().references('source_documents'),
    format: c.enum(['csv', 'bai2', 'camt053', 'ofx', 'json'] as const),
    target: c.text(),
    status: c.enum(['running', 'completed', 'partial', 'failed'] as const).default('running'),
    started_at: c.timestamp().defaultNow(),
    finished_at: c.timestamp().nullable(),
    records_total: c.int().default(0),
    records_created: c.int().default(0),
    records_duplicate: c.int().default(0),
    records_failed: c.int().default(0),
    errors: c.json<Array<{ locator: string; message: string }>>().default([]),
    imported_by: c.uuid().nullable().references('users', 'set null'),
    /** sha256(document) + target: re-importing the same file is a no-op. */
    idempotency_key: c.text().unique(),
  },
  { area: AREA, description: 'One import of one source document (idempotent; tracks created/duplicate/failed counts).', ontologyClass: 'bh:ImportBatch' },
);

export const attachments = table(
  'attachments',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    object_type: c.text(),
    object_id: c.uuid(),
    source_document_id: c.uuid().references('source_documents'),
    note: c.text().nullable(),
    attached_by: c.uuid().nullable().references('users', 'set null'),
    attached_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'Evidence attached to any object (rec, task, JE, proposal).', ontologyClass: 'bh:Evidence', indexes: [['object_type', 'object_id']] },
);

export const comments = table(
  'comments',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    object_type: c.text(),
    object_id: c.uuid(),
    author_id: c.uuid().references('users'),
    body: c.text().check('<> \'\'', (v) => v.trim().length > 0),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'Discussion on an object.',
    indexes: [['object_type', 'object_id']],
    checks: [check('comment_len', 'char_length(body) <= 4000', (r) => String(r.body).length <= 4000, 'comments are limited to 4000 characters')],
  },
);
