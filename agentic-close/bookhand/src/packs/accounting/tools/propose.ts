import { z } from 'zod';
import type { EvidenceRef, ProposeResult } from '../../../agents/framework/types';
import { canonicalJson } from '../../../shared/canonical-json';
import { DomainError } from '../../../shared/errors';
import { sha256Hex } from '../../../shared/hash';
import { AnomalyPayload, EntrySchema, type EntryInput, FluxExplanationPayload, packageContentHash, SchedulePayload } from '../proposals';
import { assemblePackage } from '../services/package';
import { accountOf, entityOf, PeriodKey, periodOf, type Tool, type X } from './common';

/**
 * Proposal tools: the ONLY way an agent changes anything. Each computes the amount at stake (reporting
 * currency) and a stable natural key, then hands the draft to the runtime for verification, disposition
 * (autonomy policy, materiality, SoD) and, if allowed, application.
 */

const Evidence = z.array(z.object({ type: z.string().min(2).max(40), id: z.string().max(80).nullable().optional(), label: z.string().min(2).max(200) }).strict()).min(1).max(30);

const meta = {
  title: z.string().min(5).max(200).describe('Short imperative title the approver sees'),
  why: z.string().min(20).max(2000).describe('Plain-English rationale citing the evidence'),
  confidence: z.number().min(0).max(1).describe('Calibrated probability this is right'),
  evidence: Evidence.describe('References to records from tool results (type, id, label)'),
  key: z.string().max(200).optional().describe('Stable key for this finding; a re-run with the same key supersedes instead of duplicating'),
  riskFlags: z.array(z.string().max(60)).max(10).optional(),
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function entryTotal(entry: EntryInput): number {
  return entry.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
}

const summarize = (o: ProposeResult) => (o.skipped ? `skipped (${o.skipped})` : `${o.status.replace('_', ' ')}${o.verification.passed ? '' : ' (verification failed)'}`);

export const proposeTools: Tool[] = [
  {
    name: 'propose_journal_entry',
    title: 'Propose a journal entry',
    description: 'Propose a balanced journal entry (bh:JournalEntry) such as an accrual (type "accrual" with autoReverseDate = first day of next period), reclass, amortization, depreciation, revaluation or elimination. Amounts are integer minor units (cents). Links tie the entry to the schedule lines, bank lines or reconciling items it settles.',
    input: z
      .object({
        ...meta,
        entry: EntrySchema,
        sourceModule: z.enum(['gl', 'ap', 'ar', 'bank', 'card', 'fixed_assets', 'prepaid', 'payroll', 'intercompany', 'fx', 'revenue']).default('gl'),
        links: z
          .object({ amortizationLineIds: z.array(z.string().uuid()).optional(), depreciationLineIds: z.array(z.string().uuid()).optional(), reconcilingItemIds: z.array(z.string().uuid()).optional(), bankTransactionIds: z.array(z.string().uuid()).optional(), voidBillIds: z.array(z.string().uuid()).optional() })
          .strict()
          .default({}),
      })
      .strict(),
    permission: 'skill.run',
    mutation: true,
    ontology: ['bh:JournalEntry', 'bh:Proposal'],
    async execute(input: { title: string; why: string; confidence: number; evidence: EvidenceRef[]; key?: string; riskFlags?: string[]; entry: EntryInput; sourceModule: string; links: Record<string, string[]> }, x: X) {
      const entity = entityOf(x, input.entry.entity);
      const period = x.pack.lookups.periodFor(entity.id, input.entry.date);
      const amount = await x.pack.toReporting(entity.id, entryTotal(input.entry), input.entry.date);
      return x.propose({
        kind: 'journal_entry',
        naturalKey: input.key ?? `je:${entity.code}:${input.entry.date}:${sha256Hex(canonicalJson(input.entry.lines)).slice(0, 16)}`,
        title: input.title,
        why: input.why,
        confidence: input.confidence,
        amountMinor: Math.abs(amount),
        currency: x.pack.reportingCurrency,
        entityId: entity.id,
        periodId: period?.id ?? null,
        payload: { entry: input.entry, sourceModule: input.sourceModule, links: input.links },
        evidence: input.evidence,
        riskFlags: input.riskFlags,
      });
    },
    summarize,
  },
  {
    name: 'propose_reversal',
    title: 'Propose reversing an entry',
    description: 'Propose reversing a posted journal entry (the only way to undo posted numbers). Use when an entry is wrong, duplicated or unsupported.',
    input: z.object({ ...meta, entryId: z.string().uuid(), reason: z.string().min(5).max(300) }).strict(),
    permission: 'skill.run',
    mutation: true,
    ontology: ['bh:Reversal'],
    async execute(input: { title: string; why: string; confidence: number; evidence: EvidenceRef[]; key?: string; riskFlags?: string[]; entryId: string; reason: string }, x: X) {
      const e = await x.tx.get('journal_entries', input.entryId);
      if (!e) throw new DomainError('NOT_FOUND', 'entry not found');
      const amount = await x.pack.toReporting(e.entity_id, e.total_minor, e.entry_date);
      return x.propose({ kind: 'journal_entry', naturalKey: input.key ?? `reverse:${e.id}`, title: input.title, why: input.why, confidence: input.confidence, amountMinor: amount, currency: x.pack.reportingCurrency, entityId: e.entity_id, periodId: e.period_id, payload: { reversesEntryId: e.id, reason: input.reason, sourceModule: e.source_module, links: {} }, evidence: input.evidence, riskFlags: input.riskFlags });
    },
    summarize,
  },
  {
    name: 'propose_transaction_coding',
    title: 'Propose coding a card transaction',
    description: 'Propose the GL account (bh:ExpenseAccount or an asset if capitalizable) and department for an uncoded card transaction (bh:CardTransaction). Posting creates the expense / card-payable entry.',
    input: z.object({ ...meta, cardTransactionId: z.string().uuid(), accountNumber: z.string().min(1), departmentCode: z.string().nullable(), source: z.enum(['rule', 'history', 'agent']).default('agent') }).strict(),
    permission: 'skill.run',
    mutation: true,
    ontology: ['bh:CardTransaction', 'bh:ExpenseAccount'],
    async execute(input: { title: string; why: string; confidence: number; evidence: EvidenceRef[]; key?: string; riskFlags?: string[]; cardTransactionId: string; accountNumber: string; departmentCode: string | null; source: string }, x: X) {
      const t = await x.tx.get('card_transactions', input.cardTransactionId);
      if (!t) throw new DomainError('NOT_FOUND', 'card transaction not found');
      accountOf(x, input.accountNumber);
      const amount = await x.pack.toReporting(t.entity_id, Math.abs(t.amount_minor), t.transaction_date);
      return x.propose({
        kind: 'transaction_coding',
        naturalKey: input.key ?? `code:${t.id}`,
        title: input.title,
        why: input.why,
        confidence: input.confidence,
        amountMinor: amount,
        currency: x.pack.reportingCurrency,
        entityId: t.entity_id,
        periodId: x.pack.lookups.periodFor(t.entity_id, t.transaction_date)?.id ?? null,
        payload: { cardTransactionId: t.id, accountNumber: input.accountNumber, departmentCode: input.departmentCode, source: input.source },
        evidence: input.evidence,
        riskFlags: input.riskFlags,
      });
    },
    summarize,
  },
  {
    name: 'propose_rec_match',
    title: 'Propose a reconciliation match',
    description: 'Propose matching bank statement lines (bh:BankTransaction) to ledger cash lines (bh:JournalLine) for a bank reconciliation: exact, fuzzy, one-to-many or many-to-one (bh:MatchType).',
    input: z
      .object({
        ...meta,
        bankAccountId: z.string().uuid(),
        period: PeriodKey,
        matchType: z.enum(['exact', 'fuzzy', 'one_to_many', 'many_to_one', 'many_to_many', 'manual']),
        rule: z.string().max(200),
        bankTransactionIds: z.array(z.string().uuid()).min(1).max(20),
        journalLineIds: z.array(z.string().uuid()).min(1).max(20),
      })
      .strict(),
    permission: 'skill.run',
    mutation: true,
    ontology: ['bh:ReconciliationMatch'],
    async execute(input: { title: string; why: string; confidence: number; evidence: EvidenceRef[]; key?: string; riskFlags?: string[]; bankAccountId: string; period: string; matchType: string; rule: string; bankTransactionIds: string[]; journalLineIds: string[] }, x: X) {
      const bank = await x.tx.get('bank_accounts', input.bankAccountId);
      if (!bank) throw new DomainError('NOT_FOUND', 'bank account not found');
      const period = periodOf(x, bank.entity_id, input.period);
      let total = 0;
      for (const id of input.bankTransactionIds) total += Math.abs((await x.tx.get('bank_transactions', id))?.amount_minor ?? 0);
      const amount = await x.pack.toReporting(bank.entity_id, total, period.end_date);
      return x.propose({
        kind: 'rec_match',
        naturalKey: input.key ?? `match:${[...input.bankTransactionIds].sort().join(',')}`,
        title: input.title,
        why: input.why,
        confidence: input.confidence,
        amountMinor: amount,
        currency: x.pack.reportingCurrency,
        entityId: bank.entity_id,
        periodId: period.id,
        payload: { bankAccountId: bank.id, periodId: period.id, matchType: input.matchType, rule: input.rule, explanation: input.why.slice(0, 600), bankTransactionIds: input.bankTransactionIds, journalLineIds: input.journalLineIds },
        evidence: input.evidence,
        riskFlags: input.riskFlags,
      });
    },
    summarize,
  },
  {
    name: 'propose_reconciling_item',
    title: 'Propose a reconciling item',
    description: 'Propose a reconciling item (bh:ReconcilingItem) that explains a difference between the GL and the bank: deposit in transit, outstanding check, timing difference, or an unexplained item to investigate. amountMinor is GL minus bank (deposit in transit positive; outstanding check negative; bank-only debit positive).',
    input: z
      .object({
        ...meta,
        bankAccountId: z.string().uuid().nullable(),
        account: z.string(),
        entity: z.string(),
        period: PeriodKey,
        kind: z.enum(['deposit_in_transit', 'outstanding_check', 'bank_fee', 'interest', 'bank_error', 'book_error', 'timing_difference', 'unrecorded_transaction', 'fx_difference', 'unexplained']),
        description: z.string().min(3).max(300),
        amountMinor: z.number().int(),
        itemDate: isoDate,
        expectedClearDate: isoDate.nullable().optional(),
        bankTransactionId: z.string().uuid().nullable().optional(),
        journalLineId: z.string().uuid().nullable().optional(),
      })
      .strict(),
    permission: 'skill.run',
    mutation: true,
    ontology: ['bh:ReconcilingItem', 'bh:TimingDifference', 'bh:UnexplainedItem'],
    async execute(
      input: { title: string; why: string; confidence: number; evidence: EvidenceRef[]; key?: string; riskFlags?: string[]; bankAccountId: string | null; account: string; entity: string; period: string; kind: string; description: string; amountMinor: number; itemDate: string; expectedClearDate?: string | null; bankTransactionId?: string | null; journalLineId?: string | null },
      x: X,
    ) {
      const entity = entityOf(x, input.entity);
      const period = periodOf(x, entity.id, input.period);
      const account = accountOf(x, input.account);
      const amount = await x.pack.toReporting(entity.id, Math.abs(input.amountMinor), period.end_date);
      return x.propose({
        kind: 'reconciling_item',
        naturalKey: input.key ?? `recitem:${account.number}:${input.period}:${input.journalLineId ?? input.bankTransactionId ?? sha256Hex(input.description).slice(0, 12)}`,
        title: input.title,
        why: input.why,
        confidence: input.confidence,
        amountMinor: amount,
        currency: x.pack.reportingCurrency,
        entityId: entity.id,
        periodId: period.id,
        payload: { bankAccountId: input.bankAccountId, accountNumber: account.number, entityId: entity.id, periodId: period.id, kind: input.kind, description: input.description, amountMinor: input.amountMinor, itemDate: input.itemDate, expectedClearDate: input.expectedClearDate ?? null, bankTransactionId: input.bankTransactionId ?? null, journalLineId: input.journalLineId ?? null },
        evidence: input.evidence,
        riskFlags: input.riskFlags,
      });
    },
    summarize,
  },
  {
    name: 'propose_flux_explanation',
    title: 'Propose a variance explanation',
    description: 'Propose the explanation (bh:FluxExplanation) for a material variance (bh:Variance) with its drivers (bh:VarianceDriver). FP&A accepts or rewrites it; the Controller approves the analysis.',
    input: z.object({ ...meta, fluxLineId: z.string().uuid(), explanation: FluxExplanationPayload.shape.explanation, drivers: FluxExplanationPayload.shape.drivers, coverage: z.number().min(0).max(1).optional() }).strict(),
    permission: 'skill.run',
    mutation: true,
    ontology: ['bh:FluxExplanation', 'bh:VarianceDriver'],
    async execute(input: { title: string; why: string; confidence: number; evidence: EvidenceRef[]; key?: string; riskFlags?: string[]; fluxLineId: string; explanation: string; drivers: unknown[]; coverage?: number }, x: X) {
      const line = await x.tx.get('flux_lines', input.fluxLineId);
      if (!line) throw new DomainError('NOT_FOUND', 'flux line not found');
      const analysis = (await x.tx.get('flux_analyses', line.analysis_id))!;
      const close = (await x.tx.get('closes', analysis.close_id))!;
      const parent = x.pack.lookups.operatingEntities().find((e) => !e.parent_entity_id) ?? x.pack.lookups.operatingEntities()[0]!;
      return x.propose({
        kind: 'flux_explanation',
        naturalKey: input.key ?? `flux:${line.id}`,
        title: input.title,
        why: input.why,
        confidence: input.confidence,
        amountMinor: 0,
        currency: x.pack.reportingCurrency,
        entityId: null,
        periodId: x.pack.lookups.period(parent.id, close.fiscal_year, close.period_number)?.id ?? null,
        payload: { fluxLineId: line.id, explanation: input.explanation, drivers: input.drivers, coverage: input.coverage },
        evidence: input.evidence,
        riskFlags: input.riskFlags,
      });
    },
    summarize,
  },
  {
    name: 'propose_anomaly',
    title: 'Raise a review finding',
    description: 'Raise a journal-entry or subledger review finding (duplicate payment, segregation-of-duties break, unsupported manual entry, tie-out difference, intercompany mismatch) with a recommended resolution: none (acknowledge), reverse an entry, or a correcting journal entry. Always needs a person to decide.',
    input: z.object({ ...meta, amountMinor: z.number().int().nonnegative(), entity: z.string().nullable(), period: PeriodKey, category: AnomalyPayload.shape.category, severity: AnomalyPayload.shape.severity, subjectIds: AnomalyPayload.shape.subjectIds, vendorIds: AnomalyPayload.shape.vendorIds, recommendedAction: AnomalyPayload.shape.recommendedAction, resolution: AnomalyPayload.shape.resolution }).strict(),
    permission: 'skill.run',
    mutation: true,
    ontology: ['bh:Evidence', 'bh:SegregationOfDutiesRule'],
    async execute(
      input: { title: string; why: string; confidence: number; evidence: EvidenceRef[]; key?: string; riskFlags?: string[]; amountMinor: number; entity: string | null; period: string; category: string; severity: string; subjectIds: string[]; vendorIds?: string[]; recommendedAction: string; resolution: unknown },
      x: X,
    ) {
      const entity = input.entity ? entityOf(x, input.entity) : null;
      const parent = entity ?? x.pack.lookups.operatingEntities().find((e) => !e.parent_entity_id)!;
      const period = periodOf(x, parent.id, input.period);
      const amount = entity ? await x.pack.toReporting(entity.id, input.amountMinor, period.end_date) : input.amountMinor;
      return x.propose({
        kind: 'anomaly',
        naturalKey: input.key ?? `anomaly:${input.category}:${[...input.subjectIds].sort().join(',')}`,
        title: input.title,
        why: input.why,
        confidence: input.confidence,
        amountMinor: amount,
        currency: x.pack.reportingCurrency,
        entityId: entity?.id ?? null,
        periodId: period.id,
        payload: { category: input.category, severity: input.severity, subjectIds: input.subjectIds, vendorIds: input.vendorIds, recommendedAction: input.recommendedAction, resolution: input.resolution },
        evidence: input.evidence,
        riskFlags: input.riskFlags,
      });
    },
    summarize,
  },
  {
    name: 'propose_prepaid_schedule',
    title: 'Propose a prepaid schedule',
    description: 'Propose an amortization schedule (bh:AmortizationSchedule) for a prepaid expense (bh:PrepaidExpense) that has none, with a catch-up entry for months already elapsed.',
    input: z.object({ ...meta, schedule: SchedulePayload.options[0] }).strict(),
    permission: 'skill.run',
    mutation: true,
    ontology: ['bh:PrepaidSchedule', 'bh:AmortizationSchedule'],
    async execute(input: { title: string; why: string; confidence: number; evidence: EvidenceRef[]; key?: string; riskFlags?: string[]; schedule: z.infer<(typeof SchedulePayload.options)[0]> }, x: X) {
      const entity = entityOf(x, input.schedule.entity);
      const catchUp = input.schedule.catchUpEntry ? entryTotal(input.schedule.catchUpEntry) : 0;
      const date = input.schedule.catchUpEntry?.date ?? input.schedule.startDate;
      const amount = await x.pack.toReporting(entity.id, catchUp || input.schedule.totalMinor, date);
      return x.propose({
        kind: 'schedule',
        naturalKey: input.key ?? `prepaid:${input.schedule.billId ?? sha256Hex(input.schedule.description).slice(0, 12)}`,
        title: input.title,
        why: input.why,
        confidence: input.confidence,
        amountMinor: amount,
        currency: x.pack.reportingCurrency,
        entityId: entity.id,
        periodId: x.pack.lookups.periodFor(entity.id, date)?.id ?? null,
        payload: input.schedule,
        evidence: input.evidence,
        riskFlags: input.riskFlags,
      });
    },
    summarize,
  },
  {
    name: 'propose_capitalize_asset',
    title: 'Propose capitalizing a purchase',
    description: 'Propose moving an expensed purchase that meets the capitalization policy (bh:CapitalizationPolicy) into property and equipment: a reclass entry plus a fixed-asset record (bh:FixedAsset) with its depreciation schedule.',
    input: z.object({ ...meta, asset: SchedulePayload.options[1] }).strict(),
    permission: 'skill.run',
    mutation: true,
    ontology: ['bh:FixedAsset', 'bh:CapitalizationPolicy'],
    async execute(input: { title: string; why: string; confidence: number; evidence: EvidenceRef[]; key?: string; riskFlags?: string[]; asset: z.infer<(typeof SchedulePayload.options)[1]> }, x: X) {
      const entity = entityOf(x, input.asset.entity);
      const amount = await x.pack.toReporting(entity.id, input.asset.costMinor, input.asset.reclass.date);
      return x.propose({
        kind: 'schedule',
        naturalKey: input.key ?? `capitalize:${input.asset.sourceCardTransactionId ?? sha256Hex(input.asset.description).slice(0, 12)}`,
        title: input.title,
        why: input.why,
        confidence: input.confidence,
        amountMinor: amount,
        currency: x.pack.reportingCurrency,
        entityId: entity.id,
        periodId: x.pack.lookups.periodFor(entity.id, input.asset.reclass.date)?.id ?? null,
        payload: input.asset,
        evidence: input.evidence,
        riskFlags: input.riskFlags,
      });
    },
    summarize,
  },
  {
    name: 'propose_close_package',
    title: 'Propose the close package',
    description: 'Assemble the close package (bh:ClosePackage) for the close (statements, entity TBs, flux commentary, reconciliation status, exceptions, agent activity, audit-chain head) and propose it for Controller/CFO approval.',
    input: z.object({ ...meta, closeId: z.string().uuid() }).strict(),
    permission: 'package.generate',
    mutation: true,
    ontology: ['bh:ClosePackage'],
    async execute(input: { title: string; why: string; confidence: number; evidence: EvidenceRef[]; key?: string; riskFlags?: string[]; closeId: string }, x: X) {
      const content = await assemblePackage(x.tx, x.ctx, x.pack.lookups, input.closeId);
      const { generatedAt: _generatedAt, ...stable } = content;
      const hash = packageContentHash(content);
      const parent = x.pack.lookups.operatingEntities().find((e) => !e.parent_entity_id)!;
      const close = (await x.tx.get('closes', input.closeId))!;
      return x.propose({
        kind: 'task_update',
        naturalKey: input.key ?? `package:${input.closeId}:${sha256Hex(canonicalJson(stable)).slice(0, 16)}`,
        title: input.title,
        why: input.why,
        confidence: input.confidence,
        amountMinor: 0,
        currency: x.pack.reportingCurrency,
        entityId: null,
        periodId: x.pack.lookups.period(parent.id, close.fiscal_year, close.period_number)?.id ?? null,
        payload: { action: 'publish_close_package', closeId: input.closeId, contentHash: hash, content: content as unknown as Record<string, unknown> },
        evidence: input.evidence,
        riskFlags: input.riskFlags,
      });
    },
    summarize,
  },
];
