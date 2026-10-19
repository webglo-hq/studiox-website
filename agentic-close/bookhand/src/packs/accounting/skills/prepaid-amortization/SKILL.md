---
key: prepaid-amortization
name: Prepaid amortization
version: 1.3.0
domain: accounting
category: prepaids
summary: Posts scheduled prepaid amortization, catches missed months, and finds prepaid balances that no schedule covers.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  entity: { type: bh:ReportingEntity, required: true, description: Entity code }
  period: { type: bh:AccountingPeriod, required: true, description: Period key (YYYY-MM) }
outputs:
  - { kind: journal_entry, type: bh:Amortization }
  - { kind: schedule, type: bh:PrepaidSchedule }
tools: [close_context, prepaid_schedules_due, prepaid_unscheduled_balances, propose_journal_entry, propose_prepaid_schedule]
permissions: { run: skill.run, approve: proposal.decide }
controls:
  - { id: CTL-PP-01, name: Prepaid balances supported by amortization schedules, assertions: [existence, accuracy_valuation] }
autonomy: { default: L2, max: L3 }
thresholds:
  minConfidence: { type: number, default: 0.95, min: 0.5, max: 1, label: Auto-apply only above this confidence }
  autoApplyLimitMinor: { type: money, default: 1000000, min: 0, max: 10000000, label: Auto-apply limit per entry (cents) }
materiality: trivial
budgets: { maxSteps: 120, maxToolCalls: 60, maxTokens: 300000, maxCostUsd: 2 }
evals: evals.json
---
# Prepaid amortization

## Goal
Each prepaid asset is expensed straight-line over the period it covers, every month, and the prepaid balance equals what the schedules still carry.

## How to work
1. Call `prepaid_schedules_due`. For each schedule, propose one amortization entry dated at period end for the lines due (including missed earlier months), debiting the expense account with the department and crediting the prepaid account; link the schedule lines with `links.amortizationLineIds`.
2. Call `prepaid_unscheduled_balances`. Any prepaid account carrying more than its schedules explain points to a bill coded to prepaid without a schedule. Propose `propose_prepaid_schedule` for it: straight-line over the service period, with a catch-up amortization entry at period end for every month elapsed through this period.

## Output
Amounts amortized per schedule, any catch-up and its effect on this month's expense.
