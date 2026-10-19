/**
 * Typed proposal payloads for the accounting pack and the builders brains and propose-tools use.
 * Payloads are plain JSON (stored in proposals.payload) and re-validated with zod at apply time,
 * so a tampered or malformed payload can never reach the ledger.
 */
import { z } from 'zod';
import type { EvidenceRef, ProposalDraft } from '../../../core/agent/types';
import type { JsonValue } from '../../../core/util/json';

const minor = z.number().int();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const periodKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const JeLineSchema = z
  .object({
    account: z.string().min(3).max(12),
    debit: minor.nonnegative().optional(),
    credit: minor.nonnegative().optional(),
    department: z.string().max(20).nullable().optional(),
    project: z.string().max(30).nullable().optional(),
    product_class: z.string().max(30).nullable().optional(),
    memo: z.string().max(200).nullable().optional(),
    counterparty_entity_id: z.string().max(40).nullable().optional(),
    txn_currency: z.string().length(3).nullable().optional(),
    txn_amount_minor: minor.nullable().optional(),
    fx_rate: z.number().positive().nullable().optional(),
  })
  .strict();

export const FixedAssetSpec = z
  .object({
    description: z.string().min(3).max(200),
    category: z.enum(['computer_equipment', 'lab_equipment', 'furniture', 'leasehold_improvements']),
    inServiceDate: isoDate,
    costMinor: minor.positive(),
    usefulLifeMonths: z.number().int().positive().max(480),
    assetAccount: z.string(),
    department: z.string().nullable(),
    sourceBillId: z.string().nullable(),
  })
  .strict();

export const JeEffectsSchema = z
  .object({
    depreciationLineIds: z.array(z.string()).optional(),
    prepaidLineIds: z.array(z.string()).optional(),
    bankMatch: z.object({ bankAccountId: z.string(), bankTxnId: z.string() }).strict().optional(),
    cardRecode: z.object({ cardTxnId: z.string(), accountCode: z.string(), department: z.string().nullable() }).strict().optional(),
    billLineRecode: z.object({ billLineId: z.string(), accountCode: z.string(), department: z.string().nullable() }).strict().optional(),
    fixedAsset: FixedAssetSpec.optional(),
  })
  .strict();

export const JePayloadSchema = z
  .object({
    entityId: z.string(),
    periodKey,
    postingDate: isoDate,
    entryType: z.enum(['standard', 'adjusting', 'accrual', 'reversing', 'recurring', 'reclass', 'elimination', 'fx_revaluation']),
    memo: z.string().min(3).max(300),
    source: z.enum(['agent', 'subledger']).default('agent'),
    lines: z.array(JeLineSchema).min(2).max(200),
    autoReverseOn: isoDate.nullable().optional(),
    counterpartyEntityId: z.string().nullable().optional(),
    sourceRef: z.string().max(80).nullable().optional(),
    effects: JeEffectsSchema.optional(),
    autoEligible: z.boolean().optional(),
    dependsOnProposalIds: z.array(z.string()).optional(),
    basis: z.string().max(40).optional(),
    fx: z.object({ foreignMinor: minor, closingRate: z.number().positive(), revaluedFunctionalMinor: minor, carryingMinor: minor, currency: z.string().length(3) }).strict().optional(),
  })
  .strict();
export type JePayload = z.infer<typeof JePayloadSchema>;

export const CodingPayloadSchema = z
  .object({
    target: z.object({ kind: z.literal('card_transaction'), id: z.string() }).strict(),
    entityId: z.string(),
    periodKey,
    accountCode: z.string(),
    department: z.string().nullable(),
    amountMinor: minor,
    merchant: z.string().max(200),
    source: z.enum(['human', 'rule', 'history', 'vendor_default', 'ontology']),
    alternatives: z.array(z.object({ accountCode: z.string(), confidence: z.number() }).strict()).default([]),
    neverAuto: z.boolean().default(false),
  })
  .strict();
export type CodingPayload = z.infer<typeof CodingPayloadSchema>;

