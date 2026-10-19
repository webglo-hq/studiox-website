# Self-assessment

What Tieout does, how it was checked, what is real and what is simulated, and what is missing.
Every number below comes from a run in the build environment (Node 22, PostgreSQL 16.15, Chromium
through Playwright 1.56); the gate figures are from the run after the independent review fixes
(2026-10-19).

## Gates

| Gate | Command | Result |
|---|---|---|
| Generated code in sync with migrations | `npm run gen:check` | OK, 81 tables |
| Types | `npm run typecheck` | 0 errors |
| Lint (incl. layering and browser-safety rules) | `npm run lint` | 0 problems |
| Unit tests | `npm run test:unit` | 111 passed, 9 files |
| Integration tests (memory, PGlite, **real PostgreSQL 16**, HTTP, full close, statements, flux coverage, accruals, close package, agent recovery, imports, identity, access control, people-first, MCP, OIDC) | `npm run pg:start && npm run test:integration` | 124 passed, 16 files |
| Skill evals (golden cases, offline engine) | `npm run evals` | 18/18 cases, 106/106 checks |
| End-to-end, server on embedded PostgreSQL: the demo script to the locked period (keyboard decisions, sign-off by named reviewers, the signed package), entity scope, two-factor, a password reset by link through the demo mailbox, a CFO invitation approved by a second person, axe WCAG 2.2 AA on every screen in light and dark | `npm run e2e` | 32 passed |
| End-to-end, static demo: the same script from `file://`, an invitation through the demo mailbox, sandboxed iframe, no network, phone on every route | `npm run e2e:demo` | 30 passed |
| Dependency advisories | `npm audit --audit-level=high` | 0 vulnerabilities |
| Static demo build checks | `npm run build:demo` | 1 file + favicon, 1.99 MB, relative paths, no service worker, guarded storage |

Without the throwaway PostgreSQL cluster the 21 PostgreSQL tests report as **skipped**, never as
passed; in the run above none was skipped.

## Independent review fixes (2026-10-19)

An independent review of accounting, engineering and product found the defects below. Each fix
has a regression test named after the defect that failed on the code as reviewed and passes now;
live-mode fixes are tested through the scripted provider seam.

