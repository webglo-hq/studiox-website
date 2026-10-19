import { z } from 'zod';

/**
 * Shapes: the structural half of the ontology (SHACL-like). Each shape types the instances
 * of an ontology class. These zod schemas ARE the domain types (via z.infer), the agent tool
 * input/output schemas (via JSON Schema export) and the validation entry point.
 */

export const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be an id');
export const CalendarDateShape = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date YYYY-MM-DD');
export const PeriodKeyShape = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a period YYYY-MM');
export const CentsShape = z.number().int('amounts are integer minor units (cents)');
export const NonNegCents = CentsShape.nonnegative();
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code');
export const Confidence = z.number().min(0).max(1);

export const ENTRY_TYPES = [
  'standard',
  'adjusting',
  'accrual',
  'reversing',
  'recurring',
  'reclass',
  'elimination',
  'fx_revaluation',
  'depreciation',
  'amortization',
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** Entry types permitted while a period is soft-closed (subledgers closed, top-side adjustments only). */
export const SOFT_CLOSE_ENTRY_TYPES: readonly EntryType[] = ['adjusting', 'accrual', 'reclass', 'elimination', 'fx_revaluation', 'depreciation', 'amortization', 'reversing'];

export const SourceRef = z.object({
  type: z.string().min(1).max(64).describe('record type, e.g. card_transaction, bill, bank_transaction'),
  id: z.string().min(1).max(64),
  label: z.string().max(200).optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const JournalLineDraft = z.object({
  accountId: Id.describe('ek:Account id'),
  debit: NonNegCents.default(0),
  credit: NonNegCents.default(0),
  memo: z.string().max(300).optional(),
  departmentId: Id.nullable().optional().describe('ek:Department dimension value id'),
  locationId: Id.nullable().optional().describe('ek:Location dimension value id'),
  classId: Id.nullable().optional().describe('ek:ClassDimension value id'),
  projectId: Id.nullable().optional().describe('ek:Project dimension value id'),
  counterpartyEntityId: Id.nullable().optional().describe('ek:LegalEntity id for intercompany lines'),
  txnCurrency: CurrencyCode.optional(),
  txnAmount: CentsShape.optional().describe('signed amount in transaction currency (debit positive)'),
  fxRate: z.number().positive().optional(),
  sourceRef: SourceRef.optional(),
});
export type JournalLineDraft = z.infer<typeof JournalLineDraft>;

export const JournalEntryDraft = z.object({
  entityId: Id.describe('ek:LegalEntity id'),
  entryDate: CalendarDateShape,
  periodKey: PeriodKeyShape,
  entryType: z.enum(ENTRY_TYPES),
  memo: z.string().min(3).max(500),
  currency: CurrencyCode.describe('functional currency of the entity'),
  autoReverseDate: CalendarDateShape.nullable().optional(),
  reversesEntryId: Id.nullable().optional(),
  lines: z.array(JournalLineDraft).min(2).max(500),
  sourceRefs: z.array(SourceRef).max(50).optional(),
});
export type JournalEntryDraft = z.infer<typeof JournalEntryDraft>;
export type JournalEntryDraftInput = z.input<typeof JournalEntryDraft>;

export const CODING_TREATMENTS = ['expense', 'prepaid', 'capitalize', 'balance_sheet'] as const;
export const CodingDecision = z.object({
  subjectType: z.enum(['card_transaction', 'bill']),
  subjectId: Id,
  accountId: Id.describe('ek:Account id'),
  departmentId: Id.nullable().optional(),
  locationId: Id.nullable().optional(),
  classId: Id.nullable().optional(),
  projectId: Id.nullable().optional(),
  treatment: z.enum(CODING_TREATMENTS),
  confidence: Confidence,
  basis: z.array(z.enum(['policy_rule', 'vendor_history', 'ontology_concept', 'merchant_category', 'capitalization_policy', 'prepaid_policy', 'model'])).min(1),
  previousAccountId: Id.nullable().optional(),
  alternatives: z.array(z.object({ accountId: Id, score: Confidence })).max(5).optional(),
});
export type CodingDecision = z.infer<typeof CodingDecision>;

export const MATCH_TYPES = ['exact', 'fuzzy', 'one_to_many', 'many_to_one', 'many_to_many', 'manual'] as const;
export const RecMatch = z.object({
  reconciliationId: Id.optional(),
  matchType: z.enum(MATCH_TYPES),
  bankItems: z.array(z.object({ id: Id, amount: CentsShape, date: CalendarDateShape.optional(), label: z.string().max(200).optional() })).min(1),
  ledgerItems: z.array(z.object({ id: Id, amount: CentsShape, date: CalendarDateShape.optional(), label: z.string().max(200).optional() })).min(1),
  confidence: Confidence,
  dateDeltaDays: z.number().int().min(0),
  nameScore: Confidence.optional(),
});
export type RecMatch = z.infer<typeof RecMatch>;

export const RECONCILING_ITEM_TYPES = [
  'deposit_in_transit',
  'outstanding_check',
  'bank_fee',
  'bank_interest',
  'bank_error',
  'book_error',
  'timing',
  'unexplained',
  'fx',
] as const;
export const ReconcilingItemDraft = z.object({
  reconciliationId: Id.optional(),
  itemType: z.enum(RECONCILING_ITEM_TYPES),
  side: z.enum(['bank', 'book']).describe('bank = on statement, not in books; book = in books, not on statement'),
  amount: CentsShape.describe('signed: positive increases the side it sits on'),
  description: z.string().min(3).max(300),
  originDate: CalendarDateShape,
  expectedClearDate: CalendarDateShape.nullable().optional(),
  clearedBy: z.array(SourceRef).optional().describe('subsequent-period evidence, e.g. next statement line'),
  sourceRefs: z.array(SourceRef).min(1),
});
export type ReconcilingItemDraft = z.infer<typeof ReconcilingItemDraft>;

export const DRIVER_KINDS = ['volume', 'rate', 'new_vendor', 'lost_vendor', 'one_time', 'timing', 'accrual', 'reclass', 'fx', 'headcount', 'mix', 'other'] as const;
export const VarianceDriver = z.object({
  label: z.string().min(2).max(200),
  kind: z.enum(DRIVER_KINDS),
  amount: CentsShape,
  evidence: z.array(SourceRef).max(20).default([]),
});
export type VarianceDriver = z.infer<typeof VarianceDriver>;

export const FluxExplanationDraft = z.object({
  fluxLineId: Id.optional(),
  entityId: Id,
  accountId: Id,
  periodKey: PeriodKeyShape,
  comparison: z.enum(['prior_month', 'prior_year', 'budget']),
  variance: CentsShape,
  narrative: z.string().min(10).max(2000),
  drivers: z.array(VarianceDriver).max(10),
  coverage: z.number().min(0).max(2).describe('share of the variance explained by listed drivers'),
});
export type FluxExplanationDraft = z.infer<typeof FluxExplanationDraft>;

export const ISSUE_CATEGORIES = [
  'duplicate_payment',
  'sod_break',
  'unexplained_bank_item',
  'misclassification',
  'control_account_posting',
  'intercompany_mismatch',
  'tieout_difference',
  'round_amount',
  'weekend_posting',
  'threshold_avoidance',
  'benford_deviation',
  'prompt_injection',
  'missing_amortization',
  'unusual_account_pair',
  'stale_reconciling_item',
  'other',
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export const IssueDraft = z.object({
  category: z.enum(ISSUE_CATEGORIES),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  title: z.string().min(3).max(200),
  description: z.string().min(3).max(2000),
  amount: CentsShape.optional(),
  entityId: Id.optional(),
  subjectRefs: z.array(SourceRef).min(1).max(50),
  recommendedAction: z.string().min(3).max(500),
  assertions: z.array(z.string()).max(9).optional().describe('ek:Assertion individuals at risk'),
});
export type IssueDraft = z.infer<typeof IssueDraft>;

export const PrepaidScheduleDraft = z.object({
  entityId: Id,
  description: z.string().min(3).max(200),
  vendorId: Id.nullable().optional(),
  total: NonNegCents.min(1),
  startPeriod: PeriodKeyShape,
  months: z.number().int().min(2).max(120),
  prepaidAccountId: Id,
  expenseAccountId: Id,
  departmentId: Id.nullable().optional(),
  sourceRef: SourceRef,
});
export type PrepaidScheduleDraft = z.infer<typeof PrepaidScheduleDraft>;

export const FixedAssetDraft = z.object({
  entityId: Id,
  name: z.string().min(2).max(200),
  assetClass: z.enum(['computer_equipment', 'furniture', 'leasehold_improvements', 'software']),
  quantity: z.number().int().min(1).max(10_000).default(1),
  cost: NonNegCents.min(1),
  salvage: NonNegCents.default(0),
  inServiceDate: CalendarDateShape,
  usefulLifeMonths: z.number().int().min(12).max(480),
  assetAccountId: Id,
  accumDeprAccountId: Id,
  deprExpenseAccountId: Id,
  departmentId: Id.nullable().optional(),
  sourceRef: SourceRef,
});
export type FixedAssetDraft = z.infer<typeof FixedAssetDraft>;

export const TASK_STATUSES = ['not_started', 'in_progress', 'blocked', 'ready_for_review', 'complete'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TaskUpdate = z.object({
  taskId: Id,
  status: z.enum(TASK_STATUSES),
  note: z.string().max(500).optional(),
});
export type TaskUpdate = z.infer<typeof TaskUpdate>;

export const ClosePackageDraft = z.object({
  periodKey: PeriodKeyShape,
  title: z.string().min(3).max(200),
  sections: z.array(z.object({ id: z.string(), title: z.string(), kind: z.enum(['table', 'narrative', 'checklist', 'metrics']) })).min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  commentary: z.string().max(10_000),
});
export type ClosePackageDraft = z.infer<typeof ClosePackageDraft>;

/** Discriminated union of everything an agent may propose. */
export const PROPOSAL_KINDS = [
  'journal_entry',
  'coding',
  'rec_match',
  'reconciling_item',
  'flux_explanation',
  'issue',
  'prepaid_schedule',
  'fixed_asset',
  'task_update',
  'close_package',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_CLASS: Record<ProposalKind, string> = {
  journal_entry: 'ek:JournalEntry',
  coding: 'ek:CodingDecision',
  rec_match: 'ek:Match',
  reconciling_item: 'ek:ReconcilingItem',
  flux_explanation: 'ek:VarianceExplanation',
  issue: 'ek:Exception',
  prepaid_schedule: 'ek:PrepaidSchedule',
  fixed_asset: 'ek:FixedAsset',
  task_update: 'ek:CloseTask',
  close_package: 'ek:ClosePackage',
};

export const PROPOSAL_SHAPES: Record<ProposalKind, z.ZodType> = {
  journal_entry: JournalEntryDraft,
  coding: CodingDecision,
  rec_match: RecMatch,
  reconciling_item: ReconcilingItemDraft,
  flux_explanation: FluxExplanationDraft,
  issue: IssueDraft,
  prepaid_schedule: PrepaidScheduleDraft,
  fixed_asset: FixedAssetDraft,
  task_update: TaskUpdate,
  close_package: ClosePackageDraft,
};

export const EvidenceItem = z.object({
  kind: z.enum(['record', 'calculation', 'rule', 'history', 'document', 'check', 'note']),
  label: z.string().min(1).max(300),
  detail: z.string().max(2000).optional(),
  ref: SourceRef.optional(),
  /** true when the content originates from an external party (bank memo, vendor text) */
  untrusted: z.boolean().optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;
