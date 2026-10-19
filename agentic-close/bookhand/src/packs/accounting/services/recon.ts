import { appendAudit } from '../../../audit/audit';
import type { Tx } from '../../../persistence/db';
import type { Row } from '../../../persistence/schema';
import { can, canOn, canSeeEntity, type Principal } from '../../../security/principal';
import type { DomainContext } from '../../../shared/context';
import { DomainError } from '../../../shared/errors';
import { formatMoney } from '../../../shared/money';
import { closeOntology } from '../ontology';
import { convertMinor } from '../../../shared/money';
import { FxTable } from '../domain/fx';
import type { LedgerLookups } from '../domain/lookups';
import type { ReconciliationSubject } from '../ontology/subjects';

/**
 * Reconciliation workpapers. Sign convention: reconciling items are "GL minus external" contributions, so a
 * reconciliation balances when  GL balance - external balance - sum(open items) = 0.
 * An item counts for the period it was raised in while it is open or cleared only after that period's end.
 */

export type RecType = Row<'reconciliations'>['rec_type'];

export async function glBalance(tx: Tx, tenantId: string, entityId: string, accountId: string, asOf: string): Promise<number> {
  const sums = await tx.sumLines({ tenantId, entityIds: [entityId], accountIds: [accountId], dateTo: asOf, groupBy: ['account_id'] });
  return sums.reduce((s, x) => s + x.debit_minor - x.credit_minor, 0);
}

/** AP subledger: posted bills less payments applied, as of a date (credit balance returned as a positive number). */
export async function apSubledger(tx: Tx, tenantId: string, entityId: string, asOf: string) {
  const bills = (await tx.find('bills', { tenant_id: tenantId, entity_id: entityId, bill_date: { lte: asOf } })).filter((b) => b.status !== 'draft' && b.status !== 'void' && b.journal_entry_id);
  const payments = (await tx.find('vendor_payments', { tenant_id: tenantId, entity_id: entityId, payment_date: { lte: asOf } })).filter((p) => p.status !== 'void');
  const apps = payments.length ? await tx.find('payment_applications', { payment_id: { in: payments.map((p) => p.id) } }) : [];
  const paid = new Map<string, number>();
  for (const a of apps) paid.set(a.bill_id, (paid.get(a.bill_id) ?? 0) + a.amount_minor);
  const open = bills.map((b) => ({ bill: b, open: b.amount_minor - (paid.get(b.id) ?? 0) })).filter((x) => x.open !== 0);
  return { total: open.reduce((s, x) => s + x.open, 0), open };
}

/** AR subledger: invoices less receipts applied, as of a date (debit balance). */
export async function arSubledger(tx: Tx, tenantId: string, entityId: string, asOf: string) {
  const invoices = (await tx.find('invoices', { tenant_id: tenantId, entity_id: entityId, invoice_date: { lte: asOf } })).filter((i) => i.status !== 'void' && i.journal_entry_id);
  const receipts = (await tx.find('customer_receipts', { tenant_id: tenantId, entity_id: entityId, receipt_date: { lte: asOf } })).filter((r) => r.status !== 'void');
  const apps = receipts.length ? await tx.find('receipt_applications', { receipt_id: { in: receipts.map((r) => r.id) } }) : [];
  const paid = new Map<string, number>();
  for (const a of apps) paid.set(a.invoice_id, (paid.get(a.invoice_id) ?? 0) + a.amount_minor);
  const open = invoices.map((i) => ({ invoice: i, open: i.amount_minor - (paid.get(i.id) ?? 0) })).filter((x) => x.open !== 0);
  return { total: open.reduce((s, x) => s + x.open, 0), open };
}

export async function ensureReconciliation(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  args: { entityId: string; periodId: string; recType: RecType; accountId: string; bankAccountId?: string | null; counterpartyEntityId?: string | null; closeTaskId?: string | null },
): Promise<Row<'reconciliations'>> {
  const existing = await tx.findOne('reconciliations', {
    period_id: args.periodId,
    account_id: args.accountId,
    rec_type: args.recType,
    bank_account_id: args.bankAccountId ?? null,
    counterparty_entity_id: args.counterpartyEntityId ?? null,
  });
  if (existing) {
    if (args.closeTaskId && !existing.close_task_id) return tx.update('reconciliations', existing.id, { close_task_id: args.closeTaskId });
    return existing;
  }
  const entity = lookups.entitiesById.get(args.entityId);
  return tx.insert('reconciliations', {
    tenant_id: ctx.tenantId,
    entity_id: args.entityId,
    period_id: args.periodId,
    close_task_id: args.closeTaskId ?? null,
    rec_type: args.recType,
    account_id: args.accountId,
    bank_account_id: args.bankAccountId ?? null,
    counterparty_entity_id: args.counterpartyEntityId ?? null,
    currency: entity?.functional_currency ?? 'USD',
    status: 'in_progress',
  });
}

