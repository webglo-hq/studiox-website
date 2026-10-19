import type { Individual } from '../../../ontology/kernel';

function ind(id: string, label: string, type: string, definition: string, whyItMatters: string, example: string, extra: Partial<Individual> = {}): Individual {
  return { id, label, type, definition, whyItMatters, example, ...extra };
}

export const FS_LINES: Array<{ key: string; label: string; statement: 'BS' | 'IS'; section: string; xbrl?: string; order: number }> = [
  { key: 'BS.CA.CASH', label: 'Cash and cash equivalents', statement: 'BS', section: 'Current assets', xbrl: 'us-gaap:CashAndCashEquivalentsAtCarryingValue', order: 10 },
  { key: 'BS.CA.AR', label: 'Accounts receivable, net', statement: 'BS', section: 'Current assets', xbrl: 'us-gaap:AccountsReceivableNetCurrent', order: 20 },
  { key: 'BS.CA.PREPAID', label: 'Prepaid expenses', statement: 'BS', section: 'Current assets', xbrl: 'us-gaap:PrepaidExpenseCurrent', order: 30 },
  { key: 'BS.CA.OTHER', label: 'Other current assets', statement: 'BS', section: 'Current assets', xbrl: 'us-gaap:OtherAssetsCurrent', order: 40 },
  { key: 'BS.CA.IC', label: 'Due from affiliates', statement: 'BS', section: 'Current assets', xbrl: 'us-gaap:DueFromRelatedPartiesCurrent', order: 45 },
  { key: 'BS.NCA.PPE', label: 'Property and equipment, net', statement: 'BS', section: 'Non-current assets', xbrl: 'us-gaap:PropertyPlantAndEquipmentNet', order: 50 },
  { key: 'BS.NCA.OTHER', label: 'Other non-current assets', statement: 'BS', section: 'Non-current assets', xbrl: 'us-gaap:OtherAssetsNoncurrent', order: 60 },
  { key: 'BS.CL.AP', label: 'Accounts payable', statement: 'BS', section: 'Current liabilities', xbrl: 'us-gaap:AccountsPayableCurrent', order: 110 },
  { key: 'BS.CL.ACCRUED', label: 'Accrued liabilities', statement: 'BS', section: 'Current liabilities', xbrl: 'us-gaap:AccruedLiabilitiesCurrent', order: 120 },
  { key: 'BS.CL.CARDS', label: 'Credit card payable', statement: 'BS', section: 'Current liabilities', xbrl: 'us-gaap:AccountsPayableCurrent', order: 125 },
  { key: 'BS.CL.DEFREV', label: 'Deferred revenue', statement: 'BS', section: 'Current liabilities', xbrl: 'us-gaap:ContractWithCustomerLiabilityCurrent', order: 130 },
  { key: 'BS.CL.IC', label: 'Due to affiliates', statement: 'BS', section: 'Current liabilities', xbrl: 'us-gaap:DueToRelatedPartiesCurrent', order: 135 },
  { key: 'BS.EQ.CAPITAL', label: 'Common stock and paid-in capital', statement: 'BS', section: 'Equity', xbrl: 'us-gaap:CommonStocksIncludingAdditionalPaidInCapital', order: 210 },
  { key: 'BS.EQ.RE', label: 'Retained earnings', statement: 'BS', section: 'Equity', xbrl: 'us-gaap:RetainedEarningsAccumulatedDeficit', order: 220 },
  { key: 'BS.EQ.AOCI', label: 'Accumulated other comprehensive income', statement: 'BS', section: 'Equity', xbrl: 'us-gaap:AccumulatedOtherComprehensiveIncomeLossNetOfTax', order: 230 },
  // Computed, not mapped from accounts: year-to-date profit, presented in equity until the year-end close.
  { key: 'BS.EQ.CYE', label: 'Current-year earnings', statement: 'BS', section: 'Equity', order: 240 },
  { key: 'IS.REV.SUBSCRIPTION', label: 'Subscription revenue', statement: 'IS', section: 'Revenue', xbrl: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', order: 310 },
  { key: 'IS.REV.SERVICES', label: 'Services revenue', statement: 'IS', section: 'Revenue', xbrl: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', order: 320 },
  { key: 'IS.COGS', label: 'Cost of revenue', statement: 'IS', section: 'Cost of revenue', xbrl: 'us-gaap:CostOfRevenue', order: 410 },
  { key: 'IS.OPEX.PAYROLL', label: 'Payroll and benefits', statement: 'IS', section: 'Operating expenses', xbrl: 'us-gaap:LaborAndRelatedExpense', order: 510 },
  { key: 'IS.OPEX.SOFTWARE', label: 'Software subscriptions', statement: 'IS', section: 'Operating expenses', order: 520 },
  { key: 'IS.OPEX.FACILITIES', label: 'Rent and facilities', statement: 'IS', section: 'Operating expenses', xbrl: 'us-gaap:OccupancyNet', order: 530 },
  { key: 'IS.OPEX.TE', label: 'Travel and entertainment', statement: 'IS', section: 'Operating expenses', xbrl: 'us-gaap:TravelAndEntertainmentExpense', order: 540 },
  { key: 'IS.OPEX.MARKETING', label: 'Marketing and events', statement: 'IS', section: 'Operating expenses', xbrl: 'us-gaap:MarketingAndAdvertisingExpense', order: 550 },
  { key: 'IS.OPEX.PROF', label: 'Professional fees', statement: 'IS', section: 'Operating expenses', xbrl: 'us-gaap:ProfessionalFees', order: 560 },
  { key: 'IS.OPEX.DA', label: 'Depreciation and amortization', statement: 'IS', section: 'Operating expenses', xbrl: 'us-gaap:DepreciationDepletionAndAmortization', order: 570 },
  { key: 'IS.OPEX.OTHER', label: 'Other operating expenses', statement: 'IS', section: 'Operating expenses', xbrl: 'us-gaap:OtherCostAndExpenseOperating', order: 580 },
  { key: 'IS.IC', label: 'Intercompany (eliminated)', statement: 'IS', section: 'Intercompany', order: 590 },
  { key: 'IS.OTHER', label: 'Other income (expense), net', statement: 'IS', section: 'Other income (expense)', xbrl: 'us-gaap:NonoperatingIncomeExpense', order: 610 },
];

export const JE_TYPE_INFO: Record<string, { label: string; definition: string }> = {
  standard: { label: 'Standard', definition: 'Routine entry recording a business transaction.' },
  adjusting: { label: 'Adjusting', definition: 'End-of-period correction or adjustment under accrual accounting.' },
  accrual: { label: 'Accrual', definition: 'Recognizes an incurred expense or earned revenue before invoice or cash; auto-reverses next period.' },
  reversing: { label: 'Reversing', definition: 'Undoes a prior entry by mirroring its lines.' },
  recurring: { label: 'Recurring', definition: 'Generated each period from a template.' },
  reclass: { label: 'Reclass', definition: 'Moves an amount between accounts or dimensions.' },
  elimination: { label: 'Elimination', definition: 'Consolidation entry removing intercompany activity.' },
  revaluation: { label: 'Revaluation', definition: 'Remeasures foreign-currency monetary balances at the closing rate.' },
  depreciation: { label: 'Depreciation', definition: 'Monthly depreciation from the fixed-asset schedule.' },
  amortization: { label: 'Amortization', definition: 'Monthly release of prepaid or deferred balances.' },
  opening: { label: 'Opening balance', definition: 'Brings forward balances when books are first set up.' },
};

export const individuals: Individual[] = [
  // Account classes and normal balances
  ind('bh:Asset', 'Asset', 'bh:AccountClass', 'Probable future economic benefit controlled by the entity.', 'Debit-normal; on the balance sheet.', 'Cash.', { order: 1, citations: ['con6'] }),
  ind('bh:Liability', 'Liability', 'bh:AccountClass', 'Present obligation to transfer economic benefits.', 'Credit-normal; on the balance sheet.', 'Accounts payable.', { order: 2, citations: ['con6'] }),
  ind('bh:Equity', 'Equity', 'bh:AccountClass', 'Residual interest in assets after deducting liabilities.', 'Credit-normal.', 'Retained earnings.', { order: 3, citations: ['con6'] }),
  ind('bh:Revenue', 'Revenue', 'bh:AccountClass', 'Inflows from delivering goods or services.', 'Credit-normal; on the income statement.', 'Subscription revenue.', { order: 4, citations: ['con6'] }),
  ind('bh:Expense', 'Expense', 'bh:AccountClass', 'Outflows or using up of assets to deliver goods or services.', 'Debit-normal; on the income statement.', 'Software subscriptions.', { order: 5, citations: ['con6'] }),
  ind('bh:DebitNormal', 'Debit-normal', 'bh:NormalBalance', 'Increases with debits: assets and expenses.', 'A credit balance is unusual and gets flagged.', 'Cash.', { order: 1 }),
  ind('bh:CreditNormal', 'Credit-normal', 'bh:NormalBalance', 'Increases with credits: liabilities, equity, revenue, contra-assets.', 'A debit balance is unusual and gets flagged.', 'Accounts payable.', { order: 2 }),

  // Period states
  ind('bh:PeriodFuture', 'Future', 'bh:PeriodState', 'Not yet open; no postings.', 'Prevents accidental postings to future months.', 'October 2026 before the September close starts.', { order: 1 }),
  ind('bh:PeriodOpen', 'Open', 'bh:PeriodState', 'Accepts all entry types.', 'Normal working state during the month and early close.', 'September 2026 on WD3.', { order: 2 }),
  ind('bh:PeriodSoftClosed', 'Soft-closed', 'bh:PeriodState', 'Subledgers frozen; only adjusting-type entries allowed.', 'Lets reviewers finalize without routine postings moving the numbers.', 'September on WD4.', { order: 3, synonyms: ['soft close'] }),
  ind('bh:PeriodLocked', 'Locked', 'bh:PeriodState', 'Hard-closed; no postings at all.', 'Final numbers; reopening requires the CFO and is audited.', 'August 2026.', { order: 4, synonyms: ['hard close', 'locked'] }),

  // Posting statuses
  ind('bh:StatusDraft', 'Draft', 'bh:PostingStatus', 'Being prepared; not in balances.', 'Drafts can still be edited or deleted.', 'An adopted suggestion awaiting submission.', { order: 1 }),
  ind('bh:StatusPendingApproval', 'Pending approval', 'bh:PostingStatus', 'Submitted; waiting for an independent approver.', 'Maker-checker in action.', 'A $24,000 accrual waiting for the Senior Accountant.', { order: 2 }),
  ind('bh:StatusPosted', 'Posted', 'bh:PostingStatus', 'In the ledger; immutable.', 'Only reversal can undo it.', 'Approved entries.', { order: 3 }),
  ind('bh:StatusRejected', 'Rejected', 'bh:PostingStatus', 'Declined by a reviewer with a reason.', 'The reason informs the next run.', 'A rejected reclass.', { order: 4 }),

  // Audit assertions
  ind('bh:ExistenceOccurrence', 'Existence / occurrence', 'bh:AuditAssertion', 'Recorded assets and liabilities exist, and recorded transactions actually happened.', 'Guards against fictitious entries; evidence must trace back to a real event.', 'A recorded receivable is backed by a real invoice and customer.', { order: 1, citations: ['pcaob1105', 'isa315'], synonyms: ['existence', 'occurrence'] }),
  ind('bh:Completeness', 'Completeness', 'bh:AuditAssertion', 'Everything that should be recorded is recorded.', 'Unrecorded liabilities violate completeness; accruals restore it.', 'September hosting is accrued even without the invoice.', { order: 2, citations: ['pcaob1105', 'isa315'] }),
  ind('bh:AccuracyValuation', 'Accuracy / valuation', 'bh:AuditAssertion', 'Amounts are recorded correctly and balances are valued appropriately.', 'Covers math, FX rates, allowances and depreciation.', 'The UK payable is revalued at the closing rate.', { order: 3, citations: ['pcaob1105', 'isa315'], synonyms: ['accuracy', 'valuation'] }),
  ind('bh:Cutoff', 'Cutoff', 'bh:AuditAssertion', 'Transactions are recorded in the correct period.', 'Period locks, accrual dates and service periods enforce cutoff.', 'A bill dated Sep 28 for September services belongs in September.', { order: 4, citations: ['pcaob1105', 'isa315'] }),
  ind('bh:Classification', 'Classification', 'bh:AuditAssertion', 'Transactions are recorded in the proper accounts.', 'Transaction coding and reclasses are classification controls.', 'A laptop purchase belongs in Computer equipment, not Office supplies.', { order: 5, citations: ['isa315'] }),
  ind('bh:RightsObligations', 'Rights and obligations', 'bh:AuditAssertion', 'The entity holds rights to its assets and its liabilities are its obligations.', 'Relevant to leases, intercompany and vendor ownership.', 'The UK office lease is an obligation of the UK entity, not the parent.', { order: 6, citations: ['pcaob1105', 'isa315'] }),
  ind('bh:PresentationDisclosure', 'Presentation and disclosure', 'bh:AuditAssertion', 'Items are properly presented, classified and described in the statements.', 'Statement line mapping and eliminations support presentation.', 'Intercompany balances are eliminated from consolidated statements.', { order: 7, citations: ['pcaob1105', 'isa315'], synonyms: ['presentation'] }),

  // Materiality levels
  ind('bh:OverallMateriality', 'Overall materiality', 'bh:Materiality', 'The largest misstatement in the statements as a whole that would not change a reasonable user\'s decisions (often 0.5-1% of revenue or 5% of pre-tax income).', 'Anything near this size must be reviewed by senior people.', '$250,000 for Brambleway (1% of revenue).', { order: 1, citations: ['pcaob2105', 'isa320', 'sab99'] }),
  ind('bh:PerformanceMateriality', 'Performance materiality', 'bh:Materiality', 'A lower threshold (typically 50-75% of overall) used for individual accounts so that undetected errors in total stay below overall materiality.', 'Sets the ceiling for agent auto-posting and the floor for flux explanations.', '$187,500 (75% of overall).', { order: 2, citations: ['pcaob2105', 'isa320'] }),
  ind('bh:ClearlyTrivial', 'Clearly trivial', 'bh:Materiality', 'An amount so small that misstatements below it need not be accumulated (typically 3-5% of overall).', 'Reconciliations may be certified with unexplained differences below it, with a note.', '$12,500 (5% of overall).', { order: 3, citations: ['isa320'], synonyms: ['clearly trivial threshold', 'trivial'] }),

  // Autonomy levels
  ind('bh:L0', 'L0 - Suggest', 'bh:AutonomyLevel', 'The agent only suggests; a person must adopt the suggestion, which then goes through normal maker-checker.', 'For new or high-judgment skills.', 'Intercompany eliminations start at L0 for a new tenant.', { order: 0 }),
  ind('bh:L1', 'L1 - Draft for approval', 'bh:AutonomyLevel', 'The agent drafts; every proposal needs an independent approver before posting.', 'The default for anything that posts to the ledger.', 'Accrual proposals wait in the inbox.', { order: 1 }),
  ind('bh:L2', 'L2 - Auto-post under threshold', 'bh:AutonomyLevel', 'Verified proposals under the amount threshold and above the confidence bar post automatically; a random sample is queued for post-hoc review; the rest need approval.', 'Removes routine work while keeping a human on anything material.', 'Card coding under $500 at confidence >= 0.9 posts automatically; 10% are sampled.', { order: 2 }),
  ind('bh:L3', 'L3 - Auto with post-hoc review', 'bh:AutonomyLevel', 'Verified proposals below the materiality cap post automatically and all are reviewed afterwards.', 'For mature, low-risk, high-volume skills.', 'Exact bank matches clear automatically and are listed for review.', { order: 3 }),

  // Rate types
  ind('bh:SpotRate', 'Spot rate', 'bh:ExchangeRate', 'The rate on the transaction date.', 'Used to record foreign-currency transactions initially.', 'GBP/USD 1.2701 on Sep 1.', { order: 1, citations: ['asc830'] }),
  ind('bh:AverageRate', 'Average rate', 'bh:ExchangeRate', 'The average rate for the period.', 'Used to translate income-statement amounts.', 'GBP/USD September average 1.2744.', { order: 2, citations: ['asc830'] }),
  ind('bh:ClosingRate', 'Closing rate', 'bh:ExchangeRate', 'The rate at period end.', 'Used to remeasure monetary items and translate the balance sheet.', 'GBP/USD 1.2788 at Sep 30.', { order: 3, citations: ['asc830'], synonyms: ['period-end rate'] }),

  // Match types
  ind('bh:MatchExact', 'Exact', 'bh:MatchType', 'Same amount and reference (or same amount and date) on both sides.', 'Highest confidence; may auto-clear under policy.', 'Bank -$31,840.00 vs AP payment -$31,840.00, same reference.', { order: 1 }),
  ind('bh:MatchFuzzy', 'Fuzzy', 'bh:MatchType', 'Same amount within tolerance and similar description, dates within a window.', 'Needs a quick human look at the evidence.', 'Bank "NIMBUS CLD" vs ledger "Nimbus Cloud Services", 2 days apart.', { order: 2 }),
  ind('bh:MatchOneToMany', 'One-to-many', 'bh:MatchType', 'One external item matches several ledger items.', 'Batched payments and deposits.', 'One bank deposit = three customer receipts.', { order: 3 }),
  ind('bh:MatchManyToOne', 'Many-to-one', 'bh:MatchType', 'Several external items match one ledger item.', 'Split card settlements, partial clearing.', 'Two bank debits = one payroll funding entry.', { order: 4 }),
  ind('bh:MatchManual', 'Manual', 'bh:MatchType', 'Matched by a person.', 'Evidence of human judgment.', 'Reviewer matched a wire with a bank fee netted.', { order: 5 }),

  // COSO components
  ind('bh:ControlEnvironment', 'Control environment', 'bh:Control', 'COSO component: integrity, ethics, oversight and structure.', 'The tone that makes other controls work.', 'Audit committee oversight.', { citations: ['coso2013'], order: 1 }),
  ind('bh:RiskAssessment', 'Risk assessment', 'bh:Control', 'COSO component: identifying and analyzing risks to reliable reporting.', 'Materiality and risk ratings on reconciliations implement it.', 'High-risk rating on the cash rec.', { citations: ['coso2013'], order: 2 }),
  ind('bh:ControlActivities', 'Control activities', 'bh:Control', 'COSO component: policies and procedures that mitigate risks (approvals, reconciliations, SoD).', 'Most of what Bookhand enforces.', 'Maker-checker on journal entries.', { citations: ['coso2013'], order: 3 }),
  ind('bh:InformationCommunication', 'Information and communication', 'bh:Control', 'COSO component: quality information flowing to the right people.', 'Provenance and the close package support it.', 'Close package to the CFO.', { citations: ['coso2013'], order: 4 }),
  ind('bh:MonitoringActivities', 'Monitoring activities', 'bh:Control', 'COSO component: ongoing evaluation of whether controls work.', 'Post-hoc sampled review of agent work is a monitoring activity.', '10% sample of auto-posted coding reviewed weekly.', { citations: ['coso2013', 'cosogenai2026'], order: 5 }),

  ...Object.entries(JE_TYPE_INFO).map(([key, info], i) =>
    ind(`bh:JE_${key}`, info.label, 'bh:JournalEntryType', info.definition, key === 'accrual' ? 'Must carry an auto-reverse date.' : 'Determines what review applies and whether it may post during soft close.', `${info.label} entry`, { order: i + 1 }),
  ),
  ...FS_LINES.map((l) =>
    ind(`bh:FS_${l.key.replace(/\./g, '_')}`, l.label, 'bh:FinancialStatementLine', `${l.statement === 'BS' ? 'Balance sheet' : 'Income statement'} line in "${l.section}"${l.xbrl ? `, mapped to ${l.xbrl}` : ''}.`, 'Accounts roll up to statement lines; the mapping makes statements reproducible.', `${l.key}`, { order: l.order }),
  ),
];
