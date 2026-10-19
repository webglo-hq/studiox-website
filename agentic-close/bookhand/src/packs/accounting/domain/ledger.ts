import { appendAudit } from '../../../audit/audit';
import type { AxiomViolation } from '../../../ontology/kernel';
import type { Tx } from '../../../persistence/db';
import { isDbConstraintError } from '../../../persistence/db';
import type { Insert, Row } from '../../../persistence/schema';
import type { DomainContext } from '../../../shared/context';
import { DomainError } from '../../../shared/errors';
import { newId } from '../../../shared/ids';
import { convertMinor } from '../../../shared/money';
import { capitalizableMatches, closeOntology } from '../ontology';
import type { JournalEntryContext, ResolvedJournalEntry, ResolvedLine } from '../ontology/subjects';
import { type LedgerLookups } from './lookups';

export type JournalEntryType = Row<'journal_entries'>['entry_type'];
export type ApprovalBasis = NonNullable<Row<'journal_entries'>['approval_basis']>;

export interface LineDraft {
  /** Account number ("6420") or id. */
  account: string;
  debit?: number;
  credit?: number;
  department?: string | null;
  location?: string | null;
  class?: string | null;
  project?: string | null;
  /** Counterparty entity code or id (intercompany lines). */
  counterpartyEntity?: string | null;
  vendorId?: string | null;
  customerId?: string | null;
  memo?: string | null;
  /** Foreign-currency lines: transaction currency and signed amount (debit-positive). */
  txnCurrency?: string;
  txnAmount?: number;
}

export interface EntryDraft {
  /** Entity code ("BW-US") or id. */
  entity: string;
  date: string;
  type?: JournalEntryType;
  description: string;
  lines: LineDraft[];
  autoReverseDate?: string | null;
  currency?: string;
  fxRate?: number;
  reversesEntryId?: string | null;
  icReference?: string | null;
  counterpartyEntity?: string | null;
}

export interface EntryMeta {
  status?: 'draft' | 'pending_approval';
  source?: Row<'journal_entries'>['source'];
  sourceModule?: Row<'journal_entries'>['source_module'];
  sourceDocumentId?: string | null;
  importBatchId?: string | null;
  sourceLocator?: string | null;
  externalRef?: string | null;
  externalPreparedBy?: string | null;
  externalApprovedBy?: string | null;
  preparedBy?: string | null;
  preparedByRunId?: string | null;
  proposalId?: string | null;
  idempotencyKey?: string | null;
  entryNumber?: string;
  id?: string;
}

export interface PostBasis {
  basis: ApprovalBasis;
  approvedBy?: string | null;
  postedBy?: string | null;
  postedByRunId?: string | null;
}

export const DEFAULT_CAPITALIZATION_THRESHOLD_MINOR = 500_000; // $5,000

export function axiomContext(capitalizationThresholdMinor = DEFAULT_CAPITALIZATION_THRESHOLD_MINOR): JournalEntryContext {
  return {
    capitalizationThresholdMinor,
    isA: (a, b) => closeOntology.isA(a, b),
    capitalizableMatches,
  };
}

export interface ResolvedDraft {
  resolved: ResolvedJournalEntry;
  entity: Row<'entities'> | undefined;
  period: Row<'periods'> | undefined;
  problems: string[];
  lines: Array<Omit<Insert<'journal_lines'>, 'tenant_id' | 'journal_entry_id' | 'line_number' | 'entity_id' | 'period_id' | 'entry_date'>>;
  total: number;
}

