# Architecture decision records

Short records of the choices that shape Tieout: context, decision, consequences. Numbered in the
order they were made; superseded records stay, marked as such.

---

## ADR-001 · One TypeScript code base, one isomorphic HTTP app

**Context.** The product needs a server, a web app, an MCP server and a zero-install demo that must
run with no backend. Four implementations of the same rules would drift.

**Decision.** TypeScript end to end. The HTTP API is a Hono app (`src/server/app.ts`) whose
`fetch` handler runs in Node and, unchanged, inside the browser demo through an in-page fetch with a
private cookie jar (`src/demo/inpage-fetch.ts`). Use cases never import Node built-ins (ESLint rule).

**Consequences.** The demo exercises the real use cases, verifier, router and audit. Browser-only
constraints leak into the core (WebCrypto, `@noble/hashes`, no `Buffer`), which keeps it portable.

## ADR-002 · SQL migrations are the source of truth; types are generated

**Context.** An ORM would hide the constraints and triggers that carry the accounting invariants.

**Decision.** Hand-written PostgreSQL migrations (`migrations/*.sql`, one column per line with
`-- @json Type` annotations). `npm run gen` derives row/insert types and table metadata;
`npm run gen:check` fails CI when they drift. The store API takes only parameterized values;
identifiers come from generated metadata and are validated.

**Consequences.** Invariants live in the database where they cannot be bypassed. Adding a column is
a migration plus `npm run gen`.

## ADR-003 · Three store backends behind one contract

**Context.** Local development, tests, the browser demo and production need different databases.

**Decision.** `PgStore` over node-postgres (production) or PGlite (embedded, default locally), and a
`MemoryStore` that emulates the triggers (browser demo, fast unit tests). One contract suite
(`tests/support/contract.ts`) runs against all three.

**Consequences.** The emulation can drift from the SQL; the contract suite is the guard and runs on
real PostgreSQL 16 in `tests/integration/postgres.test.ts`.

## ADR-004 · Money is integer minor units; FX is explicit

**Decision.** All amounts are integers in minor units (`BIGINT`); FX rates are `NUMERIC`.
Consolidation translates the UK subsidiary at the closing rate (balance sheet) and average rate
(income statement), adds the elimination ledger and balances through the cumulative translation
adjustment (ASC 830). Monetary items are remeasured at month-end by the FX skill.

**Consequences.** No floating-point drift; rounding is explicit where rates apply.

## ADR-005 · The ontology is code, with executable axioms

**Context.** Agents need grounding; proposals need validation; people need definitions.

**Decision.** The close ontology is a TypeScript module (`src/packs/accounting/ontology`): 245
classes, 75 relations, 39 axioms (all executable), 264 terms, 41 cited sources, versioned and
hashed. The verifier checks every proposal against the axioms; the UI's underlined terms explain
themselves from it; it exports to OWL as JSON-LD and Turtle.

**Consequences.** Changing a rule is a code change with tests and a version bump; the ontology hash
is recorded on every run.

## ADR-006 · Agents propose; people or a signed policy apply

**Context.** Autonomy without accountability is unacceptable in a close.

**Decision.** No agent tool can approve, post, pay or change permissions (AX-AGT-03). Every proposal
passes the verifier, then the router decides: suggestion (L0), human approval (L1), applied by policy
with sampled review (L2, under a ceiling and confidence floor, never when flagged or material), or
applied with full post-hoc review (L3). The policy is set per skill by the Controller, capped by the
skill manifest's maximum, versioned with a reason, and audited.

**Consequences.** The fastest path still leaves a decision record (human or `policy:<skill>@v<n>`).

## ADR-007 · Deterministic offline engine alongside live Claude

**Context.** CI, demos and air-gapped evaluation need repeatable results; production benefits from
model judgment.

