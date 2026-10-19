# Research: agentic finance and the month-end close (October 2026)

Evenkeel is an original product. This note records what the market looked like when it was built, so the design choices in [decisions.md](decisions.md) can be traced to evidence. It covers Ramp's AI and agent products and advertising, then the close-software landscape, then the control frameworks that govern AI in financial reporting. It ends with what we built because of all this.

## How to read this

- **Date:** 19 October 2026.
- **Method:** web searches across vendor press releases, vendor blogs and trade press (CFO Dive, CPA Practice Advisor, Journal of Accountancy, Deloitte DART, PYMNTS, LBB, Muse by Clio and others).
- **Primary pages not read in full:** the build environment's network policy blocked direct page fetches from ramp.com and most other vendor sites. Facts about those pages come from search-result extracts and from press coverage that quotes them.
- **Tags:** every factual line carries one.
  - **[V] vendor claim:** the vendor's own statement or metric, with no independent check.
  - **[R] reported:** reported by a third party, such as trade press or an analyst firm.
  - **[U] unverified:** we found only secondary or aggregator sources, or could not open the primary source. Confirm these before reuse.
- **Numbers:** we repeat no performance number as fact. Accuracy and time-saved figures in this market are almost all self-reported.

---

## 1. Ramp: AI and agent products

Ramp sells corporate cards and spend management, and has moved steadily from "assistive AI inside spend software" to "agents that do finance work". The sequence matters, because each step widens what the software is allowed to do without a person.

