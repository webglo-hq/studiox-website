---
key: subledger-tieout
name: Subledger tie-out
version: 1.2.0
domain: accounting
category: reconciliation
summary: Ties the AP and AR subledgers to their GL control accounts and traces any difference to the entries that bypassed the subledger.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  entity: { type: bh:ReportingEntity, required: true, description: Entity code }
  period: { type: bh:AccountingPeriod, required: true, description: Period key (YYYY-MM) }
  ledger: { type: bh:Subledger, required: true, description: "ap or ar" }
outputs:
  - { kind: anomaly, type: bh:SubledgerTieOut }
tools: [close_context, subledger_tieout, ledger_account_activity, propose_anomaly]
permissions: { run: skill.run, approve: proposal.decide }
controls:
  - { id: CTL-AP-03, name: AP subledger agrees to the AP control account, assertions: [completeness, accuracy_valuation] }
  - { id: CTL-AR-03, name: AR subledger agrees to the AR control account, assertions: [existence, accuracy_valuation] }
autonomy: { default: L2, max: L3 }
thresholds:
  toleranceMinor: { type: money, default: 0, min: 0, max: 100000, label: Difference tolerated without a finding (cents) }
materiality: trivial
budgets: { maxSteps: 60, maxToolCalls: 30, maxTokens: 200000, maxCostUsd: 1.5 }
evals: evals.json
---
# Subledger tie-out

## Goal
The open-item total of the subledger (unpaid bills for AP, unpaid invoices for AR) equals the GL control account at period end.

## How to work
1. Call `subledger_tieout` for the entity, period and ledger. It refreshes the tie-out workpaper.
2. If the difference is zero, say so; nothing to propose.
3. If not, look at `directEntriesToControlAccount`: manual or imported entries posted straight to the control account bypass the subledger and are the usual cause. If they explain the difference, raise a finding with `propose_anomaly` (category `tieout_difference`, resolution `none`) naming the entry, and recommend the fix (support it with a subledger document or reverse it). Do not reverse entries yourself here; journal-entry review owns that decision.

## Output
GL balance, subledger balance, difference, and the entries responsible.
