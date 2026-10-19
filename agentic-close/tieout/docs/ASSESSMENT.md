# Self-assessment

An honest account of what Tieout does, how it was verified, and what is missing. Every number below
comes from a run in the build environment (Node 22, PostgreSQL 16.15, Chromium via Playwright 1.56).

## Gates

| Gate | Command | Result |
|---|---|---|
| Generated code in sync with migrations | `npm run gen:check` | OK, 76 tables |
| Types | `npm run typecheck` | 0 errors |
| Lint (incl. layering and browser-safety rules) | `npm run lint` | 0 problems |
| Unit tests | `npm run test:unit` | 94 passed, 8 files |
| Integration tests (memory, PGlite, **real PostgreSQL 16**, HTTP, MCP, OIDC) | `npx tsx scripts/pgtest.ts start && npm run test:integration` | 55 passed, 6 files |
| Skill evals (golden cases, offline engine) | `npm run evals` | 18/18 cases, 105/105 checks |
| End-to-end, server (demo script, entity scope, axe WCAG 2.2 AA on every screen, light and dark) | `npm run e2e` | 15 passed |
| End-to-end, static demo (demo script from `file://`, sandboxed iframe, no network, phone) | `npm run e2e:demo` | 15 passed |
| Dependency advisories | `npm audit --audit-level=high` | 0 vulnerabilities |
| Static demo build checks | `npm run build:demo` | 1 file + favicon, 1.89 MB, relative paths, no service worker, guarded storage |

Without the throwaway PostgreSQL cluster the 13 PostgreSQL tests report as **skipped**, never as passed.

## Requirements

### P0

| Requirement | Status | Evidence |
|---|---|---|
| Research of the reference company's AI products and advertising | Done | `docs/research.md` (sources, verification labels, decisions with file pointers) |
| Versioned, executable accounting ontology that validates, grounds agents, drives bucketing, explains terms in the UI, with an explorer | Done | `src/packs/accounting/ontology` (v1.2.0: 245 classes, 75 relations, 39 executable axioms, 264 terms, 41 sources); verifier `agent/verify.ts`; coding signals `services/coding.ts`; `Term` popovers; Ontology screen; JSON-LD/Turtle in `docs/ontology/` |
| Production PostgreSQL schema, migrations, Mermaid ERD, DB-enforced invariants | Done | `migrations/0001–0003`, `docs/erd.md` (generated), triggers for AX-DE-01/03, AX-IM-01/02, AX-PD-01..03, AX-SOD-01, AX-CL-01, AX-AUD-01; row-level security; tested on PostgreSQL 16 (`tests/integration/postgres.test.ts`) |
| Integration layer: CSV and a bank standard, idempotent imports with provenance | Done | BAI2, ISO 20022 camt.053, OFX and CSV statements; card, ERP journal, AP (JSON) and payroll feeds (`src/integrations`); content-hash idempotency, per-record source line (`src/app/imports.ts`); tested in `parsers.test.ts` and `http-api.test.ts` |
| SKILL.md skills with typed manifests and CI evals; a full close library | Done | 10 skills in `skills/` (bank rec, coding, accruals, schedules, subledger tie-out, intercompany, FX, JE review, flux, close package), zod-validated manifests, 18 golden cases in CI |
| Durable agent runtime: plan→act→observe→verify→propose→HITL→post→audit, L0–L3, maker-checker/SoD, budgets, idempotency, crash resume, why+confidence, injection hygiene, orchestration | Done | `src/core/agent/*`, `tests/unit/runtime.test.ts` (crash after action 5 and resume without duplicates; budget stop; least privilege; injection routing) |
| Live Claude via `@anthropic-ai/sdk` plus a deterministic offline engine | Done, live path verified only with a scripted provider | `src/core/llm/anthropic.ts` (streaming, adaptive thinking, per-skill model); no API key was available here, so no live traffic was exercised |
| Web app: My close, close cockpit, inbox, rec workbench, flux, JE explorer, TB/FS, run trace, skill catalog and policy editor, ontology explorer, audit log, admin | Done | `src/web/pages/*`; screenshots in `docs/screenshots/` |
| Enterprise auth: password hashing, secure sessions, CSRF, rate limiting, RBAC + SoD, TOTP MFA, OIDC, tenant/entity scoping, audit of mutations | Done | scrypt (OWASP parameters; Argon2id was not used to stay dependency-free and browser-portable), HttpOnly/SameSite=Strict cookies with hashed tokens, HMAC CSRF + Origin checks, per-IP/account/user limits, 8 roles and 34 permissions, TOTP with replay protection and encrypted secrets, OIDC code flow + PKCE (`tests/integration/oidc.test.ts`), RLS, entity scope set per person in Admin and enforced on every read model and write path (`http-api.test.ts`, `e2e/entity-scope.spec.ts`), audit events on every mutation |
| WCAG 2.2 AA, responsive, light and dark | Done for automated checks | axe-core on 17 routes × 2 themes + drawers (0 serious/critical), keyboard checks, phone viewport without horizontal scroll; no manual screen-reader pass yet |
| Fictional multi-entity seed with planted issues and a demo script | Done | Bramblewood Labs (US parent, UK subsidiary, elimination entity; 13 months of history; >2,000 entries); planted issues listed in `README.md`; the demo script is the e2e suite |

