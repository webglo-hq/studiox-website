import { z } from 'zod';
import type { ApplyArgs, PackScope, ProposalDraft, ProposalHandler, VerificationCheck } from '../../agents/framework/types';
import { appendAudit } from '../../audit/audit';
import type { Tx } from '../../persistence/db';
import { JOURNAL_ENTRY_TYPES, type Row } from '../../persistence/schema';
import { canonicalJson } from '../../shared/canonical-json';
import type { DomainContext } from '../../shared/context';
import { addMonths, monthEnd } from '../../shared/dates';
import { DomainError } from '../../shared/errors';
import { sha256Hex } from '../../shared/hash';
import { depreciationPlan, straightLine } from './algorithms/schedules';
import { completeTask } from './domain/close';
import { createAndPost, DEFAULT_CAPITALIZATION_THRESHOLD_MINOR, type EntryDraft, errorsOf, type PostBasis, reverseEntry, verifyDraft } from './domain/ledger';
import { postCardTransaction } from './domain/subledgers';
import { closeOntology } from './ontology';
import type { AccountingScope } from './scope';
import { publishPackage, type ClosePackageContent } from './services/package';
import { ensureReconciliation, refreshReconciliation } from './services/recon';

/** Proposal kinds for the accounting pack: payload schemas, deterministic verification and effects. */

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'expected an id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const LineSchema = z
  .object({
    account: z.string().min(1).describe('Account number, e.g. "6510"'),
    debit: z.number().int().nonnegative().optional().describe('Debit in minor units (cents)'),
    credit: z.number().int().nonnegative().optional().describe('Credit in minor units (cents)'),
    department: z.string().nullable().optional().describe('Department code, e.g. "GA"'),
    counterpartyEntity: z.string().nullable().optional().describe('Counterparty entity code for intercompany lines'),
    vendorId: uuid.nullable().optional(),
    customerId: uuid.nullable().optional(),
    memo: z.string().max(300).nullable().optional(),
    txnCurrency: z.string().length(3).optional().describe('Transaction currency when different from the entity currency'),
    txnAmount: z.number().int().optional().describe('Signed transaction-currency amount (debit positive)'),
  })
  .strict();

export const EntrySchema = z
  .object({
    entity: z.string().min(2).describe('Entity code, e.g. "BW-US"'),
    date: isoDate,
    type: z.enum(JOURNAL_ENTRY_TYPES).default('adjusting'),
    description: z.string().min(5).max(300),
    lines: z.array(LineSchema).min(2).max(200),
    autoReverseDate: isoDate.nullable().optional(),
    currency: z.string().length(3).optional(),
    fxRate: z.number().positive().optional(),
    icReference: z.string().max(80).nullable().optional(),
    counterpartyEntity: z.string().nullable().optional(),
  })
  .strict();

export type EntryInput = z.infer<typeof EntrySchema>;

export function toDraft(e: EntryInput): EntryDraft {
  return {
    entity: e.entity,
    date: e.date,
    type: e.type,
    description: e.description,
    autoReverseDate: e.autoReverseDate ?? null,
    currency: e.currency,
    fxRate: e.fxRate,
    icReference: e.icReference ?? null,
    counterpartyEntity: e.counterpartyEntity ?? null,
    lines: e.lines.map((l) => ({ ...l })),
  };
}

export const JournalEntryPayload = z
  .object({
    entry: EntrySchema.optional(),
    reversesEntryId: uuid.optional(),
    reason: z.string().max(300).optional(),
    sourceModule: z.enum(['gl', 'ap', 'ar', 'bank', 'card', 'fixed_assets', 'prepaid', 'payroll', 'intercompany', 'fx', 'revenue']).default('gl'),
    links: z
      .object({
        amortizationLineIds: z.array(uuid).optional(),
        depreciationLineIds: z.array(uuid).optional(),
        reconcilingItemIds: z.array(uuid).optional(),
        bankTransactionIds: z.array(uuid).optional(),
        voidBillIds: z.array(uuid).optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .refine((p) => !!p.entry !== !!p.reversesEntryId, 'provide either entry or reversesEntryId');

export const CodingPayload = z
  .object({
    cardTransactionId: uuid,
    accountNumber: z.string().min(1),
    departmentCode: z.string().nullable(),
    source: z.enum(['rule', 'history', 'agent']).default('agent'),
  })
  .strict();

export const RecMatchPayload = z
  .object({
    bankAccountId: uuid,
    periodId: uuid,
    matchType: z.enum(['exact', 'fuzzy', 'one_to_many', 'many_to_one', 'many_to_many', 'manual']),
    rule: z.string().max(200),
    explanation: z.string().max(600),
    bankTransactionIds: z.array(uuid).min(1).max(20),
    journalLineIds: z.array(uuid).min(1).max(20),
  })
  .strict();

export const ReconcilingItemPayload = z
  .object({
    bankAccountId: uuid.nullable(),
    accountNumber: z.string(),
    entityId: uuid,
    periodId: uuid,
    kind: z.enum(['deposit_in_transit', 'outstanding_check', 'bank_fee', 'interest', 'bank_error', 'book_error', 'timing_difference', 'unrecorded_transaction', 'fx_difference', 'unexplained']),
    description: z.string().min(3).max(300),
    amountMinor: z.number().int().refine((n) => n !== 0, 'amount cannot be zero'),
    itemDate: isoDate,
    expectedClearDate: isoDate.nullable().optional(),
    clearedDate: isoDate.nullable().optional(),
    bankTransactionId: uuid.nullable().optional(),
    journalLineId: uuid.nullable().optional(),
  })
  .strict();

export const FluxExplanationPayload = z
  .object({
    fluxLineId: uuid,
    explanation: z.string().min(20).max(1500),
    drivers: z.array(z.object({ kind: z.enum(['reclass', 'fx', 'other', 'vendor', 'department', 'customer', 'new_item', 'one_time', 'volume', 'price', 'timing']), label: z.string(), amount_minor: z.number().int(), evidence: z.array(z.object({ type: z.string(), id: z.string(), label: z.string() })).optional() })).max(10),
    coverage: z.number().min(0).max(1).optional(),
  })
  .strict();

const Resolution = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('reverse_entry'), entryId: uuid, reason: z.string().min(5).max(300) }).strict(),
  z.object({ type: z.literal('journal_entry'), entry: EntrySchema, voidBillIds: z.array(uuid).optional() }).strict(),
]);

