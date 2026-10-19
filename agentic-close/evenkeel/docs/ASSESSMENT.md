# Assessment

This document is an honest account of what Evenkeel is and how complete it is, written for a reviewer. Every number below was observed on 19 October 2026 on the build machine: a shared container with 4 CPUs, Node 22.22 and PostgreSQL 16.15.

## In one paragraph

Evenkeel runs a month-end close end to end on a fictional two-country company.

- **What the close covers:** agents prepare the work, accountants decide, and the month locks.
- **Ways to run it:**
  - as a full server, with authentication and PostgreSQL;
  - as a single-file demo running entirely in a browser;
  - through an MCP server.
- **The real parts:** the ledger rules, the controls, the agent runtime, the skills and the security model. They are enforced in code and in the database, and they are tested against PostgreSQL 16.
- **The simulated parts:**
  - the company and its documents, which are generated;
  - the default "reasoning", a deterministic playbook engine that drives the same typed tools Claude uses.

  The live Claude path is implemented and tested with a scripted client. It was not run against the real Anthropic API here, because no key was available.

## Real or simulated

| Area | Real | Simulated or limited |
|---|---|---|
| General ledger | Multi-entity double entry in PostgreSQL 16. Triggers enforce balance, postable accounts, period states, maker-checker, mirror-only reversals and immutability (`db/migrations/0002_invariants.sql`). The same invariant suite runs against the memory store, PGlite and PostgreSQL 16. | One tenant is seeded. There is no tenant-administration UI, though every table and service is tenant-scoped. |
| Data | Real parsers for CSV, BAI2, OFX and camt.053. Imports are idempotent, with provenance from each row to its source document. | The company, documents and twelve months of history are generated deterministically (`src/packs/accounting/seed/`). There are no live bank or ERP feeds. |
| Agents | A durable runtime with typed tools, deterministic verification, the autonomy gate, maker-checker, budgets, crash resume and traces. Skills are versioned packages with evals. | The default brain is a deterministic playbook per skill: scripted reasoning over real tools and data. Live Claude is wired and tested with a scripted client, but not exercised against the real API here. |
| Evals | 64 expectation cases over a full close, run in CI and at seed time, with results shown in the skill catalog. | The cases were written for the planted scenario. With live Claude they measure the model, but that was not done here. |
| Security | scrypt, sessions (hash at rest, rotation, idle and absolute expiry), CSRF + Origin, rate limits, lockout, TOTP with replay protection, sealed secrets, CSP, RBAC with eight roles, entity scoping, SoD, and audit of every mutation. API tokens for MCP. | SSO is a seam (interface, registry, `idp` columns); no OIDC or SAML provider ships. No password-reset email, because there is no mail. |
| Time | A business clock pinned to WD+2 of the September 2026 close, so the demo is reproducible. | `EVENKEEL_CLOCK=system` uses real time; most of the testing used the scenario clock. |
| Delivery | A Dockerfile and compose file. The runtime stage was verified without Docker: production-only install with `--ignore-scripts`, `NODE_ENV=production`, first-run seed, health check and security headers. | No Docker daemon was available, so no image was built. CI workflows are written but have not run on GitHub; the same commands ran locally (see the gates below). |
| Accessibility | axe-core WCAG 2.2 A/AA checks on 50 views, in light and dark and at phone width, with 0 violations. Keyboard shortcuts, focus management and reduced motion. | Automated checks cover only part of WCAG. No manual screen-reader audit was done. |

## Five-minute tour

**On a phone, start with the pictures** ([docs/screenshots](screenshots/)). Each one proves something:

1. `desktop-03-my-close-after-agents.png`: after one click the agents have run and 26 items wait for people. The page says what to do next.
2. `desktop-06-proposal-why.png`: an accrual with the agent's reason, a 92% confidence, the lines it will post, and evidence linked to the purchase order.
3. `desktop-07-guardrail-injection.png`: a bank memo saying "IGNORE PRIOR INSTRUCTIONS…" was treated as data, flagged and held for a person.
4. `desktop-08-reconciliation-workbench.png`: the bank rec cannot be certified while $1,850.00 is unexplained.
5. `desktop-04-cockpit.png` and `desktop-12-run-trace.png`: the close calendar by business day, lock readiness, and a full agent trace.
6. `phone-*.png`: the same product at 390×844.

