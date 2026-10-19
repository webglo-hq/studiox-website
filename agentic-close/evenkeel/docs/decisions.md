# Decision log

The brief was built without anyone to ask, so every judgment call is recorded here. Each entry gives the context, the decision, and what follows from it. Entries are grouped by area rather than by date. All of them were made between 18 and 19 October 2026.

## Product and scope

**D-01 · Original brand: Evenkeel, with a fictional customer, Kitewell Labs.**
- *Context:* The brief forbids Ramp's name, marks, copy and assets, and any impersonation of a real company.
- *Decision:* "Evenkeel" means steady and balanced; the idea is books that balance. It has its own mark (a keel-and-waterline glyph), palette and type.
- *Scenario:* The demo company is the fictional Kitewell Labs, with a US parent, a UK subsidiary and an elimination entity. Every e-mail address uses `.example` domains, and every vendor and customer name is invented.
- *Labelling:* The seed and the sign-in page say "fictional".

**D-02 · A close layer with a real ledger, not an ERP or a spend product.**
- *Context:* The research (see [research.md](research.md)) shows card-first tools moving into the close, and AI-native ERPs absorbing it. The control story — maker-checker, SoD, audit, materiality — is what nobody makes verifiable.
- *Decision:* Evenkeel keeps a complete multi-entity double-entry GL, so the close can be run, proven and locked. Subledger and bank data arrive through connectors.
- *Out of scope:* card issuing, payments, procurement and tax.

**D-03 · A reusable framework with accounting as the first domain pack.**
- *Layers:* `src/framework` (runtime, skills, ontology model, store port, LLM adapter) knows nothing about accounting. `src/packs/accounting` supplies the ontology, schema, tools, playbooks, services and effectors. `src/app` is the typed API used by the server, the browser demo and the MCP server.
- *Enforcement:* Lint rules enforce the boundaries (`eslint.config.js`).

## Data

**D-04 · PostgreSQL 16 is the system of record. Embedded PGlite is the zero-setup default.**
- *Context:* `npm start` must work without installing a database, but production needs real Postgres.
- *Decision:* The same hand-written migrations (`db/migrations/*.sql`) run on:
  - PGlite: Postgres 16 compiled to WebAssembly, persisted under `.data/`;
  - a real PostgreSQL server, when `DATABASE_URL` is set.
- *Testing:* The integration suite runs against a throwaway PostgreSQL 16 cluster on a random port.
- *Limitation:* PGlite serialises transactions on one connection. Decision D-21 deals with the latency this causes.

**D-05 · One store port, three adapters, and a contract test.**
- *Port and adapters:* `Db<S>` is implemented by:
  - `SqlStore`, over PGlite or `pg`;
  - `MemoryStore`, which emulates the triggers and is used by unit tests and the in-browser demo.
- *Registry:* A typed table registry gives row types, an identifier whitelist (so every value is a bound parameter) and the metadata the memory adapter enforces.
- *Contract test:* It checks the registry against the live PostgreSQL catalog: tables, columns, types, nullability, enumerations, foreign keys, unique keys, named checks and triggers. It caught 16 unnamed constraints and one unconstrained enumeration, which were fixed.

**D-06 · The database enforces the ledger's rules itself (defence in depth).**
- *Triggers and constraints enforce:*
  - balanced entries with at least two one-sided lines;
  - postable, active, same-tenant accounts;
  - entry date inside an open period;
  - maker-checker;
  - elimination entries only in the elimination entity;
  - mirror-only reversals, each original reversed at most once;
  - immutability of posted entries and of their lines;
  - the period state machine (open → soft close → hard close, with reopening only with a reason);
  - acyclic task dependencies;
  - proposal immutability and its state machine;
  - an append-only audit log, sign-offs and approvals, with TRUNCATE also blocked.
- *Error codes:* Every error carries an `EK-…` code that names the ontology axiom it enforces.
- *Shared tests:* The same invariant suite runs against the memory store, PGlite and PostgreSQL 16.

**D-07 · Money is integer minor units. Corrections are reversals.**
- *Money:* `bigint` cents throughout. FX rates are `numeric(20,10)`. Rounding happens once, at the point of conversion.
- *Undo:* Every "undo" in the UI is a reversing entry, because posted entries cannot be edited or deleted.

**D-08 · The audit log is hash-chained, with the chain head locked per tenant.**
- *Chaining:* Each event stores `prev_hash` and `hash = sha256(prev | seq | tenant | time | actor | action | subject | data)`. A trigger computes it under a `FOR UPDATE` lock on a per-tenant chain-head row, so concurrent writers serialise and the chain cannot fork.
- *Verification:* The app re-verifies the whole chain on demand (Audit screen) and at the end of every full-close test.