export const AnomalyPayload = z
  .object({
    category: z.string().min(3).max(60),
    severity: z.enum(['high', 'medium', 'low']),
    subjectIds: z.array(z.string()).max(30),
    vendorIds: z.array(uuid).optional(),
    recommendedAction: z.string().min(5).max(600),
    resolution: Resolution,
  })
  .strict();

export const SchedulePayload = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('prepaid'),
      entity: z.string(),
      vendorId: uuid.nullable(),
      billId: uuid.nullable(),
      description: z.string().min(5),
      balanceAccount: z.string(),
      plAccount: z.string(),
      department: z.string().nullable(),
      totalMinor: z.number().int().positive(),
      startDate: isoDate,
      months: z.number().int().min(1).max(60),
      catchUpThrough: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
      catchUpEntry: EntrySchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('capitalize'),
      entity: z.string(),
      description: z.string().min(5),
      assetClass: z.enum(['computer_equipment', 'furniture_fixtures', 'leasehold_improvements', 'machinery', 'software', 'vehicles']),
      usefulLifeMonths: z.number().int().min(12).max(480),
      inServiceDate: isoDate,
      costMinor: z.number().int().positive(),
      assetAccount: z.string(),
      department: z.string().nullable(),
      vendorId: uuid.nullable(),
      sourceCardTransactionId: uuid.nullable(),
      reclass: EntrySchema,
    })
    .strict(),
]);

export const PackagePayload = z
  .object({
    action: z.literal('publish_close_package'),
    closeId: uuid,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    content: z.record(z.string(), z.unknown()),
  })
  .strict();

type S = AccountingScope;

// ------------------------------------------------------------------ helpers

function axiomChecks(scope: PackScope<S>, draft: EntryDraft, prefix = ''): VerificationCheck[] {
  const { violations } = verifyDraft(scope.pack.lookups, draft, { capitalizationThresholdMinor: DEFAULT_CAPITALIZATION_THRESHOLD_MINOR });
  const checks: VerificationCheck[] = violations.map((v) => ({ id: `${prefix}${v.axiom}`, label: v.message, passed: false, severity: v.severity === 'error' ? 'error' : 'warning', message: v.message }));
  if (!errorsOf(violations).length) checks.push({ id: `${prefix}AXIOMS`, label: 'Journal entry passes the ontology axioms (balance, period, accounts, dimensions, FX)', passed: true, severity: 'error' });
  return checks;
}

function basisOf(args: ApplyArgs<S>): PostBasis {
  return { basis: args.basis, approvedBy: args.approvedBy, postedByRunId: args.basis === 'autonomy_policy' ? args.runId : null };
}

async function postWithReversal(args: ApplyArgs<S>, entry: EntryInput, sourceModule: Row<'journal_entries'>['source_module'], salt = ''): Promise<{ entry: Row<'journal_entries'>; reversal: Row<'journal_entries'> | null }> {
  const { tx, ctx, pack, proposal } = args;
  const posted = await createAndPost(
    tx,
    ctx,
    pack.lookups,
    toDraft(entry),
    { source: 'agent', sourceModule, preparedByRunId: proposal.run_id, proposalId: proposal.id, idempotencyKey: `proposal:${proposal.id}${salt}` },
    basisOf(args),
  );
  let reversal: Row<'journal_entries'> | null = null;
  if (entry.autoReverseDate) {
    const target = pack.lookups.periodFor(posted.entity_id, entry.autoReverseDate);
    if (target && target.status === 'open') {
      reversal = await reverseEntry(tx, ctx, pack.lookups, posted.id, { date: entry.autoReverseDate, reason: 'automatic reversal of accrual', basis: { basis: 'reversal_exemption', postedByRunId: proposal.run_id }, proposalId: proposal.id, idempotencyKey: `proposal:${proposal.id}${salt}:reversal` });
    }
  }
  return { entry: posted, reversal };
}

async function bankGlLines(tx: Tx, entry: Row<'journal_entries'>, bank: Row<'bank_accounts'>): Promise<Row<'journal_lines'>[]> {
  return (await tx.find('journal_lines', { journal_entry_id: entry.id })).filter((l) => l.account_id === bank.gl_account_id);
}

