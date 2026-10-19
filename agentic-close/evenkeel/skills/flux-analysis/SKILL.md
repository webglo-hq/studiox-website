---
name: flux-analysis
description: Compares the month with the prior month and with budget account by account, flags variances above the company's thresholds, decomposes each material variance into drivers (vendors, one-time items, accruals, timing, volume) from transaction detail, and drafts a plain-English explanation for review. Use it after all adjustments are booked.
license: Proprietary — Evenkeel demo skill
evenkeel:
  version: 2.0.1
  title: Flux analysis
  domain: accounting
  category: Review
  summary: Finds material variances vs prior month and budget, explains each with transaction-level drivers and drafts commentary for approval.
  ontology: ">=1.3.0 <2.0.0"
  inputs:
    - name: comparisons
      type: ek:ComparisonBasis
      required: false
      description: prior_month and/or budget (default both)
  outputs: [ek:VarianceExplanation]
  tools: [get_close_context, compute_flux, analyze_variance_drivers, read_skill_resource]
  permissions: [report.view, flux.explain]
  controls:
    preparer: fpa_analyst
    reviewer: controller
    approvalRequired: [flux_explanation]
    sod: [SOD-01, SOD-02]
    assertions: [ek:Accuracy, ek:Completeness, ek:Cutoff]
    coso: ek:MonitoringActivities
  autonomy:
    default: L1
    max: L2
    autoPostBelow: 0
    minConfidence: 0.8
    sampleRate: 1
  materiality:
    basis: performance
  thresholds:
    absThreshold: 2500000
    pctThreshold: 0.1
  budgets:
    maxSteps: 40
    maxTokens: 300000
    maxCostUsd: 3
  model: balanced
  resources:
    - path: resources/flux-writing-guide.md
      description: How to write a variance explanation a CFO can read in ten seconds.
  evals: evals/cases.json
  closeTask:
    category: review
    workday: 4
---

# Flux analysis

## Procedure

1. `compute_flux` for each operating entity and each comparison (prior month, budget).
   A variance is **material** when it is at least the absolute threshold **and** the
   percentage threshold (policy: $25,000 and 10%).
2. For every material line, `analyze_variance_drivers` — the engine groups the two periods'
   activity by counterparty and entry type and returns drivers (new vendor, one-time item,
   accrual, timing, volume/rate) with their amounts and the share of the variance they
   explain (coverage).
3. Submit one `flux_explanation` per material line: the narrative, the drivers with evidence
   references, the coverage. A good explanation:
   - leads with the number and the direction ("Marketing rose $112k (+226%) vs August");
   - names the two or three drivers with amounts;
   - says whether the change is one-time or recurring;
   - states coverage honestly — below 80% says what is still unexplained.
4. Do not explain immaterial lines.

## Judgement

Numbers come from the engine; never round them into a different story. If a driver looks like
an error (e.g. an expense that should have been capitalised), say so — the explanation is
where reviewers catch misstatements.
