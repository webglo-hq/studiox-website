/**
 * Journal entry lifecycle: draft → pending_approval → approved → posted; corrections only by
 * reversal (AX-IM-01). Every step is validated against the ontology's executable axioms here,
 * and re-checked by database triggers at posting time (defense in depth).
 */
import type { Actor } from '../../../core/agent/types';
import { audit } from '../../../core/audit/audit';
import type { AxiomOutcome } from '../../../core/ontology/types';
import { conflict, forbidden, invariant, notFound, validation } from '../../../core/util/errors';
import { addDays, periodKeyOf, periodStart, shiftPeriod, type Clock } from '../../../core/util/time';
import type { DbTx, JournalEntryRow, JournalLineRow, PeriodRow } from '../../../schema';
import type { EntryFacts, LineFact } from '../ontology/axioms';
import { closeOntology } from '../ontology';
import { Chart, findPeriod } from './chart';

export type EntryType = JournalEntryRow['entry_type'];
export type EntrySource = JournalEntryRow['source'];

export interface JournalLineInput {
  account: string;
  debit?: number;
  credit?: number;
  memo?: string | null;
  department?: string | null;
  location?: string | null;
  product_class?: string | null;
  project?: string | null;
  txn_currency?: string | null;
  txn_amount_minor?: number | null;
  fx_rate?: number | null;
  counterparty_entity_id?: string | null;
  source_line_ref?: string | null;
}

export interface JournalDraftInput {
  entityId: string;
  postingDate: string;
  entryType: EntryType;
  memo: string;
  source: EntrySource;
  preparedBy: string;
  lines: JournalLineInput[];
  sourceRef?: string | null;
  sourceDocumentId?: string | null;
  proposalId?: string | null;
  agentRunId?: string | null;
  autoReverseOn?: string | null;
  reversesJeId?: string | null;
  counterpartyEntityId?: string | null;
  idempotencyKey?: string | null;
}

export interface LedgerCtx {
  tx: DbTx;
  actor: Actor;
  clock: Clock;
  chart?: Chart;
}

async function chartOf(ctx: LedgerCtx): Promise<Chart> {
  if (!ctx.chart) ctx.chart = await Chart.load(ctx.tx);
  return ctx.chart;
}

/** Build ontology facts for an entry and evaluate every applicable axiom. */
export async function evaluateEntry(ctx: LedgerCtx, input: JournalDraftInput, period?: PeriodRow): Promise<{ facts: EntryFacts; outcomes: AxiomOutcome[]; period: PeriodRow }> {
  const chart = await chartOf(ctx);
  const p = period ?? (await findPeriod(ctx.tx, input.entityId, periodKeyOf(input.postingDate)));
  const lines: LineFact[] = input.lines.map((l) => {
    const a = chart.tryAccount(l.account);
    return {
      debit_minor: l.debit ?? 0,
      credit_minor: l.credit ?? 0,
      ...(a
        ? { account: { code: a.code, is_postable: a.is_postable, status: a.status, required_dimensions: a.required_dimensions, account_class: a.account_class, control_subledger: a.control_subledger, is_intercompany: a.is_intercompany } }
        : {}),
      department: l.department ?? null,
      location: l.location ?? null,
      product_class: l.product_class ?? null,
      project: l.project ?? null,
    };
  });
  let reverses: { status: string } | null = null;
  if (input.reversesJeId) {
    const orig = await ctx.tx.get('journal_entries', input.reversesJeId);
    reverses = orig ? { status: orig.status } : { status: 'missing' };
  }
  const facts: EntryFacts = {
    lines,
    entry_type: input.entryType,
    posting_date: input.postingDate,
    period: { period_key: p.period_key, status: p.status, start_date: p.start_date, end_date: p.end_date },
    prepared_by: input.preparedBy,
    source: input.source,
    auto_reverse_on: input.autoReverseOn ?? null,
    next_period_start: periodStart(shiftPeriod(p.period_key, 1)),
    reverses,
  };
  const outcomes = closeOntology().validate('tie:JournalEntry', facts);
  if (input.entryType === 'accrual') outcomes.push(closeOntology().check('AX-ACR-01', facts));
  if (input.entryType === 'elimination') outcomes.push(closeOntology().check('AX-IC-02', facts));
  const unknown = input.lines.filter((l) => !chart.tryAccount(l.account)).map((l) => l.account);
  if (unknown.length) outcomes.push({ axiomId: 'AX-AC-01', title: 'Post to active leaf accounts', passed: false, severity: 'error', messages: unknown.map((c) => `account ${c} does not exist`) });
  return { facts, outcomes, period: p };
}

