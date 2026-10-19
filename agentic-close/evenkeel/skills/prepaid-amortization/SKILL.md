---
name: prepaid-amortization
description: Keeps prepaid expenses right — amortises every active prepaid schedule for the month, catches up months that were missed, and moves multi-month purchases that were expensed up front into prepaid with a new schedule. Use it monthly for prepaid software, insurance and similar balances.
license: Proprietary — Evenkeel demo skill
evenkeel:
  version: 1.1.0
  title: Prepaid amortisation
  domain: accounting
  category: Prepaids
  summary: Posts monthly amortisation, catches up missed months and converts up-front expensed annual purchases into prepaid schedules.
  ontology: ">=1.3.0 <2.0.0"
  inputs: []
  outputs: [ek:PrepaidSchedule, ek:JournalEntry, ek:Exception]
  tools: [get_close_context, list_prepaid_schedules, find_prepaid_candidates, read_skill_resource]
  permissions: [je.create, report.view]
  controls:
    preparer: staff_accountant
    reviewer: senior_accountant
    approvalRequired: [prepaid_schedule]
    sod: [SOD-01, SOD-02]
    assertions: [ek:Valuation, ek:Cutoff, ek:Classification]
    coso: ek:ControlActivities
  autonomy:
    default: L2
    max: L3
    autoPostBelow: 500000
    minConfidence: 0.9
    sampleRate: 0.2
  materiality:
    basis: clearly_trivial
  thresholds: {}
  budgets:
    maxSteps: 20
    maxTokens: 200000
    maxCostUsd: 1.5
  model: balanced
  resources:
    - path: resources/prepaid-policy.md
      description: Prepaid recognition threshold, amortisation convention and catch-up rules.
  evals: evals/cases.json
  closeTask:
    category: prepaids
    workday: 3
---

# Prepaid amortisation

## Procedure

1. `list_prepaid_schedules` — every schedule with its lines for this month and any earlier
   month that was never posted (a **missed** amortisation).
2. For each schedule with a line due this month, submit an `amortization` `journal_entry`
   (debit the expense account and department, credit the prepaid account), linking the line in
   `links.prepaidLineIds`.
3. For each **missed** line in a closed month, submit a catch-up entry dated in the current
   month (closed months cannot be changed) and log an `issue` of category
   `missing_amortization` so the reviewer sees the control gap.
4. `find_prepaid_candidates` — bills and card purchases expensed this month that cover more
   than one month of future service at or above the prepaid threshold. For each, submit a
   `prepaid_schedule` proposal: the runtime reclassifies the amount to prepaid, creates the
   schedule and posts this month's share in one approved step.

## Judgement

- Service dates on the bill beat words in the memo. "Annual" in a memo without dates is a
  hint; say so and lower confidence.
- Do not create a schedule for purchases below the threshold — expense them.