**Decision.** Each skill has an offline brain (async generator of plan/tool/propose actions) and a
live mode that drives the same tools through Claude tool use. Models are chosen per skill
(Opus 5.5 for judgment-heavy accruals, JE review and the package; Sonnet 5.5 for reconciliations,
intercompany and flux; Haiku 5.5 for coding, schedules and FX). Golden evals run offline in CI.

**Consequences.** Live behaviour is covered by a scripted-provider test, not by recorded model
traffic; live quality needs its own evaluation before production use.

## ADR-008 · Durable runs with deterministic replay

**Decision.** Each run step, tool call and model message is persisted as it happens. Resuming a run
replays the brain against recorded tool results; proposals and runs carry idempotency keys.

**Consequences.** Crash-safe and auditable; tool handlers must be pure reads (proposals are the only
writes).

## ADR-009 · Segregation of duties as data, enforced twice

**Decision.** SoD rules are rows (`sod_rules`) admins can tune with a documented reason: maker-checker
(SOD-01), "whoever ran the agent cannot approve its output" (SOD-02), role and permission conflicts.
Approval limits route by USD equivalent at the closing rate (AX-SOD-04). Journal-entry maker-checker
is also a database trigger.

**Revised 2026-10-19 (independent review, TO-C1).** An administrator could invite a CFO, read the
temporary password on screen, sign in as that CFO and approve entries: one person minted an approver.
Now nobody handles another person's credential and nobody grants authority alone
(`migrations/0012_access_control.sql`):

* Invitations and password resets send the person a single-use link (72 hours for an invitation,
  24 for a reset; only its SHA-256 is stored; a newer link replaces older ones) through an outbox
  whose bodies are sealed with the application key. Production queues them for the email relay. The
  demo delivers them to a demo mailbox on the sign-in page that opens a message only in a signed-out
  browser and writes every opening to the audit log, so the demo stays usable without letting the
  acting administrator use a link from their own session, or unnoticed. The administrator's screens
  and API show where a link went, never the link.
* A grant that gives someone approval authority they did not hold (approving entries, reconciliations,
  variances or payments, signing off, packaging or locking the close, setting agent autonomy or
  policy, approving access), or any change to an SoD rule, is an access request. It changes nothing
  until a second person approves it: never the requester, never the person who gains the access
  (both also CHECK constraints), and someone whose own authority covers what is granted (a
  Controller cannot approve a CFO). Narrowing access and preparer roles apply at once.

**Revised 2026-10-19 (T-10).** A checklist task is signed off by its named reviewer, or by someone
with at least the reviewer role's authority (a Controller may stand in for a Senior Accountant, never
for the CFO), and never by the task's owner, whoever completed it or whoever ran its agents. The
cockpit shows the same rule the API applies (`signOffBlockers` in `src/app/close.ts`).

## ADR-010 · Sessions and CSRF without client-readable secrets

**Decision.** Server-side sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie; only
its SHA-256 is stored. The CSRF token is an HMAC of the session token, re-derivable from the cookie on
reload and checked (by hash) on every mutation together with the Origin header. API tokens for MCP are
read-only plus `agent.run`, hashed, expiring and revocable.

## ADR-011 · TOTP MFA and OpenID Connect SSO

**Decision.** TOTP (RFC 6238) with replay protection and AES-256-GCM-encrypted secrets; a role-based
"MFA required" setting. SSO uses the OIDC authorization-code flow with PKCE, sealed state in a
short-lived Lax cookie, and ID-token validation against the provider's JWKS. Only invited, active
accounts can sign in; the provider's `amr` satisfies MFA, otherwise the account's TOTP is required.

Until two-factor is finished, a session may call only `/api/auth/me`, logout, enrol and verify, so a
password alone never yields an API token or a changed credential. Switching two-factor on issues ten
one-time recovery codes (hashed, `migrations/0004_mfa_recovery.sql`); a lost authenticator is reset by
an administrator with a documented reason, which signs the person out everywhere. TOTP is checked
against wall-clock time, never the demo's shifted business clock. An administrator reset sends the
person a single-use link (ADR-009) and retires their password, sessions and API tokens; signing in
through SSO completes an invitation and retires its link. (A temporary password from before migration
0012 must still be replaced at the next sign-in before the session can do anything else.)

