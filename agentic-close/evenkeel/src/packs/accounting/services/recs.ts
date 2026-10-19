import type { Row } from '../../../framework/store/schema';
import { stableStringify } from '../../../framework/util/canonical';
import { addDays, addMonths, periodEnd, periodStart } from '../../../framework/util/dates';
import { formatMoney } from '../../../framework/util/money';
import { AppError } from '../../../framework/util/errors';
import { sha256Hex } from '../../../framework/util/sha256';
import { scanForInjection } from '../../../framework/util/text';
import { REC_TEMPLATE, type RecTemplate } from '../close/template';
import { audit } from '../domain/audit';
import { canSeeEntity, requireEntity, requirePermission, withDb, type ServiceContext } from '../domain/context';
import { accumulatedDepreciation, type AssetFact } from '../domain/schedule-math';
import { assertSod } from '../domain/rbac';
import { accountById, accounts, entities, entityById } from '../domain/refdata';
import { ReconcilingItemDraft } from '../ontology/shapes';
import type { EkSchema } from '../store';
import { ledgerBalance, periodLines } from './balances';
import { peopleMap, person, type PersonRef } from './common';

type RecRow = Row<EkSchema, 'reconciliation'>;
type ItemRow = Row<EkSchema, 'reconciling_item'>;

/**
 * Reconciliations: bank, subledger tie-outs, intercompany and balance substantiation.
 * Balances are stored in the account's natural sign. The identity every rec must satisfy:
 *   GL − comparison = Σ book-side items − Σ bank/comparison-side items   (+ unexplained)
 * A rec can be certified only when the unexplained amount is zero and nothing is pending.
 */

export interface RecSummary {
  id: string;
  title: string;
  entityId: string;
  entityCode: string;
  periodKey: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  recType: RecRow['rec_type'];
  subledger: RecTemplate['subledger'] | null;
  currency: string;
  glBalance: number;
  comparisonBalance: number;
  comparisonLabel: string;
  difference: number;
  explained: number;
  unexplained: number;
  status: RecRow['status'];
  risk: RecRow['risk'];
  tolerance: number;
  owner: PersonRef | null;
  reviewer: PersonRef | null;
  preparedBy: PersonRef | null;
  preparedAt: string | null;
  reviewedBy: PersonRef | null;
  reviewedAt: string | null;
  openItems: number;
  unmatchedBank: number;
  pendingProposals: number;
  taskCode: string | null;
  hasStatement: boolean;
}

function templateFor(rec: RecRow, acctCode: string, entityCode: string): RecTemplate | undefined {
  return REC_TEMPLATE.find((t) => t.account === acctCode && t.entity === entityCode && t.type === rec.rec_type);
}

const COMPARISON_LABEL: Record<string, string> = {
  bank: 'Bank statement',
  ap: 'Open vendor bills (AP subledger)',
  ar: 'Open customer invoices (AR subledger)',
  prepaid: 'Prepaid schedules',
  fixed_asset: 'Fixed asset register (cost)',
  accumulated_depreciation: 'Fixed asset register (accumulated depreciation)',
  intercompany: 'Counterparty balance (USD)',
};

interface Computed {
  gl: number;
  comparison: number;
  hasStatement: boolean;
}

