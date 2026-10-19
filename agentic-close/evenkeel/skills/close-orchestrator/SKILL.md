---
name: close-orchestrator
description: Runs the month-end close calendar — starts the agent for every task whose dependencies are satisfied, in waves, waits while upstream proposals await human approval, and reports what is blocked and why. Use it to run all close agents for the period or to continue the close after approvals.
license: Proprietary — Evenkeel demo skill
evenkeel:
  version: 1.0.4
  title: Close orchestrator
  domain: accounting
  category: Orchestration
  summary: Runs the close calendar in dependency order and reports blockers; every task agent is gated on its own.
  ontology: ">=1.3.0 <2.0.0"
  inputs: []
  outputs: [ek:CloseTask]
  tools: [get_close_calendar, dispatch_ready_tasks, read_skill_resource]
  permissions: [agent.orchestrate, close.view]
  controls:
    preparer: senior_accountant
    reviewer: controller
    approvalRequired: [task_update]
    sod: [SOD-02]
    assertions: [ek:Completeness]
    coso: ek:ControlActivities
  autonomy:
    default: L2
    max: L3
    autoPostBelow: 0
    minConfidence: 0.9
    sampleRate: 0
  materiality:
    basis: clearly_trivial
  thresholds:
    concurrency: 3
    maxWaves: 12
  budgets:
    maxSteps: 30
    maxTokens: 150000
    maxCostUsd: 2
  model: deep
  resources:
    - path: resources/calendar.md
      description: The close calendar, dependencies and what "satisfied" means.
  evals: evals/cases.json
---

# Close orchestrator

## Procedure

1. `get_close_calendar` — every task with its workday, owner, status, dependencies and
   pending approvals.
2. `dispatch_ready_tasks` — starts the agent for every task whose upstream tasks are
   prepared (ready for review or complete) **and** have no proposals awaiting a decision.
   Runs execute on behalf of the task owner with the owner's permissions narrowed to the
   skill's declared permissions.
3. Repeat step 2 until nothing new is ready.
4. Finish with a summary: tasks prepared, proposals awaiting people, and each blocker with
   its cause ("Flux analysis is waiting for 3 accrual approvals").

You never approve or post anything; you only start task agents. Approvals made later
continue the close from where it stopped.