## ADR-012 · Tenant isolation in the database (row-level security)

**Context.** Store-level tenant filters are one missed `WHERE` away from a leak.

**Decision.** Migration 0003 enables and FORCEs row-level security on every tenant table. Each
transaction sets `tieout.tenant_id`. The application must connect as an ordinary role (superusers
bypass RLS); tests prove isolation as such a role.

**Revised 2026-10-19 (independent review).** 0003 let the identity lookups that run before the
tenant is known (sign-in by email, session and API-token resolution) set `tieout.bypass` — and any
session can set a custom setting, so the application role could switch isolation off for itself.
Migration 0010 removes the bypass from every policy. Those lookups now read `tenant_directory`, the
one table without row-level security, which holds only a lookup key (email, session-id hash,
API-token hash; each unique across tenants) and its tenant, kept in step by triggers; the row itself
is then read inside that tenant (`Store.tenantOf`). The database also recomputes every audit hash on
insert (migration 0009) and checks both entries when a journal line moves (migration 0008).

**Entity scope (within a tenant).** Role grants can be limited to legal entities (Admin → People →
Roles). Reads hide rows of entities outside the scope and keep group-level rows (the checklist);
writes refuse them with 403. Work that covers every entity — consolidated statements, the close
package, locking the period, group-wide runs such as intercompany matching, the group-wide policy —
needs unscoped access; "Run close agents" by a scoped person runs only the per-entity skills for
their entities. Changes apply on the next request because the actor is resolved per request.

## ADR-013 · Prompt-injection hygiene for third-party text

**Decision.** Bank memos, merchant names and documents are data. Untrusted fields are scanned for
instruction-like text; flagged proposals always go to a person; echoed text is redacted
(`[withheld]`) before it reaches titles, audit summaries or later prompts; tool results reach the
model inside a non-closable `<untrusted_data>` boundary.

## ADR-014 · A zero-install demo as one self-contained page

**Decision.** The demo build inlines JS, CSS and fonts into `index.html` (relative paths, hash
routing, no service worker, storage access in try/catch). Browsers drop `Cookie`/`Set-Cookie` on
script-built requests, so in-page only the session also travels in an `x-tieout-session` header,
accepted only when the app is created with `cookieBridge: true` (never on the network server).

**Consequences.** Works from `file://`, any static host and sandboxed iframes; nothing persists
across reloads (by design).

## ADR-015 · Accessibility as a test, not a review

**Decision.** WCAG 2.2 AA tokens (contrast-checked in light and dark), status always icon + label,
focus-trapped dialogs, skip link, keyboard shortcuts, and axe-core checks of every screen in both
themes in the Playwright suite.

## ADR-016 · People can always do the agent's work, through the same controls

**Decision.** Wherever an agent drafts, a person can too, on the same path: a variance explanation
written in the flux screen becomes a `flux_explanation` proposal with the drivers as evidence, the
same AX-FLX checks and maker-checker approval (SOD-01). Drafting the close package and approving it
are separate people (SOD-02), and finalizing it completes its checklist task.

**Consequences.** One audit trail and one approval model whether the work came from an agent or a
person; the lock (AX-CL-02) cannot tell them apart and does not need to.

## ADR-017 · The browser suite runs on the production store

**Context.** Store emulation passed every test while PostgreSQL turned application errors raised
inside transactions into 500s.

**Decision.** The end-to-end suite starts the real server on embedded PostgreSQL (PGlite in memory:
same SQL, triggers and row-level security); the in-memory store remains for the static demo and fast
tests, and one contract suite runs on all three stores. The whole close, to the lock, also runs over
HTTP on PostgreSQL 16 in the integration tests.