export async function maybeCompleteTask(scope: PackScope<S>, taskId: string, runId: string | null): Promise<void> {
  const { tx, ctx } = scope;
  const task = await tx.get('close_tasks', taskId);
  if (!task || ['done', 'skipped', 'ready_for_review'].includes(task.status)) return;
  const open = (await tx.find('proposals', { close_task_id: taskId })).filter((p) => p.status === 'pending' || p.status === 'blocked');
  if (open.length) {
    await tx.update('close_tasks', taskId, { status: 'in_progress', blocked_reason: `${open.length} item${open.length === 1 ? '' : 's'} waiting for approval in the inbox` });
    return;
  }
  const lastRun = runId ?? task.last_run_id;
  if (!lastRun) return;
  const run = await tx.get('agent_runs', lastRun);
  if (!run || run.status !== 'completed') return;
  try {
    await completeTask(tx, ctx, taskId, { runId: lastRun, note: 'Agent work complete; every proposal decided' });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'CONFLICT') await tx.update('close_tasks', taskId, { blocked_reason: e.message });
    else throw e;
  }
}

// ------------------------------------------------------------------ handlers

const journalEntry: ProposalHandler<S> = {
  kind: 'journal_entry',
  label: 'Journal entry',
  payload: JournalEntryPayload,
  permission: 'proposal.decide',
  autoApplicable: true,
  async verify(draft, scope) {
    const p = JournalEntryPayload.parse(draft.payload);
    const checks: VerificationCheck[] = [];
    if (p.reversesEntryId) {
      const original = await scope.tx.get('journal_entries', p.reversesEntryId);
      checks.push({ id: 'REV-POSTED', label: 'Entry to reverse is posted', passed: original?.status === 'posted', severity: 'error', message: 'the entry to reverse is not posted' });
      const already = original ? await scope.tx.findOne('journal_entries', { reverses_entry_id: original.id }) : null;
      checks.push({ id: 'REV-ONCE', label: 'Not already reversed', passed: !already, severity: 'error', message: `already reversed by ${already?.entry_number}` });
      return checks;
    }
    checks.push(...axiomChecks(scope, toDraft(p.entry!)));
    const period = scope.pack.lookups.periodFor(scope.pack.lookups.entity(p.entry!.entity)?.id ?? '', p.entry!.date);
    for (const id of p.links.amortizationLineIds ?? []) {
      const line = await scope.tx.get('amortization_lines', id);
      checks.push({ id: 'LINK-AMORT', label: 'Amortization line is scheduled for this period', passed: !!line && line.status === 'scheduled' && line.period_id === period?.id, severity: 'error', message: `amortization line ${id} is not scheduled in this period` });
    }
    for (const id of p.links.depreciationLineIds ?? []) {
      const line = await scope.tx.get('depreciation_lines', id);
      checks.push({ id: 'LINK-DEPR', label: 'Depreciation line is scheduled for this period', passed: !!line && line.status === 'scheduled' && line.period_id === period?.id, severity: 'error', message: `depreciation line ${id} is not scheduled in this period` });
    }
    for (const id of p.links.bankTransactionIds ?? []) {
      const b = await scope.tx.get('bank_transactions', id);
      checks.push({ id: 'LINK-BANK', label: 'Bank line is unmatched', passed: !!b && b.status === 'unmatched', severity: 'error', message: `bank line ${id} is already matched` });
    }
    return checks;
  },
  async apply(args) {
    const p = JournalEntryPayload.parse(args.proposal.payload);
    const { tx, ctx, pack, proposal } = args;
    if (p.reversesEntryId) {
      const reversal = await reverseEntry(tx, ctx, pack.lookups, p.reversesEntryId, { reason: p.reason ?? proposal.title, basis: basisOf(args), proposalId: proposal.id, idempotencyKey: `proposal:${proposal.id}` });
      return { effect: { reversalEntryId: reversal.id, reversalNumber: reversal.entry_number }, postedEntryId: reversal.id };
    }
    const { entry, reversal } = await postWithReversal(args, p.entry!, p.sourceModule);
    const now = ctx.clock.now();
    for (const id of p.links.amortizationLineIds ?? []) await tx.update('amortization_lines', id, { status: 'posted', journal_entry_id: entry.id });
    for (const id of p.links.depreciationLineIds ?? []) await tx.update('depreciation_lines', id, { status: 'posted', journal_entry_id: entry.id });
    for (const id of p.links.reconcilingItemIds ?? []) await tx.update('reconciling_items', id, { status: 'resolved', cleared_date: entry.entry_date, resolution_entry_id: entry.id });
    for (const id of p.links.voidBillIds ?? []) await tx.update('bills', id, { status: 'void' });
    if (p.links.bankTransactionIds?.length) {
      const first = await tx.get('bank_transactions', p.links.bankTransactionIds[0]!);
      const bank = first ? await tx.get('bank_accounts', first.bank_account_id) : null;
      if (first && bank) {
        const period = pack.lookups.periodFor(bank.entity_id, first.booking_date) ?? pack.lookups.periodFor(bank.entity_id, entry.entry_date)!;
        const rec = await ensureReconciliation(tx, ctx, pack.lookups, { entityId: bank.entity_id, periodId: period.id, recType: 'bank', accountId: bank.gl_account_id, bankAccountId: bank.id });
        const lines = await bankGlLines(tx, entry, bank);
        const match = await tx.insert('rec_matches', { tenant_id: ctx.tenantId, reconciliation_id: rec.id, match_type: 'exact', status: 'accepted', confidence: 1, rule: 'entry booked for bank-only item', explanation: `Booked ${entry.entry_number} for the bank-only item`, proposal_id: proposal.id, accepted_by: args.approvedBy, accepted_at: now });
        for (const id of p.links.bankTransactionIds) {
          const b = (await tx.get('bank_transactions', id))!;
          await tx.insert('rec_match_items', { tenant_id: ctx.tenantId, match_id: match.id, side: 'external', bank_transaction_id: id, amount_minor: b.amount_minor });
          await tx.update('bank_transactions', id, { status: 'matched' });
        }
        for (const l of lines) await tx.insert('rec_match_items', { tenant_id: ctx.tenantId, match_id: match.id, side: 'ledger', journal_line_id: l.id, amount_minor: l.debit_minor - l.credit_minor });
        await refreshReconciliation(tx, rec.id);
      }
    }
    return { effect: { entryId: entry.id, entryNumber: entry.entry_number, reversalEntryId: reversal?.id ?? null, reversalNumber: reversal?.entry_number ?? null }, postedEntryId: entry.id };
  },
  sodSubjects(proposal) {
    const p = proposal.payload as { entry?: { lines?: Array<{ vendorId?: string | null }> } };
    return { vendorIds: [...new Set((p.entry?.lines ?? []).map((l) => l.vendorId).filter((x): x is string => !!x))] };
  },
};

