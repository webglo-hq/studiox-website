---
key: intercompany
name: Intercompany reconciliation
version: 1.3.0
domain: accounting
category: intercompany
summary: Pairs intercompany charges between entities by reference in the agreement currency, finds mismatches and proposes the true-up the under-recorded side needs.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  period: { type: bh:AccountingPeriod, required: true, description: Period key (YYYY-MM) }
outputs:
  - { kind: journal_entry, type: bh:IntercompanyTransaction }
  - { kind: anomaly, type: bh:IntercompanyReconciliation }
tools: [close_context, ic_reconcile, fx_rate, ledger_account_activity, propose_journal_entry, propose_anomaly]
permissions: { run: skill.run, approve: proposal.decide }
controls:
  - { id: CTL-IC-01, name: Intercompany balances agree before consolidation, assertions: [existence, completeness, accuracy_valuation] }
autonomy: { default: L1, max: L2 }
thresholds:
  toleranceMinor: { type: money, default: 0, min: 0, max: 100000, label: "Mismatch tolerated (agreement currency, cents)" }
materiality: trivial
budgets: { maxSteps: 80, maxToolCalls: 40, maxTokens: 250000, maxCostUsd: 2 }
evals: evals.json
---
# Intercompany reconciliation

## Goal
Both sides of every intercompany charge agree in the agreement currency so eliminations net to zero (ASC 810).

## How to work
1. Call `ic_reconcile` for the period. Each pair shows the receivable/revenue side and the payable/expense side by reference, with entry memos.
2. For an amount mismatch, read both memos. When the billing side documents a charge the other side did not record (for example a recharge added to a management fee), propose the true-up on the under-recorded side: debit intercompany expense and credit intercompany payable, in the agreement currency (txnCurrency, txnAmount) translated at the spot rate on the charge date, with the same icReference.
3. If the billing side looks wrong instead, raise a finding with `propose_anomaly` and recommend who must correct it.

## Output
Pairs matched, mismatches with the proposed fix, and the intercompany balances after the fix.