**D-09 · Migrations were edited in place until the first release.**
- *Context:* Nothing has shipped, and the contract test found naming drift.
- *Decision:* Migrations 0001 and 0002 were amended rather than stacked with fix-ups. `migrate()` stores a checksum per file and refuses a changed migration that is already applied. After 1.0, migrations are append-only. A local `.data/` created before the change must be deleted.

## Ontology

**D-10 · Our own `ek:` ontology, mapped to the standards, executable, versioned.**
- *Context:* The brief asks for grounding in REA, double entry, XBRL US-GAAP and XBRL GL, FIBO, COSO / SOX 404, audit assertions, ASC 606/842/340/360 and materiality.
- *Rejected:* Importing those vocabularies wholesale. It would bury the 150 or so concepts the close needs under thousands that it does not.
- *Decision:* Concepts are defined in TypeScript, each with a definition, a plain-English gloss and citations to the source standard. They are exported as OWL/RDFS/SKOS Turtle and as JSON-LD (`npm run ontology:export`).
- *Axioms:* Axioms are executable (zod shapes plus functions) and also enforced by the database where possible.
- *Version:* The model is at 1.3.0. Every agent run records the ontology version it used.

## Agents

**D-11 · A durable loop with idempotency keys and replay.**
- *Loop:* plan → act (typed tool calls) → observe → verify → propose → gate → post → audit.
- *Durability:* Steps, tool calls and proposals are persisted as they happen, each with an idempotency key. After a crash, `resumeInterrupted()` replays the brain: recorded tool calls return their stored outputs and proposals de-duplicate, so no effect repeats. This is tested with fault injection.
- *Budgets:* steps, tokens and cost, per skill manifest.

**D-12 · Two engines behind one interface: deterministic playbooks by default, live Claude when configured.**
- *Context:* The demo and the evals must be reproducible offline, and the product must also run with a real model.
- *Offline:* `PlaybookBrain` drives the same typed tools through scripted plans.
- *Live:* `AnthropicBrain` uses `@anthropic-ai/sdk` with tool use, prompt caching on the system prompt and tool definitions, refusal handling and usage and cost accounting.
- *Models:* Each skill's manifest picks a tier: `claude-haiku-5-5` (fast), `claude-sonnet-5-5` (balanced) or `claude-opus-5-5` (deep). Environment variables can override each tier.
- *Testing:* The live path is tested with a scripted client that records the requests it receives.
- *Same rules:* Both engines go through the same verification, gate and approvals.

**D-13 · Autonomy L0–L3 with hard ceilings no policy can lift.**
- *Levels:*
  - L0 suggests only;
  - L1 drafts everything for approval;
  - L2 auto-posts verified, confident items under a threshold and samples them for post-hoc review;
  - L3 auto-posts verified, confident items and reviews every one of them afterwards.
- *Ceilings:* Never auto-post at any level:
  - material items;
  - failed or warning verification;
  - policy-flagged items;
  - suspected prompt injection;
  - kinds the skill marks approval-required.
- *Visibility:* The gate's reasons are stored on each proposal and shown in plain language.

**D-14 · Agents act on behalf of the task owner, with least privilege.**
- *Permissions:* An agent's permissions are the intersection of its owner's permissions and the skill manifest's declared tools and permissions. Tools outside the manifest are denied and the denial is recorded.
- *SoD:* Neither the task owner nor the requester can approve the agent's proposals (SOD-01 and SOD-02). The requester is whoever started the run, directly or by running the close, not the owner it works for. The rule is enforced in the app and by a CHECK constraint.
- *Fixed rules:* SOD-01, SOD-02 and SOD-05 cannot be disabled by an admin.

**D-15 · External text is data, never instructions.**
- *Handling:* Bank memos, vendor names and document text are:
  - sanitised (control, zero-width and bidi characters stripped; angle brackets neutralised);
  - wrapped as `<tool_output trust="untrusted">` for the live model;
  - scanned for instruction-like content.
- *Routing:* A flagged proposal is never auto-posted.
- *Demo:* The scenario plants a bank memo that tries to instruct the agent; the evals check it is caught.

**D-16 · Each decision is one transaction behind a compare-and-set claim.**
- *Context:* The PostgreSQL concurrency test showed that two people approving the same item at once applied it twice. Entries were saved by their idempotency key; issues were not.
- *Decision:* A decision, or an auto-post, runs in one transaction whose first write is a conditional claim on the proposal. A second concurrent decision waits, then finds the item already decided. A failed apply rolls back the claim, so the item stays open.
- *Locks:* Journal guards take `FOR SHARE` locks on the period row and the parent entry, so a posting and a period lock cannot interleave. Both orders are tested with lock timeouts.