const transactionCoding: ProposalHandler<S> = {
  kind: 'transaction_coding',
  label: 'Transaction coding',
  payload: CodingPayload,
  permission: 'proposal.decide',
  autoApplicable: true,
  async verify(draft, scope) {
    const p = CodingPayload.parse(draft.payload);
    const txn = await scope.tx.get('card_transactions', p.cardTransactionId);
    const checks: VerificationCheck[] = [{ id: 'CARD-PENDING', label: 'Card transaction is uncoded', passed: !!txn && txn.status === 'pending', severity: 'error', message: 'the card transaction is already coded or missing' }];
    if (!txn) return checks;
    const card = await scope.tx.get('cards', txn.card_id);
    const draftEntry: EntryDraft = {
      entity: txn.entity_id,
      date: txn.transaction_date,
      description: `Card: ${txn.merchant_name}`,
      lines: [
        { account: p.accountNumber, debit: Math.max(0, txn.amount_minor), credit: Math.max(0, -txn.amount_minor), department: p.departmentCode, memo: txn.merchant_name },
        { account: card?.liability_account_id ?? '', debit: Math.max(0, -txn.amount_minor), credit: Math.max(0, txn.amount_minor) },
      ],
    };
    return [...checks, ...axiomChecks(scope, draftEntry)];
  },
  async apply(args) {
    const p = CodingPayload.parse(args.proposal.payload);
    const { tx, ctx, pack, proposal } = args;
    const txn = await tx.get('card_transactions', p.cardTransactionId);
    if (!txn || txn.status !== 'pending') throw new DomainError('CONFLICT', 'The card transaction was coded meanwhile.');
    const account = pack.lookups.account(p.accountNumber)!;
    const dept = p.departmentCode ? pack.lookups.departments.get(p.departmentCode) : undefined;
    const entry = await postCardTransaction(tx, ctx, pack.lookups, txn, { accountId: account.id, departmentId: dept?.id ?? null }, { preparedByRunId: proposal.run_id, proposalId: proposal.id, idempotencyKey: `proposal:${proposal.id}`, basis: basisOf(args) });
    await tx.update('card_transactions', txn.id, { status: 'posted', coded_account_id: account.id, coded_department_id: dept?.id ?? null, coding_source: p.source === 'rule' ? 'rule' : p.source === 'history' ? 'history' : 'agent', coding_confidence: proposal.confidence, journal_entry_id: entry.id });
    return { effect: { entryId: entry.id, entryNumber: entry.entry_number, account: `${account.number} ${account.name}` }, postedEntryId: entry.id };
  },
};

