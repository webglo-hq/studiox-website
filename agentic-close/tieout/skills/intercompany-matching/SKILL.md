---
name: intercompany-matching
description: Matches intercompany balances and charges between group entities in the transaction currency, books the missing side of one-sided entries, and drafts pro forma elimination entries for consolidation (revenue/expense at the average rate, balances at the closing rate). Use after FX remeasurement and before the close package.
license: Proprietary (fictional demo company)
allowed-tools: close.status ic.balances ledger.account_activity ontology.lookup propose.journal_entry propose.finding
metadata:
  tieout:
    title: Intercompany matching
    summary: Make both sides of every intercompany relationship agree, then eliminate them for the group view.
    category: intercompany
    version: 1.1.0
    inputs:
      - name: balances
        type: tie:IntercompanyBalance[]
    outputs:
      - type: tie:JournalEntryProposal
        kind: journal_entry
        description: True-ups and elimination entries
    permissions: [close.view, ledger.read, subledger.read, je.create, ontology.view]
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
      escalateAbove: clearly_trivial
    confidence:
      minAuto: 0.99
    thresholds:
      fxToleranceMinor:
        label: FX tolerance
        description: Reporting-currency difference treated as rounding when comparing balances (AX-IC-01).
        default: 100
        unit: minor
        min: 0
        max: 100000
    budgets:
      maxSteps: 300
      maxToolCalls: 10
      maxCostUsd: 1.5
    model:
      live: claude-sonnet-5-5
      effort: medium
    dependsOn: [fx-revaluation]
    evals: [evals/golden.json]
    resources: [resources/consolidation.md]
---
# Intercompany matching

You run once for the whole group (no entity).

## Procedure
1. `close.status` then `ic.balances` for the period. For each entity pair you get both sides in
   the transaction currency, one-sided entries, the closing and average rates, booked amounts and
   pending proposals that touch intercompany accounts.
2. For each entry the creditor booked but the debtor did not, propose the missing side in the
   debtor's books (debit 6950 Intercompany R&D services / dept RND, credit 2400 Due to group
   entities) at the period-end closing rate, with the transaction-currency amount on both lines.
3. Draft eliminations in the elimination entity, **pro forma** (as if pending proposals were
   posted), with `dependsOnProposalIds` so they cannot be approved first:
   - P&L: debit 4900 intercompany revenue (at the average rate), credit 6950 (as booked), the
     rate difference to 7120;
   - balances: debit 2400, credit 1400 (at the closing rate), the difference to 7120, reversing on
     day one of the next month.
4. Eliminations touch intercompany accounts only (AX-IC-02).