/** Resolve references, compute functional/transaction amounts and build the ontology subject. */
export function resolveDraft(lookups: LedgerLookups, draft: EntryDraft): ResolvedDraft {
  const problems: string[] = [];
  const entity = lookups.entity(draft.entity);
  if (!entity) problems.push(`Unknown entity "${draft.entity}".`);
  const functional = entity?.functional_currency ?? 'USD';
  const currency = draft.currency ?? functional;
  const fxRate = draft.fxRate ?? 1;
  const period = entity ? lookups.periodFor(entity.id, draft.date) : undefined;
  const next = period ? lookups.nextPeriod(period) : undefined;

  const resolvedLines: ResolvedLine[] = [];
  const rows: ResolvedDraft['lines'] = [];
  draft.lines.forEach((l, i) => {
    const account = lookups.account(l.account);
    const debit = l.debit ?? 0;
    const credit = l.credit ?? 0;
    const dept = l.department ? lookups.departments.get(l.department) : undefined;
    if (l.department && !dept) problems.push(`Line ${i + 1}: unknown department "${l.department}".`);
    const loc = l.location ? lookups.locations.get(l.location) : undefined;
    if (l.location && !loc) problems.push(`Line ${i + 1}: unknown location "${l.location}".`);
    const klass = l.class ? lookups.classes.get(l.class) : undefined;
    if (l.class && !klass) problems.push(`Line ${i + 1}: unknown class "${l.class}".`);
    const project = l.project ? lookups.projects.get(l.project) : undefined;
    if (l.project && !project) problems.push(`Line ${i + 1}: unknown project "${l.project}".`);
    const cp = l.counterpartyEntity ? lookups.entity(l.counterpartyEntity) : undefined;
    if (l.counterpartyEntity && !cp) problems.push(`Line ${i + 1}: unknown counterparty entity "${l.counterpartyEntity}".`);
    const txnCurrency = l.txnCurrency ?? currency;
    const txnAmount = l.txnAmount ?? (txnCurrency === functional ? debit - credit : Math.round((debit - credit) / (fxRate || 1)));
    resolvedLines.push({
      account: account
        ? {
            id: account.id,
            number: account.number,
            name: account.name,
            subtype: account.subtype,
            accountClass: account.account_class,
            normalBalance: account.normal_balance,
            isPostable: account.is_postable,
            active: account.status === 'active',
            isIntercompany: account.is_intercompany,
            requiresDepartment: account.requires_department,
            isControlAccount: account.is_control_account,
          }
        : null,
      accountRef: l.account,
      debit,
      credit,
      txnCurrency,
      txnAmount,
      departmentId: dept?.id ?? null,
      counterpartyEntityId: cp?.id ?? null,
      memo: l.memo ?? null,
    });
    if (account) {
      rows.push({
        account_id: account.id,
        debit_minor: debit,
        credit_minor: credit,
        txn_currency: txnCurrency,
        txn_amount_minor: txnAmount,
        department_id: dept?.id ?? null,
        location_id: loc?.id ?? null,
        class_id: klass?.id ?? null,
        project_id: project?.id ?? null,
        counterparty_entity_id: cp?.id ?? null,
        vendor_id: l.vendorId ?? null,
        customer_id: l.customerId ?? null,
        memo: l.memo ?? null,
      });
    }
  });

  const resolved: ResolvedJournalEntry = {
    entityId: entity?.id ?? '',
    functionalCurrency: functional,
    period: period ? { id: period.id, entityId: period.entity_id, startDate: period.start_date, endDate: period.end_date, status: period.status } : null,
    nextPeriod: next ? { id: next.id, entityId: next.entity_id, startDate: next.start_date, endDate: next.end_date, status: next.status } : null,
    entryDate: draft.date,
    entryType: draft.type ?? 'standard',
    description: draft.description,
    currency,
    fxRate,
    lines: resolvedLines,
    autoReverseDate: draft.autoReverseDate ?? null,
    preparedBy: null,
    approvedBy: null,
    reversesEntryId: draft.reversesEntryId ?? null,
  };
  const total = resolvedLines.reduce((s, l) => s + l.debit, 0);
  return { resolved, entity, period, problems, lines: rows, total };
}

/** Ontology verification of a draft: reference problems + executable axioms. */
export function verifyDraft(lookups: LedgerLookups, draft: EntryDraft, opts: { capitalizationThresholdMinor?: number } = {}): { violations: AxiomViolation[]; resolved: ResolvedDraft } {
  const resolved = resolveDraft(lookups, draft);
  const violations: AxiomViolation[] = resolved.problems.map((message) => ({ axiom: 'REF', severity: 'error', message }));
  violations.push(...closeOntology.evaluate('bh:JournalEntry', resolved.resolved, axiomContext(opts.capitalizationThresholdMinor)));
  return { violations, resolved };
}

export function errorsOf(violations: AxiomViolation[]): AxiomViolation[] {
  return violations.filter((v) => v.severity === 'error');
}

