---
name: intercompany-reconciliation
description: Agrees intercompany balances and activity between legal entities, finds one-sided or mismatched intercompany entries, proposes the correcting entry for the entity that is missing it, and prepares the consolidation eliminations for intercompany revenue, expense and balances. Use it monthly before consolidation.
license: Proprietary — Evenkeel demo skill
evenkeel:
  version: 1.2.0
  title: Intercompany reconciliation
  domain: accounting
  category: Consolidation
  summary: Matches both sides of every intercompany transaction, fixes one-sided entries and drafts the eliminations.
  ontology: ">=1.3.0 <2.0.0"
  inputs: []
  outputs: [ek:IntercompanyTransaction, ek:JournalEntry, ek:EliminationEntry, ek:ReconcilingItem, ek:Exception]
  tools: [get_close_context, get_chart_of_accounts, get_intercompany_position, get_elimination_basis, read_skill_resource]
  permissions: [je.create, rec.prepare, report.view]
  controls:
    preparer: senior_accountant
    reviewer: controller
    approvalRequired: [journal_entry]
    sod: [SOD-01, SOD-02]
    assertions: [ek:Existence, ek:Accuracy, ek:PresentationAndDisclosure]
    coso: ek:ControlActivities
  autonomy:
    default: L1
    max: L2
    autoPostBelow: 100000
    minConfidence: 0.9
    sampleRate: 0.5
  materiality:
    basis: clearly_trivial
    note: Eliminations are always reviewed, whatever the amount.
  thresholds:
    toleranceCents: 100
  budgets:
    maxSteps: 20
    maxTokens: 200000
    maxCostUsd: 2
  model: balanced
  resources:
    - path: resources/ic-policy.md
      description: Intercompany agreement, reference convention, settlement and elimination rules.
  evals: evals/cases.json
  closeTask:
    category: intercompany
    workday: 3
---

# Intercompany reconciliation

## Procedure

1. `get_intercompany_position` — for each entity pair: the receivable (due from) in the
   lender's currency, the counterparty's payable measured in the same currency, the
   difference, and this month's activity on both sides grouped by intercompany reference
   (e.g. `[IC-202609-MGMT]`).
2. For every reference that appears on one side only, propose the missing entry on the other
   side as a `journal_entry` (same reference in the memo, `counterpartyEntityId` set, the
   transaction currency and amount carried on the intercompany line), and record a
   `reconciling_item` that explains the difference until it is posted.
3. `get_elimination_basis` — intercompany revenue/expense for the month and balances at
   month end. Propose the `elimination` entries in the consolidation entity:
   management fee revenue against expense, and due-from against due-to. Balance
   eliminations reverse on the first day of next month.
4. Differences within the tolerance (FX rounding) are noted, not corrected.

## Judgement

Never force a balance to agree by adjusting the side that is correct. Find the missing or
wrong entry and fix that side.