**D-17 · Evals are deterministic expectations over a full close, not model-graded.**
- *Format:* Each skill ships `evals/cases.json`. A case states what the agent must or must not propose on the planted scenario: kind, title, amount, payload subset, gate decision, confidence bounds, injection flags, statuses, or a named check.
- *Runner:* The runner drives the whole close — agents, approvals by the right people, continuation — and evaluates every case (`npm run evals`).
- *Where results appear:* Results are recorded at seed time and shown in the skill catalog.
- *Live engine:* For live-Claude runs, the same cases apply. That turns "x% accurate" into something a buyer can rerun.

**D-18 · Policies are plain English, versioned and audited.**
- *Model:* A skill's policy (autonomy, thresholds, confidence floor, sample rate and plain-English rules such as coding rules) is a new version on every change.
- *Changes:* Each change needs a note and writes an audit event. Runs record the policy version they used.

## Security

**D-19 · Authentication and sessions.**
- *Passwords:* scrypt (N=2¹⁵, r=8, p=3, 64-byte key, an OWASP setting), with parameters stored per hash; weaker hashes are upgraded at the next sign-in.
- *Sessions:*
  - random 256-bit tokens, stored only as SHA-256;
  - `HttpOnly`, `SameSite=Lax` cookies, with the `__Host-` prefix and `Secure` over HTTPS;
  - rotated every 15 minutes;
  - 30-minute idle and 12-hour absolute expiry.
- *CSRF:* The token is an HMAC of a per-session seed under the server key. It stays valid across tabs and through rotation. It is required with an Origin check on every mutation.
- *Rate limits:* Token buckets per IP and per account limit sign-in, two-step codes and expensive calls.
- *Lockout:* five failed passwords lock the account for 15 minutes.
- *TOTP:* RFC 6238 two-step sign-in with replay protection (the last accepted time step is stored). Secrets are encrypted with AES-256-GCM under the server key.
- *Headers:* A strict CSP and security headers on every response.

**D-20 · Demo passwords are generated, never committed.**
- *Default:* Each demo user gets a 16-character password from a CSPRNG, printed once and written to `.data/demo-credentials.json` (mode 0600, gitignored).
- *Options:* `DEMO_PASSWORD` sets one documented development password instead. The sign-in page lists the accounts (with their generated passwords) only for requests from the same machine, outside production; `DEMO_LOGIN_HELPER=0` turns that off.
- *Production:* both are refused when `NODE_ENV=production`.
- *Zero-install demo:* It has no passwords at all. You pick a role, because nothing leaves the browser.

**D-21 · Single sign-on is a seam, not a feature.**
- *Built:* An `IdentityProvider` interface (authorisation URL with state and PKCE; callback validation), a registry, and `app_user.idp` plus `external_subject` columns. The sign-in page lists any registered provider.
- *Not built:* No OIDC or SAML provider ships. Configuring one needs a real IdP to test against. Listed as a gap in [ASSESSMENT.md](ASSESSMENT.md).

## Runtime experience

**D-22 · Agents run in the background on the server. The UI polls activity.**
- *Context:* A full orchestration takes 13–15 s on PGlite, because transactions serialise on one connection. Blocking an HTTP request that long is poor UX and risks timeouts.
- *Decision:* "Run the close agents" starts a background orchestration. The UI polls `close.activity`, shows progress and refreshes when the run finishes.
- *Testing:* The e2e tests wait on an explicit `data-testid="agents-state"` marker.
- *Demo:* The in-browser demo runs the same code in a Web Worker.

**D-23 · A business clock pinned to the scenario.**
- *Problem:* The demo must always open at "WD+2 of the September 2026 close", whatever today's date is.
- *Scenario clock:* The default clock is anchored at 2026-10-02 16:05 UTC and moves forward from the last audit event, so time never runs backwards in the audit chain.
- *System clock:* `EVENKEEL_CLOCK=system` uses the real time.

## Web and demo

**D-24 · React 19 and Vite, hash routing, no UI framework.**
- *Routing:* Hash routing works on any static host and inside a sandboxed iframe.
- *Styling:* Design tokens in CSS custom properties give light and dark themes. Fonts (Inter, Newsreader, JetBrains Mono) are self-hosted, so the CSP stays strict and the demo works offline. Icons are Lucide.
- *Accessibility:* WCAG 2.2 AA is the target: focus management, skip link, landmarks, contrast-checked tokens, reduced motion, 44 px touch targets on phones and keyboard shortcuts with a help sheet.

