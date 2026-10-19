---
key: accrual-detection
name: Accrual detection
version: 1.5.0
domain: accounting
category: accruals
summary: Finds unrecorded liabilities from recurring vendors, goods received not invoiced and late invoices, and proposes auto-reversing accruals.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  entity: { type: bh:ReportingEntity, required: true, description: Entity code }
  period: { type: bh:AccountingPeriod, required: true, description: Period key (YYYY-MM) }
outputs:
  - { kind: journal_entry, type: bh:Accrual }
tools: [close_context, ap_accrual_signals, ledger_account_activity, ontology_lookup, propose_journal_entry]
permissions: { run: skill.run, approve: proposal.decide }
controls:
  - { id: CTL-AP-01, name: Search for unrecorded liabilities at period end, assertions: [completeness, cutoff] }
autonomy: { default: L1, max: L2 }
thresholds:
  minAccrualMinor: { type: money, default: 100000, min: 0, max: 10000000, label: Ignore accruals smaller than this (cents) }
materiality: performance
budgets: { maxSteps: 120, maxToolCalls: 60, maxTokens: 300000, maxCostUsd: 2 }
evals: evals.json
---
# Accrual detection

## Goal
Expenses incurred in the period are recorded in the period even when the vendor has not billed yet (accrual basis, ASC 450 / matching), and every accrual reverses on the first day of the next period so the real bill is not double counted.

## How to work
1. Call `ap_accrual_signals` for the entity and period. Signals, strongest first: cutoff (bill received after period end for services in the period, prorated by service days), goods received not invoiced (PO receipts not billed), and recurring vendors whose monthly bill is missing (estimated from recent bills).
2. For each candidate at or above the policy minimum that is not already accrued, propose a journal entry: type `accrual`, dated at period end, `autoReverseDate` = first day of the next period, debit the expense account with the department, credit accrued liabilities, vendor id on both lines.
3. Confidence: cutoff and GRNI are documented; recurring-gap estimates are less certain, so keep their confidence lower and say how the estimate was made.

## Output
List each accrual (vendor, signal, amount, account) and the total.