| When | Product | What it does | Tags |
|---|---|---|---|
| Jul 2025 | **Agents for Controllers** | Enforce expense policy, block unauthorised spend, flag fraud. Coverage says they run on "Ramp Intelligence" with OpenAI reasoning models underneath, keep an audit trail per decision and escalate when unsure. Ramp cites 99% accuracy on expense approvals. | [R] launch coverage ([CPA Practice Advisor](https://www.cpapracticeadvisor.com/2025/07/10/ramp-introduces-ai-agents-suited-for-controllers/164684/), [PYMNTS](https://www.pymnts.com/artificial-intelligence-2/2025/ramp-debuts-ai-agents-designed-for-company-controllers/)). The 99% figure is [V]. |
| Oct 2025 | **Agents for AP** | Agentic accounts payable. Ramp says its AI made more than 26 million decisions across more than $10bn of spend that month. | [R] ([fintech.global](https://fintech.global/?p=222247)). Decision and spend volumes are [V]. |
| Feb 2026 | **Accounting Agent** ("real-time close") | Codes every transaction at posting (GL, department, class, location, custom fields) and checks policy and field accuracy on all spend, not a sample. High-confidence items are marked "Ready to Sync" and synced on schedule; uncertain ones go to "Needs Review" with context. Books month-end accruals and schedules their reversal. Reconciles activity against supported ERPs and surfaces mismatches. Launched first for Ramp Plus. | [R] ([PR Newswire](https://www.prnewswire.com/news-releases/ramp-launches-accounting-agent-to-automate-bookkeeping-with-real-time-close-302686214.html), [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/02/19/ramp-unveils-accounting-agent-to-streamline-bookkeeping/177952/), [CFOtech](https://cfotech.news/story/ramp-unveils-ai-accounting-agent-to-speed-month-end-close)). Claims of 98% accuracy on ready-to-sync items, books "3× faster", "40+ hours saved" and "70% fewer corrections" are [V]; sources disagree on some multiples. |
| Apr 2026 | Blog: "Ramp customers are running month-end with AI assistants" | The title shows Ramp positioning general AI assistants plus Ramp data as a close workflow. | [U] We could not open the post ([link](https://ramp.com/blog/ramp-customers-are-running-month-end-with-ai-assistants)). |
| Apr 2026 | **Procurement agents** | A fleet of agents that triage purchase requests, source vendors, review contract terms and run compliance checks. | [R] ([PR Newswire](https://www.prnewswire.com/news-releases/ramp-launches-fleet-of-ai-agents-across-its-procurement-platform-302756657.html), [PYMNTS](https://www.pymnts.com/news/b2b-payments/2026/ramp-launches-ai-agents-to-automate-corporate-procurement/)). |
| Jun 2026 | **Ramp Stack** (for accounting firms) | Agents run reconciliations, update schedules (depreciation, prepaids, deferred revenue roll-forwards), post journal entries and draft flux analyses, "from workbook to ledger". Firms set the rules and choose where agents run autonomously and where they pause for review. | [R] ([CFO Dive](https://www.cfodive.com/news/ramp-rolls-out-accounting-close-focused-ai-operating-system/821935/), [PR Newswire](https://www.prnewswire.com/news-releases/ramp-launches-stack-an-ai-operating-system-for-accounting-firms-302789630.html), [CFOtech](https://cfotech.news/story/ramp-launches-ai-native-stack-for-accountants-at-firms)). The following are [V]: 4,500+ firms including "92 of the top 100"; "outperformed general-purpose models on 200+ accounting tasks", a self-built benchmark; and a 50% shorter close for some clients, which is a customer quote. Free through August 2026, per [Q2 release](https://virtual.ramp.com/new-on-ramp-q2-2026/). |
| 2025–26 | **MCP server** (`ramp-public/ramp_mcp`) | Official, MIT-licensed Model Context Protocol server over Ramp's Developer API. It loads data into an ephemeral in-memory SQLite database so an assistant can query large datasets without token limits. Tools include `process_data`, `execute_query` and `clear_table`. It uses client-credential scopes and defaults to the demo environment. | [U] Described by MCP directories ([mcp.so](https://mcp.so/ja/servers/ramp-mcp), [Glama](https://glama.ai/mcp/servers/@ramp-public/ramp_mcp/inspect)); we did not open the repository. |
| Apr 2026 | Builders blog: **marketing to AI agents** | Ramp put a tracked offer addressed to AI agents on its web pages and measured which assistants passed it on to people. Coverage says Claude did consistently and ChatGPT did not. | [R] ([Ramp Builders](https://builders.ramp.com/post/marketing-to-ai-agents)). This is evidence that vendors now treat agents as an audience and as a channel, and also as an injection surface. |

The pattern across these launches:

1. **Coverage over sampling.** "Check every transaction, not a sample" is the core pitch of the Accounting Agent. Agents make 100% review cheap. The human job moves from reviewing everything to reviewing exceptions.
2. **Confidence-based routing.** Items are either ready to post or need review, with context attached. It is a two-lane gate.
3. **Configurable autonomy.** Ramp Stack lets the customer decide where agents act alone and where they stop. Autonomy is a per-workflow setting, not a product-wide constant.
4. **From spend to close.** Agents moved from approving card spend (2025) to accruals, reconciliations, schedules, journal entries and flux (2026). That is the same scope as Evenkeel's skill library.
5. **Self-reported accuracy.** Every metric is the vendor's own. Ramp's Stack benchmark is "built and graded by working accountants", but it is Ramp's benchmark.
6. **The control risk is acknowledged by commentators, not marketing.** One review of the Accounting Agent notes that auto-sync follows the controls a company configures, so a misconfigured control approves misclassified spend "at machine speed" ([beancount.io commentary](https://beancount.io/blog/2026/09/13/ramp-accounting-agent-real-time-close-auto-code-transactions-bookkeeping-guide)). [R]

Context on scale: trade press reported Ramp's valuation at $32bn in 2025 ([fintech.global](https://fintech.global/?p=222247)) and a reported round at $60bn in 2026 ([Forkast](https://forkast.news/ramps-reported-60b-round-shows-corporate-spend-software-turning-into-an-agent-platform/)). [R], unconfirmed by us.

## 2. Ramp: advertising and brand

| Campaign | What it is | Tags |
|---|---|---|
| **"Multiply What's Possible"**, Super Bowl LX (Feb 2026) | A 30-second spot. Brian Baumgartner returns as "the world's most famous accountant", buried in receipts until Ramp appears as a crowd of copies of him. Made in-house, directed by Randall Einhorn through RadicalMedia, with VFX by Framestore. It was extended with a San Francisco tailgate, a livestream and a lookalike contest. | [R] ([LBB](https://lbbonline.com/news/Ramp-Super-Bowl-LX-Brian-Baumgartner), [Muse by Clio](https://musebyclios.com/super-bowl/ramp-brian-baumgartner-are-all-about-multiplication/), [Ads of the World](https://www.adsoftheworld.com/campaigns/multiply-what-s-possible)) |
| Super Bowl debut (2025) | Ramp's first Super Bowl appearance, referenced in the 2026 coverage. | [U] We found no description of the creative. |
| "Brian's First Day as a CFO" (Oct 2025) | A stunt with the same talent. Ramp-side sources claim it reached more than 100 million people. | [R] that it happened. The reach is [V]. |
| "Love Finance" (Arts & Letters) | National TV, streaming and digital films that introduced the brand to a broader market. | [R] ([DesignRush](https://news.designrush.com/ramp-and-arts-letters-new-ad-series)) |
| "Doing Finance" (Fuzzco, 2022) | An earlier brand campaign, piloted in Miami. | [V] ([Ramp blog](https://ramp.com/blog/announcing-ramps-doing-finance-campaign)) |
| Out-of-home (XYZ; Colossal) | Station takeovers in Boston, Chicago, New York and San Francisco, with more than 60 localised executions. A hand-painted "OR becomes &" mural. | [R] agency case studies ([XYZ](https://wearexyz.com/case-studies/ramp/), [Colossal](https://www.colossalmedia.com/case-studies/ramp)) |

The creative pattern is comedy about accounting drudgery, plus a single idea of multiplication: you, many times over, which reads as agents. Speed and time saved carry the message; control is not the hero.

**What this means for Evenkeel's ads**

- Our ads must be original in name, look, talent and copy.
- No celebrity, no Ramp phrasing, no receipts-avalanche visual.
- We lead with the opposite emotional promise: calm and control. The agent does the work, and you sign what you approve.

See `docs/ads/` for the creatives.

## 3. The close-software landscape (2025–2026)

| Vendor | Category | Agent and AI capabilities | Human-control story | Tags and sources |
|---|---|---|---|---|
| **Numeric** | Close management for mid-market | Automated reconciliations, "agentic flux analysis", close task organisation, and anomaly flags on transactions. More products planned for 2026–27. | AI interprets unstructured data, deterministic code does the calculations, and people add context and judgment. That is close to Evenkeel's split. | $51M Series B led by IVP in Nov 2025 (~$89M total) [R] ([PR Newswire](https://www.prnewswire.com/news-releases/numeric-raises-51m-series-b-expanding-from-close-management-to-comprehensive-finance-platform-302619774.html)). "90%+ auto-match" is [V]. |
| **FloQast** | Close management and controls (accountant-built) | **Transform** turns a team's existing monthly workflows into agents that are tested on the customer's data, show their reasoning and need an accountant's sign-off before running. **Detect** monitors the GL continuously for anomalies per account and subsidiary. A module that operationalises COSO's GenAI governance framework has been announced but is not live. | Sign-off before agents run. A governance module is coming. They hired the COSO chair. | TakeControl, 16 Sep 2026 [V]/[R] ([press release](https://www.globenewswire.com/news-release/2026/09/16/3363412/0/en/floqast-introduces-new-ai-accounting-innovations-at-takecontrol-2026-and-names-coso-chair-lucia-wind-as-svp-of-risk-audit-advisory.html), [recap](https://www.floqast.com/blog/takecontrol-2026-recap)). "3,500+ teams" is [V]. |
| **BlackLine** | Enterprise close, reconciliations and intercompany | The **Verity** suite (Sep 2025) includes "Vera", an AI team lead that orchestrates agents. **Verity Prepare**, a multi-agent system, became generally available on 27 Jul 2026: it analyses support, matches transactions, identifies reconciling items and builds audit-ready reconciliations. BlackLine announced "Agentic Financial Operations" in Apr 2026 and acquired WiseLayer in Dec 2025. | "Governed AI". The CEO says CFOs remain personally liable, so "a black box solution is not an option". | [R] ([press release Apr 2026](https://www.blackline.com/about/press-releases/2026/blackline-unveils-agentic-financial-operations-to-close-ais-governance-and-trust-gap/), [Verity Prepare GA](https://www.blackline.com/about/press-releases/2026/blackline-advances-governed-ai-for-finance-with-general-availability-of-verity-prepare/), [Enterprise Times](https://www.enterprisetimes.co.uk/2026/07/29/blacklines-verity-prepare-brings-governed-ai-to-the-financial-close/)). "Up to 92% less preparation time" is [V]. |
| **Trintech** (Cadency, Adra, ReconNET) | Enterprise and mid-market close | **Flux** and **Variance Analysis** agents (Jun 2026). **Data Access**, **Accruals Intelligence** and **Exception Management** agents (28 Sep 2026). Moving from insight-only tools to agents that do the work. | Agents work "within the same controls, approvals and audit trails". "Governed autonomous finance". | [R] ([CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/09/29/trintech-launches-three-new-ai-agents-to-advance-governed-autonomous-finance/190762/), [Trintech](https://www.trintech.com/news/trintech-introduces-flux-and-variance-analysis-agents-giving-finance-teams-trusted-ai-coworkers-for-financial-close-and-performance-review/)). We found no independent evaluations. |
| **Rillet** | AI-native ERP (financials only) | Automated close workflows and cash reconciliation, branded "Zero-Day Close". | Close happens inside the ERP. | $100M Series C at $1B led by ICONIQ, Aug 2026 [R] ([Forbes](https://www.forbes.com/sites/digital-assets/2026/08/20/rillet-hits-1-billion-as-ai-learns-to-do-the-books/), [fintech.global](https://fintech.global/2026/08/21/ai-erp-challenger-rillet-raises-100m-at-1bn-value/)). |
| **Campfire** | AI-native ERP | **Ember Agents** (12 Mar 2026), "always-on AI workers". Ember 2.0 writes and executes code. It can see close-task status and book some entries, such as accruals. | Agents work in the background, with entries visible in the ERP. | $65M Series B (Oct 2025) [R]. Feature details are [V] ([Campfire](https://campfire.ai/blog/march-product-updates), [StreetInsider/EZ Newswire](https://www.streetinsider.com/EZ+Newswire/Campfire+Launches+Ember+Agents,+Bringing+Always-On+AI+Workers+to+Finance+and+Accounting+Teams/26151251.html)). |
| **NetSuite** (Oracle) | ERP | 2026.1: an Intelligent Close Manager (AI monitoring of close progress), an AI reconciliation assistant and ML matching. An "EPM Reconciliation Agent" for continuous in-quarter reconciliation has been reported. | Agents work inside existing roles, permissions and approval gates. | [U] Mostly partner blogs ([NetSuite article](https://www.netsuite.com/portal/resource/articles/financial-management/netsuite-2026-1-features-new-ai-close-and-cash-management-ai-agents-for-planning-and-reconciliation-and-more.shtml)). |
| **Basis** | AI agents for accounting firms | Agents for tax, audit and advisory work. | People review and approve. | $100M at $1.15B, Feb 2026 [R] ([SiliconANGLE](https://siliconangle.com/2026/02/24/ai-accounting-startup-basis-secures-100m-1-15b-valuation-firms-adopt-agent-based-workflows/)). |
| Others | Various | Pilot (autonomous bookkeeping, Feb 2026), Nominal (continuous GL monitoring, $20M), Tabs (revenue), DualEntry (ERP). | — | [U] aggregator lists ([Landbase](https://www.landbase.com/blog/fastest-growing-accounting-tech-companies-startups)). |

### Where the market agrees

1. **Agents prepare; people decide.** Every vendor, from Ramp to BlackLine, frames agents as preparers of recs, flux, accruals and coding, with sign-off by accountants. The differences are in how much is auto-posted and on what terms.
2. **"Governed" is the 2026 marketing word.** BlackLine talks of the "governance and trust gap", Trintech of "governed autonomous finance", and FloQast is building a COSO GenAI module. Buyers are asking how agents fit SOX.
3. **Deterministic maths, probabilistic reading.** Numeric says it outright, and the others imply it: the language model reads documents and drafts explanations, while code computes balances, schedules and matches.
4. **Continuous, not month-end.** Ramp's real-time close, FloQast Detect, Nominal and NetSuite's in-quarter reconciliation all push review into the month.
5. **Agent fleets with an orchestrator.** BlackLine has Vera, Ramp a procurement fleet, Campfire always-on Ember. A coordinator dispatches specialist agents.

### Where the market is weak, and our opening

1. **Unverifiable accuracy claims.** Nobody publishes eval fixtures that a customer can rerun. Ramp's benchmark is in-house.
2. **Autonomy hides in configuration.** Commentators flag misconfigured auto-approval as the main risk. Products rarely show, per item, *why* it was allowed to post.
3. **Segregation of duties for agents is undefined.** If an agent prepares work on Priya's behalf, can Priya approve it? Most marketing is silent on this.
4. **Prompt injection through financial data.** Bank memos, invoice notes and vendor emails reach models as untrusted text. OWASP ranks prompt injection first (LLM01) ([summary](https://www.ud.hk/en/insight/article/what-is-prompt-injection-2026-08-27)). The 2026 AFP survey reports 76% of organisations saw attempted or actual payments fraud in 2025 ([via beancount.io](https://beancount.io/bg/blog/2026/07/20/ai-fake-invoice-fraud-accounts-payable-guide)). [R]
5. **Mid-market multi-entity.** Card-first and AI-ERP tools are strongest for single-entity startups. Consolidation, intercompany and FX revaluation stay in enterprise suites.

## 4. Control frameworks that now apply to agents

- **COSO, *Achieving Effective Internal Control Over Generative AI*** (23 Feb 2026) [R]:
  - extends the 2013 Internal Control – Integrated Framework, mapping GenAI risks to its 17 principles;
  - groups uses into eight capability types: ingestion, transformation, posting, orchestration, judgment, monitoring, regulatory intelligence and human–AI interaction;
  - recommends a six-step roadmap: govern, inventory, assess, design, implement, monitor;
  - commentators expect external auditors to reference it.

  Sources: [Deloitte DART](https://dart.deloitte.com/USDART/home/publications/deloitte/heads-up/2026/coso-internal-controls-generative-ai), [Journal of Accountancy](https://www.journalofaccountancy.com/news/2026/feb/coso-creates-audit-ready-guidance-for-governing-generative-ai/), [RSM](https://rsmus.com/insights/services/risk-fraud-cybersecurity/coso-aligns-ai-governance-with-internal-control-guidance.html), [EisnerAmper](https://www.eisneramper.com/insights/artificial-intelligence-insights/coso-ai-governance-internal-control-framework-0526/). We did not read the COSO publication itself, so this summary is [U] against the primary text.
- **SOX 404 / ITGCs:**
  - management must evidence that controls over financial reporting operate, including access, change management, segregation of duties and review;
  - an agent that prepares or posts entries is part of that control environment, so its permissions, changes (skill and policy versions) and outputs must be evidenced like any other preparer's.
- **Assertions and materiality** (AU-C 315 / AS 2110, AU-C 320 / AS 2105):
  - existence, completeness, accuracy, cut-off, classification and presentation;
  - performance materiality and clearly-trivial thresholds;
  - these remain the vocabulary auditors use to scope work.

  Evenkeel's ontology encodes them so that each proposal says which assertion it supports and in which materiality band it falls.

## 5. What we build because of this

| Finding | What Evenkeel does | Where |
|---|---|---|
| Ramp lets firms choose where agents act alone (Stack); misconfigured auto-approval is the main risk | **Autonomy levels L0–L3 per skill**, set in a versioned, audited policy. An **autonomy gate** combines level, confidence, materiality band, verification result and injection flags. Every proposal shows the gate's reasons in plain language. Material items never auto-post at any level. | `src/framework/runtime/autonomy.ts`, `src/packs/accounting/services/skills.ts`, Skills screen |
| Two-lane "ready / needs review" routing | Each proposal carries a confidence, a "why", evidence links and a gate decision (`auto_post`, `await_approval`, `suggest_only`). L2 auto-posts are **sampled for post-hoc review**; at L3 every auto-post is reviewed after the fact. | `src/framework/runtime/runtime.ts`, Inbox screen |
| "AI reads, code computes" (Numeric) | Agents call **typed, deterministic tools** for matching, schedules, accruals, FX and flux. Proposals pass **deterministic verification** (balanced, postable accounts, open period, ties to source) before anyone sees them. The database re-checks the ledger rules with triggers. | `src/packs/accounting/domain/*`, `agents/verify.ts`, `db/migrations/0002_invariants.sql` |
| Accuracy claims nobody can rerun | **Eval fixtures ship with every skill** (64 cases across 12 skills). They run in CI and at seed time, and the latest result appears in the skill catalog. | `skills/*/evals/cases.json`, `src/packs/accounting/evals/`, `npm run evals` |
| SoD for agents is undefined in the market | An agent acts **on behalf of the task owner**. The owner and the requester can never approve its proposals (SOD-01/02, enforced in the app *and* by a database constraint). Three SoD rules cannot be disabled. | `domain/rbac.ts`, `agents/adapter.ts`, `proposal_maker_checker` constraint |
| BlackLine and Trintech sell "governed" AI; COSO's GenAI guidance | Every run records plan, tool calls, verification, gate, decisions and cost in a **trace**. Every mutation is written to a **hash-chained, append-only audit log** that the database protects. Skills and policies are versioned. | Runs screen, Audit screen, `audit_log` triggers |
| COSO capability types | **Ingestion:** connectors with idempotent imports and provenance. **Transformation:** coding. **Posting:** gated proposals. **Orchestration:** the orchestrator skill. **Judgment:** flux explanations and accruals always reach a person. **Monitoring:** JE anomaly review. **Human–AI interaction:** inbox, plain-language explanations. | `docs/ASSESSMENT.md` maps each to code |
| Prompt injection through financial data (OWASP LLM01) | External text is **sanitised and wrapped as untrusted data**. Instruction-like text sets an injection flag, and a flagged proposal **never auto-posts**. The planted scenario includes a bank memo that tries to instruct the agent. | `src/framework/util/text.ts`, `runtime.ts`, bank-rec evals |
| Accruals with automatic reversal (Ramp Accounting Agent) | The accrual skill proposes accruals with an **auto-reverse date**. The database refuses an accrual without one. Evals check it. | `skills/accrual-detection`, `journal_entry_accrual_reverses` |
| Flux drafted by agents (Numeric, Trintech) | The flux skill computes variances deterministically against prior month, prior year and budget, drafts explanations from drivers and needs approval for material lines. | `skills/flux-analysis`, Flux screen |
| Enterprise tools own multi-entity | **Multi-entity from day one:** a US parent, a UK subsidiary and an elimination entity, with intercompany matching, eliminations and FX revaluation. | scenario, `skills/intercompany-reconciliation`, `skills/fx-revaluation` |
| Ramp ships an MCP server; agents are a new audience | **An MCP server** exposes the same API methods with the **same RBAC and audit trail** as the web app. | `src/mcp/` |
| Concurrency at machine speed | Decisions are **compare-and-set claims inside one transaction**, so two approvers cannot apply an item twice. Postings lock their period row against a concurrent period lock. Both are tested on PostgreSQL 16. | `runtime.ts`, `tests/integration/postgres.test.ts` |

### What we deliberately do not build

- **No card issuing, spend management, payments or procurement.** That is Ramp's core, and not the close.
- **No general ledger replacement for an ERP.** Evenkeel keeps a full double-entry GL for the close, with imports and provenance, but positions itself as the close layer.
- **No tax or audit-firm workflow.** That is where Basis competes.
- **No unverifiable "x% accurate" marketing.** We publish the eval cases instead.
