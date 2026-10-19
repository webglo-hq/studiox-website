import type { ValidationResult } from '../../../framework/ontology/types';
import type { Row } from '../../../framework/store/schema';
import { AppError, fromDbError } from '../../../framework/util/errors';
import { closeOntology, JournalEntryDraft, type AccountingAxiomContext, type JournalEntryDraftInput } from '../ontology';
import type { EkSchema } from '../store';
import { audit } from './audit';
import { requireEntity, withDb, type ServiceContext } from './context';
import { accountInfoMap, entityById, periodOf, toEntityInfo, toPeriodInfo } from './refdata';

export type JournalEntryRow = Row<EkSchema, 'journal_entry'>;
export type JournalLineRow = Row<EkSchema, 'journal_line'>;

export interface EntryOptions {
  source: JournalEntryRow['source'];
  preparedBy?: string | null;
  preparedByAgent?: string | null;
  requestedBy?: string | null;
  proposalId?: string | null;
  idempotencyKey?: string | null;
  sourceRef?: Record<string, unknown> | null;
  entryNumber?: string;
  externalPreparer?: string | null;
  externalApprover?: string | null;
  externalPostedAt?: string | null;
  /** Skip axioms that only make sense for user-authored entries (e.g. control-account warning) */
  skipAxioms?: string[];
}

export interface PostOptions {
  approvedBy?: string | null;
  approvalPolicy?: string | null;
  postedBy?: string | null;
}

export class OntologyViolationError extends AppError {
  constructor(readonly result: ValidationResult) {
    super('ONTOLOGY_VIOLATION', result.violations.filter((v) => v.severity === 'error').map((v) => v.message).join(' ') || 'Entry violates ledger rules', {
      violations: result.violations,
    });
  }
}

/** Build the axiom context for an entry from reference data. */
export async function axiomContextFor(ctx: ServiceContext, draft: JournalEntryDraft, extra: Partial<AccountingAxiomContext> = {}): Promise<AccountingAxiomContext> {
  const [accountsInfo, entity, period] = await Promise.all([accountInfoMap(ctx), entityById(ctx, draft.entityId), periodOf(ctx, draft.entityId, draft.periodKey)]);
  let original: AccountingAxiomContext['original'];
  if (draft.reversesEntryId) {
    const o = await ctx.db.get('journal_entry', draft.reversesEntryId);
    if (o) {
      const ls = await ctx.db.find('journal_line', { journal_entry_id: o.id });
      original = { entityId: o.entity_id, entryDate: o.entry_date, status: o.status, reversedByEntryId: o.reversed_by_entry_id, lines: ls.map((l) => ({ accountId: l.account_id, debit: l.debit, credit: l.credit })) };
    }
  }
  return {
    accounts: accountsInfo,
    entity: toEntityInfo(entity),
    period: toPeriodInfo(period),
    actorRoles: ctx.actor.roles,
    original,
    ...extra,
  };
}

/** Validate a draft against the ontology (shape + every applicable axiom). */
export async function validateEntry(ctx: ServiceContext, input: JournalEntryDraftInput, extra: Partial<AccountingAxiomContext> = {}, skip: string[] = []): Promise<{ draft: JournalEntryDraft; result: ValidationResult }> {
  const parsed = JournalEntryDraft.safeParse(input);
  if (!parsed.success) {
    const result: ValidationResult = {
      ok: false,
      checked: ['shape:ek:JournalEntry'],
      violations: parsed.error.issues.slice(0, 10).map((i) => ({ axiomId: 'shape:ek:JournalEntry', axiomName: 'Journal entry structure', severity: 'error', message: `${i.path.join('.')}: ${i.message}` })),
    };
    return { draft: input as JournalEntryDraft, result };
  }
  const draft = parsed.data;
  const axCtx = await axiomContextFor(ctx, draft, extra);
  const result = closeOntology().validate('ek:JournalEntry', draft, axCtx, { skip });
  return { draft, result };
}

async function nextEntryNumber(ctx: ServiceContext, entityCode: string, periodKey: string): Promise<string> {
  const n = await ctx.db.nextSequence(ctx.tenantId, `je:${entityCode}:${periodKey}`);
  return `JE-${entityCode}-${periodKey.replace('-', '')}-${String(n).padStart(4, '0')}`;
}

