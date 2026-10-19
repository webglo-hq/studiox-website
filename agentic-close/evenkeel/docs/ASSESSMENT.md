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
| 2.2 Postgres schema, migrations, ERD | `db/migrations/0001–0003`, `src/server/db.ts` (checksummed migrator), `docs/erd.md` (`npm run docs:erd`) | Schema contract in `tests/integration/postgres.test.ts` |
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
| `npm test` | 146 tests passed in 12 files |
| `npm run test:integration` | 27 passed on PostgreSQL 16.15: server version, 17 invariants, 5 schema-contract checks, 3 concurrency tests, 1 full close through lock |
| `npm run evals` | 64/64 across 12 skills |
| `npm run e2e` | 6 passed (server: demo script; demo: demo script, single-file and no network, worker fallback, sandboxed iframe, accessibility) |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `dist-demo/index.html` | about 2.6 MB (budget 15 MB); title "Evenkeel Month-End Close" |
| Screenshots | 23 PNGs (17 at 1440×900, 6 at 390×844), within the 6 MB budget |

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
