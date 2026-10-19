---
key: flux-analysis
name: Flux analysis
version: 1.5.0
domain: accounting
category: review
summary: Computes consolidated variances versus prior month, decomposes material ones into drivers and drafts plain-English explanations for FP&A.
inputs:
  closeId: { type: bh:Close, required: true, description: The close being worked }
  closeTaskId: { type: bh:CloseTask, required: false, description: The checklist task this run serves }
  period: { type: bh:AccountingPeriod, required: true, description: Period key (YYYY-MM) }
  comparison: { type: bh:FluxAnalysis, required: false, description: "prior_month (default) or budget" }
outputs:
  - { kind: flux_explanation, type: bh:FluxExplanation }
tools: [close_context, flux_compute, flux_drivers, ledger_account_activity, propose_flux_explanation]
permissions: { run: skill.run, approve: flux.explain }
controls:
  - { id: CTL-FLUX-01, name: Material fluctuations explained and approved, assertions: [presentation, completeness] }
autonomy: { default: L1, max: L2 }
thresholds:
  fluxPct: { type: percent, default: 0.1, min: 0.01, max: 1, label: Explain variances at least this large (relative) }
  fluxMinor: { type: money, default: 2500000, min: 0, max: 100000000, label: and at least this large (cents) }
  combineOr: { type: boolean, default: false, label: Use OR instead of AND between the two thresholds }
materiality: performance
budgets: { maxSteps: 120, maxToolCalls: 60, maxTokens: 400000, maxCostUsd: 3 }
evals: evals.json
---
# Flux analysis

## Goal
Every material movement in the consolidated income statement versus the comparison period has a driver-based explanation a CFO can read in ten seconds.

## How to work
1. Call `flux_compute` for the close (comparison prior month unless the input says budget).
2. For each material line still missing an accepted explanation, call `flux_drivers` and propose `propose_flux_explanation` with the drafted text and drivers. Improve the wording when you can, but every number must come from the drivers.
3. Call out one-time items (events, settlements) and say whether they recur next month.

## Output
Material variances with their main drivers and what FP&A should double-check.