/** Create a draft (or pending-approval) entry with its lines. Throws if any error axiom fails. */
export async function createEntry(ctx: ServiceContext, input: JournalEntryDraftInput, opts: EntryOptions, status: 'draft' | 'pending_approval' = 'draft'): Promise<JournalEntryRow> {
  const { draft, result } = await validateEntry(ctx, input, { source: opts.source, preparedBy: opts.preparedBy, requestedBy: opts.requestedBy }, ['AX-SOD-01', ...(opts.skipAxioms ?? [])]);
  if (!result.ok) throw new OntologyViolationError(result);
  requireEntity(ctx, draft.entityId);
  const entity = await entityById(ctx, draft.entityId);
  const period = await periodOf(ctx, draft.entityId, draft.periodKey);
  try {
    return await ctx.db.tx(async (db) => {
      const tctx = withDb(ctx, db);
      const entryNumber = opts.entryNumber ?? (await nextEntryNumber(tctx, entity.code, draft.periodKey));
      const je = await db.insert('journal_entry', {
        tenant_id: ctx.tenantId,
        entity_id: draft.entityId,
        period_id: period.id,
        period_key: draft.periodKey,
        entry_number: entryNumber,
        entry_date: draft.entryDate,
        entry_type: draft.entryType,
        status,
        memo: draft.memo,
        currency: draft.currency,
        source: opts.source,
        source_ref: opts.sourceRef ?? (draft.sourceRefs?.length ? { refs: draft.sourceRefs } : null),
        reverses_entry_id: draft.reversesEntryId ?? null,
        auto_reverse_date: draft.autoReverseDate ?? null,
        prepared_by: opts.preparedBy ?? null,
        prepared_by_agent: opts.preparedByAgent ?? null,
        requested_by: opts.requestedBy ?? null,
        proposal_id: opts.proposalId ?? null,
        external_preparer: opts.externalPreparer ?? null,
        external_approver: opts.externalApprover ?? null,
        external_posted_at: opts.externalPostedAt ?? null,
        idempotency_key: opts.idempotencyKey ?? null,
        created_at: ctx.clock.nowIso(),
      });
      await db.insertMany(
        'journal_line',
        draft.lines.map((l, i) => ({
          tenant_id: ctx.tenantId,
          journal_entry_id: je.id,
          line_no: i + 1,
          account_id: l.accountId,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
          memo: l.memo ?? null,
          department_id: l.departmentId ?? null,
          location_id: l.locationId ?? null,
          class_id: l.classId ?? null,
          project_id: l.projectId ?? null,
          counterparty_entity_id: l.counterpartyEntityId ?? null,
          txn_currency: l.txnCurrency ?? null,
          txn_amount: l.txnAmount ?? null,
          fx_rate: l.fxRate ?? null,
          source_type: l.sourceRef?.type ?? null,
          source_id: l.sourceRef?.id ?? null,
        })),
      );
      await audit(tctx, {
        action: status === 'pending_approval' ? 'je.submitted' : 'je.drafted',
        subjectType: 'journal_entry',
        subjectId: je.id,
        data: { entryNumber, entryType: draft.entryType, memo: draft.memo, total: draft.lines.reduce((s, l) => s + (l.debit ?? 0), 0), source: opts.source, warnings: result.violations.filter((v) => v.severity === 'warning').map((v) => v.axiomId) },
      });
      return je;
    });
  } catch (e) {
    throw fromDbError(e);
  }
}

