import { appendAudit } from '../audit/audit';
import { createAndPost } from '../packs/accounting/domain/ledger';
import type { LedgerLookups } from '../packs/accounting/domain/lookups';
import { postPayrollRun } from '../packs/accounting/domain/subledgers';
import type { Tx } from '../persistence/db';
import type { Row } from '../persistence/schema';
import type { DomainContext } from '../shared/context';
import { DomainError } from '../shared/errors';
import { sha256Hex } from '../shared/hash';
import { newId } from '../shared/ids';
import { adapter, detectAdapter, ImportParseError, type ParsedImport } from './adapters';
import { statementControlCheck } from './parsers/statement';

/**
 * Idempotent import pipeline.
 *   document  -> source_documents (deduplicated by SHA-256)
 *   batch     -> import_batches (idempotency key = sha256 + adapter; re-importing the same file is a no-op)
 *   records   -> target tables, each deduplicated by a natural key and stamped with provenance
 *                (source_document_id, import_batch_id, source_locator)
 */

export interface ImportRequest {
  adapterKey?: string;
  filename: string;
  content: string;
  mediaType?: string;
  connectorId?: string | null;
  /** Map a statement to a bank account explicitly (otherwise matched on the account number's last 4). */
  bankAccountId?: string | null;
  /** Payroll posting accounts (defaults resolved from the chart of accounts). */
  payrollCashAccountId?: string;
}

export interface ImportResult {
  batchId: string;
  sourceDocumentId: string;
  adapterKey: string;
  status: 'completed' | 'partial' | 'failed';
  total: number;
  created: number;
  duplicates: number;
  failed: number;
  errors: Array<{ locator: string; message: string }>;
  alreadyImported: boolean;
  summary: string;
}

const MAX_BYTES = 5 * 1024 * 1024;