async function nextEntryNumber(tx: Tx, entity: Row<'entities'>, period: Row<'periods'>): Promise<string> {
  const n = await tx.count('journal_entries', { entity_id: entity.id, period_id: period.id });
  return `${entity.code}-${String(period.fiscal_year).slice(2)}${String(period.period_number).padStart(2, '0')}-${String(n + 1).padStart(4, '0')}`;
}

/**
 * Create a journal entry (draft or pending approval) after ontology verification. Errors abort with a
 * VALIDATION DomainError carrying the violations; warnings are returned for display.
 */
export async function createEntry(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  draft: EntryDraft,
  meta: EntryMeta = {},
): Promise<{ entry: Row<'journal_entries'>; warnings: AxiomViolation[] }> {
  const { violations, resolved } = verifyDraft(lookups, draft);
  const errors = errorsOf(violations);
  if (errors.length) {
    throw new DomainError('VALIDATION', `Journal entry failed ${errors.length} check(s): ${errors.map((e) => e.message).join(' ')}`, { violations });
  }
  const entity = resolved.entity!;
  const period = resolved.period!;
  const cp = draft.counterpartyEntity ? lookups.entity(draft.counterpartyEntity) : undefined;
  let entryNumber = meta.entryNumber ?? (await nextEntryNumber(tx, entity, period));
  const header: Insert<'journal_entries'> = {
    id: meta.id ?? newId(),
    tenant_id: ctx.tenantId,
    entity_id: entity.id,
    period_id: period.id,
    entry_number: entryNumber,
    entry_date: draft.date,
    entry_type: draft.type ?? 'standard',
    status: meta.status ?? 'pending_approval',
    description: draft.description,
    source: meta.source ?? 'manual',
    source_module: meta.sourceModule ?? 'gl',
    source_document_id: meta.sourceDocumentId ?? null,
    import_batch_id: meta.importBatchId ?? null,
    source_locator: meta.sourceLocator ?? null,
    external_ref: meta.externalRef ?? null,
    external_prepared_by: meta.externalPreparedBy ?? null,
    external_approved_by: meta.externalApprovedBy ?? null,
    currency: resolved.resolved.currency,
    fx_rate: resolved.resolved.fxRate,
    prepared_by: meta.preparedBy ?? null,
    prepared_by_run_id: meta.preparedByRunId ?? null,
    proposal_id: meta.proposalId ?? null,
    reverses_entry_id: draft.reversesEntryId ?? null,
    auto_reverse_date: draft.autoReverseDate ?? null,
    ic_reference: draft.icReference ?? null,
    counterparty_entity_id: cp?.id ?? null,
    idempotency_key: meta.idempotencyKey ?? null,
    total_minor: resolved.total,
    line_count: resolved.lines.length,
  };
  let entry: Row<'journal_entries'> | undefined;
  for (let attempt = 0; attempt < 5 && !entry; attempt++) {
    try {
      entry = await tx.insert('journal_entries', { ...header, entry_number: entryNumber });
    } catch (e) {
      if (isDbConstraintError(e) && e.kind === 'unique_violation' && e.constraint?.includes('entry_number') && !meta.entryNumber) {
        entryNumber = `${entryNumber}-${attempt + 2}`;
        continue;
      }
      throw e;
    }
  }
  await tx.insertMany(
    'journal_lines',
    resolved.lines.map((l, i) => ({
      ...l,
      tenant_id: ctx.tenantId,
      journal_entry_id: entry!.id,
      line_number: i + 1,
      entity_id: entity.id,
      period_id: period.id,
      entry_date: draft.date,
    })),
  );
  return { entry: entry!, warnings: violations.filter((v) => v.severity === 'warning') };
}

/** Post an entry: the database re-validates balance, period state and accounts in the same transaction. */
export async function postEntry(tx: Tx, ctx: DomainContext, entryId: string, basis: PostBasis): Promise<Row<'journal_entries'>> {
  const entry = await tx.get('journal_entries', entryId, { forUpdate: true });
  if (!entry) throw new DomainError('NOT_FOUND', `Journal entry ${entryId} not found`);
  if (entry.status === 'posted') return entry;
  if (entry.status === 'rejected') throw new DomainError('CONFLICT', 'A rejected entry cannot be posted');
  if (basis.basis === 'human_approval') {
    if (!basis.approvedBy) throw new DomainError('VALIDATION', 'Human approval requires an approver');
    if (basis.approvedBy === entry.prepared_by) throw new DomainError('SOD_VIOLATION', 'Maker-checker: you cannot approve an entry you prepared');
  }
  const now = ctx.clock.now();
  try {
    return await tx.update('journal_entries', entryId, {
      status: 'posted',
      approval_basis: basis.basis,
      approved_by: basis.approvedBy ?? null,
      approved_at: basis.approvedBy ? now : null,
      posted_at: now,
      posted_by: basis.postedBy ?? null,
      posted_by_run_id: basis.postedByRunId ?? null,
    });
  } catch (e) {
    if (isDbConstraintError(e)) {
      if (e.kind === 'period_locked') throw new DomainError('PERIOD_LOCKED', e.message);
      throw new DomainError('INVARIANT', e.message, { constraint: e.constraint });
    }
    throw e;
  }
}