**D-25 · The zero-install demo is one HTML file running the real code.**
- *Build:* `npm run build:demo` bundles the app, the services, the agents and the in-memory store into `dist-demo/index.html` (about 2.6 MB, with scripts, styles, fonts and the worker inlined).
- *Runtime:* It makes no network calls and uses hash routes. It runs the backend in a Web Worker, falling back to the page when workers are blocked, and works with storage blocked.
- *Tests:* Playwright checks all of these properties, including inside a sandboxed iframe.

## Delivery

**D-26 · Ports, data and processes are always configurable and cleaned up.**
- *Ports:* Defaults to 4610; `PORT=0` picks a free port. Tests always use random high ports.
- *Test data:*
  - the integration suite creates and drops its own databases on a cluster under `.data/pg16-<port>`, stopped and deleted afterwards;
  - e2e servers use `.data/e2e-<port>` and delete it on graceful shutdown (`EVENKEEL_EPHEMERAL`, refused in production).

**D-27 · CI workflows live inside the product directory.**
- *Context:* The brief says to change nothing outside `agentic-close/evenkeel/`, but GitHub only runs workflows from the repository root.
- *Decision:* The workflows are in `agentic-close/evenkeel/.github/workflows/`, written to run with `working-directory: agentic-close/evenkeel`. To activate them, copy them to the root `.github/workflows/`.

**D-28 · A Dockerfile and compose file, not verified by a container build here.**
- *Context:* The build machine has no Docker daemon.
- *Files:* The Dockerfile is a multi-stage Node 22 image that runs as a non-root user with a health check. The compose file adds PostgreSQL 16.
- *Verified:* What they do — migrate, seed and serve — is exercised by the integration and e2e suites. The runtime stage was also reproduced without Docker: a production-only install with `--ignore-scripts` (which is why `tsx` is a runtime dependency), `NODE_ENV=production`, first-run seed, health check and security headers.
- *Not verified:* The container build itself.

## Interfaces beyond the web app

**D-29 · The MCP server talks to the HTTP API with personal tokens, not to the database.**
- *Context:* The brief asks for an MCP server with the same RBAC and audit as the app. PGlite cannot be opened by two processes, and a second enforcement point would drift.
- *Decision:* The MCP process (stdio, JSON-RPC 2.0) calls the server's typed API with `Authorization: Bearer ekt_…`. The server runs the same method with the token owner's roles, entity scope, SoD rules and rate limits.
- *Audit:* Events name the channel: "Casey Morgan via API token "Claude Desktop"".
- *Tokens:*
  - created in the web app and shown once; only their SHA-256 is stored;
  - read-only or allowed to make changes; they expire and can be revoked;
  - failed attempts draw on a per-IP budget.
- *Limits:* Tokens can never manage tokens, users, roles, settings or skill policies; those need an interactive session with two-step sign-in.
- *Tool schemas:* Generated from the API's zod inputs, so they cannot drift from validation.

## Quality

**D-30 · Accessibility is checked by machine on every screen.**
- *Decision:* An axe-core run in the Playwright suite checks WCAG 2.2 A/AA rules on 50 views: every screen and the main detail views and dialogs, in light and dark, plus phone width.
- *Results:* The first run found three issues: small stand-alone term links, a graph marked as an image while containing links, and a scrollable matrix that could not be focused. All three were fixed.
- *Limits:* Automated checks cover only part of WCAG; there was no manual screen-reader pass (see ASSESSMENT).

**D-31 · Eval cases are tightened when a skill has fewer than three.**
- *Context:* A thin eval set proves little. Four skills had one or two cases.
- *Decision:* Every skill now has at least three; a unit test enforces the minimum. Cases assert both behaviour (amounts, kinds, gates) and absence (the orchestrator never proposes postings itself).

## Go to market

**D-32 · A static marketing site and ad creatives in the product's own brand.**
- *Site:* `npm run build:site` produces the landing page (how it works, controls, skills, pricing, FAQ) and the single-file demo as `demo.html`. It uses self-hosted fonts and makes no external requests; the build fails if the page references any.
- *Pricing:* By entity, not by seat, so that adding reviewers and auditors is free; this matches the control story. The prices are illustrative and marked as such.
- *Ads:* Three 1080×1350 creatives (`npm run ads`) lead with control rather than speed (see research §2). Their numbers come from the demo scenario.
