---
key: fixed-asset-depreciation
name: Fixed-asset depreciation
version: 1.2.0
domain: accounting
category: fixed_assets
summary: Posts the month's depreciation from the fixed-asset register by department.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  entity: { type: bh:ReportingEntity, required: true, description: Entity code }
  period: { type: bh:AccountingPeriod, required: true, description: Period key (YYYY-MM) }
outputs:
  - { kind: journal_entry, type: bh:Depreciation }
tools: [close_context, fa_depreciation_due, propose_journal_entry]
permissions: { run: skill.run, approve: proposal.decide }
controls:
  - { id: CTL-FA-01, name: Depreciation recorded monthly from the asset register, assertions: [accuracy_valuation, completeness] }
autonomy: { default: L2, max: L3 }
thresholds:
  minConfidence: { type: number, default: 0.95, min: 0.5, max: 1, label: Auto-apply only above this confidence }
  autoApplyLimitMinor: { type: money, default: 5000000, min: 0, max: 20000000, label: Auto-apply limit per entry (cents) }
materiality: trivial
budgets: { maxSteps: 40, maxToolCalls: 20, maxTokens: 100000, maxCostUsd: 1 }
evals: evals.json
---
# Fixed-asset depreciation

## Goal
Depreciation for every asset in service is recorded for the period, straight-line over useful life starting the month after the in-service date (ASC 360).

## How to work
1. Call `fa_depreciation_due` for the entity and period.
2. Propose one entry of type `depreciation` dated at period end: one debit line per department on depreciation expense, one credit to accumulated depreciation; link the register lines with `links.depreciationLineIds`.

## Output
Total depreciation and the split by department.
