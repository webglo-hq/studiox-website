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
| Unit | `npm run test:unit` | **81 passed** in 10 files (framework, ontology, algorithms, parsers, schema DSL, generated-docs freshness, skill manifests) |
| Skill evals | `npm run test:evals` | **21 passed**: 20 eval cases across all 13 skills, plus the check that every skill ships evals |
| Integration (real DB) | `npm run test:integration` | **85 passed** in 6 files, on MemoryDb, PGlite and a PostgreSQL 16.15 server started by `scripts/with-postgres.mjs` (database invariants conformance, seed, full close flow on all three, API security, tenant isolation, SSO linking, access tokens and MCP over stdio) |
| E2E, server | `npm run build && npm run test:e2e` | **2 passed**: the full demo script (about 1.2 min, every state change a click) and the landing page (content, tiers, axe light and dark, phone width) |
| E2E, static demo | `npm run build:demo && npm run test:e2e:demo` | **5 passed**: one self-contained 1.68 MB file with relative paths; offline flow with zero network requests; 390 px with no horizontal scroll; sandboxed iframe with an opaque origin; and axe WCAG 2.2 A/AA checks with zero violations on all 16 screens and both review drawers, in light and dark |
| Screenshots | `npm run screenshots` | 3 specs passed; 23 PNGs (16 desktop at 1440x900, 7 phone at 390x844), 3.77 MB in total |
| Dependencies | `npm audit --audit-level=high` | **0 vulnerabilities** |
| SAST | Semgrep with the public JavaScript, TypeScript, HTML and generic-secrets rules | **0 errors**; 20 warnings, all triaged (below); 590 info-level internationalization and template-string notes; 212 files scanned |

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
| Formal versioned ontology used for validation, grounding, bucketing, hover explanations, explorer and graph | Done (v1.3.0: 223 classes, 74 relations, 29 executable axioms; Turtle and JSON-LD exports) | `src/packs/accounting/ontology/`, `docs/ontology/`, Ontology screen |
| Production Postgres schema, migrations, Mermaid ERD, invariants in the database, hash-chained audit | Done (75 tables) | `src/persistence/schema/`, `db/migrations/`, `docs/erd.md`, `tests/integration/conformance.ts` |
| CSV and bank-standard connectors, idempotent imports | Done: CSV, BAI2, camt.053, OFX; re-import is a no-op | `src/integrations/`, seed and integration tests |
| SKILL.md skills with typed manifests and eval fixtures in CI; plain-English policy tuning | Done: 13 skills, each with `evals.json` | `src/packs/accounting/skills/`, `tests/evals/`, Skills screen |
| Durable runtime: plan, act, observe, verify, propose, HITL, post, audit; typed tools, autonomy L0 to L3, SoD, budgets, idempotency, resume, traces, injection hygiene, orchestration | Done | `src/agents/framework/runtime.ts`, `decisions.ts`, `policy.ts`, `hygiene.ts`; Agent runs screen |
| LLM abstraction: live Claude (`claude-opus-5-5` default, Sonnet and Haiku), labeled offline engine, live path tested with recorded responses | Done; live path not run against the real API (no key here) | `src/agents/llm/anthropic.ts`, `framework.test.ts` |
| All screens; WCAG 2.2 AA, responsive, light and dark | Done: 16 screens; automated axe checks pass on every screen in both themes | `src/web/`, `tests/e2e/demo/demo.spec.ts` |
| Auth: scrypt, secure sessions, CSRF, rate limiting, RBAC, SoD, TOTP, OIDC/SAML seam, tenant scoping, audited mutations, demo users | Done; SSO is a tested seam without a bundled protocol verifier | `src/security/`, `src/api/kernel.ts`, `src/app/usecases/sso.ts`, `tests/integration/api.test.ts` |
| Deterministic seed; demo script | Done | `src/packs/accounting/seed/`, `tests/integration/seed.test.ts`, `README.md` |
| README, decision log, assessment | Done | `README.md`, `docs/decisions.md`, this file |
| Screenshots under 6 MB | Done: 3.77 MB | `docs/screenshots/` |
| Static demo (`npm run build:demo`) | Done: `dist-demo/index.html`, 1.68 MB | `tests/e2e/demo/demo.spec.ts` |
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

## Known gaps and risks

1. **Live Claude has not been exercised against the real API** from this environment (no key). The request
   shape, streaming, thinking, refusal and `max_tokens` handling are tested with recorded streams through the
   real SDK; quality of live agent output is unmeasured.
2. **Single-process runtime pieces.** The rate limiter and the agent run queue live in the server process.
   Runs resume from their journal after a restart, but a multi-instance deployment needs a shared limiter and
   queue (for example in PostgreSQL), which are not built.
3. **SSO** is a seam with tested account-linking rules; no OIDC or SAML verifier is bundled and the sign-in page
   has no SSO button.
4. **Tenancy.** Isolation is enforced in every use case and tested through the API with a second organization,
   but there is no self-service sign-up or tenant administration; tenants come from the seed or the CLI.
5. **Connectors are file-based** (CSV, BAI2, camt.053, OFX, ERP GL CSV). There are no live bank feeds or ERP
   write-back; Bookhand keeps its own ledger.
6. **MCP** exposes tools only, over stdio, authenticated with personal access tokens (no OAuth, no remote
   HTTP transport, no resources or prompts).
7. **Accessibility** is verified with automated axe checks (WCAG 2.2 A/AA rules) on every screen, both review
   drawers and the landing page, in light and dark. Automated checks cover only part of WCAG; there has been no
   manual keyboard-only or screen-reader pass, and not every state of every screen (empty, error, long data) is
   checked.
8. **Scale** is the seeded company (two operating entities, thirteen months); there is no load or soak test.
9. **The ontology** is validated by unit tests and executable axioms, not by an OWL reasoner.
10. **The in-browser demo** uses lighter scrypt parameters and an in-memory database that resets on reload; it
    is a demo, not a deployment mode.
11. **English only**, US and UK formatting; landing-page prices are illustrative.
12. **CodeQL, Gitleaks and TruffleHog** were not run (see above).

## Five things to look at first

1. The demo script: `npm ci && npm run up`, or open `dist-demo/index.html`. Sign in as Maya, run the close
   agents, then open the HALCYON FREIGHT proposal as Daniel.
2. Controls in the database: `db/migrations/0002_invariants.sql` and the conformance suite that runs the same
   violations against every adapter (`tests/integration/conformance.ts`).
3. The agent runtime: `src/agents/framework/runtime.ts` (journaled tool calls, budgets, resume, injection
   hygiene, append-only live history) and `decisions.ts` (limits, SoD, maker-checker).
4. Skills as documents with evals: `src/packs/accounting/skills/*/SKILL.md` and `evals.json`, run by
   `tests/evals/skills.test.ts`.
5. Assistants that act as a person: `src/mcp/server.ts`, `src/app/usecases/tokens.ts` and
   `tests/integration/mcp.test.ts`.
