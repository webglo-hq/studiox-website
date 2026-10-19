---
name: fixed-asset-depreciation
description: Maintains the fixed-asset register and records monthly straight-line depreciation — registers newly capitalised purchases found in the ledger and posts the month's depreciation by department. Use it every month after spend coding.
license: Proprietary — Evenkeel demo skill
evenkeel:
  version: 1.0.3
  title: Fixed assets and depreciation
  domain: accounting
  category: Fixed assets
  summary: Registers new capital purchases and posts straight-line depreciation by department, tied to the register.
  ontology: ">=1.3.0 <2.0.0"
  inputs: []
  outputs: [ek:FixedAsset, ek:JournalEntry]
  tools: [get_close_context, get_chart_of_accounts, list_fixed_assets, compute_depreciation, find_capitalization_candidates, read_skill_resource]
  permissions: [je.create, report.view]
  controls:
    preparer: staff_accountant
    reviewer: senior_accountant
    approvalRequired: [fixed_asset]
    sod: [SOD-01, SOD-02]
    assertions: [ek:Valuation, ek:Existence, ek:Completeness]
    coso: ek:ControlActivities
  autonomy:
    default: L2
    max: L3
    autoPostBelow: 2500000
    minConfidence: 0.95
    sampleRate: 0.1
  materiality:
    basis: clearly_trivial
  thresholds:
    defaultLifeComputerMonths: 36
  budgets:
    maxSteps: 20
    maxTokens: 150000
    maxCostUsd: 1
  model: fast
  resources:
    - path: resources/asset-policy.md
      description: Useful lives by asset class and the depreciation convention.
  evals: evals/cases.json
  closeTask:
    category: fixed_assets
    workday: 3
---

# Fixed assets and depreciation

## Procedure

1. `find_capitalization_candidates` — amounts posted this month to fixed-asset cost accounts
   that are not in the register yet (for example laptops re-coded from Office Supplies).
   Submit a `fixed_asset` proposal for each: name, class, quantity, cost, in-service date,
   useful life from the policy, department. Approval registers the asset and posts this
   month's depreciation for it.
2. `compute_depreciation` — the month's straight-line depreciation for every asset already
   in the register, grouped by department.
3. Submit one `depreciation` `journal_entry`: debit 6800 Depreciation Expense by department,
   credit 1590 Accumulated Depreciation, with `links.depreciationLineIds`.
4. If the register and the ledger disagree for any other reason, say so — do not plug.
