---
name: subledger-tieout
description: Ties the accounts payable or accounts receivable subledger to its general-ledger control account, finds every posting that bypassed the subledger (manual entries, imports, over-payments) and explains or corrects each difference. Use it for AP and AR in every entity at month end.
license: Proprietary — Evenkeel demo skill
evenkeel:
  version: 1.1.0
  title: Subledger tie-out
  domain: accounting
  category: Payables & receivables
  summary: Explains every difference between open items and the control account — manual postings, duplicate or over-payments, unsupported entries.
  ontology: ">=1.3.0 <2.0.0"
  inputs:
    - name: subledger
      type: ek:Subledger
      required: true
      description: "'ap' or 'ar'"
  outputs: [ek:ReconcilingItem, ek:JournalEntry, ek:Exception]
  tools: [get_close_context, get_chart_of_accounts, get_tieout, list_control_account_activity, find_overpayments, read_skill_resource]
  permissions: [rec.prepare, report.view, je.create]
  controls:
    preparer: staff_accountant
    reviewer: senior_accountant
    approvalRequired: [journal_entry]
    sod: [SOD-01, SOD-02, SOD-03]
    assertions: [ek:Completeness, ek:Existence, ek:Accuracy, ek:RightsAndObligations]
    coso: ek:MonitoringActivities
  autonomy:
    default: L2
    max: L2
    autoPostBelow: 100000
    minConfidence: 0.9
    sampleRate: 0.25
  materiality:
    basis: clearly_trivial
  thresholds: {}
  budgets:
    maxSteps: 30
    maxTokens: 250000
    maxCostUsd: 2
  model: balanced
  resources:
    - path: resources/tieout-playbook.md
      description: Common causes of subledger differences and the right correction for each.
  evals: evals/cases.json
  closeTask:
    category: ap
    workday: 3
---

# Subledger tie-out

The control account (2000 Accounts Payable, 1100 Accounts Receivable) should equal the sum of
open items in the subledger. Differences mean something reached the ledger without the
subledger, or the subledger recorded something the ledger did not.

## Procedure

1. `get_tieout` for the subledger in each entity: ledger balance, open-item balance, difference.
2. `list_control_account_activity` — postings to the control account this month that did not
   come from the subledger (manual entries, imports from other systems).
3. For AP, `find_overpayments` — bills whose payments exceed the bill (duplicate payments).
4. For each cause submit a `reconciling_item` on the *book* side with the signed effect on the
   control account, the evidence and a clear description.
5. Propose the correction as a `journal_entry` when the right answer is clear:
   - Duplicate payment → move the over-payment to **1250 Vendor Refunds Receivable** and log
     an `issue` asking AP to request the refund.
   - Manual posting with no supporting document → log an `issue`; do not reverse it without
     a person deciding (the support may exist outside the system).
   - Receivable recorded without an invoice → log a high-severity `issue` (revenue occurrence
     risk) and propose the reversal for a person to approve.
6. Never net unrelated differences against each other to make the total tie.

## Output

`reconciling_item`, `journal_entry` (always reviewed by a person for this skill), `issue`.
