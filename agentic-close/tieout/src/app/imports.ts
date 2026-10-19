/**
 * Idempotent imports with provenance: the raw file is stored once (content hash), every record
 * keeps its source document and line, re-imports are recognised, and duplicate records (same
 * external id) are skipped. Bank memos are scanned for instruction-like text on the way in.
 */
import { scanText } from '../core/agent/injection';
import { audit } from '../core/audit/audit';
import { notFound, validation } from '../core/util/errors';
import { sha256Hex } from '../core/util/hash';
import type { ImportBatchRow } from '../schema';
import { adapter } from '../integrations/adapters';
import type { ImportError } from '../integrations/types';
import type { AppContext, RequestUser } from './context';
import { requirePermission } from './context';

const MAX_BYTES = 2_000_000;

export interface ImportOutcome {
  batch: ImportBatchRow;
  duplicateOfBatchId: string | null;
  created: number;
  skipped: number;
  errors: ImportError[];
}

export async function importFile(ctx: AppContext, u: RequestUser, connectorKey: string, filename: string, content: string): Promise<ImportOutcome> {
  requirePermission(u, 'import.run');
  if (typeof content !== 'string' || !content.length) throw validation('The file is empty.');
  const size = new TextEncoder().encode(content).length;
  if (size > MAX_BYTES) throw validation('Files are limited to 2 MB.');
  const safeName = String(filename ?? 'upload').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  return ctx.db.tx(u.tenantId, async (tx) => {
    const connector = await tx.findOne('connectors', { key: connectorKey });
    if (!connector) throw notFound('Connector', connectorKey);
    const ad = adapter(String(connector.config.adapter ?? `${connector.kind === 'bank_feed' ? 'bank' : connector.kind}:${connector.format}`));
    const now = ctx.clock.now().toISOString();
    const hash = sha256Hex(content);
    const existing = await tx.findOne('source_documents', { content_hash: hash });
    if (existing) {
      const prior = await tx.findOne('import_batches', { source_document_id: existing.id });
      const batch = await tx.insert('import_batches', { connector_id: connector.id, source_document_id: existing.id, status: 'duplicate', records_total: 0, records_created: 0, records_skipped: 0, records_failed: 0, errors: [{ line: null, message: `This exact file was already imported (${existing.filename}).` }], imported_by: u.actor.id, started_at: now, finished_at: now });
      await audit(tx, u.actor, ctx.clock, { action: 'import.duplicate', subjectType: 'import_batch', subjectId: batch.id, summary: `${safeName}: identical file already imported; nothing changed`, data: { sourceDocumentId: existing.id } }, u.ip);
      return { batch, duplicateOfBatchId: prior?.id ?? null, created: 0, skipped: 0, errors: batch.errors };
    }
    let parsed;
    try {
      parsed = ad.parse(content);
    } catch (e) {
      throw validation(`Could not read the file as ${ad.name}: ${(e as Error).message}`);
    }
    const doc = await tx.insert('source_documents', { connector_id: connector.id, kind: parsed.kind, filename: safeName, mime: ad.mime, content, content_hash: hash, size_bytes: size, received_at: now, uploaded_by: u.actor.id });
    const batch = await tx.insert('import_batches', { connector_id: connector.id, source_document_id: doc.id, status: 'processing', records_total: 0, records_created: 0, records_skipped: 0, records_failed: 0, errors: [], imported_by: u.actor.id, started_at: now, finished_at: null });
    let created = 0;
    let skipped = 0;
    let total = 0;
    const errors: ImportError[] = [];
    if (parsed.kind === 'bank_statement') {
      const st = parsed.statement;
      errors.push(...st.warnings);
      const accounts = await tx.find('bank_accounts', connector.entity_id ? { entity_id: connector.entity_id } : {});
      const ba = accounts.find((a) => st.accountNumber.endsWith(a.account_last4) || String(connector.config.bankLast4 ?? '') === a.account_last4) ?? accounts[0];
      if (!ba) throw validation('No bank account matches this statement.');
      for (const t of st.transactions) {
        total++;
        if (await tx.findOne('bank_transactions', { bank_account_id: ba.id, external_id: t.externalId })) {
          skipped++;
          continue;
        }
        await tx.insert('bank_transactions', { entity_id: ba.entity_id, bank_account_id: ba.id, txn_date: t.bookingDate, value_date: t.valueDate, amount_minor: t.amountMinor, currency: ba.currency, description: t.description.slice(0, 500), counterparty: t.counterparty, reference: t.reference, type_code: t.typeCode, status: 'unmatched', injection_suspected: scanText('description', t.description).length > 0, import_batch_id: batch.id, source_document_id: doc.id, source_line: t.sourceLine, external_id: t.externalId });
        created++;
      }
    } else if (parsed.kind === 'card_transactions') {
      errors.push(...parsed.warnings);
      const cards = await tx.find('cards', connector.entity_id ? { entity_id: connector.entity_id } : {});
      for (const t of parsed.transactions) {
        total++;
        const card = cards.find((c) => c.last4 === t.cardLast4);
        if (!card) {
          errors.push({ line: t.sourceLine, message: `No card ending ${t.cardLast4}` });
          continue;
        }
        if (await tx.findOne('card_transactions', { external_id: t.externalId })) {
          skipped++;
          continue;
        }
        await tx.insert('card_transactions', { entity_id: card.entity_id, card_id: card.id, txn_date: t.txnDate, post_date: t.postDate, merchant_name: t.merchantName.slice(0, 200), mcc: t.mcc, amount_minor: t.amountMinor, currency: t.currency, memo: t.memo, receipt_status: 'missing', account_id: null, department: null, location: null, product_class: null, project: null, coding_source: null, coding_confidence: null, status: 'pending_coding', journal_entry_id: null, import_batch_id: batch.id, source_document_id: doc.id, source_line: t.sourceLine, external_id: t.externalId });
        created++;
      }
    } else if (parsed.kind === 'bills') {
      errors.push(...parsed.warnings);
      const vendors = await tx.find('vendors', {});
      for (const b of parsed.bills) {
        total++;
        const v = vendors.find((x) => x.code === b.vendorCode);
        if (!v || !v.entity_id) {
          errors.push({ line: b.sourceLine, message: `Unknown vendor ${b.vendorCode}` });
          continue;
        }
        if (await tx.findOne('bills', { external_id: b.externalId })) {
          skipped++;
          continue;
        }
        const bill = await tx.insert('bills', { entity_id: v.entity_id, vendor_id: v.id, bill_number: b.billNumber, bill_date: b.billDate, due_date: b.dueDate, received_date: now.slice(0, 10), service_period_start: b.servicePeriodStart, service_period_end: b.servicePeriodEnd, currency: b.currency, total_minor: b.totalMinor, status: 'received', purchase_order_id: null, journal_entry_id: null, source_document_id: doc.id, import_batch_id: batch.id, external_id: b.externalId, description: b.description.slice(0, 300) });
        const accounts = await tx.find('accounts', {});
        let n = 0;
        for (const l of b.lines) {
          const acct = l.accountCode ? accounts.find((a) => a.code === l.accountCode) : undefined;
          await tx.insert('bill_lines', { bill_id: bill.id, line_no: ++n, description: l.description.slice(0, 300), amount_minor: l.amountMinor, account_id: acct?.id ?? null, department: l.department, location: null, product_class: null, project: null, coding_source: acct ? 'human' : null, coding_confidence: null });
        }
        created++;
      }
    } else {
      const n = parsed.kind === 'gl_lines' ? parsed.lines.length : parsed.runs.length;
      total = n;
      skipped = n;
      errors.push(...parsed.warnings, { line: null, message: `${n} ${parsed.kind === 'gl_lines' ? 'journal lines' : 'payroll runs'} validated and staged; posting from this connector is done through the journal workflow.` });
    }
    const finished = await tx.update('import_batches', batch.id, { status: 'completed', records_total: total, records_created: created, records_skipped: skipped, records_failed: errors.filter((e) => e.line !== null).length, errors: errors.slice(0, 200), finished_at: ctx.clock.now().toISOString() });
    await tx.update('connectors', connector.id, { last_import_at: now });
    await audit(tx, u.actor, ctx.clock, { action: 'import.complete', subjectType: 'import_batch', subjectId: batch.id, entityId: connector.entity_id, summary: `${safeName} via ${connector.name}: ${created} created, ${skipped} duplicates skipped`, data: { sourceDocumentId: doc.id, contentHash: hash } }, u.ip);
    return { batch: finished, duplicateOfBatchId: null, created, skipped, errors };
  });
}
