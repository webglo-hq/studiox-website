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
against wall-clock time, never the demo's shifted business clock.

## ADR-012 · Tenant isolation in the database (row-level security)

**Context.** Store-level tenant filters are one missed `WHERE` away from a leak.

**Decision.** Migration 0003 enables and FORCEs row-level security on every tenant table. Each
transaction sets `tieout.tenant_id`; the few identity lookups that must cross tenants set
`tieout.bypass` for their transaction only. The application must connect as an ordinary role
(superusers bypass RLS); tests prove isolation as such a role.

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
