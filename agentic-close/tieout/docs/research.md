# Research: agentic close, Ramp's AI products and ads, close-management landscape

Time-boxed desk research, 2026-10-19. Method: web search only. `ramp.com`, `instagram.com`, `facebook.com`
and most third-party hosts were unreachable from the build container (proxy 403 / DNS), so every finding
below comes from search-result summaries of the linked pages. Nothing was copied from Ramp's site, ads or
brand assets.

Legend: **[V]** = vendor claim (self-reported, not independently verified) · **[U]** = unverified /
sources disagree · **[3P]** = third-party opinion.

---

## 1. Ramp: AI and agent products (chronological)

| When | Product | What it does | Source |
|---|---|---|---|
| 2023 | **Ramp Intelligence** | Suite of AI features: vendor price intelligence, accounting copilot, AI expense management. Built on GPT-4 at launch. | [Maginative](https://www.maginative.com/article/ramp-launches-ai-suite-of-tools-to-transform-business-finance) |
| Jul 2025 | **Agents for Controllers** | First autonomous agents: enforce expense policy, block unauthorized spend, catch fraud. "Agents have complete knowledge of your accounting rules and expense policies" (CTO). Claim: 15x more policy violations caught **[V]**. | [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2025/07/10/ramp-introduces-ai-agents-suited-for-controllers/164684/), [PYMNTS](https://www.pymnts.com/artificial-intelligence-2/2025/ramp-debuts-ai-agents-designed-for-company-controllers/) |
| Oct 2025 | **Agents for AP** | Invoice coding (85% first-pass field accuracy **[V]**), approval recommendations with vendor/contract/prior-bill summaries (90k recs, 90% acceptance **[V]**), fraud screening on 60+/63 signals before bill creation **[U]**, card-acceptance discovery in vendor portals. | [Ramp blog](https://ramp.com/blog/ramp-ap-agents-announcement), [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2025/10/07/ramp-launches-accounts-payable-agents/170422/), [PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2025/ramp-adds-ai-agents-invoice-coding-approval-payment-processing/) |
| Feb 12 2026 | **Accounting Agent** | Codes transactions as they occur (GL, department, class, location), flags judgment items, auto-posts selected transactions within customer-set controls; creates month-end accruals and **schedules the reversal**; reconciles against supported ERPs. "Up to 3.5x more auto-coding than legacy tools, 90%+ accuracy" **[V]**; "98% accuracy when Ramp determines a transaction is ready to sync" (narrower population) **[V]**. | [Ramp blog](https://ramp.com/blog/accounting-agent-launch), [PR Newswire](https://www.prnewswire.com/news-releases/ramp-launches-accounting-agent-to-automate-bookkeeping-with-real-time-close-302686214.html), [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/02/19/ramp-unveils-accounting-agent-to-streamline-bookkeeping/177952/), [CFOtech](https://cfotech.news/story/ramp-unveils-ai-accounting-agent-to-speed-month-end-close) |
| Apr 16 2026 | **MCP + CLI** ("customers are running month-end with AI assistants") | MCP/CLI adoption 275 → 2,500+ businesses since January **[V]**. Controllers run close, reconcile bills, approve expenses through Claude/ChatGPT/Notion AI/terminal. Example controller runs most close + AP through Claude **but keeps payment approvals in-product "where there is a full audit trail."** Pattern: AI for speed and analysis; humans keep approvals and external communication. Actions run as the authenticated user and cannot exceed that user's role. | [Ramp blog](https://ramp.com/blog/ramp-customers-are-running-month-end-with-ai-assistants), [agents.ramp.com docs](https://agents.ramp.com/docs/guides/connecting), [ramp_mcp (GitHub)](https://github.com/ramp-public/ramp_mcp) |
| Apr 29 2026 | **Procurement agents** | Intake, sourcing, contract review, compliance checks, renewals; approval routing; 2- and 3-way invoice match. 16% vendor cost reduction, 46 h/month saved **[V]**. | [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/05/01/ramp-rolls-out-ai-agents-for-procurement/182627/) |
| Jun 3 2026 | **Ramp Stack** (accounting firms) | Agents for reconciliations (bank, card, intercompany, balance-sheet), schedule roll-forwards (prepaid, fixed asset, deferred revenue) with drafted JEs, journal entries, flux analyses, close checklist. "You decide where they run autonomously and where they pause for your review." Close checklist tasks assignable to staff **or** agents; the agent drafts a plan, completes the work and routes it to an approver. Close-management skill: plan the calendar, sequence tasks by day, track blockers, keep dependencies visible. Audit summary of all changes by user and period. 4,500+ firms; up to 9x faster schedules/recs and 60% faster closes **[V]**. Free through August **[U]**. | [Ramp blog](https://ramp.com/blog/ramp-stack-launch), [Ramp support: Stack for bookkeeping](https://support.ramp.com/stack-for-bookkeeping), [Accounting Today](https://www.accountingtoday.com/news/ramp-launches-stack-made-specifically-for-accounting-firms), [CFOtech](https://cfotech.news/story/ramp-launches-ai-native-stack-for-accountants-at-firms) |
| 2026 | **Forward-deployed engineers** ("Applied AI Solutions") | Ramp engineers embed with enterprise finance teams to build and deploy agents across AP, procurement and the close; they learn the chart of accounts, close calendar and approval policies before agents run **[3P]**. Link to Stack specifically is **[U]**. | [The New Stack](https://thenewstack.io/ramp-forward-deployed-engineers-applied-ai/) |
| Sep 2026 | **Accounts Receivable** | Listed as most recent launch **[U]**. | [Autobound (aggregator)](https://www.autobound.ai/companies/ramp/news) |

### 1.1 The control model, as documented in Ramp's admin guide

From the Accounting Agent admin guide ([support.ramp.com](https://support.ramp.com/ramp-accounting-agent-enablement-daily-use-admin-guide)):

1. **Field-level scope**: AI coding applies to all fields (default), selected fields or none.
2. **Fill blanks only, at high confidence.** The agent never overrides a value set by an employee, an admin or a rule. Precedence is **human > rule > AI**.
3. **Policy-required fields are never AI-coded.** A human must complete them before the item can move on.
4. **Suggested Actions**: each row carries a badge ("Mark ready", "Waiting for approval"). Hovering shows **why** it was suggested. *Smart Groups* (beta) batch similar items for review.
5. **Auto-mark ready** applies only to low-risk, fully completed items. **Auto-sync** just moves the Ready queue nightly. The docs stress that the control sits on the *ready* decision, not on the sync.
6. Beta labels on Suggested Actions and Auto-mark ready, so the vendor itself stages autonomy gradually.

### 1.2 Jobs to be done (Ramp and the landscape combined)

| JTBD | Who | Today | Agentic version |
|---|---|---|---|
| Code every transaction to GL + dimensions | AP clerk, staff accountant | Rules + manual cleanup | Agent codes on arrival; humans handle judgment items |
| Reconcile cash and card | Staff accountant | Excel matching, ticking | Exact/fuzzy/split matching, reconciling items drafted |
| Tie out subledgers (AP/AR) to GL | Senior accountant | Aging export vs TB | Automatic tie-out; differences explained |
| Accrue unrecorded liabilities | Senior accountant | Ask around, look at POs | Detect from POs, recurring patterns and post-period bills; auto-reverse |
| Roll forward schedules (prepaid, FA) | Staff accountant | Spreadsheets | Schedule agent drafts monthly JEs |
| Flux / variance commentary | Controller, FP&A | 6–8 h writing **[V: ChatFin]** | Driver-based drafts, human edits and approves |
| Intercompany match + eliminate | Senior / controller | Email ping-pong | Pair, flag mismatches, draft true-ups and eliminations |
| Review JEs for risk | Controller, auditor | Sampling | Full-population anomaly tests |
| Shepherd the close calendar | Controller | Checklist + chasing | DAG orchestration, blockers, nudges |
| Produce the close package | Controller, CFO | Copy-paste | TB, BS, IS and commentary generated and locked |

---

## 2. Close-management landscape (2025–2026)

| Vendor | Positioning | Agent / AI scope | Autonomy and control pattern | Sources |
|---|---|---|---|---|
| **Numeric** | AI close platform, now multi-product (close, analytics, cash). $51M Series B (Nov 2025). | Recurring close workflows, rec tooling, AI-drafted flux; cash product with 90%+ auto-match **[V]**. | "AI for pattern recognition + **deterministic programming for calculations** + human review for exceptions" **[3P]**. | [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2025/11/20/ai-accounting-platform-numeric-raises-51m-series-b/173638/), [PeerSpot](https://origin.peerspot.com/vendors/numeric) |
| **FloQast** | Close management around Excel recs. | AI Transaction Matching / AutoRec (up to 75% of matches out of the box **[V]**); agents draft recs, tie out balances, chase support **[3P]**. | Checklists, review notes, sign-offs. | [FloQast](https://floqast.com/products/floqast-ai-transaction-matching), [PYMNTS](https://pymnts.com/?p=790793), [CFO Shortlist](https://www.cfoshortlist.com/vendors/floqast) |
| **BlackLine** | Enterprise R2R. | **Verity Prepare** (GA Jul 2026), a multi-agent rec-prep system: document analysis, matching, reconciling items, packages for human sign-off. "Vera" coordinates Verity agents (accruals, variance, remittance matching). | **Each recommendation carries reasoning, a confidence score and an audit trail.** ISO/IEC 42001-aligned framework. Up to 94% less rec prep time **[V]**. | [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/07/28/blackline-introduces-multi-agent-ai-system-verity-prepare/187516/), [BlackLine blog](https://blackline.com/blog/verity-prepare-transforming-account-reconciliations/) |
| **Trintech** (Cadency/Adra) | Enterprise close. | Five agents by Sep 2026: Flux, Variance Analysis, Data Access, Accruals Intelligence, Exception Management. Beacon assistant. | "From AI that surfaces insights to AI that executes the work, **within the same controls, approvals and audit trails**." Risk-based automation with tolerances. | [Unite.ai](https://www.unite.ai/?p=475110), [Trintech](https://www.trintech.com/news/trintech-advances-financial-close-with-agentic-ai-built-for-finance/) |
| **Rillet** | AI-native ERP; $100M Series C at $1B (Aug 2026). | Agents inside a real-time GL; flux runs automatically on the live ledger. | Human approves; full audit trail; "people and agents share the same data, policies and controls." | [Rillet blog](https://www.rillet.com/blog/ai-flux-analysis-variance-investigation-that-does-the-work-for-you), [Pulse 2.0](https://pulse2.com/rillet-raises-100-million-series-c-at-1-billion-valuation-as-ai-native-erp-tops-600-customers/) |
| **Campfire** | AI-native ERP; Ember Agents (Mar 2026, beta). | AP, AR, matching/categorization, policy monitoring, accruals, flux. | **Background (continuous) vs on-demand agents**, with on-demand agents wired into the close checklist; findings go to Slack and email. 5x faster close **[V]**. | [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/03/20/campfire-introduces-ember-agents-for-accounting-teams/180023/), [Campfire blog](https://campfire.ai/blog/introducing-ember-agents) |
| **NetSuite** 2026.1/2026.2 | Incumbent ERP. | Intelligent Close Manager, Intelligent Flux Analysis, AI bank matching; anomaly and missing-transaction detection. | Embedded in ERP workflows. | [NetSuite](https://www.netsuite.com/portal/resource/articles/financial-management/netsuite-2026-2-adds-ai-capabilities-for-smarter-bank-reconciliation-close-management-labor-insights-and-more.shtml) |
| **Truewind / Basis / Double** | Firm- and CAS-focused agents. | Truewind: statements and workpapers to recs, schedules and GL-ready JEs, with the accountant keeping posting control. Basis: large CPA firms. Double criticizes Stack output landing in spreadsheets **[3P]**. | Posting control stays human. | [Truewind](https://www.truewind.ai/blog/truewind-vs-basis-which-fits-your-team), [Pulse 2.0 on Basis](https://pulse2.com/basis-100-million-raised-at-1-15-billion-valuation-for-ai-agent-platform-serving-accountants) |

**Benchmarks.** APQC median close is about 6.4 calendar days, top quartile 4.8 or less (2018 data). Ventana: 88% of
highly automated organizations close within 6 business days, against 40% with little automation (2023)
([Numeric benchmark summary](https://numeric.io/blog/how-long-does-month-end-close-take), [Ventana](https://www.ventanaresearch.com/white_paper/office_of_finance/using_automation_to_close_sooner_with_less_effort/)). Gartner (Feb 2024): 59% of controllership accountants make several errors every month **[U: secondary]**.

**Consensus pattern across vendors**

1. Agents **prepare**; humans **approve**. Posting authority is configurable, never implicit.
2. Every AI output carries **why + confidence + evidence + audit trail**.
3. **Deterministic math, AI judgment.** Matching, totals and roll-forwards are computed; language and classification are generated.
4. Autonomy is **graduated and scoped** by field, amount, risk and account, and rolled out in beta stages.
5. Agents attach to the **close checklist** with dependencies, owners and approvers.
6. External surfaces (MCP/CLI) exist, but **approvals and payments stay in the audited product**.

---

## 3. Ads and brand craft (what makes Ramp's creative land)

Direct ad libraries were unreachable. Sources: Motion's Meta ad library snapshot, trade press on the
Super Bowl LX spot and stunts, third-party design-system teardowns.

| Dimension | Observation | Source |
|---|---|---|
| **Volume / cadence** | ~168 active Meta ads, ~17 new creatives per week **[3P estimate]**. | [Motion](https://motionapp.com/library/ramp) |
| **Format mix** | Headline 15%, offer-first banner 15%, screen recording 10%; "static-to-video hybrid" (receipt stacks, bolded pain words); minimalist text overlays on a rotating product shot. | [Motion](https://motionapp.com/library/ramp) |
| **Message hierarchy** | One claim, then proof (product UI or a number), then CTA. Brand line built as **setup → payoff** in two short sentences ("Time is money. Save both."). Rebrand line: "New look. Same obsession with clarity." | [Ramp about](https://ramp.com/about-us/), [Ramp on X](https://x.com/tryramp/status/1943775553892536441) |
| **Concept** | Super Bowl LX "Multiply": Ramp as a **force multiplier** (your best accountant, multiplied). Flatiron "Brian in a box" stunt made receipt drudgery visible (85M views **[V]**). | [Muse by Clio](https://musebyclios.com/super-bowl/ramp-brian-baumgartner-are-all-about-multiplication/), [LBB](https://lbbonline.com/news/Ramp-Super-Bowl-LX-Brian-Baumgartner), [Marketing Brew](https://www.marketingbrew.com/issues/back-to-the-office) |
| **Typography** | A single confident grotesk (TWK Lausanne per teardown sites), large tight display sizes, tabular figures for numbers **[U]**. | [Fonts In Use](https://fontsinuse.com/uses/38468/ramp-identity), [Refero](https://styles.refero.design/style/b38702a0-75ab-474c-9106-00b624535825) |
| **Color** | Near-monochrome canvas (white / warm sand) with **one** saturated accent (lime; hex varies by source) **[U]**. | [Refero](https://styles.refero.design/style/b38702a0-75ab-474c-9106-00b624535825) |
| **Motion / pacing** | 0–1 s hook; product UI moving under a single line; one idea per frame **[3P]**. | [Motion](https://motionapp.com/library/ramp) |
| **Channel split** | LinkedIn: very high volume (12k+ live ads at capture), incentive offers alongside product/brand ads (AI spend visibility, ERP integrations, switching) **[3P]**. | [Digital Astronauts](https://digital-astronauts.com/ad-examples/fintech/ramp/) |

**Why it lands (synthesis)**: (1) a single, specific, verifiable claim per frame; (2) the real product UI
as the hero image, which reads as proof rather than illustration; (3) restraint, meaning one accent color,
one typeface and lots of air; (4) naming the pain in the buyer's own words (receipts, month-end, chasing);
(5) volume plus fast iteration, many small bets.

---

## 4. What we build because of this

| Finding | Product decision in **Tieout** | Where |
|---|---|---|
| Customer-set controls; "you decide where agents run autonomously" | **Autonomy ladder L0–L3** per skill and entity, set by a Controller, with materiality-tied thresholds; every change is versioned and audited | `src/domain/skills/policy.ts`, Skills → Policy editor |
| Human > rule > AI precedence; fill blanks only when confident | Bucketing engine never overwrites human or rule coding; confidence floor per policy; policy-required dimensions block auto-coding | `src/domain/bucketing/` |
| Hover-for-why badges; reasoning + confidence + audit trail (BlackLine) | Every proposal has a plain-English **why**, a **confidence** score, **evidence** links and a full **run trace** | Inbox, Run trace viewer |
| Smart Groups | Inbox groups by skill and kind, with **bulk approve** limited to high-confidence items | `web/screens/Inbox.tsx` |
| Accruals with scheduled reversal | Accrual JEs carry `auto_reverse_on`; a reversal is generated and posted on day 1 of the next period | `skills/accrual-detection` |
| Schedules roll-forward (Stack) | Prepaid and depreciation schedule skill drafts monthly JEs and catches missed amortization | `skills/schedule-rollforward` |
| Checklist tasks assignable to staff **or** agents; close shepherding | Close template DAG with WD-n/WD+n, owners, reviewers and `skill` bindings; an orchestrator runs agents in dependency order | `src/domain/close/`, Close cockpit |
| Deterministic math, AI judgment (Numeric) | Matching, tie-outs and flux math are deterministic algorithms exposed as **tools**; the LLM (live mode) only plans, classifies and explains; verification is always deterministic | `src/agent/runtime.ts`, `src/domain/*` |
| Approvals and payments stay in the audited product | Agents have **no approve or post tool**. Approval is a human (or a Controller-signed policy) action through the app, with SoD | `src/domain/controls/sod.ts` |
| MCP/CLI adoption | MCP server exposing the same tools under the same RBAC + audit (P2) | `src/mcp/` |
| Background vs on-demand agents (Campfire) | Orchestrator runs on demand ("Run close agents"); skills are idempotent so they can also run on a schedule | `src/agent/orchestrator.ts` |
| Rollout in beta stages | Autonomy defaults: L1 everywhere except depreciation (L2), with L3 restricted to clearly trivial amounts | `src/seed/policies.ts` |
| Ad craft: one claim, product-as-proof, restraint | Brand: one serif display + one grotesk; paper and ink with a single *tick-red* accent; ads lead with one claim over real product UI | `web/styles/tokens.css`, `docs/ads/` |

Original brand, no borrowed identity: name **Tieout** ("does it tie out?" is the accountant's question),
ledger-green and tick-red palette (an auditor's red tickmark on green columnar paper), Instrument Serif +
Inter. Nothing from Ramp's name, logo, copy, typeface or color is used.