export async function openItemsAsOf(tx: Tx, recId: string, periodEnd: string): Promise<Row<'reconciling_items'>[]> {
  const items = await tx.find('reconciling_items', { reconciliation_id: recId });
  return items.filter((i) => i.status !== 'written_off' && (!i.cleared_date || i.cleared_date > periodEnd));
}

async function externalBalance(tx: Tx, rec: Row<'reconciliations'>, period: Row<'periods'>, gl: number): Promise<number> {
  switch (rec.rec_type) {
    case 'bank': {
      if (!rec.bank_account_id) return 0;
      const statements = await tx.find('bank_statements', { bank_account_id: rec.bank_account_id, period_end: { lte: period.end_date } }, { orderBy: [['period_end', 'desc']] });
      const exact = statements.find((s) => s.period_end === period.end_date) ?? statements[0];
      return exact?.closing_balance_minor ?? 0;
    }
    case 'subledger_ap':
      return -(await apSubledger(tx, rec.tenant_id, rec.entity_id, period.end_date)).total;
    case 'subledger_ar':
      return (await arSubledger(tx, rec.tenant_id, rec.entity_id, period.end_date)).total;
    default:
      return rec.external_balance_minor !== 0 || rec.status !== 'not_started' ? rec.external_balance_minor : gl;
  }
}

/** Recompute balances; a reviewed reconciliation whose numbers move is reopened. */
export async function refreshReconciliation(tx: Tx, recId: string): Promise<Row<'reconciliations'>> {
  const rec = await tx.get('reconciliations', recId);
  if (!rec) throw new DomainError('NOT_FOUND', 'reconciliation not found');
  const period = await tx.get('periods', rec.period_id);
  if (!period) throw new DomainError('NOT_FOUND', 'period not found');
  const gl = await glBalance(tx, rec.tenant_id, rec.entity_id, rec.account_id, period.end_date);
  const external = await externalBalance(tx, rec, period, gl);
  const items = await openItemsAsOf(tx, rec.id, period.end_date);
  const reconciling = items.reduce((s, i) => s + i.amount_minor, 0);
  const difference = gl - external - reconciling;
  const unexplained = items.some((i) => i.kind === 'unexplained' || i.kind === 'bank_error' || i.kind === 'book_error');
  const pendingMatches = await tx.count('rec_matches', { reconciliation_id: rec.id, status: 'proposed' });
  const risk: Row<'reconciliations'>['risk'] = difference !== 0 || unexplained ? 'high' : pendingMatches > 0 || items.length > 5 ? 'medium' : 'low';
  const changed = rec.gl_balance_minor !== gl || rec.external_balance_minor !== external || rec.reconciling_total_minor !== reconciling;
  const status = changed && (rec.status === 'reviewed' || rec.status === 'prepared') ? 'reopened' : rec.status === 'not_started' ? 'in_progress' : rec.status;
  return tx.update('reconciliations', rec.id, { gl_balance_minor: gl, external_balance_minor: external, reconciling_total_minor: reconciling, difference_minor: difference, risk, status });
}

export interface RecCertification {
  ok: boolean;
  problems: string[];
}

/** Listed so it is not lost, but explains nothing: an "unexplained" reconciling item still counts as unexplained. */
export const UNEXPLAINED_ITEM_KINDS: ReadonlySet<string> = new Set(['unexplained']);

/** The reconciliation as the ontology sees it (AX-REC-01..03); `notes` is the note a certification would carry. */
export async function reconciliationSubject(tx: Tx, rec: Row<'reconciliations'>, notes: string | null): Promise<ReconciliationSubject> {
  const period = (await tx.get('periods', rec.period_id))!;
  const items = await openItemsAsOf(tx, rec.id, period.end_date);
  return {
    id: rec.id,
    recType: rec.rec_type,
    currency: rec.currency,
    glBalance: rec.gl_balance_minor,
    externalBalance: rec.external_balance_minor,
    reconcilingTotal: items.filter((i) => !UNEXPLAINED_ITEM_KINDS.has(i.kind)).reduce((s, i) => s + i.amount_minor, 0),
    preparedBy: rec.prepared_by,
    reviewedBy: rec.reviewed_by,
    status: rec.status,
    notes: notes?.trim() || null,
    items: items.map((i) => ({ kind: i.kind, amount: i.amount_minor, itemDate: i.item_date, status: i.status, description: i.description })),
    asOfDate: period.end_date,
  };
}

