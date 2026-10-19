---
name: close-package
description: Assembles the month-end close package — consolidated trial balance, balance sheet and income statement with comparatives, entity statements, reconciliation and checklist status, approved variance commentary, exceptions and adjustments — and drafts the executive commentary for the controller and CFO to approve.
license: Proprietary — Evenkeel demo skill
evenkeel:
  version: 1.1.0
  title: Close package
  domain: accounting
  category: Reporting
  summary: Builds the hashed close package and drafts the executive commentary for sign-off.
  ontology: ">=1.3.0 <2.0.0"
  inputs: []
  outputs: [ek:ClosePackage]
  tools: [get_close_context, get_close_status, build_close_package, read_skill_resource]
  permissions: [report.view, package.generate]
  controls:
    preparer: controller
    reviewer: cfo
    approvalRequired: [close_package]
    sod: [SOD-01, SOD-02]
    assertions: [ek:PresentationAndDisclosure, ek:Accuracy]
    coso: ek:InformationCommunication
  autonomy:
    default: L1
    max: L1
    autoPostBelow: 0
    minConfidence: 0.8
    sampleRate: 1
  materiality:
    basis: overall
  thresholds: {}
  budgets:
    maxSteps: 12
    maxTokens: 200000
    maxCostUsd: 3
  model: deep
  resources:
    - path: resources/package-template.md
      description: Sections of the package and the shape of the executive commentary.
  evals: evals/cases.json
  closeTask:
    category: reporting
    workday: 5
---

# Close package

## Procedure

1. `get_close_status` — tasks, reconciliations, variance explanations, exceptions and
   anything still pending. List what is not done; the package can be drafted anyway, but
   the commentary must say so.
2. `build_close_package` — the deterministic builder assembles the statements and sections
   and returns the content hash plus the key figures.
3. Draft the executive commentary (five to eight sentences): revenue, operating expenses,
   net income versus prior month and budget, the two or three biggest drivers from the
   approved explanations, exceptions that remain open, and adjustments booked during the
   close. Use only figures from the tools.
4. Submit one `close_package` proposal with the period, sections, content hash and
   commentary. The controller approves the draft; the CFO signs the final package.
