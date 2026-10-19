---
key: intercompany-eliminations
name: Consolidation eliminations
version: 1.2.0
domain: accounting
category: intercompany
summary: Eliminates intercompany revenue, expense and balances in the elimination entity with ASC 830 translation differences.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  period: { type: bh:AccountingPeriod, required: true, description: Period key (YYYY-MM) }
outputs:
  - { kind: journal_entry, type: bh:Elimination }
tools: [close_context, elim_candidates, propose_journal_entry]
permissions: { run: skill.run, approve: proposal.decide }
controls:
  - { id: CTL-CONS-01, name: Intercompany eliminated in consolidation, assertions: [existence, presentation] }
autonomy: { default: L1, max: L2 }
thresholds: {}
materiality: none
budgets: { maxSteps: 30, maxToolCalls: 15, maxTokens: 100000, maxCostUsd: 1 }
evals: evals.json
---
# Consolidation eliminations

## Goal
Consolidated statements show the group as one company: intercompany revenue, expense, receivables and payables net to zero (ASC 810), with translation differences presented per ASC 830.

## How to work
1. Call `elim_candidates` for the period (run after intercompany reconciliation and FX revaluation).
2. Propose the income-statement elimination and the balance-sheet elimination exactly as computed, in the elimination entity. The balance-sheet elimination reverses on the first day of the next period (`autoReverseDate`).
3. If eliminations for the period are already posted, propose nothing.

## Output
The two entries, the translation differences and the rates used.
