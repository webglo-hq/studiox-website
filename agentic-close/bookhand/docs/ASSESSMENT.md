# Assessment

An honest account of what Bookhand is, what was verified and how, and what is missing. Every number below
was observed on 2026-10-19 in this repository's environment (Linux, Node 22, Chromium from Playwright 1.56.1,
PostgreSQL 16.15). Nothing here is extrapolated.

## Verdict

A person can open Bookhand, sign in and close a month end to end: run the close agents, review and approve
their proposals within their own limits, certify reconciliations under maker-checker, accept and approve the
flux commentary, generate and approve the close package, lock the period, and have an auditor verify the
tamper-evident audit chain. The Playwright end-to-end test does exactly that through the browser against the
built server, and the same flow runs as an integration test on MemoryDb, PGlite and a real PostgreSQL server.

## Gate results

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | clean (TypeScript 6.0.3, strict) |
| Lint | `npm run lint` | clean (ESLint 10, typescript-eslint, react-hooks) |
| Unit | `npm run test:unit` | **93 passed** in 14 files (framework, ontology, algorithms, parsers, schema DSL and generated migrations, generated-docs freshness, skill manifests, statement footing, entity scope of a principal, money formatting, keyboard shortcuts) |
| Skill evals | `npm run test:evals` | **21 passed**: 20 eval cases across all 13 skills, plus the check that every skill ships evals |
| Integration (real DB) | `npm run test:integration` | **118 passed** in 12 files, on MemoryDb, PGlite and a PostgreSQL 16.15 server started by `scripts/with-postgres.mjs` (database invariants conformance including a posting/lock race, seed, full close flow on all three, API security, tenant isolation, SSO linking, access tokens and MCP over stdio, audit tampering, inbox decisions, access control, entity scope, crash recovery, accounting review fixes) |
| E2E, server | `npm run build && npm run test:e2e` | **3 passed**: the full demo script (about 1.7 min, every state change a click), the landing page (content, tiers, honest claims, axe light and dark, phone width) and the invitation flow (admin adds a person, enrolment from the delivery log, Controller approves the role) |
| E2E, static demo | `npm run build:demo && npm run test:e2e:demo` | **7 passed**: one self-contained 1.75 MB file with relative paths; offline flow with zero network requests; agents from My close, bulk approval with confirmation, Enter on the focused proposal and a balance sheet that foots; the invitation flow; 390 px with no horizontal scroll; sandboxed iframe with an opaque origin; and axe WCAG 2.2 A/AA checks with zero violations on every screen and both review drawers, in light and dark |
| Screenshots | `npm run screenshots` | 3 specs passed; 23 PNGs (16 desktop at 1440x900, 7 phone at 390x844), 3.7 MB in total; the 16 whose screens changed with the review fixes were re-captured |
| Dependencies | `npm audit --audit-level=high` | **0 vulnerabilities** |
| SAST | Semgrep with the public JavaScript, TypeScript, HTML and generic-secrets rules | **0 errors**; 20 warnings, all triaged (below); 590 info-level internationalization and template-string notes; 212 files scanned (run before the review fixes; not re-run since) |

`npm run verify` chains typecheck, lint, unit, evals, integration, build, both e2e suites and the audit.

### Scanners in the repository's CI

The repository's security workflow runs TruffleHog, Gitleaks, npm audit, dependency review, CodeQL
(security-extended) and Semgrep (`--config auto`). From this sandbox:

- **npm audit**: run, 0 vulnerabilities at any level.
- **Semgrep**: the registry (`--config auto`) is not reachable through the egress proxy, so the same public rule
  sets were run from a clone of `semgrep/semgrep-rules`. Findings were triaged: the one ERROR (a no-op ternary)
  and the warnings that pointed at real smells (a helper named `$` that tripped a jQuery rule, an object used
  as a cookie map) were fixed. The remaining warnings are false positives or accepted: RegExps built from
  route constants and OFX tag names (not user input), the merchant-rule pattern (`detect-redos`; unambiguous
  and input capped at 300 characters), XML and HTML built in templates by the statement writers, the
  demo bundler and the ad renderer (values escaped or constant), `data:` favicons flagged for missing SRI, `JSON.stringify` of an array as a
  group key, and initial React state derived from a prop on purpose. INFO findings are internationalization
  and template-string heuristics.