/** The unexplained amount: what GL minus external minus the explained items leaves (AX-REC-01). */
export function unexplainedOf(subject: ReconciliationSubject): number {
  return subject.glBalance - subject.externalBalance - subject.reconcilingTotal;
}

/** Clearly-trivial threshold for the reconciliation's period, in the reconciliation's currency. */
async function clearlyTrivialFor(tx: Tx, rec: Row<'reconciliations'>): Promise<number> {
  const period = (await tx.get('periods', rec.period_id))!;
  const [m] = await tx.find('materiality_settings', { tenant_id: rec.tenant_id, fiscal_year: period.fiscal_year }, { orderBy: [['version', 'desc']], limit: 1 });
  const trivial = m?.trivial_minor ?? 500_000;
  const tenant = await tx.get('tenants', rec.tenant_id);
  const reporting = tenant?.reporting_currency ?? rec.currency;
  if (reporting === rec.currency) return trivial;
  const fx = await FxTable.load(tx, rec.tenant_id);
  const type = fx.has(reporting, rec.currency, period.end_date, 'closing') ? 'closing' : 'spot';
  return fx.has(reporting, rec.currency, period.end_date, type) ? convertMinor(trivial, fx.rate(reporting, rec.currency, period.end_date, type)) : trivial;
}

export interface CertificationCheck {
  problems: string[];
  /** The unexplained amount (a difference, or items listed as unexplained) the preparer must explain in a note. */
  unexplained: number;
  needsNote: boolean;
}

/**
 * Whether a reconciliation may be certified: every difference is matched or listed, nothing awaits a decision,
 * and the reconciliation axioms hold (AX-REC-01: whatever stays unexplained is within the clearly-trivial threshold
 * and explained in the preparer's note). `note` is the note the certification would carry.
 */
export async function certificationCheck(tx: Tx, rec: Row<'reconciliations'>, note?: string | null): Promise<CertificationCheck> {
  const problems: string[] = [];
  if (rec.difference_minor !== 0) problems.push(`Unreconciled difference of ${formatMoney(rec.difference_minor, { currency: rec.currency })}: every difference must be matched or listed as a reconciling item.`);
  const pending = await tx.count('proposals', { tenant_id: rec.tenant_id, status: 'pending', kind: { in: ['rec_match', 'reconciling_item'] }, period_id: rec.period_id, entity_id: rec.entity_id });
  if (pending > 0) problems.push(`${pending} proposed match(es) or reconciling item(s) for this entity and period still await a decision.`);
  const subject = await reconciliationSubject(tx, rec, note === undefined ? rec.notes : note);
  const unexplained = unexplainedOf(subject);
  if (rec.difference_minor === 0) {
    const ctx = { certifying: true, clearlyTrivialMinor: await clearlyTrivialFor(tx, rec), staleAfterDays: 60 };
    for (const v of closeOntology.evaluate('bh:Reconciliation', subject, ctx)) if (v.severity === 'error' && v.axiom !== 'AX-REC-03') problems.push(v.message);
  }
  return { problems, unexplained, needsNote: unexplained !== 0 };
}

export async function certificationProblems(tx: Tx, rec: Row<'reconciliations'>, note?: string | null): Promise<string[]> {
  return (await certificationCheck(tx, rec, note)).problems;
}

/** What stands in the way of certifying apart from the preparer's note, which is written when certifying. */
export async function certificationBeforeNote(tx: Tx, rec: Row<'reconciliations'>): Promise<CertificationCheck> {
  return certificationCheck(tx, rec, '(the preparer\'s note)');
}