async function computeBalances(ctx: ServiceContext, rec: RecRow): Promise<Computed> {
  const acct = await accountById(ctx, rec.account_id);
  const ent = await entityById(ctx, rec.entity_id);
  const tpl = templateFor(rec, acct.code, ent.code);
  const net = await ledgerBalance(ctx, rec.entity_id, rec.account_id, rec.period_key);
  const gl = acct.normal_balance === 'debit' ? net : -net;
  const pe = periodEnd(rec.period_key);
  if (rec.rec_type === 'bank') {
    const st = await ctx.db.findOne('bank_statement', { bank_account_id: rec.bank_account_id!, statement_end: pe });
    return { gl, comparison: st?.closing_balance ?? 0, hasStatement: !!st };
  }
  if (rec.rec_type === 'subledger' && tpl?.subledger === 'ap') {
    const bills = await ctx.db.find('bill', { tenant_id: ctx.tenantId, entity_id: rec.entity_id, bill_date: { lte: pe } });
    const pays = await ctx.db.find('vendor_payment', { tenant_id: ctx.tenantId, entity_id: rec.entity_id, payment_date: { lte: pe } });
    const paid = new Map<string, number>();
    for (const p of pays) if (p.bill_id && p.status !== 'void') paid.set(p.bill_id, (paid.get(p.bill_id) ?? 0) + p.amount);
    let open = 0;
    for (const b of bills) if (b.status !== 'void') open += Math.max(0, b.amount - (paid.get(b.id) ?? 0));
    return { gl, comparison: open, hasStatement: true };
  }
  if (rec.rec_type === 'subledger' && tpl?.subledger === 'ar') {
    const invs = await ctx.db.find('invoice', { tenant_id: ctx.tenantId, entity_id: rec.entity_id, invoice_date: { lte: pe } });
    const rcpts = await ctx.db.find('customer_receipt', { tenant_id: ctx.tenantId, entity_id: rec.entity_id, receipt_date: { lte: pe } });
    const got = new Map<string, number>();
    for (const r of rcpts) if (r.invoice_id) got.set(r.invoice_id, (got.get(r.invoice_id) ?? 0) + r.amount);
    let open = 0;
    for (const i of invs) if (i.status !== 'void') open += Math.max(0, i.amount - (got.get(i.id) ?? 0));
    return { gl, comparison: open, hasStatement: true };
  }
  if (rec.rec_type === 'intercompany' && rec.counterparty_entity_id) {
    // Counterparty's payable to this entity, measured in this entity's currency (transaction amounts).
    const accts = [...(await accounts(ctx)).values()].filter((a) => a.is_intercompany && a.account_class === 'liability');
    const lines = await ctx.db.find('journal_line', { tenant_id: ctx.tenantId, account_id: { in: accts.map((a) => a.id) }, counterparty_entity_id: rec.entity_id });
    const entries = new Map((await ctx.db.find('journal_entry', { tenant_id: ctx.tenantId, entity_id: rec.counterparty_entity_id, status: 'posted', period_key: { lte: rec.period_key } })).map((e) => [e.id, e]));
    let owed = 0;
    for (const l of lines) {
      if (!entries.has(l.journal_entry_id)) continue;
      owed += l.txn_currency === ent.functional_currency && l.txn_amount !== null ? -l.txn_amount : l.credit - l.debit;
    }
    return { gl, comparison: owed, hasStatement: true };
  }
  if (rec.rec_type === 'balance_substantiation' && tpl?.subledger === 'prepaid') {
    const schedules = await ctx.db.find('prepaid_schedule', { tenant_id: ctx.tenantId, entity_id: rec.entity_id, prepaid_account_id: rec.account_id });
    let remaining = 0;
    for (const s of schedules) {
      if (s.status === 'cancelled') continue;
      const lines = await ctx.db.find('prepaid_line', { schedule_id: s.id });
      remaining += s.total - lines.filter((l) => l.period_key <= rec.period_key).reduce((x, l) => x + l.amount, 0);
    }
    return { gl, comparison: remaining, hasStatement: true };
  }
  if (rec.rec_type === 'balance_substantiation' && (tpl?.subledger === 'fixed_asset' || tpl?.subledger === 'accumulated_depreciation')) {
    const assets = await ctx.db.find('fixed_asset', { tenant_id: ctx.tenantId, entity_id: rec.entity_id });
    if (tpl.subledger === 'fixed_asset') {
      const cost = assets.filter((a) => a.asset_account_id === rec.account_id && a.status !== 'disposed' && a.acquisition_date <= pe).reduce((s, a) => s + a.cost, 0);
      return { gl, comparison: cost, hasStatement: true };
    }
    const accum = assets
      .filter((a) => a.accum_depr_account_id === rec.account_id && a.status !== 'disposed')
      .reduce((s, a) => s + accumulatedDepreciation({ id: a.id, tag: a.tag, name: a.name, cost: a.cost, salvage: a.salvage, usefulLifeMonths: a.useful_life_months, inServiceDate: a.in_service_date, departmentId: a.department_id, status: a.status } as AssetFact, rec.period_key), 0);
    return { gl, comparison: accum, hasStatement: true };
  }
  return { gl, comparison: gl, hasStatement: true };
}

function explainedOf(items: ItemRow[]): { explained: number; unexplainedItems: number; unexplainedCount: number } {
  let explained = 0;
  let unexplainedItems = 0;
  let unexplainedCount = 0;
  for (const i of items) {
    if (i.status !== 'open') continue;
    const signed = i.side === 'book' ? i.amount : -i.amount;
    if (i.item_type === 'unexplained') {
      unexplainedItems += signed;
      unexplainedCount++;
    } else explained += signed;
  }
  return { explained, unexplainedItems, unexplainedCount };
}

