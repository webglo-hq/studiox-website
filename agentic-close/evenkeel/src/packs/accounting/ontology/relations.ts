import type { Individual, OntologyRelation } from '../../../framework/ontology/types';

const r = (id: string, label: string, domain: string, range: string, cardinality: OntologyRelation['cardinality'], definition: string, extra: Partial<OntologyRelation> = {}): OntologyRelation => ({
  id,
  label,
  domain,
  range,
  cardinality,
  definition,
  ...extra,
});

export const RELATIONS: OntologyRelation[] = [
  // REA core
  r('ek:stockflow', 'changes resource', 'ek:EconomicEvent', 'ek:EconomicResource', '0..*', 'Event increases or decreases a resource (REA stockflow).', { sources: ['mccarthy1982'] }),
  r('ek:participates', 'has participant', 'ek:EconomicEvent', 'ek:EconomicAgent', '1..*', 'Agents providing and receiving in the event (REA participation).', { sources: ['mccarthy1982'] }),
  r('ek:duality', 'is paired with', 'ek:EconomicEvent', 'ek:EconomicEvent', '0..*', 'Give event paired with take event in an exchange (REA duality), e.g. bill ↔ payment.', { sources: ['mccarthy1982'] }),
  r('ek:fulfills', 'fulfils', 'ek:EconomicEvent', 'ek:Commitment', '0..*', 'Event executes a commitment (e.g. bill fulfils a purchase order).', { sources: ['geerts-mccarthy2002'] }),
  // structure
  r('ek:belongsToEntity', 'belongs to entity', 'ek:Thing', 'ek:LegalEntity', '0..1', 'Record is owned by one legal entity.'),
  r('ek:functionalCurrency', 'has functional currency', 'ek:LegalEntity', 'ek:Currency', '1', 'Currency of the entity’s primary economic environment (ASC 830).', { sources: ['asc830'] }),
  r('ek:consolidatesInto', 'consolidates into', 'ek:LegalEntity', 'ek:ConsolidationGroup', '0..*', 'Entity is part of a consolidation group.', { sources: ['asc810'] }),
  r('ek:inPeriod', 'in period', 'ek:JournalEntry', 'ek:FiscalPeriod', '1', 'Accounting period the entry is recorded in (cutoff).'),
  r('ek:hasState', 'has state', 'ek:FiscalPeriod', 'ek:PeriodState', '1', 'Current lifecycle state.'),
  // chart of accounts
  r('ek:hasNormalBalance', 'has normal balance', 'ek:Account', 'ek:NormalBalance', '1', 'Side that increases the account.', { sources: ['pacioli1494'] }),
  r('ek:rollsUpTo', 'presents in', 'ek:Account', 'ek:FinancialStatementLineItem', '1', 'Statement line the account aggregates into (XBRL element).', { sources: ['xbrl-usgaap'] }),
  r('ek:childOf', 'child of', 'ek:Account', 'ek:Account', '0..1', 'Account hierarchy (summary accounts).', { transitive: true }),
  r('ek:conceptOf', 'measures concept', 'ek:Account', 'ek:Thing', '0..1', 'Spend or balance concept an account measures (used for bucketing).'),
  r('ek:controlledBy', 'controlled by', 'ek:ControlAccount', 'ek:Subledger', '1', 'Subledger whose total must equal the control account.'),
  // journal
  r('ek:hasLine', 'has line', 'ek:JournalEntry', 'ek:JournalLine', '1..*', 'Lines of the entry; Σ debits = Σ credits.', { inverse: 'ek:lineOf' }),
  r('ek:lineOf', 'line of', 'ek:JournalLine', 'ek:JournalEntry', '1', 'Entry the line belongs to.', { inverse: 'ek:hasLine' }),
  r('ek:postsTo', 'posts to', 'ek:JournalLine', 'ek:Account', '1', 'Account debited or credited.'),
  r('ek:taggedWith', 'tagged with', 'ek:JournalLine', 'ek:Dimension', '0..*', 'Dimension values on the line.'),
  r('ek:hasEntryType', 'has entry type', 'ek:JournalEntry', 'ek:EntryType', '1', 'Purpose classification.'),
  r('ek:reverses', 'reverses', 'ek:ReversingEntry', 'ek:JournalEntry', '1', 'Posted entry cancelled by this entry.', { inverse: 'ek:reversedBy' }),
  r('ek:reversedBy', 'reversed by', 'ek:JournalEntry', 'ek:ReversingEntry', '0..1', 'Reversal that cancels this entry.', { inverse: 'ek:reverses' }),
  r('ek:documentedBy', 'documented by', 'ek:Thing', 'ek:SourceDocument', '0..*', 'Provenance: originating document.', { sources: ['pcaob-as1105'] }),
  r('ek:counterparty', 'counterparty entity', 'ek:JournalLine', 'ek:LegalEntity', '0..1', 'Other group entity on an intercompany line.', { sources: ['asc810'] }),
  // subledgers
  r('ek:billedBy', 'billed by', 'ek:Bill', 'ek:Vendor', '1', 'Vendor issuing the bill.'),
  r('ek:settles', 'settles', 'ek:VendorPayment', 'ek:Bill', '1..*', 'Bills a payment settles (duality).'),
  r('ek:appliesTo', 'applies to', 'ek:CustomerReceipt', 'ek:Invoice', '1..*', 'Invoices a receipt settles.'),
  r('ek:heldAt', 'held at', 'ek:BankAccount', 'ek:Bank', '1', 'Bank holding the account.'),
  r('ek:mapsToCash', 'maps to', 'ek:BankAccount', 'ek:CashAccount', '1', 'GL cash account of the bank account.'),
  r('ek:coveredBy', 'covers service period', 'ek:Bill', 'ek:ServicePeriod', '0..1', 'Service dates on the bill (cutoff).'),
  r('ek:amortizedBy', 'amortised by', 'ek:PrepaidSchedule', 'ek:JournalEntry', '0..*', 'Monthly amortisation entries.'),
  r('ek:depreciatedBy', 'depreciated by', 'ek:FixedAsset', 'ek:DepreciationSchedule', '1', 'Schedule allocating cost.'),
  // reconciliation
  r('ek:reconciles', 'reconciles', 'ek:Reconciliation', 'ek:Account', '1', 'GL account under reconciliation.'),
  r('ek:matchesItem', 'matches', 'ek:Match', 'ek:Thing', '1..*', 'Items paired by the match (at least one on each side).'),
  r('ek:hasReconcilingItem', 'has reconciling item', 'ek:Reconciliation', 'ek:ReconcilingItem', '0..*', 'Explained differences.'),
  r('ek:resolvedBy', 'resolved by', 'ek:ReconcilingItem', 'ek:JournalEntry', '0..1', 'Entry clearing the item.'),
  r('ek:certifiedBy', 'certified by', 'ek:Reconciliation', 'ek:Certification', '0..*', 'Preparer and reviewer sign-offs.'),
  // variance
  r('ek:explains', 'explains', 'ek:VarianceExplanation', 'ek:Variance', '1', 'Variance being explained.'),
  r('ek:drivenBy', 'driven by', 'ek:Variance', 'ek:VarianceDriver', '0..*', 'Quantified causes.'),
  r('ek:comparedAgainst', 'compared against', 'ek:Variance', 'ek:Budget', '0..1', 'Budget/forecast used as comparison.'),
  // intercompany
  r('ek:eliminatedBy', 'eliminated by', 'ek:IntercompanyBalance', 'ek:EliminationEntry', '0..1', 'Consolidation elimination.', { sources: ['asc810'] }),
  r('ek:measuredAt', 'measured at', 'ek:ExchangeRate', 'ek:RateType', '1', 'Rate type.', { sources: ['asc830'] }),
  // controls
  r('ek:mitigates', 'addresses assertion', 'ek:Control', 'ek:Assertion', '1..*', 'Assertions the control supports.', { sources: ['pcaob-as1105', 'coso2013'] }),
  r('ek:preparedBy', 'prepared by', 'ek:Thing', 'ek:InternalAgent', '0..1', 'Maker.'),
  r('ek:approvedBy', 'approved by', 'ek:Thing', 'ek:InternalAgent', '0..1', 'Checker; must differ from maker.'),
  r('ek:evidencedBy', 'evidenced by', 'ek:Thing', 'ek:Evidence', '0..*', 'Supporting evidence.'),
  r('ek:conflictsWith', 'conflicts with', 'ek:Role', 'ek:Role', '0..*', 'Incompatible duties (SoD).', { sources: ['coso2013'] }),
  // close
  r('ek:dependsOn', 'depends on', 'ek:CloseTask', 'ek:CloseTask', '0..*', 'Finish-to-start dependency (acyclic).', { transitive: true }),
  r('ek:performedBySkill', 'performed by skill', 'ek:CloseTask', 'ek:Skill', '0..1', 'Skill an agent runs for the task.'),
  r('ek:dueOn', 'due on', 'ek:CloseTask', 'ek:Workday', '1', 'Workday offset due date.'),
  r('ek:partOfCycle', 'part of', 'ek:CloseTask', 'ek:CloseCycle', '1', 'Close cycle.'),
  // agents
  r('ek:executes', 'executes', 'ek:AgentRun', 'ek:Skill', '1', 'Skill version run.'),
  r('ek:proposes', 'proposes', 'ek:AgentRun', 'ek:Proposal', '0..*', 'Proposals produced by the run.'),
  r('ek:actsFor', 'acts for', 'ek:SoftwareAgent', 'ek:InternalAgent', '1', 'User whose authority the agent exercises (least privilege).'),
  r('ek:atAutonomy', 'at autonomy', 'ek:Skill', 'ek:AutonomyLevel', '1', 'Configured autonomy level.'),
  r('ek:governedBy', 'governed by', 'ek:Skill', 'ek:Policy', '1', 'Current policy version.'),
];

