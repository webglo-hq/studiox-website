# Agentic close: three independent prototypes

One brief, given unchanged to three agents, produced three complete agentic month-end close platforms. Each
one has an accounting ontology the system runs on, a PostgreSQL ledger with invariants in the database, a
library of close skills, an agent runtime with human approval and segregation of duties, a web app for
non-specialist accounting staff, and a zero-install demo. The three were then re-verified from a clean
install, reviewed side by side by three independent reviewers (accounting, engineering and security,
product and UX), and every critical and major defect the reviews found was fixed under a regression test.

Every directory is self-contained (its own `package.json`, lockfile, README and docs) and is excluded from
the studiox.fit Jekyll build (`_config.yml`).

## The three products

| | [Bookhand](bookhand/) | [Evenkeel](evenkeel/) | [tieout](tieout/) |
|---|---|---|---|
| Pitch | Agents prepare. Ontology checks verify. People approve. | The month-end close, run by AI agents under your controls. | Agents prepare. People sign off. |
| Run locally | `npm ci && npm run up` | `npm run quickstart` | `npm run setup && npm start` |
| Zero-install demo | `npm run build:demo` → `dist-demo/index.html` | `npm run build:demo` → `dist-demo/index.html` | `npm run build:demo` → `dist/demo/index.html` |
| Demo sign-in | Maya (Staff Accountant); dev-only password `bookhand-demo` | Pick Casey (Controller) on the sign-in page | Click Jordan Lee; dev-only password `close-the-books` |
| Fictional company | Brambleway Software (US + UK) | Kitewell Labs (US + UK) | Bramblewood Labs (US + UK) |
| Ontology | 226 classes, 74 relations, 31 executable axioms | 157 classes, 55 relations, 31 executable axioms | 246 classes, 75 relations, 40 executable axioms |
| Database / skills | 78 tables / 13 skills | 68 tables / 12 skills | 81 tables / 10 skills |
| TypeScript | 32.0k lines | 33.5k lines | 30.0k lines |

Each product's `README.md` has the full demo script; `docs/ASSESSMENT.md` maps every requirement to code
and lists known gaps; `docs/decisions.md` records the design decisions; `docs/research.md` covers the
market research behind it.

## Verification (re-run from a clean install after the fix round)

| Gate | Bookhand | Evenkeel | tieout |
|---|---|---|---|
| Typecheck, lint | clean | clean | clean (plus generated-code check, 81 tables) |
| Unit | 93 | 176 | 111 |
| Skill evals | 21 | 64 | 18 cases, 106 checks |
| Integration (incl. real PostgreSQL 16) | 118 (in-memory, PGlite, PostgreSQL) | 28 | 124 (21 on PostgreSQL) |
| Browser end-to-end | 3 server + 7 static demo | 9 | 32 server + 30 static demo |
| `npm audit --audit-level=high` | 0 vulnerabilities | 0 vulnerabilities | 0 vulnerabilities |

Commands: Bookhand `npm run verify`; Evenkeel `npm run check && npm run test:integration && npm run e2e`;
tieout `npm run pg:start && npm run verify && npm run e2e && npm run e2e:demo && npm run pg:stop`.

## Independent review (scored before the fixes)

| Review | Bookhand | Evenkeel | tieout |
|---|---|---|---|
| Accounting and ontology (/30) | **24** | 21 | 19 |
| Engineering and security (/30) | 18 | **20** | 19 |
| Product, UX and market (/65) | 48 | **54** | 50 |
| Overall, reviews weighted equally | 71% | **73%** | 68% |

Defects found and fixed, each with a regression test that fails on the reviewed code: Bookhand 2 critical,
6 major, 10 minor; Evenkeel 2 critical, 6 major, 10 minor; tieout 2 critical, 9 major, 10 minor. Each
product's `docs/ASSESSMENT.md` has an "Independent review fixes (2026-10-19)" table.

**Recommendation:** build on Evenkeel (clearest for a non-specialist, and the only posted ledger that resisted
every direct-SQL attack), and bring over tieout's identity layer (row-level security under a restricted
role, entity scope, OIDC with PKCE, TOTP recovery codes) and Bookhand's bank-file parsers and
three-engine conformance suite. The overall scores are within six points of each other.

## Limits

- No Anthropic API key was available, so live Claude mode is tested only with recorded and mocked
  responses; every flow runs on each product's deterministic offline engine, which the UI labels.
- CodeQL, Gitleaks and TruffleHog were not run locally, and the repository's Security Scan workflow is
  currently disabled for inactivity.
- Bank and ERP data arrive as files (CSV, BAI2, camt.053, OFX); there are no live connectors.
- All companies, people and figures are fictional.