/** Recompute balances and the unexplained difference. Certified recs are never modified. */
export async function refreshRec(ctx: ServiceContext, recId: string): Promise<RecRow> {
  const rec = await ctx.db.get('reconciliation', recId);
  if (!rec || rec.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Reconciliation not found');
  if (rec.status === 'prepared' || rec.status === 'reviewed') return rec;
  const c = await computeBalances(ctx, rec);
  const items = await ctx.db.find('reconciling_item', { reconciliation_id: rec.id });
  const { explained, unexplainedCount } = explainedOf(items);
  const diff = c.gl - c.comparison;
  let unexplained = diff - explained;
  if (unexplainedCount === 0 && Math.abs(unexplained) <= rec.tolerance) unexplained = 0;
  if (!c.hasStatement) unexplained = diff === 0 ? 0 : diff;
  const patch: Partial<RecRow> = { gl_balance: c.gl, comparison_balance: c.comparison, reconciling_total: explained, unexplained, updated_at: ctx.clock.nowIso() };
  const touched = items.length > 0 || (await ctx.db.count('rec_match', { reconciliation_id: rec.id })) > 0;
  if (rec.status === 'not_started' && touched) patch.status = 'in_progress';
  return ctx.db.update('reconciliation', rec.id, patch);
}

export async function refreshRecsForPeriod(ctx: ServiceContext, periodKey: string): Promise<void> {
  const recs = await ctx.db.find('reconciliation', { tenant_id: ctx.tenantId, period_key: periodKey });
  for (const r of recs) await refreshRec(ctx, r.id);
}

/** Current numbers for a rec without writing (certified recs keep their signed numbers). */
export async function live(ctx: ServiceContext, rec: RecRow): Promise<RecRow> {
  if (rec.status === 'prepared' || rec.status === 'reviewed') return rec;
  const c = await computeBalances(ctx, rec);
  const items = await ctx.db.find('reconciling_item', { reconciliation_id: rec.id });
  const { explained, unexplainedCount } = explainedOf(items);
  const diff = c.gl - c.comparison;
  let unexplained = diff - explained;
  if (unexplainedCount === 0 && Math.abs(unexplained) <= rec.tolerance) unexplained = 0;
  if (!c.hasStatement) unexplained = diff;
  return { ...rec, gl_balance: c.gl, comparison_balance: c.comparison, reconciling_total: explained, unexplained };
}

async function summarize(ctx: ServiceContext, stored: RecRow, people: Map<string, PersonRef>): Promise<RecSummary> {
  const rec = await live(ctx, stored);
  const acct = await accountById(ctx, rec.account_id);
  const ent = await entityById(ctx, rec.entity_id);
  const tpl = templateFor(rec, acct.code, ent.code);
  const task = tpl ? await taskFor(ctx, rec.period_key, tpl.task) : null;
  const items = await ctx.db.find('reconciling_item', { reconciliation_id: rec.id });
  const { explained } = explainedOf(items);
  const pending = await pendingProposalsFor(ctx, rec.id);
  let unmatchedBank = 0;
  let hasStatement = true;
  if (rec.rec_type === 'bank' && rec.bank_account_id) {
    unmatchedBank = await ctx.db.count('bank_transaction', { bank_account_id: rec.bank_account_id, status: 'unmatched', posted_date: { gte: periodStart(rec.period_key), lte: periodEnd(rec.period_key) } });
    hasStatement = !!(await ctx.db.findOne('bank_statement', { bank_account_id: rec.bank_account_id, statement_end: periodEnd(rec.period_key) }));
  }
  const p = (id: string | null) => (id ? (people.get(id) ?? null) : null);
  return {
    id: rec.id,
    title: tpl?.title ?? rec.notes ?? `${acct.code} ${acct.name}`,
    entityId: rec.entity_id,
    entityCode: ent.code,
    periodKey: rec.period_key,
    accountId: acct.id,
    accountCode: acct.code,
    accountName: acct.name,
    recType: rec.rec_type,
    subledger: tpl?.subledger ?? null,
    currency: ent.functional_currency,
    glBalance: rec.gl_balance,
    comparisonBalance: rec.comparison_balance,
    comparisonLabel: rec.rec_type === 'bank' ? COMPARISON_LABEL.bank! : rec.rec_type === 'intercompany' ? COMPARISON_LABEL.intercompany! : COMPARISON_LABEL[tpl?.subledger ?? ''] ?? 'Supporting detail',
    difference: rec.gl_balance - rec.comparison_balance,
    explained,
    unexplained: rec.unexplained,
    status: rec.status,
    risk: rec.risk,
    tolerance: rec.tolerance,
    owner: task ? p(task.owner_id) : tpl ? null : null,
    reviewer: task ? p(task.reviewer_id) : null,
    preparedBy: p(rec.prepared_by),
    preparedAt: rec.prepared_at,
    reviewedBy: p(rec.reviewed_by),
    reviewedAt: rec.reviewed_at,
    openItems: items.filter((i) => i.status === 'open').length,
    unmatchedBank,
    pendingProposals: pending.length,
    taskCode: tpl?.task ?? null,
    hasStatement,
  };
}

async function taskFor(ctx: ServiceContext, periodKey: string, code: string) {
  const cycle = await ctx.db.findOne('close_cycle', { tenant_id: ctx.tenantId, period_key: periodKey });
  if (!cycle) return null;
  return ctx.db.findOne('close_task', { close_cycle_id: cycle.id, code });
}

/** Pending agent proposals that touch a reconciliation (matches, items, linked entries). */
export async function pendingProposalsFor(ctx: ServiceContext, recId: string) {
  const ps = await ctx.db.find('proposal', { tenant_id: ctx.tenantId, status: { in: ['pending', 'suggested'] }, kind: { in: ['rec_match', 'reconciling_item', 'journal_entry'] } });
  return ps.filter((p) => {
    const pl = p.payload as Record<string, unknown>;
    const links = (pl.links ?? {}) as Record<string, unknown>;
    return pl.reconciliationId === recId || links.recId === recId;
  });
}

export async function listRecs(ctx: ServiceContext, periodKey: string): Promise<RecSummary[]> {
  requirePermission(ctx, 'close.view');
  const recs = (await ctx.db.find('reconciliation', { tenant_id: ctx.tenantId, period_key: periodKey })).filter((r) => canSeeEntity(ctx, r.entity_id));
  const people = await peopleMap(ctx);
  const out: RecSummary[] = [];
  for (const r of recs) out.push(await summarize(ctx, r, people));
  const order = new Map(REC_TEMPLATE.map((t, i) => [`${t.entity}:${t.account}`, i]));
  return out.sort((a, b) => (order.get(`${a.entityCode}:${a.accountCode}`) ?? 99) - (order.get(`${b.entityCode}:${b.accountCode}`) ?? 99));
}

export interface StatementLine {
  id: string;
  date: string;
  amount: number;
  description: string;
  reference: string | null;
  typeCode: string | null;
  match: { id: string; type: string; confidence: number; by: string } | null;
  documentId: string | null;
  suspicious: string[];
  subsequent: boolean;
}

export interface BookLine {
  id: string;
  entryId: string;
  entryNumber: string;
  date: string;
  amount: number;
  memo: string;
  source: string;
  match: { id: string; type: string; confidence: number; by: string } | null;
}

export interface RecDetail {
  summary: RecSummary;
  statement: { opening: number; closing: number; documentId: string | null; filename: string | null } | null;
  bankLines: StatementLine[];
  bookLines: BookLine[];
  matches: { id: string; type: string; confidence: number; status: string; rationale: string; createdBy: string; acceptedBy: PersonRef | null; bank: number; ledger: number; itemCount: number }[];
  items: { id: string; type: string; side: string; amount: number; description: string; originDate: string; expectedClearDate: string | null; status: string; clearedBy: unknown[]; sourceRefs: unknown[]; createdBy: string; proposalId: string | null }[];
  signoffs: { role: string; user: PersonRef | null; signedAt: string; statement: string }[];
  detail: { label: string; rows: { label: string; amount: number; ref?: { type: string; id: string } }[] } | null;
  canCertify: { ok: boolean; reasons: string[] };
  canReview: { ok: boolean; reasons: string[] };
}

export async function recDetail(ctx: ServiceContext, recId: string): Promise<RecDetail> {
  requirePermission(ctx, 'close.view');
  const rec = await ctx.db.get('reconciliation', recId);
  if (!rec || rec.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Reconciliation not found');
  requireEntity(ctx, rec.entity_id);
  const people = await peopleMap(ctx);
  const summary = await summarize(ctx, rec, people);
  const current = await live(ctx, rec);
  const matchRows = await ctx.db.find('rec_match', { reconciliation_id: rec.id });
  const matchItems = matchRows.length ? await ctx.db.find('rec_match_item', { match_id: { in: matchRows.map((m) => m.id) } }) : [];
  const matchById = new Map(matchRows.map((m) => [m.id, m]));
  const activeByRecord = new Map<string, Row<EkSchema, 'rec_match'>>();
  for (const it of matchItems) if (it.active) activeByRecord.set(it.record_id, matchById.get(it.match_id)!);
  const mref = (id: string) => {
    const m = activeByRecord.get(id);
    return m ? { id: m.id, type: m.match_type, confidence: m.confidence, by: m.created_by_type } : null;
  };
  let statement: RecDetail['statement'] = null;
  let bankLines: StatementLine[] = [];
  let bookLines: BookLine[] = [];
  if (rec.rec_type === 'bank' && rec.bank_account_id) {
    const st = await ctx.db.findOne('bank_statement', { bank_account_id: rec.bank_account_id, statement_end: periodEnd(rec.period_key) });
    if (st) {
      const doc = st.source_document_id ? await ctx.db.get('source_document', st.source_document_id) : null;
      statement = { opening: st.opening_balance, closing: st.closing_balance, documentId: doc?.id ?? null, filename: doc?.filename ?? null };
    }
    const txs = await ctx.db.find('bank_transaction', { bank_account_id: rec.bank_account_id, posted_date: { gte: periodStart(rec.period_key), lte: addDays(periodEnd(rec.period_key), 15) } }, { orderBy: [['posted_date', 'asc']] });
    bankLines = txs.map((t) => ({
      id: t.id,
      date: t.posted_date,
      amount: t.amount,
      description: t.description,
      reference: t.reference,
      typeCode: t.type_code,
      match: mref(t.id),
      documentId: t.source_document_id,
      suspicious: scanForInjection(`${t.description} ${t.counterparty ?? ''}`).matches,
      subsequent: t.posted_date > periodEnd(rec.period_key),
    }));
    const lines = await periodLines(ctx, rec.entity_id, [rec.account_id], rec.period_key);
    bookLines = lines.map((l) => ({ id: l.lineId, entryId: l.entryId, entryNumber: l.entryNumber, date: l.entryDate, amount: l.debit - l.credit, memo: l.lineMemo ?? l.memo, source: l.source, match: mref(l.lineId) }));
  }
  const items = await ctx.db.find('reconciling_item', { reconciliation_id: rec.id }, { orderBy: [['origin_date', 'asc']] });
  const signoffs = await ctx.db.find('signoff', { subject_type: 'reconciliation', subject_id: rec.id }, { orderBy: [['signed_at', 'asc']] });
  const detail = await supportingDetail(ctx, rec, summary);
  const matchesOut = matchRows.map((m) => {
    const its = matchItems.filter((i) => i.match_id === m.id);
    return {
      id: m.id,
      type: m.match_type,
      confidence: m.confidence,
      status: m.status,
      rationale: m.rationale,
      createdBy: m.created_by_type,
      acceptedBy: m.accepted_by ? (people.get(m.accepted_by) ?? null) : null,
      bank: its.filter((i) => i.side === 'bank').reduce((s, i) => s + i.amount, 0),
      ledger: its.filter((i) => i.side !== 'bank').reduce((s, i) => s + i.amount, 0),
      itemCount: its.length,
    };
  });
  return {
    summary,
    statement,
    bankLines,
    bookLines,
    matches: matchesOut,
    items: items.map((i) => ({ id: i.id, type: i.item_type, side: i.side, amount: i.amount, description: i.description, originDate: i.origin_date, expectedClearDate: i.expected_clear_date, status: i.status, clearedBy: i.cleared_by ?? [], sourceRefs: i.source_refs, createdBy: i.created_by_type, proposalId: i.proposal_id })),
    signoffs: await Promise.all(signoffs.map(async (s) => ({ role: s.role, user: await person(ctx, s.user_id), signedAt: s.signed_at, statement: s.statement }))),
    detail,
    canCertify: certifyReadiness(ctx, current, summary),
    canReview: reviewReadiness(ctx, current),
  };
}

async function supportingDetail(ctx: ServiceContext, rec: RecRow, s: RecSummary): Promise<RecDetail['detail']> {
  const pe = periodEnd(rec.period_key);
  if (s.subledger === 'ap') {
    const bills = await ctx.db.find('bill', { tenant_id: ctx.tenantId, entity_id: rec.entity_id, bill_date: { lte: pe } });
    const pays = await ctx.db.find('vendor_payment', { tenant_id: ctx.tenantId, entity_id: rec.entity_id, payment_date: { lte: pe } });
    const vendors = new Map((await ctx.db.find('vendor', { tenant_id: ctx.tenantId })).map((v) => [v.id, v.name]));
    const paid = new Map<string, number>();
    for (const p of pays) if (p.bill_id && p.status !== 'void') paid.set(p.bill_id, (paid.get(p.bill_id) ?? 0) + p.amount);
    const rows = bills
      .map((b) => ({ label: `${vendors.get(b.vendor_id) ?? 'Vendor'} — ${b.bill_number} (${b.bill_date})`, amount: Math.max(0, b.amount - (paid.get(b.id) ?? 0)), ref: { type: 'bill', id: b.id } }))
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    return { label: 'Open bills at month end', rows };
  }
  if (s.subledger === 'ar') {
    const invs = await ctx.db.find('invoice', { tenant_id: ctx.tenantId, entity_id: rec.entity_id, invoice_date: { lte: pe } });
    const rcpts = await ctx.db.find('customer_receipt', { tenant_id: ctx.tenantId, entity_id: rec.entity_id, receipt_date: { lte: pe } });
    const customers = new Map((await ctx.db.find('customer', { tenant_id: ctx.tenantId })).map((c) => [c.id, c.name]));
    const got = new Map<string, number>();
    for (const r of rcpts) if (r.invoice_id) got.set(r.invoice_id, (got.get(r.invoice_id) ?? 0) + r.amount);
    const rows = invs
      .map((i) => ({ label: `${customers.get(i.customer_id) ?? 'Customer'} — ${i.invoice_number}`, amount: Math.max(0, i.amount - (got.get(i.id) ?? 0)), ref: { type: 'invoice', id: i.id } }))
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    return { label: 'Open invoices at month end', rows: rows.slice(0, 60) };
  }
  if (s.subledger === 'prepaid') {
    const schedules = await ctx.db.find('prepaid_schedule', { tenant_id: ctx.tenantId, entity_id: rec.entity_id, prepaid_account_id: rec.account_id });
    const rows = [];
    for (const sc of schedules) {
      const lines = await ctx.db.find('prepaid_line', { schedule_id: sc.id });
      rows.push({ label: `${sc.description} — remaining per schedule`, amount: sc.total - lines.filter((l) => l.period_key <= rec.period_key).reduce((x, l) => x + l.amount, 0), ref: { type: 'prepaid_schedule', id: sc.id } });
    }
    return { label: 'Prepaid schedules', rows: rows.filter((r) => r.amount !== 0) };
  }
  if (s.subledger === 'fixed_asset' || s.subledger === 'accumulated_depreciation') {
    const assets = await ctx.db.find('fixed_asset', { tenant_id: ctx.tenantId, entity_id: rec.entity_id }, { orderBy: [['tag', 'asc']] });
    const rows = assets
      .filter((a) => (s.subledger === 'fixed_asset' ? a.asset_account_id === rec.account_id : a.accum_depr_account_id === rec.account_id))
      .map((a) => ({
        label: `${a.tag} ${a.name}`,
        amount: s.subledger === 'fixed_asset' ? a.cost : accumulatedDepreciation({ id: a.id, tag: a.tag, name: a.name, cost: a.cost, salvage: a.salvage, usefulLifeMonths: a.useful_life_months, inServiceDate: a.in_service_date, departmentId: a.department_id, status: a.status }, rec.period_key),
        ref: { type: 'fixed_asset', id: a.id },
      }));
    return { label: s.subledger === 'fixed_asset' ? 'Asset register — cost' : 'Asset register — accumulated depreciation', rows };
  }
  if (rec.rec_type === 'intercompany' && rec.counterparty_entity_id) {
    const ents = await entities(ctx);
    const us = ents.get(rec.entity_id)!;
    const them = ents.get(rec.counterparty_entity_id)!;
    const mine = await periodLines(ctx, rec.entity_id, [rec.account_id], rec.period_key);
    const theirAcct = [...(await accounts(ctx)).values()].find((a) => a.is_intercompany && a.account_class === 'liability');
    const theirs = theirAcct ? await periodLines(ctx, them.id, [theirAcct.id], rec.period_key) : [];
    return {
      label: `Activity this month — ${us.code} vs ${them.code}`,
      rows: [
        ...mine.map((l) => ({ label: `${us.code} ${l.entryNumber}: ${l.memo}`, amount: l.debit - l.credit, ref: { type: 'journal_entry', id: l.entryId } })),
        ...theirs.map((l) => ({ label: `${them.code} ${l.entryNumber}: ${l.memo}`, amount: l.txnAmount !== null && l.txnCurrency === us.functional_currency ? -l.txnAmount : l.credit - l.debit, ref: { type: 'journal_entry', id: l.entryId } })),
      ],
    };
  }
  return null;
}

function certifyReadiness(ctx: ServiceContext, rec: RecRow, s: RecSummary): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (rec.status === 'prepared' || rec.status === 'reviewed') reasons.push('Already certified.');
  if (!s.hasStatement) reasons.push('No bank statement for the period has been imported.');
  if (rec.unexplained !== 0) reasons.push(`There is an unexplained difference of ${formatMoney(Math.abs(rec.unexplained), s.currency)}.`);
  if (s.pendingProposals > 0) reasons.push(`${s.pendingProposals} agent proposal${s.pendingProposals === 1 ? '' : 's'} for this reconciliation still need a decision.`);
  if (rec.rec_type === 'bank' && s.unmatchedBank > 0 && rec.unexplained !== 0) reasons.push(`${s.unmatchedBank} statement line${s.unmatchedBank === 1 ? ' is' : 's are'} not matched or explained.`);
  if (!ctx.actor.permissions.has('rec.prepare') && !ctx.actor.permissions.has('*')) reasons.push('Your role cannot certify reconciliations.');
  return { ok: reasons.length === 0, reasons };
}

function reviewReadiness(ctx: ServiceContext, rec: RecRow): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (rec.status !== 'prepared') reasons.push(rec.status === 'reviewed' ? 'Already reviewed.' : 'The preparer has not certified this reconciliation yet.');
  if (rec.prepared_by && rec.prepared_by === ctx.actor.userId) reasons.push('You prepared this reconciliation, so someone else must review it.');
  if (!ctx.actor.permissions.has('rec.review') && !ctx.actor.permissions.has('*')) reasons.push('Your role cannot review reconciliations.');
  return { ok: reasons.length === 0, reasons };
}

