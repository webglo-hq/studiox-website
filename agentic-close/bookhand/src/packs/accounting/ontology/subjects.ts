/**
 * Resolved subjects the executable axioms run on. Drafts arriving from agents or people reference accounts
 * by number and dimensions by code; the domain layer resolves them into these shapes first.
 */

export interface ResolvedAccount {
  id: string;
  number: string;
  name: string;
  subtype: string;
  accountClass: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normalBalance: 'debit' | 'credit';
  isPostable: boolean;
  active: boolean;
  isIntercompany: boolean;
  requiresDepartment: boolean;
  isControlAccount: boolean;
}

export interface ResolvedLine {
  account: ResolvedAccount | null;
  accountRef: string;
  debit: number;
  credit: number;
  txnCurrency: string;
  txnAmount: number;
  departmentId: string | null;
  counterpartyEntityId: string | null;
  memo: string | null;
}

export interface ResolvedPeriod {
  id: string;
  entityId: string;
  startDate: string;
  endDate: string;
  status: 'future' | 'open' | 'soft_closed' | 'locked';
}

export interface ResolvedJournalEntry {
  entityId: string;
  functionalCurrency: string;
  period: ResolvedPeriod | null;
  nextPeriod: ResolvedPeriod | null;
  entryDate: string;
  entryType: string;
  description: string;
  currency: string;
  fxRate: number;
  lines: ResolvedLine[];
  autoReverseDate: string | null;
  preparedBy: string | null;
  approvedBy: string | null;
  reversesEntryId: string | null;
}

export interface JournalEntryContext {
  /** Capitalization threshold (minor units, functional currency). */
  capitalizationThresholdMinor: number;
  /** Is classId a subclass of ancestorId (ontology subsumption)? */
  isA(classId: string, ancestorId: string): boolean;
  /** Capitalizable class ids whose bucketing keywords match a text, from the ontology. */
  capitalizableMatches(text: string): string[];
}

export interface TrialBalanceSubject {
  entityLabel: string;
  rows: Array<{ accountNumber: string; accountName: string; accountClass: ResolvedAccount['accountClass']; normalBalance: 'debit' | 'credit'; subtype: string; debit: number; credit: number }>;
}

export interface ReconciliationSubject {
  id: string;
  recType: string;
  glBalance: number;
  externalBalance: number;
  reconcilingTotal: number;
  preparedBy: string | null;
  reviewedBy: string | null;
  status: string;
  notes: string | null;
  items: Array<{ kind: string; amount: number; itemDate: string; status: string; description: string }>;
  asOfDate: string;
}

export interface ReconciliationContext {
  clearlyTrivialMinor: number;
  staleAfterDays: number;
  /** Validating a certification request (stricter than routine validation). */
  certifying: boolean;
}

export interface FluxSubject {
  status: string;
  preparedBy: string | null;
  approvedBy: string | null;
  lines: Array<{ accountNumber: string; current: number; comparison: number; variance: number; isMaterial: boolean; explanationStatus: string; explanation: string | null }>;
}

export interface MaterialitySubject {
  overall: number;
  performance: number;
  trivial: number;
}

export interface ScheduleSubject {
  kind: 'amortization' | 'depreciation';
  label: string;
  total: number;
  salvage: number;
  lines: number[];
  accumulated?: number;
}

export interface IntercompanySubject {
  pairLabel: string;
  receivableReporting: number;
  payableReporting: number;
  toleranceMinor: number;
}

export interface ProposalSubject {
  why: string;
  confidence: number;
  evidenceCount: number;
  riskFlags: string[];
  disposition: string;
}