export function blockingMessages(outcomes: readonly AxiomOutcome[], opts: { allowClosedPeriod?: boolean } = {}): string[] {
  return outcomes
    .filter((o) => !o.passed && o.severity === 'error' && !(opts.allowClosedPeriod && o.axiomId === 'AX-PD-01'))
    .flatMap((o) => o.messages.map((m) => `${o.axiomId}: ${m}`));
}

async function nextNumber(ctx: LedgerCtx, entityId: string, periodKey: string): Promise<string> {
  const chart = await chartOf(ctx);
  const code = chart.shortCode(entityId);
  const n = await ctx.tx.nextCounter(`je:${code}:${periodKey}`);
  return `JE-${periodKey}-${code}-${String(n).padStart(4, '0')}`;
}

/** Create a validated draft (or pending/approved) entry. Throws on any blocking axiom violation. */
export async function createJournalEntry(ctx: LedgerCtx, input: JournalDraftInput, status: 'draft' | 'pending_approval' = 'draft'): Promise<JournalEntryRow> {
  if (input.idempotencyKey) {
    const existing = await ctx.tx.findOne('journal_entries', { idempotency_key: input.idempotencyKey });
    if (existing) return existing;
  }
  const { outcomes, period } = await evaluateEntry(ctx, input);
  const errors = blockingMessages(outcomes);
  if (errors.length) throw invariant(errors[0]!.split(':')[0]!, errors.map((e) => e.replace(/^AX-[A-Z]+-\d+: /, '')).join('; '), { violations: errors });
  const chart = await chartOf(ctx);
  const entity = chart.entity(input.entityId);
  const total = input.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const now = ctx.clock.now().toISOString();
  const je = await ctx.tx.insert('journal_entries', {
    entity_id: input.entityId,
    period_id: period.id,
    je_number: await nextNumber(ctx, input.entityId, period.period_key),
    entry_type: input.entryType,
    status: 'draft',
    posting_date: input.postingDate,
    memo: input.memo,
    source: input.source,
    source_ref: input.sourceRef ?? null,
    source_document_id: input.sourceDocumentId ?? null,
    proposal_id: input.proposalId ?? null,
    agent_run_id: input.agentRunId ?? null,
    currency: entity.functional_currency,
    total_minor: total,
    prepared_by: input.preparedBy,
    reverses_je_id: input.reversesJeId ?? null,
    auto_reverse_on: input.autoReverseOn ?? null,
    counterparty_entity_id: input.counterpartyEntityId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    created_at: now,
    updated_at: now,
  });
  await ctx.tx.insertMany(
    'journal_lines',
    input.lines.map((l, i) => ({
      journal_entry_id: je.id,
      line_no: i + 1,
      account_id: chart.account(l.account).id,
      debit_minor: l.debit ?? 0,
      credit_minor: l.credit ?? 0,
      memo: l.memo ?? null,
      department: l.department ?? null,
      location: l.location ?? null,
      product_class: l.product_class ?? null,
      project: l.project ?? null,
      txn_currency: l.txn_currency ?? null,
      txn_amount_minor: l.txn_amount_minor ?? null,
      fx_rate: l.fx_rate ?? null,
      counterparty_entity_id: l.counterparty_entity_id ?? null,
      source_line_ref: l.source_line_ref ?? null,
    })),
  );
  const out = status === 'draft' ? je : await ctx.tx.update('journal_entries', je.id, { status, updated_at: now });
  await audit(ctx.tx, ctx.actor, ctx.clock, {
    action: 'je.create',
    subjectType: 'journal_entry',
    subjectId: je.id,
    entityId: input.entityId,
    summary: `${je.je_number} drafted (${input.entryType}, ${(total / 100).toFixed(2)} ${entity.functional_currency})`,
    data: { status: out.status, source: input.source, proposalId: input.proposalId ?? null },
  });
  return out;
}

