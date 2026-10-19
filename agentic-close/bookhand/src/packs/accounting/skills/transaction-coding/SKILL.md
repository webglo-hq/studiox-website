---
key: transaction-coding
name: Transaction coding
version: 1.4.0
domain: accounting
category: cards
summary: Codes card spend to the right account and department using policy rules, company history and ontology semantics; catches expensed equipment that should be capitalized.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  entity: { type: bh:ReportingEntity, required: true, description: Entity code whose card feed to code }
  period: { type: bh:AccountingPeriod, required: true, description: Period key (YYYY-MM) }
outputs:
  - { kind: transaction_coding, type: bh:CardTransaction }
  - { kind: schedule, type: bh:FixedAsset }
  - { kind: journal_entry, type: bh:ReclassEntry }
tools: [close_context, ontology_lookup, cards_uncoded, cards_suggest_coding, cards_review_posted, ledger_account_activity, propose_transaction_coding, propose_capitalize_asset, propose_journal_entry]
permissions: { run: skill.run, approve: proposal.decide }
controls:
  - { id: CTL-CARD-01, name: Card spend coded to the correct account and department, assertions: [classification, accuracy_valuation] }
  - { id: CTL-FA-02, name: Purchases above the capitalization threshold are capitalized, assertions: [classification, existence] }
autonomy: { default: L2, max: L3 }
thresholds:
  minConfidence: { type: number, default: 0.9, min: 0.5, max: 1, label: Auto-apply only above this confidence }
  autoApplyLimitMinor: { type: money, default: 250000, min: 0, max: 5000000, label: Auto-apply limit per transaction (cents) }
  sampleRate: { type: percent, default: 0.1, min: 0, max: 1, label: Share of auto-applied items sampled for review }
rules:
  - Always code Figma to 6420
  - Code Delta Air Lines to 6200
  - Require approval for Apple Store
materiality: trivial
budgets: { maxSteps: 900, maxToolCalls: 450, maxTokens: 600000, maxCostUsd: 4 }
evals: evals.json
---
# Transaction coding

## Goal
Every card transaction in the period is coded to the correct general-ledger account and department, and anything that meets the capitalization policy ends up in property and equipment instead of expense.

## How to work
1. Call `close_context`, then `cards_uncoded` for the entity and period.
2. Call `cards_suggest_coding` with the uncoded ids (batches of up to 100). The suggestion engine applies, in order: the accountant's plain-English policy rules, this company's history for the merchant (human corrections weigh double), then ontology semantics (keywords, MCC codes and vendor categories attached to account classes).
3. For each transaction propose coding with `propose_transaction_coding`. Use the suggestion's account and department unless the evidence clearly says otherwise; if you deviate, say why. Keep the suggestion's confidence unless you have a reason to lower it. Skip transactions with no usable suggestion and mention them in the summary.
4. Call `cards_review_posted` to re-check coding already posted this period (including by people). When a purchase coded to an expense account meets the capitalization threshold and looks like equipment, propose `propose_capitalize_asset` with a reclass entry dated at period end (debit the asset account, credit the expense account it was coded to, same department), the asset class, useful life (computer equipment 36 months) and in-service date.

## Judgment
- Department: the cardholder's department unless the merchant only serves one department (e.g. GitHub for Engineering).
- Travel and meals are separate accounts (6200 vs 6210).
- A laptop, monitor or server above the threshold is equipment, not office supplies, no matter who coded it.
- Never code to intercompany or equity accounts.

## Output
Summarize counts by account, what was auto-applied versus queued, and any capitalization finding with its dollar effect on operating expense.