| Defect | Severity | What was wrong | Fix | Regression test |
|---|---|---|---|---|
| TO-ACC-C1 | Critical | "Other income (expense), net" was negated twice, so net income was wrong in every income statement and in the signed package ($106,615.67 against a ledger figure of $100,720.55) | Each caption decides its own sign; new axiom AX-FS-01 (an income statement's net income equals the ledger's P&L for its period) is checked when statements are built, when the package is assembled and signed, and by the lock gate | `tests/integration/statements.test.ts`, `tests/integration/full-close.test.ts` |
| TO-C1 | Critical | An administrator could invite a CFO, read the temporary password, sign in as that CFO and approve the payroll accrual: one person minted an approver | No credential reaches an administrator: single-use, expiring enrolment and reset links (only a hash stored) go through an outbox; the demo mailbox opens a message only in a signed-out browser and audits every opening. New approval authority and any SoD change are access requests that a second person with sufficient authority approves; the requester and the grantee never can (also database CHECKs, migration 0012) | `tests/integration/access-control.test.ts`, `tests/support/contract.ts`, `tests/e2e/password-reset.spec.ts`, `tests/e2e/second-person.spec.ts` |
| TO-ACC-M1 / T-2 (and T-6) | Major | Explanations were keyed by account only: approved text kept counting after a later posting moved the variance and shipped in the signed package; the agent drafted a second explanation after a person had written one | Explanations store the figures they cover (migration 0007); a stale one no longer counts toward the lock, is marked out of date in the package and blocks signing it; drafts are checked against the ledger; the agent leaves a variance with a current draft alone | `tests/integration/flux-staleness.test.ts` |
| TO-ACC-M2 | Major | The year-end close was an ordinary December entry, so December's income statement (and January's prior-month column) showed the year's profit moved to retained earnings | A `closing` entry type (migration 0006), excluded from period P&L, kept in balances | `tests/integration/statements.test.ts` |
| T-1 | Major | The package headline read "Gross margin +8890.0%" (a percentage scaled as a fraction again) | A formatter for levels already in percent; the KPI documents its unit | `tests/e2e/demo-script.spec.ts` (step 16b) |
| T-3 | Major | Enter opened a proposal and the panel closed at once: keyboard users could not read evidence before approving | Enter no longer reaches the panel's Close button; the panel focuses its title and the focus trap wraps from there | `tests/e2e/demo-script.spec.ts` (step 5b) |
| TO-M1 | Major | The database let a journal line move out of a posted entry | Migration 0008 checks (and share-locks) both entries a line leaves and joins; posting share-locks the period row | `tests/support/contract.ts`, `tests/integration/postgres.test.ts` |
| TO-M2 | Major | Nothing resumed a run whose process died | The server resumes stale runs at start and every minute, claiming each atomically | `tests/integration/agent-recovery.test.ts` |
| TO-M3 | Major | A resumed live run replayed tool results by position and handed the model another call's output | Each call is keyed (migration 0011) and replay matches the key | `tests/integration/agent-recovery.test.ts` |
| TO-M4 | Major | Live coding took the amount and the never-auto flag from the model ($797.56 auto-posted as $1.00) | The amount comes from the card charge, never-auto rules are evaluated on the record, and the verifier refuses a mismatch | `tests/integration/agent-recovery.test.ts` |
| TO-M5 | Major | Bank imports corrupted data silently (missing debit/credit indicator read as credit, only the first statement read, fallback account, dropped lines, "12-34" read as 1,234.00, quadratic OFX scan) | Importers fail closed: every problem is listed with its line and nothing is half-imported; balances must roll forward; an unknown account is refused | `tests/unit/imports-fail-closed.test.ts`, `tests/integration/imports.test.ts` |
| TO-ACC-PAYROLL | Minor | The payroll accrual priced a day on 9 business days although the run paid 10 (Labor Day): $459,094 instead of $413,182 | The daily cost is the run over its weekdays, holidays included | `tests/integration/accruals-and-review.test.ts` |
| TO-ACC-SELFAPPROVED | Minor | The $62,000 Sunday bonus true-up its preparer approved himself was only flagged | The risk review also proposes reversing it pending support, decided only by someone independent of the entry | `tests/integration/accruals-and-review.test.ts` |
| T-9 | Minor | The package listed no open items although a $2,750 bank debit was unexplained, and a final package said "(draft) Not ready to lock" | Open reconciling exceptions are open items; the package reports every lock condition but its own; a package drafted with work open cannot lock the period | `tests/integration/close-package.test.ts` |
| T-7 | Minor | Counts disagreed (37 "need approval" against 39 in the inbox and at the lock; "16 waiting · All agent items decided"); a pound amount read as "$17,976.00" | One open count everywhere; the checklist reads what still waits live; match reasons, package open items and entry totals use their own currency | `tests/integration/people-first.test.ts`, `tests/e2e/demo-script.spec.ts` (steps 2b, 15) |
| T-5 | Minor | Internal terms leaked: "Needs the flux.approve permission", "below pm", skill and task keys, "amount 459094.00 exceeds your approval limit of 250000.00; it needs the cfo." | Plain language: what you cannot do and which roles can, money as money, materiality spelled out, names instead of keys | `tests/integration/people-first.test.ts`, `tests/e2e/demo-script.spec.ts` (steps 2, 5b) |
| T-10 | Minor | The Controller signed off a checklist task she owns although the CFO is its named reviewer | The named reviewer signs off, or someone with at least that role's authority; never the owner, the completer or whoever ran its agents | `tests/integration/people-first.test.ts`, `tests/e2e/demo-script.spec.ts` (step 15b) |
| T-8 | Minor | The theme button's name lacked its visible "Auto" (WCAG 2.5.3); row checkboxes were named "Select P-0106" only | Names start with the visible word; checkboxes name the item | `tests/e2e/demo-script.spec.ts` (steps 5b, 5c) |
| T-4 | Minor | No guided first run; no next step for the Staff Accountant after approvals; no starting hint on the sign-in cards | "What's next for you" for every person (or what the close waits on), a dismissible guide with where the month is, sign-in cards that say who does what | `tests/integration/people-first.test.ts`, `tests/e2e/demo-script.spec.ts` (steps 0, 1b, 12b) |
| TO-DB-AUDIT | Minor | The audit insert trigger checked the sequence and previous hash only, so an event with a made-up hash was stored | Migration 0009 recomputes the hash in the database and refuses a mismatch | `tests/support/contract.ts` |
| TO-DB-RLS | Minor | Any session could switch row-level security off with `tieout.bypass` | Migration 0010 removes the bypass; pre-tenant lookups read a minimal tenant directory | `tests/support/contract.ts`, `tests/integration/postgres.test.ts` |