export interface ApprovalOptions {
  route: 'human' | 'policy' | 'system';
  approverId: string;
  policyRef?: string;
  reason?: string;
}

/** Approve and post in one step (the normal path once a checker approves). */
export async function approveAndPost(ctx: LedgerCtx, jeId: string, opts: ApprovalOptions): Promise<JournalEntryRow> {
  const je = await ctx.tx.get('journal_entries', jeId);
  if (!je) throw notFound('Journal entry', jeId);
  if (je.status === 'posted') return je;
  if (!['draft', 'pending_approval', 'approved'].includes(je.status)) throw conflict(`Journal entry ${je.je_number} is ${je.status}`);
  if (opts.route === 'human' && opts.approverId === je.prepared_by) throw invariant('AX-SOD-01', `${je.je_number}: the preparer cannot approve their own entry`);
  // Re-verify now (the period may have changed state since drafting).
  const lines = await ctx.tx.find('journal_lines', { journal_entry_id: je.id }, { orderBy: [['line_no', 'asc']] });
  const chart = await chartOf(ctx);
  const { outcomes } = await evaluateEntry(ctx, entryInputFromRows(je, lines, chart));
  const errors = blockingMessages(outcomes);
  if (errors.length) throw invariant(errors[0]!.split(':')[0]!, errors.join('; '));
  const now = ctx.clock.now().toISOString();
  const posted = await ctx.tx.update('journal_entries', je.id, {
    status: 'posted',
    approved_by: opts.approverId,
    approval_route: opts.route,
    posted_by: ctx.actor.id,
    posted_at: now,
    updated_at: now,
  });
  await ctx.tx.insert('approvals', {
    subject_type: 'journal_entry',
    subject_id: je.id,
    decision: 'approved',
    actor_type: opts.route === 'policy' ? 'policy' : 'user',
    actor_id: opts.approverId,
    policy_ref: opts.policyRef ?? (opts.route === 'policy' ? 'policy' : null),
    reason: opts.reason ?? null,
    at: now,
  });
  await audit(ctx.tx, ctx.actor, ctx.clock, {
    action: 'je.post',
    subjectType: 'journal_entry',
    subjectId: je.id,
    entityId: je.entity_id,
    summary: `${je.je_number} approved (${opts.route}) and posted`,
    data: { approvedBy: opts.approverId, route: opts.route, policyRef: opts.policyRef ?? null },
  });
  return posted;
}

export async function rejectJournalEntry(ctx: LedgerCtx, jeId: string, reason: string): Promise<JournalEntryRow> {
  if (!reason || reason.trim().length < 3) throw validation('A rejection needs a reason');
  const je = await ctx.tx.get('journal_entries', jeId);
  if (!je) throw notFound('Journal entry', jeId);
  if (je.status === 'posted') throw invariant('AX-IM-01', 'posted entries cannot be rejected; reverse instead');
  const out = await ctx.tx.update('journal_entries', jeId, { status: 'rejected', updated_at: ctx.clock.now().toISOString() });
  await audit(ctx.tx, ctx.actor, ctx.clock, { action: 'je.reject', subjectType: 'journal_entry', subjectId: jeId, entityId: je.entity_id, summary: `${je.je_number} rejected: ${reason}`, data: { reason } });
  return out;
}

export function entryInputFromRows(je: JournalEntryRow, lines: readonly JournalLineRow[], chart: Chart): JournalDraftInput {
  return {
    entityId: je.entity_id,
    postingDate: je.posting_date,
    entryType: je.entry_type,
    memo: je.memo,
    source: je.source,
    preparedBy: je.prepared_by,
    autoReverseOn: je.auto_reverse_on,
    reversesJeId: je.reverses_je_id,
    lines: lines.map((l) => ({
      account: chart.account(l.account_id).code,
      debit: l.debit_minor,
      credit: l.credit_minor,
      memo: l.memo,
      department: l.department,
      location: l.location,
      product_class: l.product_class,
      project: l.project,
      txn_currency: l.txn_currency,
      txn_amount_minor: l.txn_amount_minor,
      fx_rate: l.fx_rate,
      counterparty_entity_id: l.counterparty_entity_id,
    })),
  };
}

