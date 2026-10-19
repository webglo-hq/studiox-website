import { CONNECTOR_CATALOG, importDocument } from '../connectors/importer';
import { canSeeEntity, requireEntity, requirePermission, type ServiceContext } from '../domain/context';
import { entities } from '../domain/refdata';
import { person } from './common';

/** Connectors, imported documents and file uploads (idempotent imports with provenance). */

export async function listConnectors(ctx: ServiceContext) {
  requirePermission(ctx, 'close.view');
  const rows = (await ctx.db.find('connector', { tenant_id: ctx.tenantId }, { orderBy: [['name', 'asc']] })).filter((c) => canSeeEntity(ctx, c.entity_id));
  const ents = await entities(ctx);
  const docs = await ctx.db.find('source_document', { tenant_id: ctx.tenantId }, { orderBy: [['received_at', 'desc']] });
  return rows.map((c) => ({
    id: c.id,
    kind: c.kind,
    name: c.name,
    status: c.status,
    entityCode: c.entity_id ? (ents.get(c.entity_id)?.code ?? null) : null,
    lastSyncAt: c.last_sync_at,
    catalog: CONNECTOR_CATALOG[c.kind as keyof typeof CONNECTOR_CATALOG] ?? null,
    documents: docs.filter((d) => d.connector_id === c.id).length,
  }));
}

export async function listDocuments(ctx: ServiceContext, f: { connectorId?: string; limit?: number }) {
  requirePermission(ctx, 'report.view');
  const visible = new Set((await ctx.db.find('connector', { tenant_id: ctx.tenantId })).filter((c) => canSeeEntity(ctx, c.entity_id)).map((c) => c.id));
  const rows = (await ctx.db.find('source_document', { tenant_id: ctx.tenantId, ...(f.connectorId ? { connector_id: f.connectorId } : {}) }, { orderBy: [['received_at', 'desc']], limit: Math.min(200, f.limit ?? 50) })).filter((d) => (d.connector_id ? visible.has(d.connector_id) : canSeeEntity(ctx, null)));
  const out = [];
  for (const d of rows) out.push({ id: d.id, filename: d.filename, mediaType: d.media_type, sha256: d.sha256, sizeBytes: d.size_bytes, receivedAt: d.received_at, receivedBy: (await person(ctx, d.received_by))?.name ?? null, status: d.parse_status, records: d.record_count });
  return out;
}

export async function uploadDocument(ctx: ServiceContext, input: { connectorId: string; filename: string; content: string }) {
  const connector = await ctx.db.get('connector', input.connectorId);
  if (connector && connector.tenant_id === ctx.tenantId) requireEntity(ctx, connector.entity_id);
  return importDocument(ctx, input);
}
