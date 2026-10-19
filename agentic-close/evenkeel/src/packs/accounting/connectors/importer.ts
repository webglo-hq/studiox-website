import { AppError } from '../../../framework/util/errors';
import { periodOf as periodKeyOf } from '../../../framework/util/dates';
import { normalize } from '../../../framework/util/text';
import { sha256Hex } from '../../../framework/util/sha256';
import { audit } from '../domain/audit';
import { requirePermission, withDb, type ServiceContext } from '../domain/context';
import { createAndPost } from '../domain/ledger';
import { accountByCode, accounts, departmentByCode, dimensionValues, entityByCode, entityById } from '../domain/refdata';
import { detectBankFormat, parseBai2, parseBankCsv, parseCamt053, parseOfx, type ParsedBankStatement } from './bank-formats';
import { parseBillsCsv, parseCardCsv, parseErpGlJson, parsePayrollCsv } from './records';

export const CONNECTOR_CATALOG = {
  bank_bai2: { label: 'Bank statement (BAI2)', description: 'Cash management balance report, BAI version 2 — common with US banks.', system: 'Bank feed' },
  bank_camt053: { label: 'Bank statement (ISO 20022 camt.053)', description: 'XML BankToCustomerStatement — standard across UK/EU banks.', system: 'Bank feed' },
  bank_ofx: { label: 'Bank statement (OFX)', description: 'Open Financial Exchange download (OFX 1.x SGML or 2.x XML).', system: 'Bank feed' },
  bank_csv: { label: 'Bank statement (CSV)', description: 'date, description, amount[, reference] columns.', system: 'Bank feed' },
  card_csv: { label: 'Corporate card feed', description: 'Card transactions with merchant, MCC, cardholder and suggested coding.', system: 'Card program' },
  ap_bills_csv: { label: 'AP bills', description: 'Vendor bills from the AP system; posts the AP subledger entry.', system: 'AP' },
  ar_invoices_csv: { label: 'AR invoices', description: 'Customer invoices from billing.', system: 'AR' },
  payroll_csv: { label: 'Payroll register', description: 'Pay run totals by department from the payroll provider.', system: 'Payroll' },
  gl_journal_csv: { label: 'GL journal (CSV)', description: 'Journal lines exported from another ledger.', system: 'ERP / GL' },
  erp_gl_json: { label: 'Legacy ERP GL export', description: 'Manual journal entries from the legacy ERP (JSON), incl. preparer/approver.', system: 'ERP / GL' },
} as const;

export interface ImportResult {
  status: 'imported' | 'duplicate_file';
  batchId: string;
  documentId: string;
  created: number;
  duplicates: number;
  errors: { line: string; message: string }[];
  warnings: string[];
}

const MAX_BYTES = 5 * 1024 * 1024;

function mediaTypeFor(filename: string): string {
  if (/\.xml$/i.test(filename)) return 'application/xml';
  if (/\.json$/i.test(filename)) return 'application/json';
  if (/\.(ofx|qfx)$/i.test(filename)) return 'application/x-ofx';
  if (/\.csv$/i.test(filename)) return 'text/csv';
  return 'text/plain';
}

/**
 * Idempotent import of one source document. The same bytes never import twice (content
 * hash), the same record never imports twice (per-record dedupe hash), and every created
 * record links back to its source document, batch and line.
 */
