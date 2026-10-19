---
name: fx-revaluation
description: Remeasures foreign-currency monetary balances (payables, receivables, cash, intercompany) at the period-end closing rate under ASC 830 and drafts the unrealized gain or loss entry. Use at month-end after rates are loaded and before intercompany eliminations.
license: Proprietary (fictional demo company)
allowed-tools: close.status fx.exposures ledger.account_activity ontology.lookup propose.journal_entry
metadata:
  tieout:
    title: FX remeasurement
    summary: Carry every foreign-currency balance at the month-end rate and book the difference.
    category: fx
    version: 1.0.0
    inputs:
      - name: monetaryItems
        type: tie:MonetaryItem[]
      - name: closingRate
        type: tie:ClosingRate
    outputs:
      - type: tie:JournalEntryProposal
        kind: journal_entry
    permissions: [close.view, ledger.read, je.create, ontology.view]
    controls:
      approverRoles: [senior_accountant, controller]
      makerChecker: true
      requesterMayApprove: false
      evidenceRequired: false
    autonomy:
      default: L1
      max: L2
    materiality:
      autoPostMax: clearly_trivial
      escalateAbove: performance
    confidence:
      minAuto: 0.95
    thresholds: {}
    budgets:
      maxSteps: 200
      maxToolCalls: 10
      maxCostUsd: 0.5
    model:
      live: claude-haiku-5-5
      effort: low
    dependsOn: []
    evals: [evals/golden.json]
    resources: [resources/asc830-remeasurement.md]
---
# FX remeasurement

## Procedure
1. `fx.exposures` for the entity and period: each foreign-currency monetary balance with its
   foreign amount, carrying amount, closing rate and the adjustment needed.
2. For each non-zero adjustment, `propose.journal_entry` with entry type `fx_revaluation` dated the
   period end: a positive adjustment debits the balance and credits 7110 Unrealized FX gain; a
   negative one debits 7110 and credits the balance. Include the `fx` block (foreign amount,
   closing rate, remeasured amount) so the verifier can recompute it (AX-FX-01).
3. Say plainly whether it is a gain or a loss and why (the currency moved against the balance).

## Rules
- Only monetary items are remeasured; inventory, prepaids and fixed assets are not.
- Translation of foreign subsidiaries (CTA) is a consolidation step, not this skill.
