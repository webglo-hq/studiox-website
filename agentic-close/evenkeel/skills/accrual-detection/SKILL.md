---
name: accrual-detection
description: Finds liabilities for goods and services received but not yet recorded at month end — purchase orders received without a bill, recurring vendors with no bill yet, bills that arrived after month end for this month's service, and payroll earned but unpaid — and proposes accrual entries that reverse automatically next month.
license: Proprietary — Evenkeel demo skill
evenkeel:
  version: 1.4.0
  title: Accrual detection
  domain: accounting
  category: Accruals
  summary: Searches POs, bills, recurring vendors and payroll for unrecorded liabilities and drafts auto-reversing accruals with the evidence.
  ontology: ">=1.3.0 <2.0.0"
  inputs: []
  outputs: [ek:Accrual, ek:GrniAccrual, ek:PayrollAccrual]
  tools: [get_close_context, get_chart_of_accounts, detect_accrual_candidates, list_purchase_orders, list_recent_bills, get_payroll_runs, read_skill_resource]
  permissions: [je.create, report.view]
  controls:
    preparer: staff_accountant
    reviewer: senior_accountant
    approvalRequired: []
    sod: [SOD-01, SOD-02]
    assertions: [ek:Completeness, ek:Cutoff, ek:Valuation]
    coso: ek:ControlActivities
  autonomy:
    default: L2
    max: L3
    autoPostBelow: 500000
    minConfidence: 0.9
    sampleRate: 0.25
  materiality:
    basis: performance
  thresholds:
    lookbackMonths: 4
    minHits: 3
  budgets:
    maxSteps: 30
    maxTokens: 250000
    maxCostUsd: 2
  model: balanced
  resources:
    - path: resources/accrual-policy.md
      description: Kitewell's accrual policy, estimation methods and the auto-reversal convention.
  evals: evals/cases.json
  closeTask:
    category: accruals
    workday: 3
---

# Accrual detection

Completeness of liabilities is the assertion at risk: expenses for the month must be in the
month even when the bill has not arrived. You draft the accruals; people approve them.

## Procedure

1. `get_close_context` for the period and thresholds.
2. `detect_accrual_candidates` runs four deterministic detectors:
   - **GRNI** — purchase orders received by month end with no bill (ek:GrniAccrual);
   - **Subsequent bills** — bills dated after month end whose service period falls in the
     month (use the exact amount, pro-rated by service days);
   - **Recurring gaps** — vendors billed in at least 3 of the last 4 months with nothing for
     this month (estimate = median of recent bills);
   - **Payroll** — wages earned after the last pay period inside the month (ek:PayrollAccrual).
3. Check each candidate against the evidence (`list_purchase_orders`, `list_recent_bills`,
   `get_payroll_runs`). Drop candidates already accrued or billed.
4. Submit one `journal_entry` per accrual:
   - `entryType: "accrual"`, dated the last day of the month,
   - `autoReverseDate` = first day of next month (the runtime posts the reversal),
   - debit the expense account and department of the source (PO, vendor history, payroll by
     department), credit **2100 Accrued Liabilities** (**2110 Accrued Payroll** for wages),
   - confidence: exact bills high, GRNI high, recurring estimates by their variability.
5. Do not accrue service periods that start after month end (e.g. next quarter's licences).

## Output

`journal_entry` proposals typed `ek:Accrual` with evidence links to the PO, bills or payroll run.