export async function importDocument(ctx: ServiceContext, input: { connectorId: string; filename: string; content: string }): Promise<ImportResult> {
  requirePermission(ctx, 'integration.import');
  if (input.content.length > MAX_BYTES) throw new AppError('VALIDATION', 'File is larger than 5 MB.');
  const connector = await ctx.db.get('connector', input.connectorId);
  if (!connector || connector.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Connector not found');
  const sha = sha256Hex(input.content);
  const existing = await ctx.db.findOne('source_document', { tenant_id: ctx.tenantId, sha256: sha });
  if (existing) {
    const batch = await ctx.db.findOne('import_batch', { source_document_id: existing.id });
    return { status: 'duplicate_file', batchId: batch?.id ?? '', documentId: existing.id, created: 0, duplicates: existing.record_count, errors: [], warnings: ['This exact file was already imported; nothing changed.'] };
  }
  return ctx.db.tx(async (db) => {
    const tctx = withDb(ctx, db);
    const doc = await db.insert('source_document', {
      tenant_id: ctx.tenantId,
      connector_id: connector.id,
      filename: input.filename.slice(0, 200),
      media_type: mediaTypeFor(input.filename),
      sha256: sha,
      size_bytes: new TextEncoder().encode(input.content).length,
      content: input.content,
      received_at: ctx.clock.nowIso(),
      received_by: ctx.actor.userId,
      parse_status: 'pending',
    });
    const batch = await db.insert('import_batch', {
      tenant_id: ctx.tenantId,
      connector_id: connector.id,
      source_document_id: doc.id,
      status: 'running',
      idempotency_key: `${connector.id}:${sha}`,
      started_at: ctx.clock.nowIso(),
      started_by: ctx.actor.userId,
    });
    const res: ImportResult = { status: 'imported', batchId: batch.id, documentId: doc.id, created: 0, duplicates: 0, errors: [], warnings: [] };
    try {
      switch (connector.kind) {
        case 'bank_bai2':
        case 'bank_camt053':
        case 'bank_ofx':
        case 'bank_csv':
          await ingestBank(tctx, connector, doc.id, batch.id, input.content, res);
          break;
        case 'card_csv':
          await ingestCards(tctx, connector, doc.id, batch.id, input.content, res);
          break;
        case 'ap_bills_csv':
          await ingestBills(tctx, connector, doc.id, batch.id, input.content, res);
          break;
        case 'payroll_csv':
          await ingestPayroll(tctx, connector, doc.id, batch.id, input.content, res);
          break;
        case 'erp_gl_json':
          await ingestErp(tctx, doc.id, input.content, res);
          break;
        default:
          throw new AppError('VALIDATION', `Importing ${connector.kind} files is not enabled for this workspace yet.`);
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('VALIDATION', `Could not read ${input.filename}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await db.update('import_batch', batch.id, {
      status: 'completed',
      created_count: res.created,
      duplicate_count: res.duplicates,
      error_count: res.errors.length,
      errors: res.errors,
      finished_at: ctx.clock.nowIso(),
    });
    await db.update('source_document', doc.id, { parse_status: 'parsed', record_count: res.created + res.duplicates });
    await db.update('connector', connector.id, { last_sync_at: ctx.clock.nowIso() });
    await audit(tctx, { action: 'integration.imported', subjectType: 'source_document', subjectId: doc.id, data: { connector: connector.name, filename: input.filename, sha256: sha, created: res.created, duplicates: res.duplicates, errors: res.errors.length } });
    return res;
  });
}

type ConnectorRow = NonNullable<Awaited<ReturnType<ServiceContext['db']['get']>>> & { id: string };

async function ingestBank(ctx: ServiceContext, connector: { id: string; kind: string; bank_account_id: string | null; config: Record<string, unknown> }, docId: string, batchId: string, content: string, res: ImportResult): Promise<void> {
  if (!connector.bank_account_id) throw new AppError('VALIDATION', 'This bank connector is not linked to a bank account.');
  const bankAccount = await ctx.db.get('bank_account', connector.bank_account_id);
  if (!bankAccount) throw new AppError('NOT_FOUND', 'Bank account not found');
  const fmt = connector.kind === 'bank_bai2' ? 'BAI2' : connector.kind === 'bank_camt053' ? 'CAMT053' : connector.kind === 'bank_ofx' ? 'OFX' : detectBankFormat(content);
  let stmts: ParsedBankStatement[];
  if (fmt === 'BAI2') stmts = parseBai2(content);
  else if (fmt === 'CAMT053') stmts = parseCamt053(content);
  else if (fmt === 'OFX') stmts = parseOfx(content);
  else stmts = parseBankCsv(content, bankAccount.account_mask, bankAccount.currency);
  for (const st of stmts) {
    res.warnings.push(...st.warnings);
    if (st.currency !== bankAccount.currency) res.warnings.push(`Statement currency ${st.currency} differs from account currency ${bankAccount.currency}.`);
    let statementId: string | null = null;
    if (st.closingBalance !== null && st.statementEnd) {
      const existing = await ctx.db.findOne('bank_statement', { bank_account_id: bankAccount.id, statement_end: st.statementEnd });
      if (existing) statementId = existing.id;
      else {
        const opening = st.openingBalance ?? st.closingBalance - st.lines.reduce((s, l) => s + l.amount, 0);
        const row = await ctx.db.insert('bank_statement', {
          tenant_id: ctx.tenantId,
          bank_account_id: bankAccount.id,
          period_key: periodKeyOf(st.statementEnd),
          statement_start: st.statementStart,
          statement_end: st.statementEnd,
          opening_balance: opening,
          closing_balance: st.closingBalance,
          source_document_id: docId,
          import_batch_id: batchId,
          created_at: ctx.clock.nowIso(),
        });
        statementId = row.id;
      }
    }
    const seen = new Map<string, number>();
    for (const l of st.lines) {
      const base = `${bankAccount.id}|${l.postedDate}|${l.amount}|${l.externalId ?? ''}|${normalize(l.description)}`;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      const hash = sha256Hex(`${base}|${occurrence}`);
      const dup = await ctx.db.findOne('bank_transaction', { tenant_id: ctx.tenantId, bank_account_id: bankAccount.id, dedupe_hash: hash });
      if (dup) {
        res.duplicates++;
        continue;
      }
      if (l.amount === 0) {
        res.errors.push({ line: l.sourceLine, message: 'zero-amount line skipped' });
        continue;
      }
      await ctx.db.insert('bank_transaction', {
        tenant_id: ctx.tenantId,
        bank_account_id: bankAccount.id,
        statement_id: statementId,
        posted_date: l.postedDate,
        value_date: l.valueDate,
        amount: l.amount,
        description: l.description.slice(0, 500),
        reference: l.reference?.slice(0, 120) ?? null,
        counterparty: l.counterparty?.slice(0, 200) ?? null,
        type_code: l.typeCode,
        external_id: l.externalId,
        status: 'unmatched',
        dedupe_hash: hash,
        source_document_id: docId,
        import_batch_id: batchId,
        source_line: l.sourceLine,
        created_at: ctx.clock.nowIso(),
      });
      res.created++;
    }
  }
}

async function ingestCards(ctx: ServiceContext, connector: { entity_id: string | null }, docId: string, batchId: string, content: string, res: ImportResult): Promise<void> {
  if (!connector.entity_id) throw new AppError('VALIDATION', 'Card connector has no entity.');
  const records = parseCardCsv(content);
  const users = await ctx.db.find('app_user', { tenant_id: ctx.tenantId });
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
  const acctMap = await accounts(ctx);
  const byCode = new Map([...acctMap.values()].map((a) => [a.code, a]));
  const depts = await dimensionValues(ctx, 'department');
  const employees = await ctx.db.find('dimension_value', { tenant_id: ctx.tenantId });
  void employees;
  for (const r of records) {
    const hash = sha256Hex(`card|${connector.entity_id}|${r.externalId}`);
    if (await ctx.db.findOne('card_transaction', { tenant_id: ctx.tenantId, dedupe_hash: hash })) {
      res.duplicates++;
      continue;
    }
    const user = byEmail.get(r.cardholderEmail);
    const suggested = r.suggestedAccount ? byCode.get(r.suggestedAccount.split(' ')[0]!) : undefined;
    const deptFromCfg = (cardholder: string) => depts.find((d) => cardholder.toLowerCase().includes(d.code.toLowerCase()));
    const cardholderDept = user?.department_id ?? deptFromCfg(r.cardholder)?.id ?? null;
    await ctx.db.insert('card_transaction', {
      tenant_id: ctx.tenantId,
      entity_id: connector.entity_id,
      card_last4: /^\d{4}$/.test(r.cardLast4) ? r.cardLast4 : '0000',
      cardholder_name: r.cardholder.slice(0, 120),
      cardholder_user_id: user?.id ?? null,
      cardholder_department_id: cardholderDept,
      merchant_name: r.merchant.slice(0, 200),
      mcc: r.mcc && /^\d{4}$/.test(r.mcc) ? r.mcc : null,
      amount: r.amount,
      currency: r.currency,
      txn_date: r.txnDate,
      posted_date: r.postedDate,
      memo: r.memo?.slice(0, 500) ?? null,
      receipt_attached: r.receipt,
      status: suggested ? 'coded' : 'uncoded',
      account_id: suggested?.id ?? null,
      department_id: suggested ? cardholderDept : null,
      coding_source: suggested ? 'cardholder' : null,
      coding_confidence: null,
      external_id: r.externalId,
      dedupe_hash: hash,
      source_document_id: docId,
      import_batch_id: batchId,
      created_at: ctx.clock.nowIso(),
    });
    res.created++;
  }
}

async function ingestBills(ctx: ServiceContext, connector: { entity_id: string | null }, docId: string, batchId: string, content: string, res: ImportResult): Promise<void> {
  if (!connector.entity_id) throw new AppError('VALIDATION', 'AP connector has no entity.');
  const entity = await entityById(ctx, connector.entity_id);
  const records = parseBillsCsv(content);
  const ap = [...(await accounts(ctx)).values()].find((a) => a.subledger === 'ap');
  if (!ap) throw new AppError('VALIDATION', 'No AP control account configured.');
  for (const r of records) {
    const vendor = (await ctx.db.find('vendor', { tenant_id: ctx.tenantId })).find((v) => normalize(v.name) === normalize(r.vendor));
    if (!vendor) {
      res.errors.push({ line: r.sourceLine, message: `Unknown vendor "${r.vendor}" — create the vendor first (vendor master changes are SoD-controlled).` });
      continue;
    }
    if (await ctx.db.findOne('bill', { tenant_id: ctx.tenantId, vendor_id: vendor.id, bill_number: r.billNumber })) {
      res.duplicates++;
      continue;
    }
    const account = r.accountCode ? await accountByCode(ctx, r.accountCode) : vendor.default_account_id ? (await accounts(ctx)).get(vendor.default_account_id) : undefined;
    if (!account) {
      res.errors.push({ line: r.sourceLine, message: 'No expense account on the bill or vendor.' });
      continue;
    }
    const dept = r.department ? await departmentByCode(ctx, r.department).catch(() => null) : null;
    const po = r.poNumber ? await ctx.db.findOne('purchase_order', { tenant_id: ctx.tenantId, po_number: r.poNumber }) : null;
    const bill = await ctx.db.insert('bill', {
      tenant_id: ctx.tenantId,
      entity_id: entity.id,
      vendor_id: vendor.id,
      bill_number: r.billNumber,
      bill_date: r.billDate,
      due_date: r.dueDate,
      received_date: r.billDate,
      amount: r.amount,
      currency: r.currency,
      status: 'open',
      service_start: r.serviceStart,
      service_end: r.serviceEnd,
      po_id: po?.id ?? null,
      account_id: account.id,
      department_id: dept?.id ?? vendor.default_department_id,
      memo: r.memo,
      source_document_id: docId,
      import_batch_id: batchId,
      created_at: ctx.clock.nowIso(),
    });
    const je = await createAndPost(
      ctx,
      {
        entityId: entity.id,
        entryDate: r.billDate,
        periodKey: periodKeyOf(r.billDate),
        entryType: 'standard',
        memo: `Bill ${r.billNumber} — ${vendor.name}`,
        currency: entity.functional_currency,
        lines: [
          { accountId: account.id, debit: r.amount, credit: 0, departmentId: dept?.id ?? vendor.default_department_id, sourceRef: { type: 'bill', id: bill.id } },
          { accountId: ap.id, debit: 0, credit: r.amount, sourceRef: { type: 'bill', id: bill.id } },
        ],
      },
      { source: 'subledger', sourceRef: { bill: bill.id, document: docId }, approvalPolicy: 'subledger:ap' },
    );
    await ctx.db.update('bill', bill.id, { journal_entry_id: je.id });
    res.created++;
  }
}

async function ingestPayroll(ctx: ServiceContext, connector: { entity_id: string | null }, docId: string, batchId: string, content: string, res: ImportResult): Promise<void> {
  if (!connector.entity_id) throw new AppError('VALIDATION', 'Payroll connector has no entity.');
  const entity = await entityById(ctx, connector.entity_id);
  const rows = parsePayrollCsv(content);
  const byRun = new Map<string, typeof rows>();
  for (const r of rows) byRun.set(`${r.payDate}|${r.periodStart}|${r.periodEnd}`, [...(byRun.get(`${r.payDate}|${r.periodStart}|${r.periodEnd}`) ?? []), r]);
  const wages = await accountByCode(ctx, '6000');
  const taxes = await accountByCode(ctx, '6010');
  const benefits = await accountByCode(ctx, '6020');
  const cashPayroll = await accountByCode(ctx, entity.code === 'US' ? '1010' : '1050');
  const taxPayable = await accountByCode(ctx, '2120');
  for (const [, run] of byRun) {
    const first = run[0]!;
    const exists = await ctx.db.findOne('payroll_run', { tenant_id: ctx.tenantId, entity_id: entity.id, pay_date: first.payDate, period_start: first.periodStart });
    if (exists) {
      res.duplicates += run.length;
      continue;
    }
    const sum = (k: 'grossWages' | 'employerTaxes' | 'benefits' | 'withholdings' | 'netPay') => run.reduce((s, r) => s + r[k], 0);
    const pr = await ctx.db.insert('payroll_run', {
      tenant_id: ctx.tenantId,
      entity_id: entity.id,
      provider: 'Paywell (fictional)',
      pay_date: first.payDate,
      period_start: first.periodStart,
      period_end: first.periodEnd,
      gross_wages: sum('grossWages'),
      employer_taxes: sum('employerTaxes'),
      benefits: sum('benefits'),
      withholdings: sum('withholdings'),
      net_pay: sum('netPay'),
      source_document_id: docId,
      import_batch_id: batchId,
      created_at: ctx.clock.nowIso(),
    });
    const lines = [];
    for (const r of run) {
      const dept = await departmentByCode(ctx, r.department);
      await ctx.db.insert('payroll_line', { tenant_id: ctx.tenantId, payroll_run_id: pr.id, department_id: dept.id, gross_wages: r.grossWages, employer_taxes: r.employerTaxes, benefits: r.benefits, headcount: r.headcount });
      lines.push({ accountId: wages.id, debit: r.grossWages, credit: 0, departmentId: dept.id, sourceRef: { type: 'payroll_run', id: pr.id } });
      lines.push({ accountId: taxes.id, debit: r.employerTaxes, credit: 0, departmentId: dept.id, sourceRef: { type: 'payroll_run', id: pr.id } });
      lines.push({ accountId: benefits.id, debit: r.benefits, credit: 0, departmentId: dept.id, sourceRef: { type: 'payroll_run', id: pr.id } });
    }
    lines.push({ accountId: cashPayroll.id, debit: 0, credit: sum('netPay'), departmentId: null, sourceRef: { type: 'payroll_run', id: pr.id } });
    lines.push({ accountId: taxPayable.id, debit: 0, credit: sum('withholdings') + sum('employerTaxes') + sum('benefits'), departmentId: null, sourceRef: { type: 'payroll_run', id: pr.id } });
    const je = await createAndPost(
      ctx,
      { entityId: entity.id, entryDate: first.payDate, periodKey: periodKeyOf(first.payDate), entryType: 'standard', memo: `Payroll ${first.periodStart} – ${first.periodEnd} (paid ${first.payDate})`, currency: entity.functional_currency, lines },
      { source: 'subledger', sourceRef: { payroll_run: pr.id, document: docId }, approvalPolicy: 'subledger:payroll' },
    );
    await ctx.db.update('payroll_run', pr.id, { journal_entry_id: je.id });
    res.created += run.length;
  }
}

async function ingestErp(ctx: ServiceContext, docId: string, content: string, res: ImportResult): Promise<void> {
  const exp = parseErpGlJson(content);
  for (const [i, e] of exp.entries.entries()) {
    const key = `erp:${e.erp_id}`;
    if (await ctx.db.findOne('journal_entry', { idempotency_key: key })) {
      res.duplicates++;
      continue;
    }
    try {
      const entity = await entityByCode(ctx, e.entity);
      const lines = [];
      for (const l of e.lines) {
        const acct = await accountByCode(ctx, l.account);
        const dept = l.department ? await departmentByCode(ctx, l.department) : null;
        lines.push({ accountId: acct.id, debit: l.debit, credit: l.credit, departmentId: dept?.id ?? null, memo: l.memo ?? undefined });
      }
      await createAndPost(
        ctx,
        { entityId: entity.id, entryDate: e.date, periodKey: periodKeyOf(e.date), entryType: e.type, memo: `${e.memo} [${e.erp_id}]`, currency: entity.functional_currency, lines },
        {
          source: 'import',
          idempotencyKey: key,
          sourceRef: { erp_id: e.erp_id, document: docId, system: exp.source },
          externalPreparer: e.prepared_by,
          externalApprover: e.approved_by,
          externalPostedAt: e.posted_at ? new Date(e.posted_at).toISOString() : null,
          approvalPolicy: `erp-import:${exp.source}`,
          skipAxioms: ['AX-ACC-04'],
        },
      );
      res.created++;
    } catch (err) {
      res.errors.push({ line: `entries[${i}] ${e.erp_id}`, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

export type { ConnectorRow };
