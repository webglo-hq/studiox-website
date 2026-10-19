---
name: schedule-rollforward
description: Rolls forward depreciation and prepaid amortization schedules — finds scheduled lines that are due but have no journal entry, checks each schedule allocates exactly and stays within the depreciable base, and drafts the monthly entries. Use every month before flux analysis.
license: Proprietary (fictional demo company)
allowed-tools: close.status schedules.status ledger.account_activity ontology.lookup propose.journal_entry propose.finding
metadata:
  tieout:
    title: Schedule roll-forward
    summary: Post this month's depreciation and amortization exactly as the schedules say — and notice when a month was missed.
    category: schedules
    version: 1.0.2
    inputs:
      - name: fixedAssets
        type: tie:DepreciationSchedule
      - name: prepaids
        type: tie:PrepaidSchedule
    outputs:
      - type: tie:JournalEntryProposal
        kind: journal_entry
      - type: tie:Finding
        kind: finding
    permissions: [close.view, ledger.read, subledger.read, je.create, ontology.view]
    controls:
      approverRoles: [senior_accountant]
      makerChecker: true
      requesterMayApprove: false
      evidenceRequired: false
    autonomy:
      default: L2
      max: L3
    materiality:
      autoPostMax: clearly_trivial
      escalateAbove: performance
    confidence:
      minAuto: 0.95
    thresholds: {}
    budgets:
      maxSteps: 300
      maxToolCalls: 10
      maxCostUsd: 0.5
    model:
      live: claude-haiku-5-5
      effort: low
    dependsOn: []
    evals: [evals/golden.json]
    resources: [resources/schedules.md]
---
# Schedule roll-forward

You keep the fixed-asset and prepaid schedules and the ledger in step.

## Procedure
1. `schedules.status` for the entity and period: due depreciation lines, due prepaid lines and
   integrity issues.
2. Integrity issues (AX-SCH-01 exact allocation, AX-SCH-02 depreciable base) → `propose.finding`;
   do not post from a broken schedule.
3. Depreciation: one entry per asset category and month — debit 6800 by department, credit 1590
   Accumulated depreciation — with `effects.depreciationLineIds` so the schedule lines are marked
   posted. Use source `subledger` (the schedule is the subledger).
4. Prepaids: one entry per due line — debit the schedule's expense account and department, credit
   the prepaid account — with `effects.prepaidLineIds`.
5. Lines from earlier months that never posted are a catch-up: post them in the current open month
   and say so in the why.

## Rules
- Amounts come from the schedule, never recomputed by hand.
- Mark entries `autoEligible`: they are mechanical; the policy decides whether they post themselves.