/** Preparer / reviewer certification with maker-checker. */
export async function signReconciliation(tx: Tx, ctx: DomainContext, principal: Principal, recId: string, role: 'preparer' | 'reviewer', comment?: string): Promise<Row<'reconciliations'>> {
  const found = await tx.get('reconciliations', recId);
  if (!found || found.tenant_id !== ctx.tenantId || !canSeeEntity(principal, found.entity_id)) throw new DomainError('NOT_FOUND', 'reconciliation not found');
  if (!canOn(principal, role === 'preparer' ? 'rec.prepare' : 'rec.review', found.entity_id)) throw new DomainError('FORBIDDEN', `Your role cannot ${role === 'preparer' ? 'prepare' : 'review'} reconciliations for this entity.`);
  let rec = await refreshReconciliation(tx, recId);
  const period = await tx.get('periods', rec.period_id);
  if (period?.status === 'locked') throw new DomainError('PERIOD_LOCKED', 'The period is locked.');
  const account = await tx.get('accounts', rec.account_id);
  const label = `${account?.number ?? ''} ${account?.name ?? ''}`.trim();
  if (role === 'preparer') {
    if (!can(principal, 'rec.prepare')) throw new DomainError('FORBIDDEN', 'Your role cannot prepare reconciliations.');
    // The preparer's comment is the note that explains anything still unexplained (AX-REC-01).
    const note = comment?.trim() || rec.notes;
    const problems = await certificationProblems(tx, rec, note);
    if (problems.length) throw new DomainError('CONFLICT', problems.join(' '), { problems });
    rec = await tx.update('reconciliations', rec.id, { status: 'prepared', prepared_by: principal.user.id, prepared_at: ctx.clock.now(), reviewed_by: null, reviewed_at: null, notes: note });
  } else {
    if (!can(principal, 'rec.review')) throw new DomainError('FORBIDDEN', 'Your role cannot review reconciliations.');
    if (rec.status !== 'prepared') throw new DomainError('CONFLICT', 'A reconciliation must be prepared before it is reviewed.');
    if (rec.prepared_by === principal.user.id) throw new DomainError('SOD_VIOLATION', 'Maker-checker: you prepared this reconciliation, so someone else must review it.');
    rec = await tx.update('reconciliations', rec.id, { status: 'reviewed', reviewed_by: principal.user.id, reviewed_at: ctx.clock.now() });
  }
  await tx.insert('signoffs', { tenant_id: ctx.tenantId, object_type: 'reconciliation', object_id: rec.id, role, user_id: principal.user.id, comment: comment ?? null });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: `reconciliation.${role === 'preparer' ? 'prepare' : 'review'}`, objectType: 'reconciliation', objectId: rec.id, summary: `${role === 'preparer' ? 'Prepared' : 'Reviewed'} ${rec.rec_type.replace('_', ' ')} reconciliation ${label}`, details: { gl: rec.gl_balance_minor, external: rec.external_balance_minor, items: rec.reconciling_total_minor } }, ctx.clock.now());
  return rec;
}

export async function reopenReconciliation(tx: Tx, ctx: DomainContext, principal: Principal, recId: string, reason: string): Promise<Row<'reconciliations'>> {
  if (!can(principal, 'rec.review')) throw new DomainError('FORBIDDEN', 'Your role cannot reopen reconciliations.');
  if (!reason || reason.trim().length < 3) throw new DomainError('VALIDATION', 'Give a reason for reopening.');
  const rec = await tx.get('reconciliations', recId);
  if (!rec || rec.tenant_id !== ctx.tenantId || !canSeeEntity(principal, rec.entity_id)) throw new DomainError('NOT_FOUND', 'reconciliation not found');
  if (!canOn(principal, 'rec.review', rec.entity_id)) throw new DomainError('FORBIDDEN', 'Your role cannot reopen reconciliations for this entity.');
  const updated = await tx.update('reconciliations', recId, { status: 'reopened', notes: `Reopened: ${reason.trim()}` });
  await tx.insert('signoffs', { tenant_id: ctx.tenantId, object_type: 'reconciliation', object_id: recId, role: 'reviewer', action: 'revoke', user_id: principal.user.id, comment: reason.trim() });
  await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'reconciliation.reopen', objectType: 'reconciliation', objectId: recId, summary: `Reopened reconciliation: ${reason.trim()}` }, ctx.clock.now());
  return updated;
}

/** Balance-sheet accounts that need a reconciliation each period, by rec type. */
export function recTypeFor(account: Row<'accounts'>): RecType | null {
  if (!account.is_reconcilable) return null;
  const s = account.subtype;
  if (closeOntology.isA(s, 'bh:Cash')) return 'bank';
  if (closeOntology.isA(s, 'bh:AccountsPayable')) return 'subledger_ap';
  if (closeOntology.isA(s, 'bh:AccountsReceivable')) return 'subledger_ar';
  if (account.is_intercompany) return 'intercompany';
  if (closeOntology.isA(s, 'bh:PrepaidExpense')) return 'prepaid';
  if (closeOntology.isA(s, 'bh:PropertyAndEquipment') || closeOntology.isA(s, 'bh:AccumulatedDepreciation')) return 'fixed_assets';
  if (closeOntology.isA(s, 'bh:CreditCardPayable')) return 'credit_card';
  if (closeOntology.isA(s, 'bh:PayrollLiabilities')) return 'payroll_liabilities';
  if (closeOntology.isA(s, 'bh:AccruedLiabilities')) return 'accrued_liabilities';
  if (closeOntology.isA(s, 'bh:DeferredRevenue')) return 'deferred_revenue';
  return 'balance_sheet';
}