## Real vs simulated

| Real (runs and is tested) | Simulated or not exercised here |
|---|---|
| Double-entry ledger, multi-entity consolidation (closing/average rates, CTA, eliminations), period states and locking | The company: **Bramblewood Labs is fictional**; 13 months of history are generated by a seeded PRNG |
| PostgreSQL 16 schema with triggers and row-level security; the whole close runs on it in the tests | Bank and ERP connectivity: data arrives as files (real BAI2, camt.053, OFX, CSV parsers; sample payloads) |
| Agent runtime: durable, idempotent, budgeted, crash-resumable, with verifier, autonomy router and orchestration | **Live Claude**: implemented with `@anthropic-ai/sdk` but no API key was available, so it is tested with a mocked SDK client and a scripted provider; the offline engine (rules, heuristics, ontology) drives every flow and is labeled in the UI |
| Auth: scrypt, sessions, CSRF, rate limits, RBAC + SoD, entity scope, TOTP + recovery codes, OIDC code flow + PKCE, enrolment and reset links, two-person access changes | The identity provider for SSO is an in-process test IdP; outgoing mail is queued in the outbox for an email relay that is not included (the demo delivers it to the demo mailbox) |
| MCP server, static demo, landing page, ad creatives | Container deployment: `Dockerfile` and `compose.yaml` were written but not built (no Docker daemon) |

## Five-minute tour

Open `dist/demo/index.html` (after `npm run build:demo`) or the running server, and follow the demo
script in the [README](../README.md#demo-script-5-minutes-for-the-tour-10-to-finish-the-close). What to
look for:

1. **My close** (Jordan Lee) says what to do next; **Run close agents** runs nine checklist tasks in
   dependency waves.
2. **Inbox**: every item has a why, a confidence, evidence and the verifier's checks; the Riverside wire
   shows the prompt-injection defence (`[withheld]`, held for a person, never bulk-approvable).
3. **Controls**: Jordan cannot approve what his agents prepared (SOD-02); the payroll accrual goes to
   the CFO (AX-SOD-04); *Admin* shows SoD rules, entity scope, two-factor, and *Access requests*: an
   invited CFO's role, or switching a control off, waits for a second person (invitation and reset
   links arrive in the *demo mailbox* on the sign-in page).
4. **Reconciliation workbench, Flux, Skills & policy**: the tie-out bridge, drivers that add up to the
   variance, a plain-English rule compiled before it is saved.
5. **Finish the close** (README steps 12–16): certify, explain, sign off, approve the package, lock
   September; then **Audit log → Verify chain**.

## How each requirement is met

### 2.1 Ontology (`src/packs/accounting/ontology`, v1.3.0)

| Requirement | Evidence |
|---|---|
| Formal, machine-readable, versioned, cited | 246 classes (`classes-*.ts`), 75 relations, 265 terms, 41 sources (`citations.ts`: REA, XBRL US-GAAP/GL, FIBO, COSO 2013, PCAOB AS 1105, ASC 606/842/340/360…); exported as OWL in JSON-LD and Turtle (`docs/ontology/`) |
| Coverage (accounts and normal balances, COA→FS lines, dimensions, period states, JE types, subledgers, recs, accruals/deferrals, flux, intercompany, FX, controls, close calendar) | the class modules and `axioms.ts`; unit tests in `ontology.test.ts` |
| (a) validates data and proposals | 40 executable axioms (`axioms.ts`) checked by the verifier (`agent/verify.ts`) and mirrored by DB triggers |
| (b) grounds agents | tool schemas and skill manifests typed by ontology classes (`agent/tools.ts`, `skills/*/SKILL.md`); prompts carry an ontology slice |
| (c) bucketing | coding signals from account classes and synonyms (`services/coding.ts`) |
| (d) explanations for non-experts | `Term` popovers (definition, why it matters, example) across the app |
| (e) explorer | Ontology screen: class tree, search, axioms with deep links, glossary, export |

### 2.2 Data model (`migrations/`, `docs/erd.md`)