### P1

| Requirement | Status | Evidence |
|---|---|---|
| README, assessment, decision records | Done | `README.md`, this file, `docs/decisions.md`, `docs/architecture.md` |
| Screenshots (1440×900 and phone, < 6 MB) | Done | 17 PNGs, 3.3 MB, regenerated by `npm run screenshots` |
| Zero-install static demo | Done | `npm run build:demo` → `dist/demo/index.html` (single file, 1.89 MB); Playwright-verified from disk, in a sandboxed iframe, offline and on a phone viewport |

### P2

| Requirement | Status | Evidence |
|---|---|---|
| MCP server | Done | `src/mcp` (11 tools over the HTTP API with read-only + agent-run tokens), `tests/integration/mcp.test.ts` |
| Landing page | Done | `site/index.html`, `npm run build:site` → `dist/site/` with the demo inside |
| 2–3 ad creatives (1080×1350) | Done | `docs/ads/` (3 creatives, `npm run ads`) |

## Bugs found and fixed by the tests

* The crash-injection hook never fired (it compared the attempt counter after increment), so resume
  was untested until `runtime.test.ts` exposed it.
* The camt.053 sample on the import screen had no balances and failed its own parser.
* Browsers silently drop `Cookie`/`Set-Cookie` on script-built requests; the static demo could not
  keep a session until the in-page cookie bridge.
* axe found an `aria-selected` without a role in the inbox and task links below the 24 px target size.
* The server trusted `X-Real-IP` from clients (rate-limit evasion); proxy headers now require
  `TRUST_PROXY=true`.
* Admin settings and materiality accepted arbitrary keys (mass assignment); both are whitelisted.
* Inviting a person hung forever on the in-memory and PGlite stores: a global email lookup ran
  inside the tenant transaction, and those stores serialise transactions. It now runs first.
* Entity scope was enforced on some screens only and could not be set: rejecting, reviewing and
  editing items, run traces, the close package and consolidated statements ignored it, and a scoped
  administrator could have invited people with access to every entity.
* The SSO callback page linked to `/`, which the static-demo build check rejects (and which breaks
  under a path prefix); it now links relative to the callback.
* The PostgreSQL pool set the session time zone with a query that raced the first query on each new
  connection; it is now a startup parameter (and asserted in the PostgreSQL tests).

## Known gaps and risks

1. **Live model quality is unmeasured.** The live loop is covered by a scripted provider; before
   production, the golden evals should also run against Claude with a budget.
2. **Container files are unverified.** `Dockerfile` and `compose.yaml` were written but not built
   (no container runtime in the build environment).
3. **Identity lifecycle is minimal.** No password-reset email, MFA recovery codes or admin MFA reset,
   SCIM, or OIDC logout; SSO was tested against an in-process provider, not a commercial IdP.
4. **Single-node limits.** Rate limits and agent runs are in-process; several nodes need a shared
   limiter and a job queue. Agents run on demand (no built-in scheduler).
5. **Connectors are file-based.** Bank and ERP data arrive as files (BAI2, camt.053, OFX, CSV, JSON);
   there are no live bank or ERP API connectors.
6. **Accounting scope.** Two legal entities plus an elimination ledger; no multi-level consolidation,
   minority interests, revenue recognition or lease skills (their ontology classes exist).
7. **Demo state is per page.** The static demo resets on reload; the demo server's in-memory store
   resets on restart (PGlite and PostgreSQL persist).
8. **Accessibility.** Automated checks pass; a manual screen-reader and switch-control review has not
   been done. English only.
