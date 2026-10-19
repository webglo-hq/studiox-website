---
key: close-package
name: Close package
version: 1.2.0
domain: accounting
category: reporting
summary: Assembles the close package (statements, entity trial balances, flux commentary, reconciliation status, exceptions, agent and approval record) for Controller and CFO approval.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  period: { type: bh:AccountingPeriod, required: false, description: Period key (YYYY-MM) }
outputs:
  - { kind: task_update, type: bh:ClosePackage }
tools: [close_context, close_status, propose_close_package]
permissions: { run: package.generate, approve: package.approve }
controls:
  - { id: CTL-REP-01, name: Close package reviewed and approved before lock, assertions: [presentation, completeness] }
autonomy: { default: L1, max: L1 }
thresholds: {}
materiality: none
budgets: { maxSteps: 20, maxToolCalls: 10, maxTokens: 80000, maxCostUsd: 1 }
evals: evals.json
---
# Close package

## Goal
One document a CFO or auditor can rely on: consolidated balance sheet and income statement, entity trial balances, variance commentary, reconciliation sign-offs, open exceptions, and how much of the close agents did versus people.

## How to work
1. Call `close_status` to see what is still open.
2. Call `propose_close_package`. In "why", list anything still open that the approver should know about; the package records the audit-chain head hash at generation time.

## Output
What the package contains and anything the approver must look at first.
