---
name: accrual-detection
description: Finds unrecorded liabilities at month-end and drafts auto-reversing accruals with evidence — bills received after month-end for services used in the month, recurring vendors with no bill, goods received but not invoiced, and payroll earned but unpaid. Use after the month's bills and receipts are in, before flux analysis.
license: Proprietary (fictional demo company)
allowed-tools: close.status accruals.candidates ledger.account_activity coa.accounts ontology.lookup propose.journal_entry
metadata:
  tieout:
    title: Accrual detection
    summary: Make sure every cost incurred this month is in this month — with the evidence to prove it.
    category: accruals
    version: 1.1.0
    inputs:
      - name: bills
        type: tie:VendorBill[]
      - name: receipts
        type: tie:GoodsReceipt[]
      - name: payroll
        type: tie:PayrollRun[]
    outputs:
      - type: tie:AccrualEntryProposal
        kind: journal_entry
    permissions: [close.view, ledger.read, subledger.read, je.create, ontology.view]
    controls:
      approverRoles: [senior_accountant, controller, cfo]
      makerChecker: true
      requesterMayApprove: false
      evidenceRequired: true
    autonomy:
      default: L1
      max: L2
    materiality:
      autoPostMax: clearly_trivial
      escalateAbove: performance
    confidence:
      minAuto: 0.95
    thresholds:
      recurringMonths:
        label: Recurring pattern length
        description: Months in a row a vendor must have billed before a missing bill is accrued.
        default: 3
        unit: count
        min: 2
        max: 12
    budgets:
      maxSteps: 400
      maxToolCalls: 20
      maxCostUsd: 2
    model:
      live: claude-opus-5-5
      effort: high
    dependsOn: [transaction-coding]
    evals: [evals/golden.json]
    resources: [resources/accrual-policy.md]
---
# Accrual detection

You make the month complete: costs incurred in the period but not yet recorded become accruals
that reverse on day one of the next period (AX-ACR-01), so the real invoice can post normally.

## Procedure
1. `accruals.candidates` for the entity and period. Each candidate carries its basis, amount,
   suggested lines and evidence:
   - **subsequent_invoice** – a bill dated or received after month-end whose service period ends
     in the month. Use the invoice amount. Strongest evidence.
   - **recurring_gap** – a monthly-service vendor billed in each of the last three months but not
     this one. Use the three-month average; say it is an estimate.
   - **grni** – goods received against a PO with no bill. Use the receipt amount; debit the PO's
     account (inventory for components).
   - **payroll_calendar** – business days after the last pay period that are earned but unpaid.
     Wages, employer taxes and benefits by department, credit 2120 Accrued payroll.
2. For each candidate, `propose.journal_entry` with entry type `accrual`, posting date = period
   end, `autoReverseOn` = first day of next period, credit 2110 Accrued expenses (2120 for payroll).
3. Explain the basis in plain English and cite the documents (AX-ACR-02).

## Rules
- Do not accrue a vendor twice: if a subsequent invoice exists, it replaces the recurring estimate.
- Never accrue without evidence. Never invent an amount.
- Large accruals (above performance materiality) escalate to the Controller or CFO by amount.
