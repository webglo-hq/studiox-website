import { periodEnd } from '../../../framework/util/dates';
import { AppError } from '../../../framework/util/errors';
import { audit } from '../domain/audit';
import { hasPermission, requireEntity, requirePermission, withDb, type ServiceContext } from '../domain/context';
import { createEntry, postEntry, reverseEntry, validateEntry } from '../domain/ledger';
import { assertSod } from '../domain/rbac';
import { accounts, dimensionById, entities, entityByCode } from '../domain/refdata';
import { JournalEntryDraft, type JournalEntryDraftInput } from '../ontology/shapes';
import { peopleMap } from './common';
import { sourceLabel } from './reports';

/** Journal entry explorer, manual entries (maker-checker) and undo-by-reversal. */

/** Entities, the chart of accounts and departments, for entry forms and filters. */
export async function ledgerReference(ctx: ServiceContext) {
  requirePermission(ctx, 'report.view');
  const ents = [...(await entities(ctx)).values()];
  const accs = [...(await accounts(ctx)).values()].filter((a) => a.is_active && a.is_postable);
  const dims = [...(await dimensionById(ctx)).values()];
  const deptType = await ctx.db.findOne('dimension_type', { tenant_id: ctx.tenantId, code: 'department' });
  return {
    entities: ents.map((e) => ({ id: e.id, code: e.code, name: e.name, currency: e.functional_currency, elimination: e.is_elimination })),
    accounts: accs.map((a) => ({ id: a.id, code: a.code, name: a.name, accountClass: a.account_class, normalBalance: a.normal_balance, isControl: a.is_control_account, requiresDepartment: a.requires_department, concept: a.concept })).sort((x, y) => x.code.localeCompare(y.code)),
    departments: dims.filter((d) => deptType && d.dimension_type_id === deptType.id).map((d) => ({ id: d.id, code: d.code, name: d.name })),
  };
}

export interface EntrySummary {
  id: string;
  entryNumber: string;
  entityCode: string;
  date: string;
  periodKey: string;
  type: string;
  status: string;
  source: string;
  memo: string;
  total: number;
  currency: string;
  preparedBy: string | null;
  approvedBy: string | null;
  postedAt: string | null;
  reversedBy: string | null;
  reverses: string | null;
  proposalId: string | null;
}

export async function listEntries(ctx: ServiceContext, f: { periodKey?: string; entityCode?: string; status?: string; source?: string; type?: string; accountId?: string; q?: string; limit?: number; offset?: number }): Promise<{ total: number; items: EntrySummary[] }> {
  requirePermission(ctx, 'report.view');
  const ents = await entities(ctx);
  const where: Record<string, unknown> = { tenant_id: ctx.tenantId };
  if (f.periodKey) where.period_key = f.periodKey;
  if (f.entityCode) where.entity_id = (await entityByCode(ctx, f.entityCode)).id;
  if (f.status) where.status = f.status;
  if (f.source) where.source = f.source;
  if (f.type) where.entry_type = f.type;
  if (f.q) where.memo = { contains: f.q.slice(0, 80) };
  let rows = await ctx.db.find('journal_entry', where as never, { orderBy: [['entry_date', 'desc'], ['entry_number', 'desc']] });
  if (f.accountId) {
    const lines = await ctx.db.find('journal_line', { tenant_id: ctx.tenantId, account_id: f.accountId });
    const ids = new Set(lines.map((l) => l.journal_entry_id));
    rows = rows.filter((r) => ids.has(r.id));
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    const byNumber = await ctx.db.find('journal_entry', { tenant_id: ctx.tenantId, entry_number: { contains: q } });
    const seen = new Set(rows.map((r) => r.id));
    for (const r of byNumber) if (!seen.has(r.id)) rows.push(r);
  }
  const people = await peopleMap(ctx);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const limit = Math.min(200, f.limit ?? 50);
  const offset = f.offset ?? 0;
  const page = rows.slice(offset, offset + limit);
  const numberOf = async (id: string | null) => (id ? (byId.get(id)?.entry_number ?? (await ctx.db.get('journal_entry', id))?.entry_number ?? null) : null);
  const items: EntrySummary[] = [];
  for (const e of page) {
    items.push({
      id: e.id,
      entryNumber: e.entry_number,
      entityCode: ents.get(e.entity_id)?.code ?? '',
      date: e.entry_date,
      periodKey: e.period_key,
      type: e.entry_type,
      status: e.status,
      source: e.source,
      memo: e.memo,
      total: e.total_debit || 0,
      currency: e.currency,
      preparedBy: (e.prepared_by ? people.get(e.prepared_by)?.name : null) ?? (e.prepared_by_agent ? `Agent · ${e.prepared_by_agent}` : null) ?? e.external_preparer,
      approvedBy: (e.approved_by ? people.get(e.approved_by)?.name : null) ?? e.external_approver ?? e.approval_policy,
      postedAt: e.external_posted_at ?? e.posted_at,
      reversedBy: await numberOf(e.reversed_by_entry_id),
      reverses: await numberOf(e.reverses_entry_id),
      proposalId: e.proposal_id,
    });
  }
  return { total: rows.length, items };
}

