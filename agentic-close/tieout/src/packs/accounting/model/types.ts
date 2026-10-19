/** Accounting-pack value types stored in JSONB columns or exchanged between modules. */

export type DimensionKey = 'department' | 'location' | 'product_class' | 'project';
export const DIMENSION_KEYS: readonly DimensionKey[] = ['department', 'location', 'product_class', 'project'];

/**
 * Materiality (AU-C 320 / AS 2105 / ISA 320): overall materiality (OM) from a benchmark,
 * performance materiality (PM) as a fraction of OM, and a clearly-trivial (CT) threshold below
 * which misstatements need not be accumulated. Invariant AX-MAT-01: CT < PM < OM.
 */
export interface MaterialitySettings {
  basis: 'revenue' | 'pretax_income' | 'total_assets';
  basisAmountMinor: number;
  basisPct: number;
  overallMinor: number;
  performanceMinor: number;
  clearlyTrivialMinor: number;
  fluxAbsMinor: number;
  fluxPct: number;
  rationale: string;
}

export interface FluxDriver {
  label: string;
  kind: 'vendor' | 'department' | 'customer' | 'new_item' | 'volume' | 'rate' | 'one_time' | 'timing' | 'reclass' | 'other';
  amountMinor: number;
  detail?: string;
  refType?: string;
  refId?: string;
}

export interface SodRuleConfig {
  /** maker_checker / requester_checker: subject types the rule covers */
  subjects?: string[];
  /** role_conflict: the first role key may not be held together with any of the others */
  roles?: string[];
  /** permission_conflict: permissions that must not be held together */
  permissions?: string[];
}

export interface StatementLine {
  code: string;
  label: string;
  section: string;
  amountMinor: number;
  priorMinor?: number;
  budgetMinor?: number;
  xbrl?: string;
  level: number;
  isTotal?: boolean;
}

export interface ClosePackageContent {
  periodKey: string;
  periodLabel: string;
  reportingCurrency: string;
  generatedAt: string;
  generatedBy: string;
  entities: { id: string; code: string; name: string; currency: string }[];
  trialBalances: {
    entityCode: string;
    currency: string;
    rows: { code: string; name: string; debitMinor: number; creditMinor: number }[];
    totalDebitMinor: number;
    totalCreditMinor: number;
  }[];
  balanceSheet: StatementLine[];
  incomeStatement: StatementLine[];
  consolidation: { eliminationsMinor: number; ctaMinor: number; closingRate: number | null; averageRate: number | null };
  commentary: { accountCode: string; accountName: string; entityCode: string; varianceMinor: number; variancePct: number | null; text: string; approvedBy: string | null }[];
  reconciliations: { entityCode: string; account: string; recType: string; status: string; unreconciledMinor: number; preparer: string | null; reviewer: string | null }[];
  openItems: { kind: string; ref: string; title: string; amountMinor: number }[];
  agentActivity: { runs: number; proposals: number; autoApplied: number; approved: number; rejected: number; costMicros: number; mode: string };
  signoffs: { role: string; name: string; at: string }[];
  kpis: { revenueMinor: number; grossMarginPct: number | null; opexMinor: number; netIncomeMinor: number; cashMinor: number };
}