- **Gitleaks, TruffleHog, CodeQL**: binaries are not available offline, so they were approximated: a pattern scan
  for provider keys and private keys (none found), test secrets replaced with low-entropy values, passwords
  never logged, and the static file server made separator-safe against path traversal (a classic CodeQL
  finding). These three scanners have not actually been run against this code.

## Requirements, with evidence

| Requirement | Status | Where to look |
|---|---|---|
| Research | Done | `docs/research.md` |
| Original brand | Done: name, mark, palette, copy; fictional company on `.example` domains | `src/web/components/ui.tsx` (Logo), `README.md` |
| Deep modules, reusable agent framework, accounting as first pack | Done | `src/agents/framework/` (tested with a non-accounting pack in `framework.test.ts`), `src/packs/accounting/` |
| Formal versioned ontology used for validation, grounding, bucketing, hover explanations, explorer and graph | Done (v1.6.0: 226 classes, 74 relations, 31 executable axioms; Turtle and JSON-LD exports) | `src/packs/accounting/ontology/`, `docs/ontology/`, Ontology screen |
| Production Postgres schema, migrations, Mermaid ERD, invariants in the database, hash-chained audit | Done (78 tables; forward-only migrations 0001 to 0004) | `src/persistence/schema/`, `db/migrations/`, `docs/erd.md`, `tests/integration/conformance.ts` |
| CSV and bank-standard connectors, idempotent imports | Done: CSV, BAI2, camt.053, OFX; re-import is a no-op | `src/integrations/`, seed and integration tests |
| SKILL.md skills with typed manifests and eval fixtures in CI; plain-English policy tuning | Done: 13 skills, each with `evals.json` | `src/packs/accounting/skills/`, `tests/evals/`, Skills screen |
| Durable runtime: plan, act, observe, verify, propose, HITL, post, audit; typed tools, autonomy L0 to L3, SoD, budgets, idempotency, resume, traces, injection hygiene, orchestration | Done | `src/agents/framework/runtime.ts`, `decisions.ts`, `policy.ts`, `hygiene.ts`; Agent runs screen |
| LLM abstraction: live Claude (`claude-opus-5-5` default, Sonnet and Haiku), labeled offline engine, live path tested with recorded responses | Done; live path not run against the real API (no key here) | `src/agents/llm/anthropic.ts`, `framework.test.ts` |
| All screens; WCAG 2.2 AA, responsive, light and dark | Done: 17 screen modules (enrolment, reset and the demo delivery log added); automated axe checks pass on every screen in both themes | `src/web/`, `tests/e2e/demo/demo.spec.ts` |
| Auth: scrypt, secure sessions, CSRF, rate limiting, RBAC, SoD, TOTP, OIDC/SAML seam, tenant scoping, audited mutations, demo users | Done, plus single-use enrolment and reset links, dual control over authority grants and SoD changes, entity-scoped roles and a generic lockout answer; SSO is a tested seam without a bundled protocol verifier (planned) | `src/security/`, `src/api/kernel.ts`, `src/app/usecases/access.ts`, `src/app/usecases/sso.ts`, `tests/integration/api.test.ts`, `tests/integration/access-control.test.ts`, `tests/integration/entity-scope.test.ts` |
| Deterministic seed; demo script | Done | `src/packs/accounting/seed/`, `tests/integration/seed.test.ts`, `README.md` |
| README, decision log, assessment | Done | `README.md`, `docs/decisions.md`, this file |
| Screenshots under 6 MB | Done: 3.7 MB | `docs/screenshots/` |
| Static demo (`npm run build:demo`) | Done: `dist-demo/index.html`, 1.75 MB | `tests/e2e/demo/demo.spec.ts` |
| P2: MCP server with the same RBAC and audit | Done: 13 tools over stdio, personal access tokens | `src/mcp/server.ts`, `src/server/mcp.ts`, `tests/integration/mcp.test.ts` |
| P2: landing page with tiers | Done | `src/web/landing.html` (served at `/landing.html`), `tests/e2e/server/02-landing.spec.ts` |
| P2: 2 to 3 ads at 1080x1350 | Done: 3 | `docs/ads/`, `scripts/render-ads.ts` |