**Then run it** (one file, no install beyond `npm install && npm run build:demo`), and open `dist-demo/index.html`:

1. Sign in as **Casey** (Controller) and press **Run the close agents**.
2. Open the **Agent inbox**, then open *Suspicious outgoing wire…*. Note the red banner and that it never auto-posted.
3. Open *Reverse JE-US-202609-0112…*: Priya requested it, so only someone else can approve it.
4. Select all you can approve and approve them. Watch the next wave of agents start, then the cockpit's calendar fill in.
5. Open **Skills & policies → Bank reconciliation**. The plain-English policy is restated line by line, autonomy is L2, and the evaluation results are shown.
6. Open **Audit log → Verify the chain**.

**Then read five files:**

1. `src/framework/runtime/runtime.ts`: the loop, the gate hand-off, and decisions as compare-and-set transactions.
2. `src/framework/runtime/autonomy.ts`: L0–L3 and the ceilings no policy lifts.
3. `db/migrations/0002_invariants.sql`: the ledger rules, enforced by PostgreSQL.
4. `skills/bank-reconciliation/SKILL.md`: what a skill is.
5. `tests/integration/postgres.test.ts`: the schema contract, concurrency and the full close on PostgreSQL 16.

## Requirement → where it lives

| Brief | Implementation | Tests |
|---|---|---|
| §1 Research | `docs/research.md` (claim tags, sources, "what we build because of this") | — |
| Original brand, fictional data | `src/web/ui/brand.tsx`, `site/`, `docs/ads/`; scenario in `src/packs/accounting/seed/scenario.ts` (`.example` domains) | — |
| Deep modules; reusable framework plus accounting pack | `src/framework/*` (runtime, skills, ontology, store, LLM) and `src/packs/accounting/*`; boundaries enforced by `eslint.config.js` | `tests/unit/framework.test.ts` |
| 2.1 Ontology (formal, versioned, grounded, executable) | `src/packs/accounting/ontology/` (classes, relations, axioms, citations, shapes), `src/framework/ontology/model.ts`; exports in `docs/ontology/` | `tests/unit/ontology.test.ts` |
| 2.1 Used for grounding, bucketing, hover definitions, explorer | Proposal shapes and tool typing (`agents/tool-kit.ts`, `ontology/shapes.ts`), FS mapping, `src/web/ui/term.tsx`, `src/web/screens/Ontology.tsx` | e2e (`ontology` views) |
| 2.2 Postgres schema, migrations, ERD | `db/migrations/0001–0004`, `src/server/db.ts` (checksummed migrator), `docs/erd.md` (`npm run docs:erd`) | Schema contract in `tests/integration/postgres.test.ts` |
| 2.2 Balancing, immutability, invariants in the database | `db/migrations/0002_invariants.sql` | `tests/shared/invariant-suite.ts` × memory, PGlite and PostgreSQL 16 |
| 2.2 Hash-chained audit log | `ek_audit_chain` trigger, `src/framework/audit/chain.ts`, `src/packs/accounting/domain/audit.ts` | Invariant suite; full close checks the chain |
| 2.3 Connectors (CSV and bank standards), idempotent, provenance | `src/framework/connectors/{csv,xml}.ts`, `src/packs/accounting/connectors/{bank-formats,importer,records}.ts`, `services/integrations.ts` | `tests/unit/connectors.test.ts` |
| 2.4 Skills in Agent-Skills format with manifest and evals | `skills/*/SKILL.md` (front-matter manifest: ontology I/O, tools, permissions, controls, autonomy, materiality, budgets), `src/framework/skills/manifest.ts` | `npm run evals` (64 cases), `tests/unit/skills.test.ts` |
| 2.4 Skill library | 12 skills in `skills/`; tools in `src/packs/accounting/agents/tools-*.ts`; maths in `domain/{matching,accrual-math,schedule-math,flux-math,anomaly-math}.ts` | `tests/unit/{matching,close-math,policy-coding}.test.ts` |
| 2.4 Plain-English policies, versioned and audited | `src/packs/accounting/domain/policy-rules.ts`, `services/skills.ts`, `src/web/screens/Skills.tsx` | `tests/unit/policy-coding.test.ts` |
| 2.5 Durable loop, idempotency, crash resume, budgets, trace | `src/framework/runtime/runtime.ts`, `agents/runtime-store.ts`, `src/web/screens/Runs.tsx` | `tests/unit/agents.test.ts` (crash and resume, budget, denied tools) |
| 2.5 Autonomy L0–L3, maker-checker, SoD | `src/framework/runtime/autonomy.ts`, `agents/adapter.ts`, `domain/rbac.ts`, `proposal_maker_checker` constraint | `tests/unit/agents.test.ts`, MCP tests, e2e |
| 2.5 Injection hygiene | `src/framework/util/text.ts`, untrusted wrapping in `src/framework/llm/anthropic-brain.ts`, flag routing in the runtime | Agents and evals (`bank-reconciliation`) |
| 2.5 Live Claude (opus/sonnet/haiku 5.5), offline engine, mocked tests | `src/framework/llm/{anthropic-brain,models}.ts`, `src/framework/runtime/playbook.ts`, `agents/playbooks.ts` | `tests/unit/agents.test.ts` (scripted client) |
| 2.6 Screens | `src/web/screens/*` (My close, Cockpit, Inbox, Recs, Flux, Issues, Package, Journals, Reports, Runs, Skills, Ontology, Audit, Admin, Account) | `tests/e2e/demo-script.spec.ts` |
| 2.6 UX (plain language, definitions, guided first run, states, undo by reversal, shortcuts, a11y, phone, themes) | `src/web/ui/kit.tsx`, `src/web/Shell.tsx`, `src/web/styles/*`, `services/inbox.ts` (`undoProposal`) | `tests/e2e/accessibility.spec.ts` (50 views) |
| 2.6 Auth: scrypt, cookies, CSRF, rate limits, TOTP, OIDC/SAML seam, RBAC, scoping, audit | `src/server/auth/*`, `src/server/http.ts`, `src/server/rate-limit.ts`, `domain/rbac.ts`, `domain/context.ts` | `tests/unit/{auth,http}.test.ts` |
| 2.6 Demo users for each role | `src/server/seed.ts` (passwords generated at seed time), sign-in helper on loopback | e2e |
| 2.7 Scenario: US parent and UK subsidiary, 12 closed months with budget, open month with planted issues | `src/packs/accounting/seed/{scenario,generate,load}.ts` | Full close in unit, evals and integration |
| 2.7 Demo script | Playwright `tests/e2e/demo-script.spec.ts`, against the server and the static demo | `npm run e2e` |
| §3 Constraints: Node 22, PG16 as a non-root user, configurable random ports, data under `.data/`, servers stopped | `scripts/with-postgres.ts`, `playwright.config.ts`, `src/server/config.ts` (`EVENKEEL_EPHEMERAL`) | — |
| §3 Dockerfile and compose | `Dockerfile`, `compose.yaml`, `.dockerignore` | Runtime stage simulated (see above) |
| §3 CI and security scanning | `.github/workflows/ci.yml`, `.github/workflows/security.yml`, `.gitleaks.toml` | Not run on GitHub (see gaps) |
| §4 README, assessment, decisions, screenshots, static demo | `README.md`, this file, `docs/decisions.md`, `docs/screenshots/` (`npm run screenshots`), `npm run build:demo` | `tests/e2e/static-demo.spec.ts` |
| §5 MCP server with the same RBAC and audit | `src/mcp/{server,tools,main}.ts`, `scripts/mcp.mjs`, `services/api-tokens.ts`, bearer path in `src/server/http.ts` | `tests/unit/mcp.test.ts` |
| §5 Landing page with pricing; ad creatives | `site/` (`npm run build:site`), `docs/ads/` (`npm run ads`) | Build-time check for external URLs |

## Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 problems |
| `npm test` | 176 tests passed in 17 files |
| `npm run test:integration` | 28 passed on PostgreSQL 16.15: server version, 18 invariants, 5 schema-contract checks, 3 concurrency tests, 1 full close through lock |
| `npm run evals` | 64/64 across 12 skills |
| `npm run e2e` | 9 passed (server: demo script; demo: demo script, single-file and no network, worker fallback, sandboxed iframe, accessibility, no sideways scrolling at phone width, accessible names and keyboard access, bulk approval) |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `dist-demo/index.html` | about 2.6 MB (budget 15 MB); title "Evenkeel Month-End Close" |
| Screenshots | 23 PNGs (17 at 1440×900, 6 at 390×844), 5.4 MB, within the 6 MB budget |

## Independent review fixes (2026-10-19)

An independent review (accounting, engineering and product) found the defects below; all are fixed. Each has a regression test named after the defect, which fails on the code before the fix and passes after it. The gates above were re-run afterwards.

| ID | Severity | What was wrong | Fix | Regression test |
|---|---|---|---|---|
| E-1 | Critical | The prior-month balance-sheet column counted current-year earnings twice, so it did not foot. | Each column's totals are taken before the current-year-earnings line is added. Every column of every statement carries a footing check, shown under the statement. | `tests/unit/statements.test.ts` |
| EK-C1 | Critical | Live (Claude) mode trusted the amount the model declared. A proposal declaring no amount, or a smaller one, could post automatically above the cap, and verification never compared it with the lines. | The server computes the amount and materiality from the entry lines and the records a proposal references. A money-moving item whose amount cannot be computed is held and treated as material. Verification refuses a declared amount that differs from the lines. | `tests/unit/agent-controls.test.ts` |
| E-3 (accounting MAJOR 1) | Major | The CFO signed a package showing reconciliations not started, open exceptions and 1 of 15 tasks complete. Workflow status was a snapshot outside the signed hash, and approval compared numbers only. | Reconciliation, checklist and exception status are part of the signed content hash. Signing a version that no longer matches the close is refused; "Refresh" renders a new version with the same preparer of record. | `tests/unit/close-guidance.test.ts` |
| E-2 | Major | The close-package step dead-ended. The agent's draft waited for the controller, who could not approve it; the CFO could not generate a package; the CFO's home said "All set" while the lock was blocked. The README demo script did not match the real path. | Close-package drafts are approved with the package-approval permission (the CFO); the draft is attributed to whoever started the run. My close never says "All set" while the month cannot lock and names who the close waits on. It offers "Continue the close" first when approvals unblock tasks, and sends the CFO to refresh and sign. The reporting task completes only by signing. The README demo script follows the real path. | `tests/unit/close-guidance.test.ts`, `tests/e2e/demo-script.spec.ts` |
| ACC-M2 (accounting MAJOR 2) | Major | Retained earnings were translated at the closing rate, because only `ek:EquityAccount` was treated as historical. Consolidated retained earnings and the CTA were each off by $29,168.93. | `ek:RetainedEarningsAccount` translates at historical rates like other equity, leaving the CTA as the only plug. | `tests/unit/statements.test.ts` |
| EK-M1 | Major | Runs were recorded as requested by the task owner, so whoever launched a run could approve its output. | Whoever starts a run, directly or by running the close, is its requester and cannot approve what it proposes (SOD-02). The CFO can approve entries and reconciliation items, so a third approver exists. | `tests/unit/agent-controls.test.ts` |
| EK-M2 | Major | Entity scope could not be configured (grants were always tenant-wide) and guarded only some writes; reads showed every entity. | Admin sets the entities a person's roles cover. Every read path filters or refuses other entities. Consolidated views, the close package and the audit log need tenant-wide access. The writes that lacked the check (tasks, agent runs, entry rejection, flux approval, reconciling items, matches) now have it. | `tests/unit/entity-scope.test.ts` |
| EK-M3 | Major | Live mode dropped injection flags and policy-rule holds, which only the offline playbooks set. | The server computes both for every draft, whatever drafted it. | `tests/unit/agent-controls.test.ts` |
| E-4 | Minor | The inbox scrolled sideways at 390 px: the page was 640 px wide. | Scroll containers are positioned, so screen-reader text inside a table can no longer widen the page. | `tests/e2e/accessibility.spec.ts` |
| E-5 | Minor | "Select all I can approve" included an injection-flagged exception and low-confidence items. | They are left out of select-all and bulk approval, and the server refuses them in a bulk decision. Each is opened and approved on its own. | `tests/unit/agent-controls.test.ts`, `tests/e2e/inbox.spec.ts` |
| E-6 | Minor | Guidance mistakes: staff told to certify before the agents ran; counts not per person; "Complete 13 task reviews" on a button labelled "Open reconciliations"; "1 proposal wait". | Per-person counts that wait for the agent's preparation, button labels that match where they go, singular and plural, and no "work on" for tasks still blocked upstream. | `tests/unit/close-guidance.test.ts` |
| E-7 | Minor | Persona buttons had `role="listitem"`; the search button's name differed from its visible label (WCAG 2.5.3); inbox rows were not reachable with Tab. | Buttons sit inside list items; the visible label is the accessible name; each inbox row has a link. | `tests/e2e/accessibility.spec.ts` |
| EK-m1 | Minor | A manual entry could post with no approver (`0002:88`). | Migration `0004_review_fixes.sql`: a person-prepared entry posts only with an approver (mirror reversals excepted), emulated in the memory store. | `tests/shared/invariant-suite.ts` (memory, PGlite, PostgreSQL 16) |
| EK-m2 | Minor | A locked account answered 423 to the right password and 401 to a wrong one, revealing whether a guess was right. | The lock is checked before the password. | `tests/unit/http.test.ts` |
| EK-m3 | Minor | scrypt with N=2^15 and p=1 is below the OWASP minimum. | N=2^15, r=8, p=3 (an OWASP setting); weaker hashes are upgraded at the next sign-in. | `tests/unit/auth.test.ts`, `tests/unit/http.test.ts` |
| ACC-m1 | Minor | The payroll accrual was about 10% high: a half-month salary scaled by 11/10 business days. | Accrued by pay period: the share of each later pay period that falls inside the month ($620,727.20, was $682,799.93). | `tests/unit/close-math.test.ts` |
| ACC-m2 | Minor | Flux drivers dropped offsetting movements and did not add up to the variance; budget-vs-actual drivers used a trailing average instead of the budget. | Drivers keep both directions, group the rest and show any untraced remainder, so they reconcile (also a verification check). Budget-vs-actual drivers are measured against the budget. | `tests/unit/close-math.test.ts`, `tests/unit/statements.test.ts` |
| E-9 | Minor | The ads had no call to action, and ad 3 showed the $450 gift-card purchase as "Posted automatically" although the demo holds it. | Every ad ends with "Try the demo". Ad 3 shows a coding that does post, the gift cards held by the policy rule and the corrected payroll accrual; ad 2 shows the demo's own flux lines. | `tests/unit/ads.test.ts` |

## Known gaps

1. **Live Claude was not run against the real API** in this environment. The adapter, tool schemas, caching, refusal handling and cost accounting are tested with a scripted client. Model quality on these skills is unmeasured; the eval cases are ready for it.
2. **Single sign-on is a seam only.** No OIDC or SAML provider is implemented.
3. **No email.** That rules out password reset, invitations and notifications. Admins enable or disable users and change roles in the app.
4. **CI workflows and the Docker image were not executed** here: there is no GitHub runner and no Docker daemon. The workflows sit inside the product directory and must be copied to the repository root.
5. **One seeded tenant.** Tenant isolation is in the schema and services, but there is no tenant onboarding.
6. **PGlite performance.** The embedded database serialises transactions, so a full agent wave takes 13–15 s. The UI runs agents in the background and shows progress. PostgreSQL is faster and is the production target.
7. **Generated data.** Real customers would connect real exports. The connectors parse the standard formats, but no bank or ERP API integrations exist.
8. **Accessibility** is verified by automated checks and keyboard testing, not by a manual screen-reader audit.
9. **The ontology** is a pragmatic close vocabulary mapped to the standards with citations. It does not import FIBO or the XBRL taxonomies wholesale (see `docs/decisions.md`, D-10).
