---
name: subledger-tieout
description: Ties out the accounts payable and accounts receivable subledgers to their general-ledger control accounts at month-end — rebuilds each aging from bills, invoices, payments and receipts, explains any difference, and reclassifies counterparty balances with the wrong sign (for example an overpaid vendor). Use after coding and before the close package.
license: Proprietary (fictional demo company)
allowed-tools: close.status subledger.tieout ledger.account_activity ontology.lookup propose.journal_entry propose.finding
metadata:
  tieout:
    title: Subledger tie-out
    summary: Prove AP and AR agree to the ledger, and present balances on the right side of the balance sheet.
    category: tie_out
    version: 1.0.1
    inputs:
      - name: apAging
        type: tie:APSubledger
      - name: arAging
        type: tie:ARSubledger
    outputs:
      - type: tie:ReclassProposal
        kind: journal_entry
      - type: tie:Finding
        kind: finding
    permissions: [close.view, ledger.read, subledger.read, je.create, ontology.view]
    controls:
      approverRoles: [senior_accountant, controller]
      makerChecker: true
      requesterMayApprove: false
      evidenceRequired: true
    autonomy:
      default: L1
      max: L2
    materiality:
      autoPostMax: none
      escalateAbove: clearly_trivial
    confidence:
      minAuto: 0.95
    thresholds: {}
    budgets:
      maxSteps: 200
      maxToolCalls: 10
      maxCostUsd: 0.5
    model:
      live: claude-sonnet-5-5
      effort: medium
    dependsOn: [transaction-coding]
    evals: [evals/golden.json]
    resources: [resources/tieout-procedure.md]
---
# Subledger tie-out

## Procedure
1. `subledger.tieout` with kind `ap`, then `ar`, for the entity and period.
2. If the subledger and the control account differ, `propose.finding` (category
   `subledger_difference`) with the amount and where to look (entries posted straight to the
   control account, unposted documents, cut-off).
3. For each **vendor with a debit balance** in AP (we paid more than we owe), propose a `reclass`
   journal entry: debit 1250 Vendor refunds receivable, credit 2000 Accounts payable. Mention the
   duplicate-payment finding if there is one. Customers with credit balances: the reverse, to
   2110, only when material.
4. Report clean tie-outs in the run notes, not as proposals.

## Rules
- Entries that touch control accounts are reclasses only, and always go to a person (AX-AC-04).
- Do not "plug" a difference. Explain it or raise it.
