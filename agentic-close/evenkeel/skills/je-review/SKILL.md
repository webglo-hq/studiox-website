---
name: je-review
description: Tests the month's journal entries the way an auditor would — duplicate payments, self-approved entries, round amounts, weekend and after-hours postings, manual postings to control accounts, amounts just under approval thresholds, unusual account pairs and Benford's-law deviations — and logs each finding as an exception with a recommended action.
license: Proprietary — Evenkeel demo skill
evenkeel:
  version: 1.3.1
  title: Journal entry review
  domain: accounting
  category: Controls
  summary: Runs fraud-and-error tests over the month's entries and logs exceptions with evidence and a recommended action.
  ontology: ">=1.3.0 <2.0.0"
  inputs: []
  outputs: [ek:Exception, ek:ReversingEntry]
  tools: [get_close_context, list_period_entries, get_journal_entry, run_je_tests, read_skill_resource]
  permissions: [report.view, je.create]
  controls:
    preparer: senior_accountant
    reviewer: controller
    approvalRequired: [journal_entry]
    sod: [SOD-01, SOD-02, SOD-04]
    assertions: [ek:Occurrence, ek:Accuracy, ek:Classification]
    coso: ek:MonitoringActivities
  autonomy:
    default: L2
    max: L3
    autoPostBelow: 0
    minConfidence: 0.7
    sampleRate: 1
  materiality:
    basis: clearly_trivial
    note: Exceptions are logged automatically; any corrective entry is always reviewed.
  thresholds:
    roundAmountMin: 1000000
    approvalThreshold: 5000000
  budgets:
    maxSteps: 16
    maxTokens: 200000
    maxCostUsd: 2
  model: balanced
  resources:
    - path: resources/je-testing-guide.md
      description: The tests, why each matters (PCAOB AS 2401) and how to word findings.
  evals: evals/cases.json
  closeTask:
    category: review
    workday: 2
---

# Journal entry review

## Procedure

1. `run_je_tests` — deterministic tests over every posted entry in the month (including
   imports from other systems) plus the month's vendor payments.
2. For each finding, decide severity from the evidence, not the test name:
   - an entry prepared and approved by the same person that touches revenue is **critical**;
   - a weekend posting of a round amount with no support is **high**;
   - a lone round amount in a normal account is **low**.
3. Submit one `issue` per finding with the subject references, the assertion at risk
   (occurrence, accuracy, classification…) and a concrete recommended action.
4. Where the correction is unambiguous and supported (for example a duplicate payment), the
   other skills propose the entry. For a suspicious entry with no support, propose a
   `journal_entry` that reverses it — a person always decides.
5. Report Benford's-law results only as context (they need volume to be meaningful).

## Judgement

Exceptions are not accusations. Write what the data shows and what to check next.