/** Post an existing draft. Re-validates (including SoD), then the database re-checks. */
export async function postEntry(ctx: ServiceContext, entryId: string, opts: PostOptions = {}): Promise<JournalEntryRow> {
  const je = await ctx.db.get('journal_entry', entryId);
  if (!je || je.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Journal entry not found');
  if (je.status === 'posted') return je;
  requireEntity(ctx, je.entity_id);
  const lines = await ctx.db.find('journal_line', { journal_entry_id: je.id }, { orderBy: [['line_no', 'asc']] });
  const draft = rowToDraft(je, lines);
  const { result } = await validateEntry(ctx, draft, { source: je.source, preparedBy: je.prepared_by, requestedBy: je.requested_by, approvedBy: opts.approvedBy ?? null }, ['AX-ACC-04']);
  if (!result.ok) throw new OntologyViolationError(result);
  try {
    return await ctx.db.tx(async (db) => {
      const posted = await db.update('journal_entry', je.id, {
        status: 'posted',
        approved_by: opts.approvedBy ?? null,
        approval_policy: opts.approvalPolicy ?? null,
        posted_by: opts.postedBy !== undefined ? opts.postedBy : ctx.actor.userId,
        posted_at: ctx.clock.nowIso(),
      });
      await audit(withDb(ctx, db), {
        action: 'je.posted',
        subjectType: 'journal_entry',
        subjectId: je.id,
        data: { entryNumber: je.entry_number, total: posted.total_debit, approvedBy: opts.approvedBy ?? null, policy: opts.approvalPolicy ?? null },
      });
      return posted;
    });
  } catch (e) {
    throw fromDbError(e);
  }
}

export async function createAndPost(ctx: ServiceContext, input: JournalEntryDraftInput, opts: EntryOptions & PostOptions): Promise<JournalEntryRow> {
  return ctx.db.tx(async (db) => {
    const tctx = withDb(ctx, db);
    const je = await createEntry(tctx, input, opts);
    return postEntry(tctx, je.id, opts);
  });
}

export function rowToDraft(je: JournalEntryRow, lines: JournalLineRow[]): JournalEntryDraft {
  return {
    entityId: je.entity_id,
    entryDate: je.entry_date,
    periodKey: je.period_key,
    entryType: je.entry_type,
    memo: je.memo,
    currency: je.currency,
    autoReverseDate: je.auto_reverse_date,
    reversesEntryId: je.reverses_entry_id,
    lines: lines.map((l) => ({
      accountId: l.account_id,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo ?? undefined,
      departmentId: l.department_id,
      locationId: l.location_id,
      classId: l.class_id,
      projectId: l.project_id,
      counterpartyEntityId: l.counterparty_entity_id,
      txnCurrency: l.txn_currency ?? undefined,
      txnAmount: l.txn_amount ?? undefined,
      fxRate: l.fx_rate ?? undefined,
      sourceRef: l.source_type && l.source_id ? { type: l.source_type, id: l.source_id } : undefined,
    })),
  };
}

/**
 * Reverse a posted entry: the only way to correct posted history. The reversal mirrors
 * the original exactly, so it needs no fresh judgement; it is still fully audited.
 */
export async function reverseEntry(ctx: ServiceContext, entryId: string, opts: { entryDate: string; periodKey: string; reason: string; source?: JournalEntryRow['source'] }): Promise<JournalEntryRow> {
  const je = await ctx.db.get('journal_entry', entryId);
  if (!je || je.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Journal entry not found');
  if (je.status !== 'posted') throw new AppError('CONFLICT', 'Only posted entries can be reversed.');
  if (je.reversed_by_entry_id) throw new AppError('CONFLICT', 'This entry has already been reversed.');
  if (!opts.reason || opts.reason.trim().length < 5) throw new AppError('VALIDATION', 'Give a reason for the reversal (at least 5 characters).');
  const lines = await ctx.db.find('journal_line', { journal_entry_id: je.id }, { orderBy: [['line_no', 'asc']] });
  const draft: JournalEntryDraftInput = {
    ...rowToDraft(je, lines),
    entryType: 'reversing',
    entryDate: opts.entryDate,
    periodKey: opts.periodKey,
    autoReverseDate: null,
    reversesEntryId: je.id,
    memo: `Reversal of ${je.entry_number}: ${opts.reason.trim()}`.slice(0, 500),
    lines: lines.map((l) => ({
      accountId: l.account_id,
      debit: l.credit,
      credit: l.debit,
      memo: l.memo ?? undefined,
      departmentId: l.department_id,
      locationId: l.location_id,
      classId: l.class_id,
      projectId: l.project_id,
      counterpartyEntityId: l.counterparty_entity_id,
      txnCurrency: l.txn_currency ?? undefined,
      txnAmount: l.txn_amount === null ? undefined : -l.txn_amount,
      fxRate: l.fx_rate ?? undefined,
    })),
  };
  return ctx.db.tx(async (db) => {
    const tctx = withDb(ctx, db);
    const rev = await createEntry(tctx, draft, { source: opts.source ?? 'manual', preparedBy: ctx.actor.userId, skipAxioms: ['AX-ACC-04'] });
    const posted = await postEntry(tctx, rev.id, { approvalPolicy: `reversal-of:${je.entry_number}` });
    await audit(tctx, { action: 'je.reversed', subjectType: 'journal_entry', subjectId: je.id, data: { entryNumber: je.entry_number, reversal: posted.entry_number, reason: opts.reason } });
    return posted;
  });
}

export async function getEntry(ctx: ServiceContext, entryId: string): Promise<{ entry: JournalEntryRow; lines: JournalLineRow[] }> {
  const entry = await ctx.db.get('journal_entry', entryId);
  if (!entry || entry.tenant_id !== ctx.tenantId) throw new AppError('NOT_FOUND', 'Journal entry not found');
  const lines = await ctx.db.find('journal_line', { journal_entry_id: entryId }, { orderBy: [['line_no', 'asc']] });
  return { entry, lines };
}