const recMatch: ProposalHandler<S> = {
  kind: 'rec_match',
  label: 'Reconciliation match',
  payload: RecMatchPayload,
  permission: 'proposal.decide',
  autoApplicable: true,
  limitApplies: false,
  async verify(draft, scope) {
    const p = RecMatchPayload.parse(draft.payload);
    const { tx } = scope;
    const bank = await tx.get('bank_accounts', p.bankAccountId);
    const checks: VerificationCheck[] = [];
    let bankTotal = 0;
    let ledgerTotal = 0;
    for (const id of p.bankTransactionIds) {
      const b = await tx.get('bank_transactions', id);
      bankTotal += b?.amount_minor ?? 0;
      checks.push({ id: 'BANK-OPEN', label: 'Bank line belongs to this account and is unmatched', passed: !!b && b.bank_account_id === p.bankAccountId && b.status === 'unmatched', severity: 'error', message: `bank line ${b?.description ?? id} is matched already or belongs to another account` });
    }
    for (const id of p.journalLineIds) {
      const l = await tx.get('journal_lines', id);
      const e = l ? await tx.get('journal_entries', l.journal_entry_id) : null;
      ledgerTotal += l ? l.debit_minor - l.credit_minor : 0;
      const taken = l ? (await tx.find('rec_match_items', { journal_line_id: l.id })).length : 0;
      let acceptedElsewhere = false;
      if (taken) {
        for (const item of await tx.find('rec_match_items', { journal_line_id: id })) {
          const m = await tx.get('rec_matches', item.match_id);
          if (m?.status === 'accepted') acceptedElsewhere = true;
        }
      }
      checks.push({ id: 'LEDGER-CASH', label: 'Ledger line is a posted line on the bank\'s cash account', passed: !!l && !!bank && l.account_id === bank.gl_account_id && e?.status === 'posted', severity: 'error', message: `ledger line ${id} is not a posted cash line for this bank account` });
      checks.push({ id: 'LEDGER-FREE', label: 'Ledger line not already matched', passed: !acceptedElsewhere, severity: 'error', message: 'ledger line already matched' });
    }
    const diff = bankTotal - ledgerTotal;
    checks.push({ id: 'AMOUNTS', label: 'Bank and ledger amounts agree', passed: diff === 0, severity: p.matchType === 'fuzzy' ? 'warning' : 'error', message: `bank ${bankTotal / 100} vs ledger ${ledgerTotal / 100} (difference ${diff / 100})` });
    return checks;
  },
  async onCreate(proposal, scope) {
    const p = RecMatchPayload.parse(proposal.payload);
    const { tx, ctx, pack } = scope;
    const bank = (await tx.get('bank_accounts', p.bankAccountId))!;
    const rec = await ensureReconciliation(tx, ctx, pack.lookups, { entityId: bank.entity_id, periodId: p.periodId, recType: 'bank', accountId: bank.gl_account_id, bankAccountId: bank.id, closeTaskId: proposal.close_task_id });
    const match = await tx.insert('rec_matches', { tenant_id: ctx.tenantId, reconciliation_id: rec.id, match_type: p.matchType, status: 'proposed', confidence: proposal.confidence, rule: p.rule, explanation: p.explanation, proposal_id: proposal.id });
    for (const id of p.bankTransactionIds) {
      const b = (await tx.get('bank_transactions', id))!;
      await tx.insert('rec_match_items', { tenant_id: ctx.tenantId, match_id: match.id, side: 'external', bank_transaction_id: id, amount_minor: b.amount_minor });
    }
    for (const id of p.journalLineIds) {
      const l = (await tx.get('journal_lines', id))!;
      await tx.insert('rec_match_items', { tenant_id: ctx.tenantId, match_id: match.id, side: 'ledger', journal_line_id: id, amount_minor: l.debit_minor - l.credit_minor });
    }
  },
  async apply(args) {
    const { tx, proposal, ctx } = args;
    const p = RecMatchPayload.parse(proposal.payload);
    const match = (await tx.find('rec_matches', { proposal_id: proposal.id }))[0];
    if (!match) throw new DomainError('INVARIANT', 'match workpaper missing');
    await tx.update('rec_matches', match.id, { status: 'accepted', accepted_by: args.approvedBy, accepted_at: ctx.clock.now() });
    let clearedOn = '';
    for (const id of p.bankTransactionIds) {
      const b = await tx.update('bank_transactions', id, { status: 'matched' });
      if (b.booking_date > clearedOn) clearedOn = b.booking_date;
    }
    // Items carried from earlier reconciliations clear when their ledger line is matched to the bank.
    let resolved = 0;
    for (const lineId of p.journalLineIds) {
      for (const item of await tx.find('reconciling_items', { journal_line_id: lineId, status: 'open' })) {
        if (item.reconciliation_id === match.reconciliation_id) continue;
        await tx.update('reconciling_items', item.id, { status: 'resolved', cleared_date: clearedOn });
        resolved++;
      }
    }
    await refreshReconciliation(tx, match.reconciliation_id);
    return { effect: { matchId: match.id, priorItemsCleared: resolved } };
  },
  async onReject(proposal, scope) {
    for (const m of await scope.tx.find('rec_matches', { proposal_id: proposal.id })) await scope.tx.update('rec_matches', m.id, { status: 'rejected' });
  },
  async onSupersede(proposal, scope) {
    for (const m of await scope.tx.find('rec_matches', { proposal_id: proposal.id })) await scope.tx.update('rec_matches', m.id, { status: 'rejected' });
  },
};