export const RecMatchPayloadSchema = z
  .object({
    bankAccountId: z.string(),
    entityId: z.string(),
    periodKey,
    matchType: z.enum(['exact', 'fuzzy', 'one_to_many', 'many_to_one']),
    externalIds: z.array(z.string()).min(1).max(10),
    ledgerLineIds: z.array(z.string()).min(1).max(10),
    externalSumMinor: minor,
    ledgerSumMinor: minor,
    explanation: z.string().min(10).max(600),
  })
  .strict();
export type RecMatchPayload = z.infer<typeof RecMatchPayloadSchema>;

export const ReconcilingItemPayloadSchema = z
  .object({
    bankAccountId: z.string(),
    entityId: z.string(),
    periodKey,
    kind: z.enum(['deposit_in_transit', 'outstanding_check', 'bank_fee', 'interest', 'bank_error', 'book_error', 'timing', 'unexplained', 'fx_difference', 'other']),
    side: z.enum(['external', 'ledger']),
    amountMinor: minor.refine((v) => v !== 0, 'amount cannot be zero'),
    itemDate: isoDate,
    description: z.string().min(5).max(300),
    relatedItemType: z.enum(['bank_transaction', 'journal_line']).nullable(),
    relatedItemId: z.string().nullable(),
    requiresAdjustment: z.boolean(),
    clearedBy: z.object({ bankTxnId: z.string(), date: isoDate }).strict().nullable().optional(),
  })
  .strict();
export type ReconcilingItemPayload = z.infer<typeof ReconcilingItemPayloadSchema>;

export const FluxDriverSchema = z
  .object({
    label: z.string().max(200),
    kind: z.enum(['vendor', 'department', 'customer', 'new_item', 'volume', 'rate', 'one_time', 'timing', 'reclass', 'other']),
    amountMinor: minor,
    detail: z.string().max(200).optional(),
    refType: z.string().optional(),
    refId: z.string().optional(),
  })
  .strict();

export const FluxPayloadSchema = z
  .object({
    entityId: z.string(),
    periodKey,
    comparison: z.enum(['pop', 'yoy']),
    accountCode: z.string(),
    currentMinor: minor,
    comparativeMinor: minor,
    budgetMinor: minor.nullable(),
    varianceMinor: minor,
    variancePct: z.number().nullable(),
    thresholdAbsMinor: minor,
    thresholdPct: z.number(),
    materiality: z.enum(['trivial', 'below_pm', 'material']),
    text: z.string().min(20).max(4000),
    drivers: z.array(FluxDriverSchema).max(12),
    pending: z.array(z.object({ proposalId: z.string(), proposalRef: z.string(), label: z.string(), amountMinor: minor }).strict()).default([]),
  })
  .strict();
export type FluxPayload = z.infer<typeof FluxPayloadSchema>;

export const FindingPayloadSchema = z
  .object({
    entityId: z.string().nullable(),
    periodKey,
    category: z.enum(['self_approval', 'duplicate_payment', 'weekend_holiday', 'round_amount', 'threshold_skirting', 'benford', 'subledger_difference', 'intercompany', 'other']),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    recommendation: z.string().min(10).max(800),
    subjects: z.array(z.object({ type: z.string(), id: z.string(), label: z.string() }).strict()).min(1).max(20),
    tests: z.array(z.string()).default([]),
    score: z.number().default(0),
  })
  .strict();
export type FindingPayload = z.infer<typeof FindingPayloadSchema>;

