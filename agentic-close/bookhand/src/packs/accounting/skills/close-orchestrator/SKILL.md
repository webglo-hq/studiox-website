---
key: close-orchestrator
name: Close orchestrator
version: 1.3.0
domain: accounting
category: orchestration
summary: Runs the close calendar - starts each agent skill when its checklist dependencies are satisfied, wave by wave, and stops where people need to decide.
inputs:
  closeId: { type: bh:Close, required: true, description: The close to run }
outputs: []
tools: [close_context, close_ready_tasks, close_status]
permissions: { run: skill.run, approve: proposal.decide }
controls:
  - { id: CTL-CLOSE-01, name: Close tasks performed in dependency order by the close calendar, assertions: [completeness, cutoff] }
autonomy: { default: L1, max: L1 }
thresholds:
  maxWaves: { type: integer, default: 8, min: 1, max: 20, label: Maximum dependency waves per run }
materiality: none
budgets: { maxSteps: 300, maxToolCalls: 60, maxTokens: 50000, maxCostUsd: 0.5 }
spawns: ["*"]
evals: evals.json
execution: deterministic
---
# Close orchestrator

## Goal
Every agent-assisted checklist task runs as soon as it can (its dependencies are done or with the reviewer), in calendar order, without anyone having to remember the sequence.

## How it works
Scheduling is deterministic by design: exact dependency order is a control, not a judgment call. Each wave asks `close_ready_tasks` for tasks whose dependencies are satisfied, starts the task's skill as a child run, and repeats. Tasks waiting on approvals stop the wave; approving their proposals completes them, and the next run continues from there.

## Output
Runs started, proposals created, what was auto-applied, and what now waits for people.