const reconcilingItem: ProposalHandler<S> = {
  kind: 'reconciling_item',
  label: 'Reconciling item',
  payload: ReconcilingItemPayload,
  permission: 'proposal.decide',
  autoApplicable: true,
  limitApplies: false,
  async verify(draft, scope) {
    const p = ReconcilingItemPayload.parse(draft.payload);
    const { tx } = scope;
    const checks: VerificationCheck[] = [];
    const period = await tx.get('periods', p.periodId);
    checks.push({ id: 'PERIOD', label: 'Period is open', passed: !!period && period.status !== 'locked', severity: 'error', message: 'period is locked' });
    if (p.journalLineId) {
      const l = await tx.get('journal_lines', p.journalLineId);
      checks.push({ id: 'BOOK-SIDE', label: 'Book-side item is a posted line dated on or before period end', passed: !!l && !!period && l.entry_date <= period.end_date, severity: 'error', message: 'journal line missing or after period end' });
      if (l) checks.push({ id: 'SIGN', label: 'Item amount equals the ledger line (GL minus bank)', passed: l.debit_minor - l.credit_minor === p.amountMinor, severity: 'error', message: `item ${p.amountMinor} vs line ${l.debit_minor - l.credit_minor}` });
    }
    if (p.bankTransactionId) {
      const b = await tx.get('bank_transactions', p.bankTransactionId);
      checks.push({ id: 'BANK-SIDE', label: 'Bank-only item is an unmatched bank line', passed: !!b && b.status === 'unmatched', severity: 'error', message: 'bank line missing or already matched' });
      if (b) checks.push({ id: 'SIGN', label: 'Item amount is the bank line negated (GL minus bank)', passed: -b.amount_minor === p.amountMinor, severity: 'error', message: `item ${p.amountMinor} vs bank ${b.amount_minor}` });
    }
    if (p.kind === 'deposit_in_transit' || p.kind === 'outstanding_check' || p.kind === 'timing_difference') {
      checks.push({ id: 'CLEARS', label: 'Timing item has an expected clear date after period end', passed: !!p.expectedClearDate && !!period && p.expectedClearDate > period.end_date, severity: 'warning', message: 'no clearing evidence after period end' });
    }
    return checks;
  },
  async apply(args) {
    const { tx, ctx, pack, proposal } = args;
    const p = ReconcilingItemPayload.parse(proposal.payload);
    const account = pack.lookups.account(p.accountNumber)!;
    const rec = await ensureReconciliation(tx, ctx, pack.lookups, { entityId: p.entityId, periodId: p.periodId, recType: p.bankAccountId ? 'bank' : 'balance_sheet', accountId: account.id, bankAccountId: p.bankAccountId, closeTaskId: proposal.close_task_id });
    const item = await tx.insert('reconciling_items', {
      tenant_id: ctx.tenantId,
      reconciliation_id: rec.id,
      kind: p.kind,
      description: p.description,
      amount_minor: p.amountMinor,
      item_date: p.itemDate,
      expected_clear_date: p.expectedClearDate ?? null,
      bank_transaction_id: p.bankTransactionId ?? null,
      journal_line_id: p.journalLineId ?? null,
      proposal_id: proposal.id,
      created_by: args.approvedBy,
      created_by_run_id: proposal.run_id,
    });
    await refreshReconciliation(tx, rec.id);
    return { effect: { reconcilingItemId: item.id, reconciliationId: rec.id } };
  },
};

const fluxExplanation: ProposalHandler<S> = {
  kind: 'flux_explanation',
  label: 'Variance explanation',
  payload: FluxExplanationPayload,
  permission: 'flux.explain',
  autoApplicable: true,
  limitApplies: false,
  async verify(draft, scope) {
    const p = FluxExplanationPayload.parse(draft.payload);
    const line = await scope.tx.get('flux_lines', p.fluxLineId);
    const analysis = line ? await scope.tx.get('flux_analyses', line.analysis_id) : null;
    const subject = { variance: line?.variance_minor ?? 0, driverTotal: p.drivers.reduce((s, d) => s + d.amount_minor, 0), coverage: p.coverage ?? 0 };
    const violations = closeOntology.evaluate('bh:FluxExplanation', subject, {});
    return [
      { id: 'FLUX-LINE', label: 'Variance line exists and is material', passed: !!line && line.is_material, severity: 'error', message: 'flux line missing or not material' },
      { id: 'FLUX-OPEN', label: 'Analysis not yet approved', passed: analysis?.status !== 'approved', severity: 'error', message: 'analysis already approved' },
      ...closeOntology.axiomsFor('bh:FluxExplanation').map((a) => {
        const hit = violations.find((x) => x.axiom === a.id);
        return { id: a.id, label: a.label, passed: !hit, severity: a.severity, message: hit?.message };
      }),
    ];
  },
  async onCreate(proposal, scope) {
    const p = FluxExplanationPayload.parse(proposal.payload);
    await scope.tx.update('flux_lines', p.fluxLineId, { explanation: p.explanation, explanation_status: 'drafted', drivers: p.drivers, explained_by_run_id: proposal.run_id, explained_by: null, confidence: proposal.confidence, proposal_id: proposal.id });
  },
  async apply(args) {
    const p = FluxExplanationPayload.parse(args.proposal.payload);
    await args.tx.update('flux_lines', p.fluxLineId, { explanation_status: 'accepted', reviewed_by: args.approvedBy, reviewed_at: args.ctx.clock.now() });
    return { effect: { fluxLineId: p.fluxLineId } };
  },
  async onReject(proposal, scope) {
    const p = FluxExplanationPayload.parse(proposal.payload);
    await scope.tx.update('flux_lines', p.fluxLineId, { explanation_status: 'rejected' });
  },
};

