import { addMonths, periodEnd } from '../../../framework/util/dates';
import { AppError } from '../../../framework/util/errors';
import { formatMoney } from '../../../framework/util/money';
import { requirePermission, type ServiceContext } from '../domain/context';
import { ledgerLines } from '../domain/queries';
import { accounts, entities, entityByCode, fxRate } from '../domain/refdata';
import { consolidatedTrialBalance, trialBalance, validateTrialBalance, type Statement } from '../domain/reporting';
import { peopleMap } from './common';
import { statementsFor } from './package';

/** Trial balance, statements and drill-down from a statement line to the source record. */

async function scopeOf(ctx: ServiceContext, scope: string): Promise<{ kind: 'consolidated' } | { kind: 'entity'; entityId: string; code: string }> {
  if (scope === 'consolidated' || scope === 'CONSOLIDATED') return { kind: 'consolidated' };
  const e = await entityByCode(ctx, scope);
  return { kind: 'entity', entityId: e.id, code: e.code };
}

export async function trialBalanceView(ctx: ServiceContext, input: { scope: string; periodKey: string }) {
  requirePermission(ctx, 'report.view');
  const s = await scopeOf(ctx, input.scope);
  const tb = s.kind === 'consolidated' ? await consolidatedTrialBalance(ctx, input.periodKey) : await trialBalance(ctx, s.entityId, input.periodKey);
  const fs = new Map((await ctx.db.find('fs_line_item', { tenant_id: ctx.tenantId })).map((f) => [f.id, f]));
  const v = validateTrialBalance(tb);
  return {
    scope: input.scope,
    periodKey: input.periodKey,
    currency: tb.currency,
    rows: tb.rows.map((r) => ({ ...r, fsLine: fs.get(r.fsLineItemId)?.label ?? '', statement: fs.get(r.fsLineItemId)?.statement ?? '', natural: r.normalBalance === 'debit' ? r.net : -r.net })),
    totals: tb.totals,
    balanced: tb.balanced,
    axiom: { id: 'AX-DE-05', ok: v.ok, messages: v.violations.map((x) => x.message) },
    translation: tb.translation ?? null,
  };
}

export async function statementView(ctx: ServiceContext, input: { kind: 'BS' | 'IS'; scope: string; periodKey: string }): Promise<Statement & { comparisonLabel: string; scope: string }> {
  requirePermission(ctx, 'report.view');
  const s = await scopeOf(ctx, input.scope);
  const st = await statementsFor(ctx, s.kind === 'consolidated' ? 'consolidated' : s.entityId, input.periodKey);
  const out = input.kind === 'BS' ? st.bs : st.is;
  return { ...out, scope: input.scope, comparisonLabel: addMonths(input.periodKey, -1) };
}

export async function sourceLabel(ctx: ServiceContext, type: string, id: string): Promise<string> {
  switch (type) {
    case 'bill': {
      const b = await ctx.db.get('bill', id);
      if (!b) return 'Bill';
      const v = await ctx.db.get('vendor', b.vendor_id);
      return `Bill ${b.bill_number} · ${v?.name ?? ''}`;
    }
    case 'vendor_payment': {
      const p = await ctx.db.get('vendor_payment', id);
      return p ? `Payment ${p.method.toUpperCase()} ${p.reference}` : 'Vendor payment';
    }
    case 'invoice': {
      const i = await ctx.db.get('invoice', id);
      return i ? `Invoice ${i.invoice_number}` : 'Invoice';
    }
    case 'customer_receipt': {
      const r = await ctx.db.get('customer_receipt', id);
      return r ? `Receipt ${r.reference ?? ''}` : 'Receipt';
    }
    case 'card_transaction': {
      const c = await ctx.db.get('card_transaction', id);
      return c ? `Card ${c.card_last4} · ${c.merchant_name}` : 'Card transaction';
    }
    case 'payroll_run': {
      const p = await ctx.db.get('payroll_run', id);
      return p ? `Payroll ${p.period_start} – ${p.period_end}` : 'Payroll run';
    }
    case 'bank_transaction': {
      const t = await ctx.db.get('bank_transaction', id);
      return t ? `Bank ${t.posted_date} ${t.reference ?? ''}` : 'Bank transaction';
    }
    case 'prepaid_line':
    case 'prepaid_schedule': {
      const sid = type === 'prepaid_line' ? (await ctx.db.get('prepaid_line', id))?.schedule_id : id;
      const s = sid ? await ctx.db.get('prepaid_schedule', sid) : null;
      return s ? `Prepaid schedule · ${s.description.slice(0, 60)}` : 'Prepaid schedule';
    }
    case 'fixed_asset': {
      const a = await ctx.db.get('fixed_asset', id);
      return a ? `Asset ${a.tag} · ${a.name}` : 'Fixed asset';
    }
    default:
      return type.replace(/_/g, ' ');
  }
}