/** The lines that cancel an entry exactly: same accounts and dimensions, debits and credits swapped (AX-IM-02). */
export function reversalLines(je: JournalEntryRow, lines: readonly JournalLineRow[], chart: Chart): JournalLineInput[] {
  return entryInputFromRows(je, lines, chart).lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, txn_amount_minor: l.txn_amount_minor === null || l.txn_amount_minor === undefined ? l.txn_amount_minor : -l.txn_amount_minor }));
}

/**
 * Build the reversing entry for a posted JE (AX-IM-01/02). Manual reversals go to approval;
 * system reversals (accrual auto-reversal) post immediately.
 */
export async function reverseJournalEntry(ctx: LedgerCtx, jeId: string, opts: { postingDate: string; reason: string; preparedBy: string; post: 'system' | 'approval' }): Promise<JournalEntryRow> {
  const je = await ctx.tx.get('journal_entries', jeId);
  if (!je) throw notFound('Journal entry', jeId);
  if (je.status !== 'posted') throw invariant('AX-IM-02', `${je.je_number} is ${je.status}; only posted entries can be reversed`);
  const existing = await ctx.tx.findOne('journal_entries', { reverses_je_id: jeId });
  if (existing && existing.status !== 'rejected') throw conflict(`${je.je_number} already has a reversal (${existing.je_number})`);
  if (!opts.reason || opts.reason.trim().length < 3) throw validation('A reversal needs a reason');
  const chart = await chartOf(ctx);
  const lines = await ctx.tx.find('journal_lines', { journal_entry_id: jeId }, { orderBy: [['line_no', 'asc']] });
  const input: JournalDraftInput = {
    ...entryInputFromRows(je, lines, chart),
    postingDate: opts.postingDate,
    entryType: 'reversing',
    memo: `Reversal of ${je.je_number} (${je.memo.slice(0, 90)}): ${opts.reason}`.slice(0, 500),
    source: opts.post === 'system' ? 'system' : 'manual',
    preparedBy: opts.preparedBy,
    reversesJeId: jeId,
    autoReverseOn: null,
    idempotencyKey: `reversal:${jeId}`,
    lines: reversalLines(je, lines, chart),
  };
  const draft = await createJournalEntry(ctx, input, opts.post === 'system' ? 'draft' : 'pending_approval');
  if (opts.post === 'system') return approveAndPost(ctx, draft.id, { route: 'system', approverId: 'system:auto-reversal', reason: opts.reason });
  return draft;
}

/** Post due auto-reversals (accruals dated in the prior period reversing on or before `asOf`). */
export async function runAutoReversals(ctx: LedgerCtx, entityId: string, asOf: string): Promise<JournalEntryRow[]> {
  const due = await ctx.tx.find('journal_entries', { entity_id: entityId, status: 'posted', auto_reverse_on: { lte: asOf } });
  const out: JournalEntryRow[] = [];
  for (const je of due) {
    const already = await ctx.tx.findOne('journal_entries', { reverses_je_id: je.id });
    if (already) continue;
    const period = await ctx.tx.findOne('periods', { entity_id: entityId, period_key: periodKeyOf(je.auto_reverse_on!) });
    if (!period || period.status !== 'open') continue;
    out.push(await reverseJournalEntry(ctx, je.id, { postingDate: je.auto_reverse_on!, reason: 'scheduled auto-reversal of accrual', preparedBy: 'system:auto-reversal', post: 'system' }));
  }
  return out;
}

export async function getJournalEntry(tx: DbTx, id: string) {
  const entry = await tx.get('journal_entries', id);
  if (!entry) throw notFound('Journal entry', id);
  const chart = await Chart.load(tx);
  const lines = (await tx.find('journal_lines', { journal_entry_id: id }, { orderBy: [['line_no', 'asc']] })).map((l) => {
    const a = chart.account(l.account_id);
    return { ...l, account_code: a.code, account_name: a.name };
  });
  const reversal = await tx.findOne('journal_entries', { reverses_je_id: id });
  return { entry, lines, reversal: reversal ?? null };
}

export function assertCanPrepare(actor: Actor) {
  if (!actor.permissions.has('je.create') && actor.type === 'user') throw forbidden('You do not have permission to prepare journal entries');
}

export const nextDay = (iso: string) => addDays(iso, 1);