function recHash(rec: RecRow, items: ItemRow[]): string {
  return sha256Hex(stableStringify({ id: rec.id, gl: rec.gl_balance, comparison: rec.comparison_balance, unexplained: rec.unexplained, items: items.filter((i) => i.status === 'open').map((i) => [i.item_type, i.side, i.amount, i.description]) }));
}

/** Preparer certification (sign-off). */
export async function certifyRec(ctx: ServiceContext, recId: string, statement?: string): Promise<RecSummary> {
  requirePermission(ctx, 'rec.prepare');
  const fresh = await refreshRec(ctx, recId);
  requireEntity(ctx, fresh.entity_id);
  const people = await peopleMap(ctx);
  const s = await summarize(ctx, fresh, people);
  const ready = certifyReadiness(ctx, fresh, s);
  if (!ready.ok) throw new AppError('CONFLICT', ready.reasons.join(' '));
  const period = await ctx.db.findOne('fiscal_period', { tenant_id: ctx.tenantId, entity_id: fresh.entity_id, period_key: fresh.period_key });
  if (period?.status === 'hard_close') throw new AppError('PERIOD_LOCKED', 'This period is locked.');
  const items = await ctx.db.find('reconciling_item', { reconciliation_id: fresh.id });
  const now = ctx.clock.nowIso();
  await ctx.db.tx(async (db) => {
    const t = withDb(ctx, db);
    await db.update('reconciliation', fresh.id, { status: 'prepared', prepared_by: ctx.actor.userId, prepared_at: now, updated_at: now });
    await db.insert('signoff', { tenant_id: ctx.tenantId, subject_type: 'reconciliation', subject_id: fresh.id, role: 'preparer', user_id: ctx.actor.userId!, signed_at: now, statement: statement?.trim() || 'I certify this reconciliation is complete and every reconciling item is supported.', content_hash: recHash(fresh, items) });
    await audit(t, { action: 'rec.certified', subjectType: 'reconciliation', subjectId: fresh.id, data: { title: s.title, gl: fresh.gl_balance, comparison: fresh.comparison_balance, openItems: s.openItems } });
  });
  return summarize(ctx, (await ctx.db.get('reconciliation', fresh.id))!, people);
}