const i = (id: string, label: string, type: string, definition: string, extra: Partial<Individual> = {}): Individual => ({ id, label, type, definition, ...extra });

export const INDIVIDUALS: Individual[] = [
  i('ek:Debit', 'Debit', 'ek:NormalBalance', 'Left side; increases assets and expenses.', { plain: 'Money going into an asset or expense.', sources: ['pacioli1494'], mappings: { xbrlGl: 'debitCreditCode=D' } }),
  i('ek:Credit', 'Credit', 'ek:NormalBalance', 'Right side; increases liabilities, equity and revenue.', { plain: 'Money coming from a liability, equity or revenue.', sources: ['pacioli1494'], mappings: { xbrlGl: 'debitCreditCode=C' } }),

  i('ek:Open', 'Open', 'ek:PeriodState', 'All entry types may post (subject to approval).', { plain: 'Anything can still be booked.', properties: { allowsPosting: true } }),
  i('ek:SoftClose', 'Soft close', 'ek:PeriodState', 'Subledgers closed; only adjusting-type entries by Senior Accountant or above.', { plain: 'Only top-side adjustments are allowed.', properties: { allowsPosting: 'adjusting-only' } }),
  i('ek:HardClose', 'Hard close (locked)', 'ek:PeriodState', 'No postings; reopening requires CFO approval with a reason.', { plain: 'Locked. Numbers are final.', properties: { allowsPosting: false } }),

  i('ek:Standard', 'Standard entry', 'ek:EntryType', 'Ordinary transaction entry.'),
  i('ek:Adjusting', 'Adjusting entry', 'ek:EntryType', 'Top-side correction made during the close.'),
  i('ek:AccrualType', 'Accrual entry', 'ek:EntryType', 'Recognises incurred but unbilled amounts; auto-reverses next period.'),
  i('ek:Reversing', 'Reversing entry', 'ek:EntryType', 'Mirror of a posted entry; cancels it.'),
  i('ek:Recurring', 'Recurring entry', 'ek:EntryType', 'Template-generated each period.'),
  i('ek:Reclass', 'Reclassification', 'ek:EntryType', 'Moves an amount between accounts/dimensions without changing totals.'),
  i('ek:Elimination', 'Elimination', 'ek:EntryType', 'Consolidation-only intercompany elimination.', { sources: ['asc810'] }),
  i('ek:FxRevaluationType', 'FX revaluation', 'ek:EntryType', 'Remeasures monetary items at closing rate.', { sources: ['asc830'] }),
  i('ek:DepreciationType', 'Depreciation', 'ek:EntryType', 'Fixed-asset depreciation from the register.', { sources: ['asc360'] }),
  i('ek:AmortizationType', 'Amortisation', 'ek:EntryType', 'Prepaid amortisation from schedules.', { sources: ['asc340'] }),

  i('ek:Existence', 'Existence', 'ek:Assertion', 'Assets, liabilities and equity interests exist at the balance sheet date.', { plain: 'It is real.', sources: ['pcaob-as1105'] }),
  i('ek:Occurrence', 'Occurrence', 'ek:Assertion', 'Recorded transactions and events have occurred and pertain to the entity.', { plain: 'It actually happened.', sources: ['isa315'] }),
  i('ek:Completeness', 'Completeness', 'ek:Assertion', 'All transactions and balances that should be recorded have been recorded.', { plain: 'Nothing is missing.', sources: ['pcaob-as1105', 'isa315'] }),
  i('ek:Accuracy', 'Accuracy', 'ek:Assertion', 'Amounts and data have been recorded appropriately.', { plain: 'The amount is right.', sources: ['isa315'] }),
  i('ek:Valuation', 'Valuation & allocation', 'ek:Assertion', 'Balances are included at appropriate amounts and adjustments are recorded.', { plain: 'It is worth what we say.', sources: ['pcaob-as1105'] }),
  i('ek:Cutoff', 'Cutoff', 'ek:Assertion', 'Transactions are recorded in the correct period.', { plain: 'It is in the right month.', sources: ['isa315'] }),
  i('ek:Classification', 'Classification', 'ek:Assertion', 'Transactions are recorded in the proper accounts.', { plain: 'It is in the right account.', sources: ['isa315'] }),
  i('ek:RightsAndObligations', 'Rights & obligations', 'ek:Assertion', 'The entity holds rights to assets and liabilities are its obligations.', { plain: 'It is ours / we owe it.', sources: ['pcaob-as1105'] }),
  i('ek:PresentationAndDisclosure', 'Presentation & disclosure', 'ek:Assertion', 'Components are properly classified, described and disclosed.', { plain: 'It is shown and described properly.', sources: ['pcaob-as1105'] }),

  i('ek:OverallMateriality', 'Overall materiality', 'ek:Materiality', 'Threshold for the financial statements as a whole (e.g. 1% of revenue).', { sources: ['isa320', 'pcaob-as2105'], properties: { basis: 'revenue', pct: 0.01 } }),
  i('ek:PerformanceMateriality', 'Performance materiality', 'ek:Materiality', 'Lower threshold used to reduce aggregation risk (typically 50–75% of overall).', { sources: ['isa320'], properties: { pctOfOverall: 0.75 } }),
  i('ek:ClearlyTrivial', 'Clearly trivial', 'ek:Materiality', 'Threshold below which misstatements are clearly inconsequential (typically ≤5% of overall).', { sources: ['isa450'], properties: { pctOfOverall: 0.05 } }),

  i('ek:L0', 'L0 — Suggest', 'ek:AutonomyLevel', 'Agent suggests; a person must act.', { plain: 'Agent only makes suggestions.' }),
  i('ek:L1', 'L1 — Draft for approval', 'ek:AutonomyLevel', 'Agent drafts; every item needs approval before posting.', { plain: 'Agent prepares, a person approves each item.' }),
  i('ek:L2', 'L2 — Auto-post under threshold', 'ek:AutonomyLevel', 'Agent posts items below the policy threshold and confidence floor; a sample is reviewed after posting.', { plain: 'Small, confident items post automatically; a sample is checked.' }),
  i('ek:L3', 'L3 — Auto with post-hoc review', 'ek:AutonomyLevel', 'Agent posts verified items; all are reviewed after posting. Never above performance materiality.', { plain: 'Agent posts, people review afterwards.' }),

  i('ek:Spot', 'Spot rate', 'ek:RateType', 'Rate on the transaction date.', { sources: ['asc830'] }),
  i('ek:Closing', 'Closing rate', 'ek:RateType', 'Rate at the balance sheet date; used for monetary items.', { sources: ['asc830'] }),
  i('ek:Average', 'Average rate', 'ek:RateType', 'Period average; used for income statement translation.', { sources: ['asc830'] }),
  i('ek:Historical', 'Historical rate', 'ek:RateType', 'Rate when the item arose; used for equity and non-monetary items.', { sources: ['asc830'] }),

  i('ek:ControlEnvironment', 'Control environment', 'ek:Control', 'COSO component 1 (principles 1–5).', { sources: ['coso2013'] }),
  i('ek:RiskAssessment', 'Risk assessment', 'ek:Control', 'COSO component 2 (principles 6–9).', { sources: ['coso2013'] }),
  i('ek:ControlActivities', 'Control activities', 'ek:Control', 'COSO component 3 (principles 10–12): approvals, reconciliations, SoD.', { sources: ['coso2013'] }),
  i('ek:InformationCommunication', 'Information & communication', 'ek:Control', 'COSO component 4 (principles 13–15).', { sources: ['coso2013'] }),
  i('ek:MonitoringActivities', 'Monitoring activities', 'ek:Control', 'COSO component 5 (principles 16–17).', { sources: ['coso2013'] }),

  i('ek:BalanceSheet', 'Balance sheet', 'ek:FinancialStatement', 'Statement of financial position at a date.', { sources: ['con6'] }),
  i('ek:IncomeStatement', 'Income statement', 'ek:FinancialStatement', 'Statement of operations for a period.', { sources: ['con6'] }),
  i('ek:CashFlowStatement', 'Cash flow statement', 'ek:FinancialStatement', 'Statement of cash flows for a period.', { sources: ['con6'] }),

  i('ek:PriorMonth', 'Prior month', 'ek:ComparisonBasis', 'Compare with the immediately preceding period.'),
  i('ek:PriorYear', 'Prior year', 'ek:ComparisonBasis', 'Compare with the same period last year (seasonality).'),
  i('ek:BudgetComparison', 'Budget', 'ek:ComparisonBasis', 'Compare with the approved budget.'),
];
