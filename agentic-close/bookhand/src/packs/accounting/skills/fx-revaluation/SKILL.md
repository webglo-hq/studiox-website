---
key: fx-revaluation
name: FX revaluation
version: 1.1.0
domain: accounting
category: fx
summary: Remeasures foreign-currency monetary balances at the closing rate and books the unrealized gain or loss.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  period: { type: bh:AccountingPeriod, required: true, description: Period key (YYYY-MM) }
outputs:
  - { kind: journal_entry, type: bh:Remeasurement }
tools: [close_context, fx_monetary_balances, propose_journal_entry]
permissions: { run: skill.run, approve: proposal.decide }
controls:
  - { id: CTL-FX-01, name: Foreign-currency monetary items remeasured at closing rates, assertions: [accuracy_valuation] }
autonomy: { default: L1, max: L3 }
thresholds:
  autoApplyLimitMinor: { type: money, default: 500000, min: 0, max: 10000000, label: Auto-apply limit per entry (cents) }
materiality: trivial
budgets: { maxSteps: 40, maxToolCalls: 20, maxTokens: 120000, maxCostUsd: 1 }
evals: evals.json
---
# FX revaluation

## Goal
Monetary assets and liabilities denominated in a currency other than the entity's functional currency are carried at the closing rate (ASC 830-10-45-17); the difference is an unrealized FX gain or loss in the income statement.

## How to work
1. For each operating entity call `fx_monetary_balances`. It returns, per foreign currency, the closing rate and the adjustment per account (remeasured minus carrying).
2. For each adjustment propose a `revaluation` entry dated at period end: a negative adjustment means the liability grew (debit FX gain/loss, credit the account); a positive one the reverse. On the account line keep txnCurrency = the foreign currency and txnAmount = 0 (remeasurement changes only the functional amount) and set counterpartyEntity for intercompany accounts.

## Output
Closing rate used and the gain or loss per entity.