/** Drill-down: every posted line on an account for a period (entity or consolidated). */
export async function accountActivity(ctx: ServiceContext, input: { accountId: string; scope: string; periodKey: string; ytd?: boolean; limit?: number }) {
  requirePermission(ctx, 'report.view');
  const s = await scopeOf(ctx, input.scope);
  const acct = (await accounts(ctx)).get(input.accountId);
  if (!acct) throw new AppError('NOT_FOUND', 'Account not found');
  const ents = await entities(ctx);
  const entityIds = s.kind === 'consolidated' ? [...ents.values()].map((e) => e.id) : [s.entityId];
  const from = input.ytd ? `${input.periodKey.slice(0, 4)}-01` : input.periodKey;
  const rows = await ctx.db.query(ledgerLines, { tenantId: ctx.tenantId, entityIds, accountIds: [input.accountId], periodFrom: from, periodTo: input.periodKey, limit: Math.min(1000, input.limit ?? 500) });
  const people = await peopleMap(ctx);
  const out = [];
  for (const r of rows) {
    out.push({
      lineId: r.lineId,
      entryId: r.entryId,
      entryNumber: r.entryNumber,
      entityCode: ents.get(r.entityId)?.code ?? '',
      date: r.entryDate,
      type: r.entryType,
      source: r.source,
      memo: r.lineMemo ?? r.memo,
      debit: r.debit,
      credit: r.credit,
      preparedBy: (r.preparedBy ? people.get(r.preparedBy)?.name : null) ?? r.externalPreparer,
      approvedBy: (r.approvedBy ? people.get(r.approvedBy)?.name : null) ?? r.externalApprover,
      record: r.sourceType && r.sourceId ? { type: r.sourceType, id: r.sourceId, label: await sourceLabel(ctx, r.sourceType, r.sourceId) } : null,
    });
  }
  const debit = out.reduce((x, l) => x + l.debit, 0);
  const credit = out.reduce((x, l) => x + l.credit, 0);
  return { account: { id: acct.id, code: acct.code, name: acct.name, normalBalance: acct.normal_balance, concept: acct.concept }, scope: input.scope, periodKey: input.periodKey, lines: out, totals: { debit, credit, net: debit - credit }, truncated: rows.length >= Math.min(1000, input.limit ?? 500) };
}

/** A source record (bill, card transaction, bank line…) with its document of origin. */
export async function sourceRecord(ctx: ServiceContext, input: { type: string; id: string }) {
  requirePermission(ctx, 'report.view');
  const allowed = ['bill', 'vendor_payment', 'invoice', 'customer_receipt', 'card_transaction', 'payroll_run', 'bank_transaction', 'prepaid_schedule', 'fixed_asset', 'purchase_order'] as const;
  if (!(allowed as readonly string[]).includes(input.type)) throw new AppError('VALIDATION', 'Unknown record type');
  const row = (await ctx.db.get(input.type as (typeof allowed)[number], input.id)) as Record<string, unknown> | null;
  if (!row || row.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Record not found');
  const docId = (row.source_document_id as string | null | undefined) ?? null;
  const doc = docId ? await ctx.db.get('source_document', docId) : null;
  const fields = Object.fromEntries(Object.entries(row).filter(([k]) => !['tenant_id', 'dedupe_hash'].includes(k)));
  return { type: input.type, id: input.id, label: await sourceLabel(ctx, input.type, input.id), fields, document: doc ? { id: doc.id, filename: doc.filename, mediaType: doc.media_type, sha256: doc.sha256, receivedAt: doc.received_at, line: (row.source_line as string | null | undefined) ?? null } : null };
}

export async function sourceDocument(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'report.view');
  const d = await ctx.db.get('source_document', id);
  if (!d || d.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Document not found');
  const connector = d.connector_id ? await ctx.db.get('connector', d.connector_id) : null;
  const batch = await ctx.db.findOne('import_batch', { source_document_id: d.id });
  const receiver = d.received_by ? await ctx.db.get('app_user', d.received_by) : null;
  const content = d.content ?? '';
  return {
    id: d.id,
    filename: d.filename,
    mediaType: d.media_type,
    sha256: d.sha256,
    sizeBytes: d.size_bytes,
    receivedAt: d.received_at,
    receivedBy: receiver?.display_name ?? null,
    connector: connector ? { name: connector.name, kind: connector.kind } : null,
    status: d.parse_status,
    records: d.record_count,
    batch: batch ? { created: batch.created_count, duplicates: batch.duplicate_count, errors: batch.errors } : null,
    content: content.length > 200_000 ? `${content.slice(0, 200_000)}\n… (truncated)` : content,
  };
}

/** Headline figures for the home screen (consolidated, reporting currency). */
export async function headline(ctx: ServiceContext, periodKey: string) {
  requirePermission(ctx, 'report.view');
  const st = await statementsFor(ctx, 'consolidated', periodKey);
  const sec = (n: string) => st.is.sections.find((x) => x.name === n);
  const ni = st.is.subtotals.find((x) => x.label === 'Net income');
  const cash = st.bs.sections.flatMap((x) => x.lines).find((l) => l.code === 'BS-CASH');
  const rate = await fxRate(ctx, 'GBP', 'USD', periodEnd(periodKey), 'closing').catch(() => null);
  return {
    currency: st.tb.currency,
    revenue: { current: sec('Revenue')?.total ?? 0, prior: sec('Revenue')?.comparisonTotal ?? 0 },
    netIncome: { current: ni?.amount ?? 0, prior: ni?.comparison ?? 0 },
    cash: { current: cash?.amount ?? 0, prior: cash?.comparison ?? 0 },
    gbpUsdClosing: rate,
    label: `${formatMoney(sec('Revenue')?.total ?? 0)} revenue`,
  };
}