/** Reviewer sign-off (approve) or send back with a note. */
export async function reviewRec(ctx: ServiceContext, recId: string, input: { approve: boolean; note?: string }): Promise<RecSummary> {
  requirePermission(ctx, 'rec.review');
  const rec = await ctx.db.get('reconciliation', recId);
  if (!rec || rec.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Reconciliation not found');
  requireEntity(ctx, rec.entity_id);
  if (rec.status !== 'prepared') throw new AppError('CONFLICT', 'Only certified reconciliations can be reviewed.');
  await assertSod(ctx, { kind: 'review_rec', preparedBy: rec.prepared_by });
  const now = ctx.clock.nowIso();
  const items = await ctx.db.find('reconciling_item', { reconciliation_id: rec.id });
  await ctx.db.tx(async (db) => {
    const t = withDb(ctx, db);
    if (input.approve) {
      await db.update('reconciliation', rec.id, { status: 'reviewed', reviewed_by: ctx.actor.userId, reviewed_at: now, updated_at: now });
      await db.insert('signoff', { tenant_id: ctx.tenantId, subject_type: 'reconciliation', subject_id: rec.id, role: 'reviewer', user_id: ctx.actor.userId!, signed_at: now, statement: input.note?.trim() || 'Reviewed and agreed.', content_hash: recHash(rec, items) });
      await audit(t, { action: 'rec.reviewed', subjectType: 'reconciliation', subjectId: rec.id, data: { note: input.note ?? null } });
    } else {
      if (!input.note || input.note.trim().length < 3) throw new AppError('VALIDATION', 'Say what needs to change (at least 3 characters).');
      await db.update('reconciliation', rec.id, { status: 'in_progress', prepared_by: null, prepared_at: null, notes: `${rec.notes ?? ''}\nReturned: ${input.note.trim()}`.trim().slice(0, 2000), updated_at: now });
      await audit(t, { action: 'rec.returned', subjectType: 'reconciliation', subjectId: rec.id, data: { note: input.note.trim() } });
    }
  });
  return summarize(ctx, (await ctx.db.get('reconciliation', rec.id))!, await peopleMap(ctx));
}

function assertEditable(rec: RecRow): void {
  if (rec.status === 'prepared' || rec.status === 'reviewed') throw new AppError('CONFLICT', 'This reconciliation is certified; ask the reviewer to return it before changing it.');
}

/** Manual reconciling item added by a person. */
export async function addReconcilingItem(ctx: ServiceContext, recId: string, input: unknown): Promise<RecSummary> {
  requirePermission(ctx, 'rec.prepare');
  const rec = await ctx.db.get('reconciliation', recId);
  if (!rec || rec.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Reconciliation not found');
  requireEntity(ctx, rec.entity_id);
  assertEditable(rec);
  const d = ReconcilingItemDraft.parse(input);
  await ctx.db.tx(async (db) => {
    const t = withDb(ctx, db);
    const item = await db.insert('reconciling_item', { tenant_id: ctx.tenantId, reconciliation_id: rec.id, item_type: d.itemType, side: d.side, amount: d.amount, description: d.description, origin_date: d.originDate, expected_clear_date: d.expectedClearDate ?? null, status: 'open', cleared_by: d.clearedBy ?? null, source_refs: d.sourceRefs, created_by_type: 'user', created_at: ctx.clock.nowIso() });
    await audit(t, { action: 'rec.item.added', subjectType: 'reconciliation', subjectId: rec.id, data: { item: item.id, type: d.itemType, amount: d.amount } });
  });
  await refreshRec(ctx, rec.id);
  return summarize(ctx, (await ctx.db.get('reconciliation', rec.id))!, await peopleMap(ctx));
}

export async function resolveReconcilingItem(ctx: ServiceContext, itemId: string, input: { status: 'cleared' | 'resolved' | 'written_off'; note: string }): Promise<RecSummary> {
  requirePermission(ctx, 'rec.prepare');
  const item = await ctx.db.get('reconciling_item', itemId);
  if (!item || item.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Item not found');
  const rec = (await ctx.db.get('reconciliation', item.reconciliation_id))!;
  requireEntity(ctx, rec.entity_id);
  assertEditable(rec);
  if (!input.note || input.note.trim().length < 3) throw new AppError('VALIDATION', 'Add a short note explaining the resolution.');
  if (input.status === 'written_off') requirePermission(ctx, 'je.approve');
  await ctx.db.tx(async (db) => {
    await db.update('reconciling_item', item.id, { status: input.status, resolved_at: ctx.clock.nowIso(), resolved_by: ctx.actor.userId });
    await audit(withDb(ctx, db), { action: 'rec.item.resolved', subjectType: 'reconciliation', subjectId: rec.id, data: { item: item.id, status: input.status, note: input.note.trim() } });
  });
  await refreshRec(ctx, rec.id);
  return summarize(ctx, (await ctx.db.get('reconciliation', rec.id))!, await peopleMap(ctx));
}

/** Create an accepted match between statement lines and ledger lines (amounts must agree). */
export async function createMatch(
  ctx: ServiceContext,
  input: { reconciliationId: string; bankTransactionIds: string[]; journalLineIds: string[]; matchType?: 'exact' | 'fuzzy' | 'one_to_many' | 'many_to_one' | 'many_to_many' | 'manual'; confidence?: number; rationale: string; proposalId?: string | null; createdBy: 'agent' | 'user' | 'system'; acceptedBy?: string | null },
): Promise<string> {
  const rec = await ctx.db.get('reconciliation', input.reconciliationId);
  if (!rec || rec.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Reconciliation not found');
  assertEditable(rec);
  if (!input.bankTransactionIds.length || !input.journalLineIds.length) throw new AppError('VALIDATION', 'Pick at least one statement line and one ledger line.');
  const txs = await ctx.db.find('bank_transaction', { id: { in: input.bankTransactionIds } });
  const lines = await ctx.db.find('journal_line', { id: { in: input.journalLineIds } });
  if (txs.length !== input.bankTransactionIds.length || lines.length !== input.journalLineIds.length) throw new AppError('NOT_FOUND', 'Some lines no longer exist.');
  if (txs.some((t) => t.bank_account_id !== rec.bank_account_id)) throw new AppError('VALIDATION', 'Statement lines belong to another bank account.');
  if (lines.some((l) => l.account_id !== rec.account_id)) throw new AppError('VALIDATION', 'Ledger lines must be on the reconciled cash account.');
  const bankSum = txs.reduce((s, t) => s + t.amount, 0);
  const ledgerSum = lines.reduce((s, l) => s + l.debit - l.credit, 0);
  if (bankSum !== ledgerSum) throw new AppError('VALIDATION', `Amounts do not agree (statement ${bankSum / 100}, ledger ${ledgerSum / 100}).`);
  const already = await ctx.db.find('rec_match_item', { record_id: { in: [...input.bankTransactionIds, ...input.journalLineIds] }, active: true });
  if (already.length) throw new AppError('CONFLICT', 'Some of these lines are already matched.');
  const type = input.matchType ?? (txs.length === 1 && lines.length === 1 ? 'manual' : txs.length > 1 && lines.length === 1 ? 'many_to_one' : txs.length === 1 ? 'one_to_many' : 'many_to_many');
  const now = ctx.clock.nowIso();
  return ctx.db.tx(async (db) => {
    const m = await db.insert('rec_match', { tenant_id: ctx.tenantId, reconciliation_id: rec.id, match_type: type, confidence: input.confidence ?? 1, status: 'accepted', rationale: input.rationale.slice(0, 1000), proposal_id: input.proposalId ?? null, accepted_by: input.acceptedBy ?? null, accepted_at: now, created_by_type: input.createdBy, created_at: now });
    await db.insertMany('rec_match_item', [
      ...txs.map((t) => ({ tenant_id: ctx.tenantId, match_id: m.id, side: 'bank' as const, record_type: 'bank_transaction', record_id: t.id, amount: t.amount, active: true })),
      ...lines.map((l) => ({ tenant_id: ctx.tenantId, match_id: m.id, side: 'ledger' as const, record_type: 'journal_line', record_id: l.id, amount: l.debit - l.credit, active: true })),
    ]);
    await db.updateWhere('bank_transaction', { id: { in: txs.map((t) => t.id) } }, { status: 'matched' });
    // A statement line that is now matched no longer needs to be carried as a reconciling item.
    const items = await db.find('reconciling_item', { reconciliation_id: rec.id, status: 'open' });
    for (const it of items) {
      const refs = (it.source_refs ?? []) as { type?: string; id?: string }[];
      if (refs.some((r) => r.type === 'bank_transaction' && r.id && input.bankTransactionIds.includes(r.id))) await db.update('reconciling_item', it.id, { status: 'resolved', resolved_at: now, resolved_by: input.acceptedBy ?? null });
    }
    await audit(withDb(ctx, db), { action: 'rec.matched', subjectType: 'reconciliation', subjectId: rec.id, data: { match: m.id, type, bank: input.bankTransactionIds.length, ledger: input.journalLineIds.length, amount: bankSum, by: input.createdBy } });
    return m.id;
  });
}

export async function manualMatch(ctx: ServiceContext, input: { reconciliationId: string; bankTransactionIds: string[]; journalLineIds: string[]; note?: string }): Promise<RecSummary> {
  requirePermission(ctx, 'rec.prepare');
  const rec = await ctx.db.get('reconciliation', input.reconciliationId);
  if (rec && rec.tenant_id === ctx.tenantId) requireEntity(ctx, rec.entity_id);
  await createMatch(ctx, { ...input, rationale: input.note?.trim() || 'Matched manually.', createdBy: 'user', acceptedBy: ctx.actor.userId });
  await refreshRec(ctx, input.reconciliationId);
  return summarize(ctx, (await ctx.db.get('reconciliation', input.reconciliationId))!, await peopleMap(ctx));
}

export async function unmatch(ctx: ServiceContext, matchId: string, reason: string): Promise<RecSummary> {
  requirePermission(ctx, 'rec.prepare');
  const m = await ctx.db.get('rec_match', matchId);
  if (!m || m.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Match not found');
  const rec = (await ctx.db.get('reconciliation', m.reconciliation_id))!;
  requireEntity(ctx, rec.entity_id);
  assertEditable(rec);
  if (!reason || reason.trim().length < 3) throw new AppError('VALIDATION', 'Say why you are undoing this match.');
  await ctx.db.tx(async (db) => {
    const items = await db.find('rec_match_item', { match_id: m.id });
    await db.updateWhere('rec_match_item', { match_id: m.id }, { active: false });
    await db.update('rec_match', m.id, { status: 'rejected' });
    const bankIds = items.filter((i) => i.side === 'bank').map((i) => i.record_id);
    if (bankIds.length) await db.updateWhere('bank_transaction', { id: { in: bankIds } }, { status: 'unmatched' });
    await audit(withDb(ctx, db), { action: 'rec.unmatched', subjectType: 'reconciliation', subjectId: rec.id, data: { match: m.id, reason: reason.trim() } });
  });
  await refreshRec(ctx, rec.id);
  return summarize(ctx, (await ctx.db.get('reconciliation', rec.id))!, await peopleMap(ctx));
}

/** Locate the reconciliation for a period by template key (e.g. "bank:US-OP"). */
export async function recByKey(ctx: ServiceContext, periodKey: string, key: string): Promise<RecRow> {
  const tpl = REC_TEMPLATE.find((t) => t.key === key);
  if (!tpl) throw new AppError('NOT_FOUND', `Unknown reconciliation ${key}`);
  const ent = [...(await entities(ctx)).values()].find((e) => e.code === tpl.entity)!;
  const acct = [...(await accounts(ctx)).values()].find((a) => a.code === tpl.account)!;
  const rec = await ctx.db.findOne('reconciliation', { tenant_id: ctx.tenantId, period_key: periodKey, entity_id: ent.id, account_id: acct.id, rec_type: tpl.type });
  if (!rec) throw new AppError('NOT_FOUND', `No ${tpl.title} reconciliation for ${periodKey}`);
  return rec;
}

export function priorPeriod(periodKey: string): string {
  return addMonths(periodKey, -1);
}