export async function createAndPost(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  draft: EntryDraft,
  meta: EntryMeta,
  basis: PostBasis,
): Promise<Row<'journal_entries'>> {
  const { entry } = await createEntry(tx, ctx, lookups, draft, { ...meta, status: 'pending_approval' });
  return postEntry(tx, ctx, entry.id, basis);
}

/**
 * Reverse a posted entry (the only way to change posted numbers; also how "undo" works).
 * The reversal mirrors every line, references the original and posts on `date` (default: first day of the
 * next open period when the original's period is closed, else the original date).
 */
export async function reverseEntry(
  tx: Tx,
  ctx: DomainContext,
  lookups: LedgerLookups,
  entryId: string,
  opts: { date?: string; reason: string; basis: PostBasis; preparedBy?: string | null; proposalId?: string | null; idempotencyKey?: string },
): Promise<Row<'journal_entries'>> {
  const original = await tx.get('journal_entries', entryId);
  if (!original) throw new DomainError('NOT_FOUND', `Journal entry ${entryId} not found`);
  if (original.status !== 'posted') throw new DomainError('CONFLICT', 'Only posted entries can be reversed');
  const already = await tx.findOne('journal_entries', { reverses_entry_id: entryId });
  if (already) throw new DomainError('CONFLICT', `Entry ${original.entry_number} was already reversed by ${already.entry_number}`);
  const lines = await tx.find('journal_lines', { journal_entry_id: entryId }, { orderBy: [['line_number', 'asc']] });
  let date = opts.date;
  if (!date) {
    const period = lookups.periodsById.get(original.period_id);
    date = period && period.status === 'open' ? original.entry_date : (lookups.periodsOf(original.entity_id).find((p) => p.status === 'open')?.start_date ?? original.entry_date);
  }
  const entity = lookups.entitiesById.get(original.entity_id)!;
  const draft: EntryDraft = {
    entity: entity.id,
    date,
    type: 'reversing',
    description: `Reversal of ${original.entry_number}: ${opts.reason}`,
    currency: original.currency,
    fxRate: original.fx_rate,
    reversesEntryId: original.id,
    lines: lines.map((l) => ({
      account: l.account_id,
      debit: l.credit_minor,
      credit: l.debit_minor,
      department: l.department_id,
      location: l.location_id,
      class: l.class_id,
      project: l.project_id,
      counterpartyEntity: l.counterparty_entity_id,
      vendorId: l.vendor_id,
      customerId: l.customer_id,
      memo: l.memo,
      txnCurrency: l.txn_currency,
      txnAmount: -l.txn_amount_minor,
    })),
  };
  const reversal = await createAndPost(
    tx,
    ctx,
    lookups,
    draft,
    {
      source: ctx.actor.type === 'agent' ? 'agent' : ctx.actor.type === 'system' ? 'system' : 'manual',
      sourceModule: original.source_module,
      preparedBy: opts.preparedBy ?? null,
      proposalId: opts.proposalId ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
    },
    opts.basis,
  );
  await appendAudit(tx, ctx.tenantId, ctx.actor, {
    action: 'journal_entry.reverse',
    objectType: 'journal_entry',
    objectId: original.id,
    summary: `Reversed ${original.entry_number} with ${reversal.entry_number}: ${opts.reason}`,
    details: { reversal_id: reversal.id, reason: opts.reason },
  }, ctx.clock.now());
  return reversal;
}

/** Convert a functional amount to the reporting currency at a rate (helper for previews). */
export function toReporting(minor: number, rate: number): number {
  return convertMinor(minor, rate);
}