const anomaly: ProposalHandler<S> = {
  kind: 'anomaly',
  label: 'Review finding',
  payload: AnomalyPayload,
  permission: 'proposal.decide',
  autoApplicable: false,
  async verify(draft, scope) {
    const p = AnomalyPayload.parse(draft.payload);
    const checks: VerificationCheck[] = [{ id: 'FINDING', label: 'Finding cites its subjects', passed: p.subjectIds.length > 0, severity: 'error', message: 'no subjects' }];
    if (p.resolution.type === 'reverse_entry') {
      const e = await scope.tx.get('journal_entries', p.resolution.entryId);
      const already = e ? await scope.tx.findOne('journal_entries', { reverses_entry_id: e.id }) : null;
      checks.push({ id: 'REV', label: 'Entry can be reversed', passed: e?.status === 'posted' && !already, severity: 'error', message: 'entry not posted or already reversed' });
    }
    if (p.resolution.type === 'journal_entry') checks.push(...axiomChecks(scope, toDraft(p.resolution.entry), 'RES:'));
    return checks;
  },
  async apply(args) {
    const p = AnomalyPayload.parse(args.proposal.payload);
    const { tx, ctx, pack, proposal } = args;
    if (p.resolution.type === 'reverse_entry') {
      const reversal = await reverseEntry(tx, ctx, pack.lookups, p.resolution.entryId, { reason: p.resolution.reason, basis: basisOf(args), proposalId: proposal.id, idempotencyKey: `proposal:${proposal.id}` });
      return { effect: { resolution: 'reverse_entry', reversalEntryId: reversal.id, reversalNumber: reversal.entry_number }, postedEntryId: reversal.id };
    }
    if (p.resolution.type === 'journal_entry') {
      const { entry } = await postWithReversal(args, p.resolution.entry, 'gl');
      for (const id of p.resolution.voidBillIds ?? []) await tx.update('bills', id, { status: 'void' });
      return { effect: { resolution: 'journal_entry', entryId: entry.id, entryNumber: entry.entry_number, voidedBills: p.resolution.voidBillIds ?? [] }, postedEntryId: entry.id };
    }
    return { effect: { resolution: 'acknowledged', note: 'Finding confirmed by an independent reviewer; no entry required.' } };
  },
  sodSubjects(proposal) {
    return { vendorIds: ((proposal.payload as { vendorIds?: string[] }).vendorIds ?? []).filter(Boolean) };
  },
};

const schedule: ProposalHandler<S> = {
  kind: 'schedule',
  label: 'Schedule',
  payload: SchedulePayload,
  permission: 'proposal.decide',
  autoApplicable: false,
  async verify(draft, scope) {
    const p = SchedulePayload.parse(draft.payload);
    const checks: VerificationCheck[] = [];
    if (p.type === 'prepaid') {
      const start = p.startDate;
      const plan = straightLine(p.totalMinor, p.months, Number(start.slice(0, 4)), Number(start.slice(5, 7)));
      checks.push({ id: 'AX-SCH-01', label: 'Schedule lines sum to the total', passed: plan.reduce((s, l) => s + l.amount, 0) === p.totalMinor, severity: 'error', message: 'schedule does not sum to total' });
      const bal = scope.pack.lookups.account(p.balanceAccount);
      checks.push({ id: 'PREPAID-ACCT', label: 'Balance account is a prepaid asset', passed: !!bal && bal.account_class === 'asset', severity: 'error', message: 'balance account must be an asset' });
      if (p.catchUpEntry) checks.push(...axiomChecks(scope, toDraft(p.catchUpEntry), 'CATCHUP:'));
    } else {
      checks.push({ id: 'AX-CAP-01', label: 'Cost meets the capitalization threshold', passed: p.costMinor >= DEFAULT_CAPITALIZATION_THRESHOLD_MINOR, severity: 'error', message: 'below the capitalization threshold; expense it instead' });
      checks.push(...axiomChecks(scope, toDraft(p.reclass), 'RECLASS:'));
      if (p.sourceCardTransactionId) {
        const t = await scope.tx.get('card_transactions', p.sourceCardTransactionId);
        checks.push({ id: 'SOURCE', label: 'Source card transaction is posted', passed: t?.status === 'posted', severity: 'error', message: 'source transaction not posted' });
      }
    }
    return checks;
  },
  async apply(args) {
    const p = SchedulePayload.parse(args.proposal.payload);
    const { tx, ctx, pack, proposal } = args;
    const entity = pack.lookups.entity(p.entity)!;
    if (p.type === 'prepaid') {
      const y = Number(p.startDate.slice(0, 4));
      const m = Number(p.startDate.slice(5, 7));
      const plan = straightLine(p.totalMinor, p.months, y, m);
      const end = addMonths(y, m, p.months - 1);
      const sched = await tx.insert('amortization_schedules', {
        tenant_id: ctx.tenantId,
        entity_id: entity.id,
        kind: 'prepaid_expense',
        description: p.description,
        vendor_id: p.vendorId,
        bill_id: p.billId,
        balance_account_id: pack.lookups.account(p.balanceAccount)!.id,
        pl_account_id: pack.lookups.account(p.plAccount)!.id,
        department_id: p.department ? (pack.lookups.departments.get(p.department)?.id ?? null) : null,
        total_minor: p.totalMinor,
        start_date: p.startDate.slice(0, 8) + '01',
        end_date: monthEnd(end.year, end.month),
        months: p.months,
        created_by: args.approvedBy,
        created_by_run_id: proposal.run_id,
      });
      let catchUp: Row<'journal_entries'> | null = null;
      if (p.catchUpEntry) catchUp = (await postWithReversal(args, p.catchUpEntry, 'prepaid')).entry;
      for (const line of plan) {
        const period = pack.lookups.period(entity.id, line.year, line.month);
        if (!period) continue;
        const key = `${line.year}-${String(line.month).padStart(2, '0')}`;
        const covered = !!catchUp && !!p.catchUpThrough && key <= p.catchUpThrough;
        await tx.insert('amortization_lines', { tenant_id: ctx.tenantId, schedule_id: sched.id, period_id: period.id, period_end: monthEnd(line.year, line.month), amount_minor: line.amount, status: covered ? 'posted' : 'scheduled', journal_entry_id: covered ? catchUp!.id : null });
      }
      return { effect: { scheduleId: sched.id, catchUpEntryId: catchUp?.id ?? null, catchUpNumber: catchUp?.entry_number ?? null }, postedEntryId: catchUp?.id ?? null };
    }
    const { entry } = await postWithReversal(args, p.reclass, 'fixed_assets');
    const count = await tx.count('fixed_assets', { tenant_id: ctx.tenantId });
    const asset = await tx.insert('fixed_assets', {
      tenant_id: ctx.tenantId,
      entity_id: entity.id,
      asset_number: `FA-${String(count + 1).padStart(4, '0')}`,
      description: p.description,
      asset_class: p.assetClass,
      acquisition_date: p.inServiceDate,
      in_service_date: p.inServiceDate,
      cost_minor: p.costMinor,
      useful_life_months: p.usefulLifeMonths,
      asset_account_id: pack.lookups.account(p.assetAccount)!.id,
      accumulated_depreciation_account_id: pack.lookups.accountsBySubtype('bh:AccumulatedDepreciation')[0]!.id,
      depreciation_expense_account_id: pack.lookups.accountsBySubtype('bh:DepreciationExpense')[0]!.id,
      department_id: p.department ? (pack.lookups.departments.get(p.department)?.id ?? null) : null,
      vendor_id: p.vendorId,
    });
    let accumulated = 0;
    for (const line of depreciationPlan(p.costMinor, 0, p.usefulLifeMonths, p.inServiceDate)) {
      const period = pack.lookups.period(entity.id, line.year, line.month);
      if (!period) continue;
      accumulated += line.amount;
      await tx.insert('depreciation_lines', { tenant_id: ctx.tenantId, fixed_asset_id: asset.id, period_id: period.id, fiscal_year: line.year, period_number: line.month, amount_minor: line.amount, accumulated_minor: accumulated, net_book_value_minor: p.costMinor - accumulated, status: 'scheduled' });
    }
    await appendAudit(tx, ctx.tenantId, ctx.actor, { action: 'fixed_asset.create', objectType: 'fixed_asset', objectId: asset.id, summary: `Capitalized ${p.description} as ${asset.asset_number} (${p.usefulLifeMonths} months)` }, ctx.clock.now());
    return { effect: { assetId: asset.id, assetNumber: asset.asset_number, entryId: entry.id, entryNumber: entry.entry_number }, postedEntryId: entry.id };
  },
};