export const ReportPayloadSchema = z
  .object({
    periodKey,
    summary: z.string().min(20).max(6000),
    highlights: z.array(z.string().max(400)).max(12),
    readiness: z.object({ ready: z.boolean(), messages: z.array(z.string()) }).strict(),
    content: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ReportPayload = z.infer<typeof ReportPayloadSchema>;

export const PAYLOAD_SCHEMAS = {
  journal_entry: JePayloadSchema,
  coding: CodingPayloadSchema,
  rec_match: RecMatchPayloadSchema,
  reconciling_item: ReconcilingItemPayloadSchema,
  flux_explanation: FluxPayloadSchema,
  finding: FindingPayloadSchema,
  report: ReportPayloadSchema,
} as const;

interface Common {
  title: string;
  why: string;
  confidence: number;
  evidence: EvidenceRef[];
  dedupeKey: string;
  flags?: string[];
}

const asJson = (x: unknown) => x as unknown as Record<string, JsonValue>;
const conf = (c: number) => Math.max(0, Math.min(1, Math.round(c * 1000) / 1000));

export function jeDraft(p: JePayload, c: Common & { ontologyType?: string }): ProposalDraft {
  const ontologyType = c.ontologyType ?? (p.entryType === 'accrual' ? 'tie:AccrualEntryProposal' : p.entryType === 'reclass' ? 'tie:ReclassProposal' : 'tie:JournalEntryProposal');
  return { kind: 'journal_entry', ontologyType, title: c.title, why: c.why, confidence: conf(c.confidence), entityId: p.entityId, periodKey: p.periodKey, payload: asJson(JePayloadSchema.parse(p)), evidence: c.evidence, dedupeKey: c.dedupeKey, flags: c.flags };
}

export function codingDraft(p: CodingPayload, c: Common): ProposalDraft {
  return { kind: 'coding', ontologyType: 'tie:CodingProposal', title: c.title, why: c.why, confidence: conf(c.confidence), entityId: p.entityId, periodKey: p.periodKey, payload: asJson(CodingPayloadSchema.parse(p)), evidence: c.evidence, dedupeKey: c.dedupeKey, flags: c.flags };
}

export function recMatchDraft(p: RecMatchPayload, c: Common): ProposalDraft {
  return { kind: 'rec_match', ontologyType: 'tie:MatchProposal', title: c.title, why: c.why, confidence: conf(c.confidence), entityId: p.entityId, periodKey: p.periodKey, payload: asJson(RecMatchPayloadSchema.parse(p)), evidence: c.evidence, dedupeKey: c.dedupeKey, flags: c.flags };
}

export function reconcilingItemDraft(p: ReconcilingItemPayload, c: Common): ProposalDraft {
  return { kind: 'reconciling_item', ontologyType: 'tie:ReconcilingItemProposal', title: c.title, why: c.why, confidence: conf(c.confidence), entityId: p.entityId, periodKey: p.periodKey, payload: asJson(ReconcilingItemPayloadSchema.parse(p)), evidence: c.evidence, dedupeKey: c.dedupeKey, flags: c.flags };
}

export function fluxDraft(p: FluxPayload, c: Common): ProposalDraft {
  return { kind: 'flux_explanation', ontologyType: 'tie:FluxExplanationProposal', title: c.title, why: c.why, confidence: conf(c.confidence), entityId: p.entityId, periodKey: p.periodKey, payload: asJson(FluxPayloadSchema.parse(p)), evidence: c.evidence, dedupeKey: c.dedupeKey, flags: c.flags };
}

export function findingDraft(p: FindingPayload, c: Common): ProposalDraft {
  return { kind: 'finding', ontologyType: 'tie:Finding', title: c.title, why: c.why, confidence: conf(c.confidence), entityId: p.entityId, periodKey: p.periodKey, payload: asJson(FindingPayloadSchema.parse(p)), evidence: c.evidence, dedupeKey: c.dedupeKey, flags: c.flags };
}

export function reportDraft(p: ReportPayload, c: Common): ProposalDraft {
  return { kind: 'report', ontologyType: 'tie:ClosePackage', title: c.title, why: c.why, confidence: conf(c.confidence), entityId: null, periodKey: p.periodKey, payload: asJson(ReportPayloadSchema.parse(p)), evidence: c.evidence, dedupeKey: c.dedupeKey, flags: c.flags };
}

export const money = (minor: number, ccy = 'USD') => `${minor < 0 ? '−' : ''}${ccy === 'GBP' ? '£' : ccy === 'EUR' ? '€' : '$'}${(Math.abs(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