export async function importDocument(tx: Tx, ctx: DomainContext, lookups: LedgerLookups, req: ImportRequest): Promise<ImportResult> {
  const bytes = new TextEncoder().encode(req.content);
  if (bytes.length > MAX_BYTES) throw new DomainError('VALIDATION', `File is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  const desc = req.adapterKey ? adapter(req.adapterKey) : detectAdapter(req.filename, req.content);
  if (!desc) throw new DomainError('VALIDATION', 'Could not recognize the file format; choose a connector type.');
  const sha = sha256Hex(bytes);
  const idempotencyKey = sha256Hex(`${sha}|${desc.key}|${ctx.tenantId}`);

  const existingBatch = await tx.findOne('import_batches', { idempotency_key: idempotencyKey });
  if (existingBatch) {
    return {
      batchId: existingBatch.id,
      sourceDocumentId: existingBatch.source_document_id,
      adapterKey: desc.key,
      status: existingBatch.status === 'running' ? 'failed' : existingBatch.status,
      total: existingBatch.records_total,
      created: 0,
      duplicates: existingBatch.records_total,
      failed: 0,
      errors: [],
      alreadyImported: true,
      summary: `${req.filename} was already imported on ${existingBatch.started_at.slice(0, 10)}; nothing changed.`,
    };
  }

  let doc = await tx.findOne('source_documents', { tenant_id: ctx.tenantId, sha256: sha });
  if (!doc) {
    doc = await tx.insert('source_documents', {
      tenant_id: ctx.tenantId,
      kind: desc.documentKind,
      filename: req.filename,
      media_type: req.mediaType ?? (desc.format === 'json' ? 'application/json' : desc.format === 'camt053' ? 'application/xml' : 'text/plain'),
      sha256: sha,
      size_bytes: bytes.length,
      content: bytes,
      text_content: req.content.length <= 200_000 ? req.content : null,
      connector_id: req.connectorId ?? null,
      uploaded_by: ctx.actor.userId,
      metadata: { adapter: desc.key, format: desc.format },
    });
  }

  let parsed: ParsedImport;
  try {
    parsed = desc.parse(req.content);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const locator = e instanceof ImportParseError ? (e.locator ?? 'file') : 'file';
    const failed = await tx.insert('import_batches', {
      tenant_id: ctx.tenantId,
      connector_id: req.connectorId ?? null,
      source_document_id: doc.id,
      format: desc.format,
      target: desc.kind,
      status: 'failed',
      finished_at: ctx.clock.now(),
      records_failed: 1,
      errors: [{ locator, message }],
      imported_by: ctx.actor.userId,
      idempotency_key: idempotencyKey,
    });
    return { batchId: failed.id, sourceDocumentId: doc.id, adapterKey: desc.key, status: 'failed', total: 0, created: 0, duplicates: 0, failed: 1, errors: [{ locator, message }], alreadyImported: false, summary: `Could not read ${req.filename}: ${message}` };
  }

  const batch = await tx.insert('import_batches', {
    tenant_id: ctx.tenantId,
    connector_id: req.connectorId ?? null,
    source_document_id: doc.id,
    format: desc.format,
    target: desc.kind,
    status: 'running',
    imported_by: ctx.actor.userId,
    idempotency_key: idempotencyKey,
  });

  const counts = { total: 0, created: 0, duplicates: 0, failed: 0 };
  const errors: Array<{ locator: string; message: string }> = [];
  const prov = { source_document_id: doc.id, import_batch_id: batch.id };

  if (parsed.kind === 'bank_feed') {
    const s = parsed.statement;
    const control = statementControlCheck(s);
    if (control) errors.push({ locator: 'statement', message: `control check failed: ${control}` });
    let bank: Row<'bank_accounts'> | null = req.bankAccountId ? await tx.get('bank_accounts', req.bankAccountId) : null;
    if (!bank) {
      const last4 = s.accountId.replace(/\s/g, '').slice(-4);
      bank = (await tx.find('bank_accounts', { tenant_id: ctx.tenantId, account_last4: last4 }))[0] ?? null;
    }
    if (!bank) throw new DomainError('VALIDATION', `No bank account matches statement account ...${s.accountId.slice(-4)}; map it on the connector first.`);
    if (bank.currency !== s.currency) errors.push({ locator: 'statement', message: `statement currency ${s.currency} differs from bank account currency ${bank.currency}` });
    let statement = await tx.findOne('bank_statements', { bank_account_id: bank.id, period_start: s.periodStart, period_end: s.periodEnd });
    if (!statement) {
      statement = await tx.insert('bank_statements', {
        tenant_id: ctx.tenantId,
        bank_account_id: bank.id,
        statement_date: s.statementDate || s.periodEnd,
        period_start: s.periodStart,
        period_end: s.periodEnd,
        opening_balance_minor: s.openingBalance ?? 0,
        closing_balance_minor: s.closingBalance ?? 0,
        currency: s.currency,
        ...prov,
        source_locator: s.format,
      });
    }
    const existing = new Set((await tx.find('bank_transactions', { bank_account_id: bank.id, booking_date: { between: [s.periodStart, s.periodEnd] } })).map((t) => t.dedupe_key));
    const rows = [];
    for (const l of s.lines) {
      counts.total++;
      const dedupe = sha256Hex(`${bank.id}|${l.bankReference}|${l.bookingDate}|${l.amount}`).slice(0, 40);
      if (existing.has(dedupe)) {
        counts.duplicates++;
        continue;
      }
      if (l.amount === 0) {
        counts.failed++;
        errors.push({ locator: l.locator, message: 'zero-amount line skipped' });
        continue;
      }
      existing.add(dedupe);
      rows.push({
        id: newId(),
        tenant_id: ctx.tenantId,
        entity_id: bank.entity_id,
        bank_account_id: bank.id,
        statement_id: statement.id,
        booking_date: l.bookingDate,
        value_date: l.valueDate,
        amount_minor: l.amount,
        currency: s.currency,
        description: l.description,
        counterparty: l.counterparty,
        reference: l.reference,
        bank_reference: l.bankReference,
        type_code: l.typeCode,
        dedupe_key: dedupe,
        ...prov,
        source_locator: l.locator,
      });
    }
    await tx.insertMany('bank_transactions', rows);
    counts.created += rows.length;
  } else if (parsed.kind === 'card_feed') {
    const cards = await tx.find('cards', { tenant_id: ctx.tenantId });
    const rows = [];
    for (const l of parsed.lines) {
      counts.total++;
      const card = cards.find((c) => c.last4 === l.cardLast4);
      if (!card) {
        counts.failed++;
        errors.push({ locator: l.locator, message: `no card ending ${l.cardLast4}` });
        continue;
      }
      if (await tx.findOne('card_transactions', { card_id: card.id, external_id: l.externalId })) {
        counts.duplicates++;
        continue;
      }
      rows.push({
        tenant_id: ctx.tenantId,
        entity_id: card.entity_id,
        card_id: card.id,
        transaction_date: l.transactionDate,
        posted_date: l.postedDate,
        merchant_name: l.merchant,
        mcc: l.mcc,
        amount_minor: l.amount,
        currency: l.currency,
        memo: l.memo,
        external_id: l.externalId,
        import_batch_id: batch.id,
        source_locator: l.locator,
      });
    }
    await tx.insertMany('card_transactions', rows);
    counts.created += rows.length;
  } else if (parsed.kind === 'erp_gl') {
    for (const j of parsed.journals) {
      counts.total++;
      const key = `erp:${j.externalRef}`;
      if (await tx.findOne('journal_entries', { idempotency_key: key })) {
        counts.duplicates++;
        continue;
      }
      try {
        await createAndPost(
          tx,
          ctx,
          lookups,
          {
            entity: j.entityCode,
            date: j.date,
            type: (['standard', 'adjusting', 'accrual', 'reclass'].includes(j.type) ? j.type : 'standard') as 'standard',
            description: j.description,
            lines: j.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, department: l.department, memo: l.memo })),
          },
          {
            source: 'import',
            sourceModule: 'gl',
            externalRef: j.externalRef,
            externalPreparedBy: j.preparedBy,
            externalApprovedBy: j.approvedBy,
            idempotencyKey: key,
            sourceDocumentId: doc.id,
            importBatchId: batch.id,
            sourceLocator: j.locator,
          },
          { basis: 'import' },
        );
        counts.created++;
      } catch (e) {
        counts.failed++;
        errors.push({ locator: j.locator, message: e instanceof Error ? e.message : String(e) });
      }
    }
  } else if (parsed.kind === 'payroll') {
    const wages = lookups.accountsBySubtype('bh:SalariesAndWages')[0];
    const taxes = lookups.accountsBySubtype('bh:PayrollTaxExpense')[0];
    const benefits = lookups.accountsBySubtype('bh:EmployeeBenefits')[0];
    const liabilities = lookups.accountsBySubtype('bh:PayrollLiabilities')[0];
    if (!wages || !taxes || !benefits || !liabilities) throw new DomainError('INVARIANT', 'payroll accounts are not configured');
    for (const r of parsed.runs) {
      counts.total++;
      const entity = lookups.entity(r.entityCode);
      if (!entity) {
        counts.failed++;
        errors.push({ locator: r.locator, message: `unknown entity ${r.entityCode}` });
        continue;
      }
      if (await tx.findOne('payroll_runs', { entity_id: entity.id, provider: parsed.provider, external_id: r.externalId })) {
        counts.duplicates++;
        continue;
      }
      const cashAccount = req.payrollCashAccountId ?? (await tx.find('bank_accounts', { entity_id: entity.id }))[0]?.gl_account_id;
      if (!cashAccount) throw new DomainError('INVARIANT', 'no bank account for payroll');
      const run = await tx.insert('payroll_runs', {
        tenant_id: ctx.tenantId,
        entity_id: entity.id,
        provider: parsed.provider,
        external_id: r.externalId,
        pay_period_start: r.periodStart,
        pay_period_end: r.periodEnd,
        pay_date: r.payDate,
        currency: r.currency,
        gross_minor: r.gross,
        employer_tax_minor: r.employerTaxes,
        benefits_minor: r.benefits,
        withholding_minor: r.withholdings,
        net_pay_minor: r.net,
        headcount: r.headcount,
        source_document_id: doc.id,
        import_batch_id: batch.id,
      });
      const lines = [];
      for (const d of r.departments) {
        const dept = lookups.departments.get(d.code);
        lines.push(
          { tenant_id: ctx.tenantId, payroll_run_id: run.id, department_id: dept?.id ?? null, category: 'wages' as const, amount_minor: d.wages },
          { tenant_id: ctx.tenantId, payroll_run_id: run.id, department_id: dept?.id ?? null, category: 'employer_tax' as const, amount_minor: d.employerTaxes },
          { tenant_id: ctx.tenantId, payroll_run_id: run.id, department_id: dept?.id ?? null, category: 'benefits' as const, amount_minor: d.benefits },
        );
      }
      const saved = await tx.insertMany('payroll_lines', lines);
      await postPayrollRun(tx, ctx, lookups, run, saved, { wages: wages.id, taxes: taxes.id, benefits: benefits.id, liabilities: liabilities.id, cash: cashAccount }, { sourceLocator: r.locator });
      counts.created++;
    }
  } else if (parsed.kind === 'ap') {
    for (const b of parsed.bills) {
      counts.total++;
      errors.push({ locator: b.locator, message: 'AP bill import is staged for review in the AP inbox (not auto-posted).' });
    }
  }

  const status: ImportResult['status'] = counts.failed && !counts.created ? 'failed' : counts.failed || errors.length ? 'partial' : 'completed';
  await tx.update('import_batches', batch.id, {
    status,
    finished_at: ctx.clock.now(),
    records_total: counts.total,
    records_created: counts.created,
    records_duplicate: counts.duplicates,
    records_failed: counts.failed,
    errors: errors.slice(0, 200),
  });
  const summary = `${req.filename}: ${counts.created} created, ${counts.duplicates} duplicates skipped, ${counts.failed} failed.`;
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'import.completed', objectType: 'import_batch', objectId: batch.id, summary, details: { adapter: desc.key, sha256: sha, ...counts } }, ctx.clock.now());
  return { batchId: batch.id, sourceDocumentId: doc.id, adapterKey: desc.key, status, ...counts, errors, alreadyImported: false, summary };
}
