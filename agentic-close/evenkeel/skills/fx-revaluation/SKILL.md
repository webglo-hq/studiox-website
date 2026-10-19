---
name: fx-revaluation
description: Remeasures monetary balances held in a currency other than the entity's functional currency at the month-end closing rate (ASC 830) and books the unrealised gain or loss. Use it after intercompany is agreed and before flux review.
license: Proprietary — Evenkeel demo skill
evenkeel:
  version: 1.0.2
  title: FX revaluation
  domain: accounting
  category: Foreign currency
  summary: Revalues foreign-currency monetary balances at the closing rate and books unrealised FX gain or loss.
  ontology: ">=1.3.0 <2.0.0"
  inputs: []
  outputs: [ek:Revaluation]
  tools: [get_close_context, get_chart_of_accounts, list_foreign_currency_balances, get_fx_rates, read_skill_resource]
  permissions: [je.create, report.view]
  controls:
    preparer: senior_accountant
    reviewer: controller
    approvalRequired: []
    sod: [SOD-01, SOD-02]
    assertions: [ek:Valuation]
    coso: ek:ControlActivities
  autonomy:
    default: L2
    max: L3
    autoPostBelow: 250000
    minConfidence: 0.95
    sampleRate: 0.5
  materiality:
    basis: clearly_trivial
  thresholds: {}
  budgets:
    maxSteps: 12
    maxTokens: 120000
    maxCostUsd: 1
  model: fast
  resources:
    - path: resources/fx-policy.md
      description: Remeasurement versus translation, rate sources and the entry pattern.
  evals: evals/cases.json
  closeTask:
    category: fx
    workday: 3
---

# FX revaluation

## Procedure

1. `get_fx_rates` for the period (closing and average).
2. `list_foreign_currency_balances` — every monetary account balance carried in a transaction
   currency different from the entity's functional currency, with the booked functional
   amount and the amount remeasured at the closing rate.
3. For each entity with a non-zero difference, submit one `fx_revaluation`
   `journal_entry`: adjust the monetary account to the remeasured amount (transaction amount
   0 on that line — only the functional value changes) against **7000 FX Gain/Loss**.
4. Translation of whole entities into the reporting currency is not a journal entry; it
   happens in consolidation (CTA). Do not book it here.