const closePackage: ProposalHandler<S> = {
  kind: 'task_update',
  label: 'Close package',
  payload: PackagePayload,
  permission: 'package.approve',
  autoApplicable: false,
  limitApplies: false,
  async verify(draft, scope) {
    const p = PackagePayload.parse(draft.payload);
    const content = p.content as unknown as ClosePackageContent;
    const close = await scope.tx.get('closes', p.closeId);
    return [
      { id: 'PKG-HASH', label: 'Content hash matches the package', passed: sha256Hex(canonicalJson(p.content)) === p.contentHash, severity: 'error', message: 'content hash mismatch' },
      { id: 'PKG-OPEN', label: 'Close is still open', passed: !!close && close.status !== 'closed', severity: 'error', message: 'close already locked' },
      { id: 'AX-TB-01', label: 'Consolidated trial balance balances', passed: content.statements?.consolidatedTb?.totalDebit === content.statements?.consolidatedTb?.totalCredit, severity: 'error', message: 'consolidated TB does not balance' },
      { id: 'BS-BALANCES', label: 'Balance sheet balances (assets = liabilities + equity)', passed: !!content.statements?.balanceSheet?.balances, severity: 'error', message: 'balance sheet does not balance' },
      // A final package states that the close is complete; one generated over open work stays a draft.
      { id: 'BLOCKERS', label: 'Everything else in the close is finished and signed off', passed: (content.openBlockers ?? []).length === 0, severity: 'error', message: `${(content.openBlockers ?? []).length} open item(s): ${(content.openBlockers ?? []).slice(0, 3).join('; ')}. Finish them, then regenerate the package.` },
    ];
  },
  async onCreate(proposal, scope) {
    const p = PackagePayload.parse(proposal.payload);
    await publishPackage(scope.tx, scope.ctx, p.closeId, p.content as unknown as ClosePackageContent, { approvedBy: null, runId: proposal.run_id, generatedBy: null });
  },
  async apply(args) {
    const p = PackagePayload.parse(args.proposal.payload);
    const pkg = await publishPackage(args.tx, args.ctx, p.closeId, p.content as unknown as ClosePackageContent, { approvedBy: args.approvedBy, runId: args.proposal.run_id, generatedBy: null });
    return { effect: { packageId: pkg.id, version: pkg.version, contentHash: pkg.content_hash } };
  },
};

export const ACCOUNTING_HANDLERS: ProposalHandler<S>[] = [journalEntry, transactionCoding, recMatch, reconcilingItem, fluxExplanation, anomaly, schedule, closePackage];

export function packageContentHash(content: unknown): string {
  return sha256Hex(canonicalJson(content));
}

export type { ProposalDraft, DomainContext };