export async function entryDetail(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'report.view');
  const e = await ctx.db.get('journal_entry', id);
  if (!e || e.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Journal entry not found');
  const accs = await accounts(ctx);
  const dims = await dimensionById(ctx);
  const ents = await entities(ctx);
  const people = await peopleMap(ctx);
  const lines = await ctx.db.find('journal_line', { journal_entry_id: e.id }, { orderBy: [['line_no', 'asc']] });
  const events = await ctx.db.find('audit_log', { tenant_id: ctx.tenantId, subject_id: e.id }, { orderBy: [['seq', 'asc']] });
  const proposal = e.proposal_id ? await ctx.db.get('proposal', e.proposal_id) : null;
  const ref = (e.source_ref ?? {}) as Record<string, unknown>;
  const docId = typeof ref.document === 'string' ? ref.document : null;
  const doc = docId ? await ctx.db.get('source_document', docId) : null;
  const name = (uid: string | null) => (uid ? (people.get(uid)?.name ?? null) : null);
  const lineOut = [];
  for (const l of lines) {
    lineOut.push({
      lineNo: l.line_no,
      account: { id: l.account_id, code: accs.get(l.account_id)?.code ?? '', name: accs.get(l.account_id)?.name ?? '' },
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
      department: l.department_id ? (dims.get(l.department_id)?.name ?? null) : null,
      counterparty: l.counterparty_entity_id ? (ents.get(l.counterparty_entity_id)?.code ?? null) : null,
      txnCurrency: l.txn_currency,
      txnAmount: l.txn_amount,
      fxRate: l.fx_rate,
      source: l.source_type && l.source_id ? { type: l.source_type, id: l.source_id, label: await sourceLabel(ctx, l.source_type, l.source_id) } : null,
    });
  }
  const isPreparer = !!e.prepared_by && e.prepared_by === ctx.actor.userId;
  return {
    entry: {
      id: e.id,
      entryNumber: e.entry_number,
      entityCode: ents.get(e.entity_id)?.code ?? '',
      entityName: ents.get(e.entity_id)?.name ?? '',
      date: e.entry_date,
      periodKey: e.period_key,
      type: e.entry_type,
      status: e.status,
      source: e.source,
      memo: e.memo,
      currency: e.currency,
      total: e.total_debit,
      autoReverseDate: e.auto_reverse_date,
      preparedBy: name(e.prepared_by),
      preparedByAgent: e.prepared_by_agent,
      requestedBy: name(e.requested_by),
      approvedBy: name(e.approved_by),
      approvalPolicy: e.approval_policy,
      externalPreparer: e.external_preparer,
      externalApprover: e.external_approver,
      externalPostedAt: e.external_posted_at,
      postedAt: e.posted_at,
      postedBy: name(e.posted_by),
      createdAt: e.created_at,
      sourceRef: e.source_ref,
    },
    lines: lineOut,
    document: doc ? { id: doc.id, filename: doc.filename, receivedAt: doc.received_at } : null,
    proposal: proposal ? { id: proposal.id, title: proposal.title, why: proposal.why, skillId: proposal.skill_id, runId: proposal.run_id, status: proposal.status, confidence: proposal.confidence } : null,
    reversedBy: e.reversed_by_entry_id ? { id: e.reversed_by_entry_id, entryNumber: (await ctx.db.get('journal_entry', e.reversed_by_entry_id))?.entry_number ?? '' } : null,
    reverses: e.reverses_entry_id ? { id: e.reverses_entry_id, entryNumber: (await ctx.db.get('journal_entry', e.reverses_entry_id))?.entry_number ?? '' } : null,
    audit: events.map((a) => ({ seq: a.seq, at: a.occurred_at, actor: a.actor_label, actorType: a.actor_type, action: a.action, data: a.data })),
    can: {
      approve: e.status === 'pending_approval' && hasPermission(ctx.actor, 'je.approve') && !isPreparer,
      reject: e.status === 'pending_approval' && hasPermission(ctx.actor, 'je.approve'),
      reverse: e.status === 'posted' && !e.reversed_by_entry_id && !e.reverses_entry_id && hasPermission(ctx.actor, 'je.reverse'),
    },
  };
}

