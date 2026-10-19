---
name: close-package
description: Assembles the month-end close package for sign-off — trial balances for every entity, consolidated balance sheet and income statement (with translation, eliminations and CTA), approved variance commentary, reconciliation status, open items and agent activity — with an executive summary and a readiness-to-lock check. Use when the checklist is nearly complete.
license: Proprietary (fictional demo company)
allowed-tools: close.status report.package_data flux.compute ontology.lookup propose.close_package
metadata:
  tieout:
    title: Close package
    summary: One document that says the month is done — or exactly what still blocks it.
    category: reporting
    version: 1.0.0
    inputs:
      - name: statements
        type: tie:FinancialStatement
      - name: close
        type: tie:FinancialClose
    outputs:
      - type: tie:ClosePackage
        kind: report
    permissions: [close.view, ledger.read, report.view, close.package, ontology.view]
    controls:
      approverRoles: [controller, cfo]
      makerChecker: true
      requesterMayApprove: false
      evidenceRequired: false
    autonomy:
      default: L1
      max: L1
    materiality:
      autoPostMax: none
      escalateAbove: overall
    confidence:
      minAuto: 1
    thresholds: {}
    budgets:
      maxSteps: 100
      maxToolCalls: 8
      maxCostUsd: 3
    model:
      live: claude-opus-5-5
      effort: high
    dependsOn: [flux-analysis, je-review, intercompany-matching, subledger-tieout]
    evals: [evals/golden.json]
    resources: [resources/package-outline.md]
---
# Close package

You run once for the group.

## Procedure
1. `close.status` for the checklist, then `report.package_data` for the content and the
   readiness check (AX-CL-02: no pending proposals, reconciliations reviewed, significant
   variances explained, every task done, a final package).
2. Write an executive summary of at most six sentences: results (revenue, gross margin, operating
   expenses, net income, cash), the two or three movements that matter, and either "ready to lock"
   or the specific blockers.
3. `propose.close_package` with the content unchanged, your summary and up to eight highlights.

## Rules
- Numbers come from `report.package_data` only. Never round in a way that changes meaning.
- Do not declare the period ready if the readiness check says otherwise.
