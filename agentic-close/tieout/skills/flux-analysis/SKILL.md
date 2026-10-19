---
name: flux-analysis
description: Explains month-over-month and budget variances on the income statement — applies the variance thresholds, decomposes each significant change into drivers (vendors, customers, payroll, accruals, one-offs) that add up to the variance, notes proposals still awaiting approval, and drafts plain-English commentary for review. Use after accruals, schedules and reconciliations.
license: Proprietary (fictional demo company)
allowed-tools: close.status flux.compute ledger.account_activity ontology.lookup propose.flux_explanation
metadata:
  tieout:
    title: Flux analysis
    summary: Say what changed, why, and by how much — in words a CFO can forward to the board.
    category: flux
    version: 1.2.0
    inputs:
      - name: incomeStatement
        type: tie:IncomeStatement
      - name: budget
        type: tie:Budget
    outputs:
      - type: tie:FluxExplanationProposal
        kind: flux_explanation
    permissions: [close.view, ledger.read, report.view, flux.explain, ontology.view]
    controls:
      approverRoles: [controller]
      makerChecker: true
      requesterMayApprove: false
      evidenceRequired: true
    autonomy:
      default: L1
      max: L1
    materiality:
      autoPostMax: none
      escalateAbove: performance
    confidence:
      minAuto: 1
    thresholds: {}
    budgets:
      maxSteps: 300
      maxToolCalls: 15
      maxCostUsd: 2
    model:
      live: claude-sonnet-5-5
      effort: medium
    dependsOn: [accrual-detection, schedule-rollforward, bank-reconciliation]
    evals: [evals/golden.json]
    resources: [resources/flux-writing-guide.md]
---
# Flux analysis

## Procedure
1. `flux.compute` for the entity and period. Each line has current, prior-month and budget
   amounts, the variance, whether it exceeds the threshold (absolute AND percentage, or above
   performance materiality), drivers that sum to the variance, and pending proposals.
2. For every line that exceeds the threshold and has no approved explanation,
   `propose.flux_explanation` with the drivers exactly as computed (AX-FLX-02) and two to four
   sentences: direction and size, the main drivers with amounts, what is still pending (by
   proposal reference), and the budget comparison.
3. Do not explain lines below the threshold.

## Writing rules
- Lead with the number. "Events rose $102,141 (+1,204%) to $110,625" — not "Events increased".
- Name the counterparty and the reason: "ConfabCon headline sponsorship (+$110,000)".
- Separate timing (accruals, reversals) from real change.
- No speculation. If the drivers do not explain it, say what is unexplained.
- Read `resources/flux-writing-guide.md` for examples.