/** A person prepares a manual entry; submitting sends it for approval by someone else. */
export async function createManualEntry(ctx: ServiceContext, input: { draft: JournalEntryDraftInput; submit: boolean }) {
  requirePermission(ctx, 'je.create');
  const parsed = JournalEntryDraft.safeParse(input.draft);
  if (!parsed.success) throw new AppError('VALIDATION', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  requireEntity(ctx, parsed.data.entityId);
  const je = await createEntry(ctx, parsed.data, { source: 'manual', preparedBy: ctx.actor.userId }, input.submit ? 'pending_approval' : 'draft');
  return { id: je.id, entryNumber: je.entry_number, status: je.status };
}

export async function previewManualEntry(ctx: ServiceContext, draft: JournalEntryDraftInput) {
  requirePermission(ctx, 'je.create');
  const { result } = await validateEntry(ctx, draft, { source: 'manual', preparedBy: ctx.actor.userId }, ['AX-SOD-01']);
  return result;
}

export async function approveEntry(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'je.approve');
  const e = await ctx.db.get('journal_entry', id);
  if (!e || e.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Journal entry not found');
  if (e.status !== 'pending_approval') throw new AppError('CONFLICT', `This entry is ${e.status.replace('_', ' ')}, not waiting for approval.`);
  await assertSod(ctx, { kind: 'approve_entry', preparedBy: e.prepared_by, requestedBy: e.requested_by });
  const posted = await postEntry(ctx, id, { approvedBy: ctx.actor.userId, approvalPolicy: 'human-approval' });
  return { id: posted.id, entryNumber: posted.entry_number, status: posted.status };
}

export async function rejectEntry(ctx: ServiceContext, id: string, reason: string) {
  requirePermission(ctx, 'je.approve');
  if (!reason || reason.trim().length < 3) throw new AppError('VALIDATION', 'Say why the entry is rejected.');
  const e = await ctx.db.get('journal_entry', id);
  if (!e || e.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Journal entry not found');
  if (e.status !== 'pending_approval' && e.status !== 'draft') throw new AppError('CONFLICT', 'Only unposted entries can be rejected.');
  await ctx.db.tx(async (db) => {
    await db.update('journal_entry', id, { status: 'rejected' });
    await audit(withDb(ctx, db), { action: 'je.rejected', subjectType: 'journal_entry', subjectId: id, data: { entryNumber: e.entry_number, reason: reason.trim() } });
  });
  return { id, status: 'rejected' };
}

/** Undo a posted entry the only way the ledger allows: a mirror-image reversal. */
export async function reversePostedEntry(ctx: ServiceContext, id: string, reason: string) {
  requirePermission(ctx, 'je.reverse');
  const e = await ctx.db.get('journal_entry', id);
  if (!e || e.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Journal entry not found');
  const open = await ctx.db.find('fiscal_period', { tenant_id: ctx.tenantId, entity_id: e.entity_id, status: 'open' }, { orderBy: [['period_key', 'asc']] });
  const own = open.find((p) => p.period_key === e.period_key);
  const target = own ?? open.find((p) => p.period_key > e.period_key);
  if (!target) throw new AppError('PERIOD_LOCKED', 'No open period to post the reversal in.');
  const date = own ? e.entry_date : target.start_date;
  const rev = await reverseEntry(ctx, id, { entryDate: date, periodKey: target.period_key, reason });
  return { id: rev.id, entryNumber: rev.entry_number, periodKey: target.period_key, date: date <= periodEnd(target.period_key) ? date : target.start_date };
}