81 tables in twelve migrations: multi-entity GL with balanced, immutable entries corrected by reversal;
subledgers (AP, AR, bank, card, fixed assets, prepaids, payroll); budgets and forecasts; close
periods, templates, tasks, dependencies, sign-offs with workday due dates; reconciliations, matches,
items, evidence; flux analyses, lines, explanations; agent runs, steps, tool calls, messages,
proposals, approvals with token and cost accounting; skills, versions, policies; users, roles,
permissions, sessions, MFA factors and recovery codes; a hash-chained append-only audit log. Database
triggers enforce AX-DE-01/03 (balance, two lines), AX-IM-01/02 (immutability), AX-PD-01..03 (periods),
AX-SOD-01 (maker-checker), AX-CL-01 (task dependencies), AX-AUD-01 (append-only audit); migration 0003
adds FORCE row-level security on every tenant table. Since the review: closing entries (0006),
explanation coverage (0007), line guards on both entries and a period share-lock (0008), audit hashes
recomputed by the database (0009), a tenant directory instead of an RLS bypass (0010), tool-call keys
(0011), and enrolment links, an outbox and two-person access requests (0012). Proven on PostgreSQL 16
as an ordinary role (`tests/integration/postgres.test.ts`).

### 2.3 Integration layer (`src/integrations`, `src/app/imports.ts`)

Real parsers for BAI2, ISO 20022 camt.053, OFX and CSV bank statements; typed adapters with sample
payloads for card, ERP journal, AP (JSON) and payroll. Imports are idempotent by content hash, every
record links to its source document and line, and memos are scanned for instruction-like text on the
way in (`parsers.test.ts`, `http-api.test.ts`).

### 2.4 Skills (`skills/`, `src/core/skills`)

Ten skills, each a `SKILL.md` with YAML frontmatter, instructions and resources (progressive
disclosure) plus a zod-validated manifest: ontology-typed inputs and outputs, allowed tools, permissions,
controls, autonomy default and maximum, thresholds, budgets, model, and golden evals (18 cases run in
CI). Library: transaction coding, bank reconciliation (exact, fuzzy, one-to-many, many-to-one, timing
differences), subledger tie-out, accrual detection (POs/receipts, recurring vendors, subsequent invoices,
payroll; auto-reversing), schedule roll-forward (prepaids, depreciation), flux with drivers,
intercompany matching and eliminations, JE risk review (duplicates, round amounts, weekend postings, SoD
breaks, Benford), close orchestration, close package. Policies are edited without code (thresholds,
mappings, plain-English rules compiled and shown back), versioned and audited.

### 2.5 Agent runtime (`src/core/agent`, `src/packs/accounting/agent`)

plan → act (typed tools only, no SQL) → observe → verify (deterministic checks) → propose → route by
autonomy L0–L3 → human approval or policy post → audit. Maker-checker and SoD enforced by the runtime,
the app and the database; step, token and cost budgets; idempotency keys; crash resume by
deterministic replay (`runtime.test.ts` crashes after an action and resumes without duplicates); every
proposal has a why, a confidence, evidence and checks; untrusted text is scanned, redacted and wrapped
as data; the orchestrator runs the checklist in dependency waves. Live mode: `src/core/llm/anthropic.ts`
(streaming, adaptive thinking, effort, prompt caching, per-skill model), unit-tested with a mocked
client.

### 2.6 Web app and security (`src/web`, `src/server`, `src/app`)

Screens: My close, close cockpit (workday calendar, checklist, readiness, package, lock and reopen),
inbox with bulk actions and reject-with-reason, reconciliation workbench, flux review (agent drafts or
your own text), JE explorer with drill-down to source documents, trial balance and statements, run
trace viewer, skill catalog and policy editor, ontology explorer, audit log, admin. Plain language and
inline definitions, designed empty/error/loading states, undo by reversal, keyboard shortcuts (`?`),
light and dark themes from CSS tokens, responsive to 390 px. Security: scrypt (Argon2id was not used to
stay dependency-free and browser-portable), HttpOnly SameSite=Strict sessions with rotation and expiry,
HMAC CSRF + Origin checks, rate limits, 8 roles and 35 permissions, SoD rules, approval limits, entity
scope, TOTP with recovery codes, invitations and resets by single-use link (no credential reaches an
administrator), a second person for new approval authority and SoD changes, checklist sign-off by the
named reviewer, OIDC code flow + PKCE, every mutation audited
(`http-api.test.ts`, `identity.test.ts`, `oidc.test.ts`, `e2e/*`).

### 2.7 Seed and scenario (`src/packs/accounting/seed`)