## Bugs the gates found (and fixed)

- The FX agent remeasured the UK's GBP bank account because USD wires were paid from it, so the UK bank
  reconciliation could never tie and the close could not lock (found by the e2e test; decision C3).
- A close package could be generated and approved while the flux analysis was unapproved, producing a
  "Final" package that said so (found while capturing screenshots; decisions C1 and C2).
- The whole-app accessibility check found muted text below 4.5:1, a settings link and task cards whose
  accessible names did not contain their visible text, and an unlabeled file input (U4).
- Embedded databases starved HTTP requests during agent runs (F10); successful sign-ins were charged against
  the brute-force limit (S4); nested reads deadlocked a connection (T3); a GBP depreciation entry was titled
  in dollars (T2); an SSO refusal's audit entry was rolled back with the refusal.

## Independent review fixes (2026-10-19)

Three independent reviews (accounting, engineering, product) found the defects below. Each fix is a root-cause
change with a regression test that fails on the reviewed code and passes now; the test names carry the defect
ID.

| ID | Severity | What was wrong | Fix | Regression test |
|---|---|---|---|---|
| BH-C1 | Critical | An admin could mint an approver: creating a user or resetting a password returned a working password (the reviewer signed in as an invented CFO and posted a $34,456 accrual), and SoD rules changed on the admin's word alone. | No credential is ever returned or shown to the acting admin: single-use, expiring enrolment (72 h) and reset (60 min) links, stored as hashes, sent through an outbox; a demo organization's delivery log opens only for the addressee and every opening is audited. Grants that carry approval authority and every SoD rule change wait as access requests until a Controller or CFO approves them who is neither the requester nor the grantee and holds at least that authority; the database refuses a decision by either. | `tests/integration/access-control.test.ts`, `tests/e2e/server/03-access.spec.ts`, `tests/e2e/demo/demo.spec.ts` |
| B-1 | Critical | The balance sheet did not foot: current-year earnings were missing from equity, there was no "Total liabilities and equity", the package income statement had no net income, and "-$0" appeared. | Current-year earnings is an equity statement line; totals are computed from the presented lines and a footing check fails loudly on every balance-sheet rendering; the package income statement ends in net income; amounts that round to zero never show a sign. | `src/packs/accounting/domain/reporting.test.ts`, `src/web/lib/format.test.ts`, `tests/e2e/demo/demo.spec.ts` |
| BH-M1 | Major | Roles carried an entity but nothing enforced it: a person meant for one entity read and decided every entity's work. | Admins grant a role for every entity or one; every read filters to the entities a person's grants cover (other entities' objects are "not found"), every action checks its permission on the object's entity, approval limits come only from grants covering it, and whole-organization views and actions need a grant for every entity. | `tests/integration/entity-scope.test.ts`, `src/security/principal.test.ts` |
| BH-M2 | Major | Whoever started an agent run could approve its output (up to $10,000, and always for bank matches). | SOD-002 blocks the run's requester on every proposal of every kind and amount; the database refuses it too, so the rule cannot be switched off. | `tests/integration/inbox-review.test.ts`, `tests/integration/conformance.ts`, `src/agents/framework/framework.test.ts` |
| BH-M3 | Major | Crash recovery ran only at start-up and skipped runs with a heartbeat under 60 s old, so a quick restart left the close "already running" until a second restart. | Leases: a worker renews a run's heartbeat every 10 s; `App.maintain()` (at start-up and every 15 s) takes over runs with no heartbeat for 30 s; "Run close agents" takes over an abandoned orchestrator at once; a run interrupted 3 times is failed instead of looping. | `tests/integration/crash-recovery.test.ts` |
| BH-M4 | Major | The database let a draft line move into a posted entry (unbalancing it), and posting did not lock the period row. | The line trigger checks the old and the new parent; posting locks the period row `FOR UPDATE` and locking a close takes the period rows first (migration 0003). | `tests/integration/conformance.ts` (every adapter, including a race on PostgreSQL) |
| B-2 | Major | "Select all" and bulk approval swept in flagged, failed-check and low-confidence items. | Those items are left out of select-all and refused server-side in a bulk request; bulk approval asks for confirmation of the count and total, which the server checks. | `tests/integration/inbox-review.test.ts`, `src/agents/framework/framework.test.ts`, `tests/e2e/demo/demo.spec.ts` |
| B-3 | Major | Enter opened the shortcut cursor's proposal instead of the focused one. | Enter and Space belong to the focused control; focusing a proposal moves the cursor to it. | `src/web/lib/hooks.test.ts`, `tests/e2e/demo/demo.spec.ts` |
| ACC-1 | Minor | The Copperline accrual ($21,906) included the planted duplicate bill. | A bill entered twice for the same service month counts once in the run rate ($15,772.67), and the reason says what was left out. | `tests/integration/accounting-review.test.ts`, `src/packs/accounting/algorithms/close-algos.test.ts` |
| ACC-2 | Minor | Benford ran on 41 account totals and always said "insufficient". | Every posted line of the trailing twelve months (computed entries left out), with a 300-amount floor. | `tests/integration/accounting-review.test.ts`, `src/packs/accounting/algorithms/flux-anomaly.test.ts` |
| ACC-3 | Minor | Declared axioms were not executed (`checkTrialBalance` never called; the reconciliation note rule unenforced) and AX-FLX-02/03 were reused for driver checks. | The trial-balance axioms run on the report, in the close gate and in the package; driver checks are AX-FLX-04/05, evaluated through the ontology; AX-REC-01 runs at certification. | `tests/integration/accounting-review.test.ts` |
| B-4 | Minor | A reconciliation certified with an "unexplained" $1,250 item and no note, beside "Unexplained difference 0.00". | An item listed as unexplained explains nothing: it stays in the unexplained difference, and certifying needs it within clearly trivial and a preparer's note. | `tests/integration/accounting-review.test.ts` |
| B-7 | Minor | "Run close agents" landed on a technical trace page with no next step. | It stays on My close, which shows the agents working and then "Review N items". | `tests/e2e/demo/demo.spec.ts`, `tests/e2e/server/01-close.spec.ts` |
| B-8 | Minor | Pounds shown with "$", "$254760.00", flux items at "$0.00", raw numbers in summaries. | Every amount is formatted in its entity's currency; explanations show the variance they cover. | `tests/integration/accounting-review.test.ts`, `src/packs/accounting/algorithms/close-algos.test.ts` |
| B-10 | Minor | The landing page promised "Nobody approves their own work" and sold single sign-on. | Claims describe the built controls; single sign-on is marked planned. | `tests/e2e/server/02-landing.spec.ts` |
| SEC-1 | Minor | A locked account answered differently from a wrong password, revealing that it exists. | Same answer and timing; the account holder is told by message. | `tests/integration/access-control.test.ts`, `tests/integration/api.test.ts` |
| SEC-2 | Minor | The audit hash omitted the time, actor type, object type and IP shown in the log. | Every shown column is bound to the hashed record; the insert trigger and both verifiers check them. | `tests/integration/audit-tamper.test.ts`, `tests/integration/conformance.ts` |
| SEC-3 | Minor | A write access token could set a skill's autonomy to L3. | Autonomy and policy changes are browser-session only. | `tests/integration/access-control.test.ts` |

Tests changed because they encoded the defects (each explained in its commit): the framework SoD test that let
a requester approve up to the limit (BH-M2), the MCP test in which the launcher approved her own run's output
(BH-M2), the conformance audit case whose rows did not match their records (SEC-2), the lockout test that
expected the account-revealing 429 (SEC-1), and the e2e helpers that now confirm bulk approvals, stay on My
close after starting the agents and write the reconciliation note.

## Known gaps and risks

1. **Live Claude has not been exercised against the real API** from this environment (no key). The request
   shape, streaming, thinking, refusal and `max_tokens` handling are tested with recorded streams through the
   real SDK; quality of live agent output is unmeasured.
2. **Single-process runtime pieces.** The rate limiter and the agent run queue live in the server process. Runs
   hold heartbeat leases, so any process takes over a run whose worker died (within about 45 s), but a
   multi-instance deployment still needs a shared limiter and a shared queue (for example in PostgreSQL), which
   are not built.
3. **SSO** is a seam with tested account-linking rules; no OIDC or SAML verifier is bundled and the sign-in page
   has no SSO button. The landing page marks it planned.
4. **Outbox transport.** Enrolment and reset links go through an outbox; no SMTP or mail-API transport is
   bundled, so a real organization must plug one in (`AppConfig.outbox`) or its messages stay queued. The demo
   delivery log exists only for demo organizations; opening it is audited, not prevented.
5. **Entity scope** is enforced in the application layer (every use case, tested through the API), not by
   PostgreSQL row-level security.
6. **Tenancy.** Isolation is enforced in every use case and tested through the API with a second organization,
   but there is no self-service sign-up or tenant administration; tenants come from the seed or the CLI.
7. **Connectors are file-based** (CSV, BAI2, camt.053, OFX, ERP GL CSV). There are no live bank feeds or ERP
   write-back; Bookhand keeps its own ledger.
8. **MCP** exposes tools only, over stdio, authenticated with personal access tokens (no OAuth, no remote
   HTTP transport, no resources or prompts).
9. **Accessibility** is verified with automated axe checks (WCAG 2.2 A/AA rules) on every screen, both review
   drawers and the landing page, in light and dark. Automated checks cover only part of WCAG; there has been no
   manual keyboard-only or screen-reader pass, and not every state of every screen (empty, error, long data) is
   checked.
10. **Scale** is the seeded company (two operating entities, thirteen months); there is no load or soak test.
11. **The ontology** is validated by unit tests and executable axioms, not by an OWL reasoner.
12. **The in-browser demo** uses lighter scrypt parameters and an in-memory database that resets on reload; it
    is a demo, not a deployment mode.
13. **English only**, US and UK formatting; landing-page prices are illustrative.
14. **CodeQL, Gitleaks and TruffleHog** were not run (see above).

## Five things to look at first

1. The demo script: `npm ci && npm run up`, or open `dist-demo/index.html`. Sign in as Maya, run the close
   agents, then open the HALCYON FREIGHT proposal as Daniel.
2. Controls in the database: `db/migrations/0002_invariants.sql`, `0003_review_invariants.sql` and the conformance suite that runs the same
   violations against every adapter (`tests/integration/conformance.ts`).
3. The agent runtime: `src/agents/framework/runtime.ts` (journaled tool calls, budgets, resume, injection
   hygiene, append-only live history) and `decisions.ts` (limits, SoD, maker-checker).
4. Skills as documents with evals: `src/packs/accounting/skills/*/SKILL.md` and `evals.json`, run by
   `tests/evals/skills.test.ts`.
5. Assistants that act as a person: `src/mcp/server.ts`, `src/app/usecases/tokens.ts` and
   `tests/integration/mcp.test.ts`.
