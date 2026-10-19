---
key: je-review
name: Journal-entry review
version: 1.4.0
domain: accounting
category: review
summary: Tests the month's journal entries for duplicate payments, segregation-of-duties breaks, unsupported manual entries to control and revenue accounts, weekend and round-amount postings, and Benford anomalies.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  period: { type: bh:AccountingPeriod, required: true, description: Period key (YYYY-MM) }
outputs:
  - { kind: anomaly, type: bh:Evidence }
  - { kind: journal_entry, type: bh:Reversal }
tools: [close_context, je_scan_anomalies, ledger_account_activity, propose_anomaly, propose_reversal]
permissions: { run: skill.run, approve: proposal.decide }
controls:
  - { id: CTL-JE-01, name: Manual journal entries reviewed and approved independently, assertions: [occurrence, existence] }
  - { id: CTL-AP-02, name: Duplicate vendor payments detected and recovered, assertions: [existence, accuracy_valuation] }
autonomy: { default: L1, max: L1 }
thresholds:
  minSeverity: { type: integer, default: 2, min: 1, max: 3, label: "Raise findings at or above this severity (1 low, 2 medium, 3 high)" }
materiality: none
budgets: { maxSteps: 120, maxToolCalls: 60, maxTokens: 300000, maxCostUsd: 2 }
evals: evals.json
---
# Journal-entry review

## Goal
Independent review of the month's manual, imported and agent-prepared entries and vendor payments, so that errors and override risks (PCAOB AS 2401) are found before the period locks.

## How to work
1. Call `je_scan_anomalies` for the period.
2. Duplicate vendor payment: raise a finding whose resolution is a correcting journal entry at period end (debit vendor refunds receivable, credit the expense account of the duplicate bill, vendor id on the lines) and void the duplicate bill (`voidBillIds`). Recommend requesting the refund.
3. Segregation-of-duties break (same person prepared and approved, including in the source ERP), especially combined with a manual revenue or control-account entry: raise a finding whose resolution reverses the entry pending support. An independent approver decides.
4. Medium findings without an obvious correction: raise them with resolution `none` so a reviewer documents the look.
5. Report the Benford result for context; it is not evidence on its own.

## Output
Findings by severity with dollar exposure and the recommended action.