Bramblewood Labs: US parent, UK subsidiary (GBP), elimination ledger, 13 months of history with budgets,
one open month with the planted issues listed in the README (unrecorded liabilities, duplicate payment,
misclassified spend, timing differences and an unexplained bank item, intercompany mismatch, material
flux, unamortized prepaid, an SoD-breaking entry). The demo script, to the locked period, is the e2e
suite.

### P1 and P2

| Requirement | Evidence |
|---|---|
| README, assessment, decision log | `README.md`, this file, `docs/decisions.md`, `docs/architecture.md` |
| Screenshots | 20 PNGs (1440×900 light and dark, 390×844 phone), 3.94 MB, `npm run screenshots` |
| Zero-install static demo | `npm run build:demo` → `dist/demo/index.html`, Playwright-verified from disk, in a sandboxed iframe, offline, on a phone |
| MCP server | `src/mcp` (11 tools over the HTTP API, read-only + agent-run tokens), `tests/integration/mcp.test.ts` |
| Landing page | `site/index.html`, `npm run build:site` → `dist/site/` with the demo inside |
| Ad creatives (1080×1350) | `docs/ads/` (3 creatives, `npm run ads`) |

## Bugs found and fixed by the tests

* Application errors thrown inside a SQL transaction (forbidden, validation, SoD) came back as 500s on
  PostgreSQL and PGlite: the store turned every error with a `code` into a database error. Found by
  running the whole close on PostgreSQL; the browser suite now runs the server on embedded PostgreSQL.
* The flux screen said "run the flux agent or write one" but offered neither; the close cockpit promised
  a reopen path that did not exist; the `audit.verify` permission was never checked; bulk approval could
  include an item flagged for instruction-like text; agents could still be run on a locked month, and
  *My close* invited it. All fixed and covered by `full-close.test.ts` and the e2e script.
* The crash-injection hook never fired, so resume was untested until `runtime.test.ts` exposed it.
* The camt.053 sample on the import screen had no balances and failed its own parser.
* Browsers drop `Cookie`/`Set-Cookie` on script-built requests; the static demo could not keep a
  session until the in-page cookie bridge.
* axe found an `aria-selected` without a role and links below the 24 px target size.
* The server trusted `X-Real-IP` from clients; proxy headers now require `TRUST_PROXY=true`.
* Admin settings and materiality accepted arbitrary keys; both are whitelisted.
* Inviting a person hung on the in-memory and PGlite stores (a global lookup nested in the tenant
  transaction).
* Entity scope was enforced on some screens only and could not be set; a scoped administrator could
  have invited people with access to every entity.
* A session that had not finished two-factor could create an API token or change the password; failed
  two-factor attempts were audited inside a rolled-back transaction; TOTP used the demo's shifted
  business clock.
* SOD-05 read "auditor vs preparers" as "any two of these roles"; disabling a person discarded the
  reason; the SSO callback linked to an absolute `/`; the PostgreSQL pool's time-zone query raced the
  first query on new connections; admin tabs and long selects widened the page on phones.
* Adding a role permission silently changed the generated scenario (row ids are drawn from the seeded
  RNG); the evals caught it, and the seed now says so.

## Known gaps and next steps

1. **Live model quality is unmeasured.** Next: run the golden evals against Claude with a budget, and
   compare live and offline proposals.
2. **Container files are unverified.** Next: build the image and run `compose.yaml` in CI.
3. **Identity lifecycle.** Resets are administrator-initiated single-use links; there is no
   self-service "forgot password", and no SMTP sender is included (the outbox queues mail for a relay;
   the demo shows it in the demo mailbox). No SCIM provisioning or OIDC logout; SSO was tested against an
   in-process provider. Next: an email relay, SCIM, OIDC logout, a commercial IdP in staging.
4. **Single node.** Rate limits and agent runs are in-process; several nodes need a shared limiter and a
   job queue; agents run on demand (no scheduler).
5. **Connectors are file-based.** Next: bank (e.g. Plaid or host-to-host camt.053) and ERP API adapters
   behind the existing connector interface.
6. **Accounting scope.** Two legal entities plus eliminations; no multi-level consolidation, minority
   interests, revenue-recognition or lease skills (their ontology classes exist).
7. **Demo state is per page.** The static demo resets on reload; the demo server's in-memory store
   resets on restart (PGlite and PostgreSQL persist).
8. **Accessibility.** Automated checks pass on every screen; a manual screen-reader and switch-control
   review has not been done. English only.
