# Research: agentic close, Ramp's AI products, and the close-management landscape

Time-boxed desk research, 2026-10-19. It feeds product decisions; every decision it drives is mapped in the last section.

**Method and limits**
- Sources are web-search results, press coverage and third-party write-ups. Direct fetches of ramp.com, instagram.com and facebook.com fail from this environment (proxy 403 / DNS), and so did several trade-press hosts. Where a claim appears only in a search summary, it is cited to the page the search surfaced.
- Labels used below: **[vendor claim]** = self-reported by the company, not independently verified. **[secondary]** = third-party write-up, may be interested. **[unverified]** = could not be confirmed in any primary source. **[our analysis]** = our inference, not a sourced fact.

---

## 1. Ramp: AI and agent products

| Date | Product | What it does | Control model | Source |
|---|---|---|---|---|
| Jul 2025 | Agents for controllers (expense policy) | Learn from company policy and reviewer feedback; approve low-risk expenses or recommend approval with a rationale | Every action carries a rationale and an audit trail; "99% accuracy in expense approvals" **[vendor claim]** | [Ramp blog](https://ramp.com/blog/ramp-agents-announcement), [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2025/07/10/ramp-introduces-ai-agents-suited-for-controllers/164684/), [Ramp Intelligence](https://ramp.com/ai) |
| Feb 12, 2026 | **Accounting Agent** | Reviews and codes transactions *as they happen*; surfaces only items that need a person; decides which transactions are ready for ERP sync; reconciles with the ERP and flags missing, duplicate or mismatched transactions | Auto-posts selected transactions *within controls the customer sets*; customers can limit automated actions; no "if-this-then-that" rule setup, it learns from historical coding and adjustments. Example: a small ride-share charge posts automatically | [Ramp blog](https://ramp.com/blog/accounting-agent-launch), [CFOtech](https://cfotech.news/story/ramp-unveils-ai-accounting-agent-to-speed-month-end-close), [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/02/12/ramp-unveils-accounting-agent-to-streamline-bookkeeping/177952/) |
| | Claimed results | "Up to 3.5x more auto-coding than legacy tools", "90%+ accuracy", "40+ hours saved per month" | **[vendor claim]**; footnotes not visible in sources | same |
| (docs) | Accruals feature | Creates the accrual and the reversing entry for unsynced transactions; users edit mapped accounting fields in a review table; syncs only after a user selects "Sync accrual(s)"; moves the accounting date of later-synced transactions to the reversal date to avoid double counting; sync history exportable as CSV | Human-triggered posting | [Ramp support](https://support.ramp.com/hc/en-us/articles/45051928397459-How-to-Use-Ramp-s-Accruals-Feature) |
| Apr 16, 2026 | Blog: "Ramp customers are running month-end with AI assistants" | MCP + CLI connectors grew from 275 to 2,500+ businesses since January; controllers run close and recs through Claude, ChatGPT, Notion AI or a terminal. A logistics-tech controller spent 10+ hours tuning Claude to generate statements, run flux, do internal audits and one-click reporting, aiming to avoid logging into the ERP | Early adopters keep humans in charge of approvals and external communication: he does not approve or release payments through AI; Claude may talk to vendors but not customers | [Ramp blog](https://ramp.com/blog/ramp-customers-are-running-month-end-with-ai-assistants) |
| Jun 3, 2026 | **Ramp Stack** (accounting firms) | Agents that reconcile cash, manage prepaid schedules, post journal entries, run flux analyses and "shepherd the monthly close", with an audit trail; skills are reusable SOPs; firm data is not shared or used for training. Ramp says it works with 4,500+ firms incl. 92 of the top 100 **[vendor claim]** | Firms set the rules agents follow, decide what runs automatically and where human review is required | [Ramp blog](https://ramp.com/blog/ramp-stack-launch), [ramp.com/stack](https://ramp.com/stack), [CFOtech](https://cfotech.news/story/ramp-launches-ai-native-stack-for-accountants-at-firms) |
| | Forward-deployed engineers | FDEs embedded at firms to learn the chart of accounts, close calendar and approval policies before agents run | **[unverified]**: only in a third-party (Korean-language) write-up | [beancount.io guide](https://beancount.io/blog/2026/08/13/ramp-stack-ai-operating-system-accounting-firms-2026-guide) **[secondary]** |
| | Critique | "Ramp Stack automates month-end close but audits become the new work"; competitor Double critiques the architecture | **[secondary]** | [remio.ai](https://www.remio.ai/post/ramp-stack-automates-month-end-close-but-audits-become-the-new-work), [Double](https://doublehq.com/?p=2572) |
| Aug 31, 2026 | Procurement / AP agents | Intake, contract analysis, vendor security and compliance checks; every card txn, expense, AP invoice, PO and vendor payment on one platform; "46 hours per month", "3x faster" **[vendor claim]** | | [Ramp blog](https://ramp.com/blog/ai-agents-in-procurement) |

**Takeaways (Ramp)**
1. The unit of value is *"only the items that need a person"*. Automation is the default; the human queue is the product.
2. Control is expressed as **customer-set limits on automated actions** (what may auto-post, where review is required), not as rule authoring. Learning comes from history and corrections.
3. Every agent action ships with a **rationale + audit trail**.
4. Distribution goes where accountants already are: MCP/CLI into Claude and other assistants, and skills as **SOPs**.
5. The critique matters: when agents do the work, **review becomes the bottleneck**. Review UX (evidence, confidence, bulk actions, sampling) is the real product surface.

## 2. Ramp's ads and brand: why they land

Primary ad pages could not be loaded. What follows combines third-party trackers and style references **[secondary]** with our own analysis **[our analysis]**.

| Dimension | Evidence | Notes |
|---|---|---|
| Volume and cadence | ~168 active Meta ads, ~17 new creatives/week; mix: headline-led statics ~15%, offer-first banners ~15%, screen recordings ~10% ([Motion](https://motionapp.com/library/ramp)); another tracker: 50 active, carousel 56% / video 44%, average run 25 days ([Opus](https://www.opus.pro/agent/ads-library/ramp-ads)) | Trackers disagree; treat as rough. High iteration rate means creative is a testing system, not a campaign. |
| Message hierarchy | Headline pattern "Time is money. Save both." on ramp.com/savings ([Ramp](https://ramp.com/savings)) | Two-beat line: tension, then resolution. One idea per frame. |
| Typography | Lausanne (proprietary grotesque), regular weight throughout; designer describes "loud and quiet moments" in the system ([Refero](https://styles.refero.design/style/b38702a0-75ab-474c-9106-00b624535825), designer write-up via [LinkedIn](https://pt.linkedin.com/in/henriquemeyrelles)) | Confidence comes from *size and space*, not weight. |
| Color | Near-black and white with a solar yellow used sparingly for highlights and CTAs; exact hex varies by source ([shadcn.io](https://www.shadcn.io/design/ramp/raw), [webdesignhot](https://www.webdesignhot.com/design.md/ramp/)) | One accent color does all the pointing. |
| Product as hero | Screen recordings are a top format | The UI itself, cropped tight, is the proof. |
| Paid creative role | Hiring for designers to "push the creative bar on what a finance brand can look and feel like" ([job post](https://jobs.generalcatalyst.com/companies/ramp-2/jobs/81694633-growth-creative-designer-paid-advertising-contract)) | |

**Why they land [our analysis]**
- **One claim, one number, one proof.** A short declarative headline, a quantified outcome, then a UI crop as evidence.
- **Typographic confidence through restraint.** Large regular-weight type, generous whitespace, almost no decoration. Calm reads as competent in finance.
- **A single accent color** carries attention: highlight the number or the verb, nothing else.
- **Motion = product doing work.** Short loops where a queue empties, a number ties out, a status flips to done. Pacing: hold the headline ~1.5 s, show the action ~2-3 s, land on the outcome.
- **Wit without jokes.** Finance pain named precisely (receipts, close nights) beats generic humor.

**How we borrow the craft, not the identity.** Bookhand uses its own name, mark, typefaces (Inter Variable + Instrument Serif, both OFL) and palette (ink, paper and a "tick green" accent). No Ramp names, marks, copy or assets appear in the product, ads or docs (outside this research file).

## 3. Close-management landscape (2026)

| Vendor | Positioning | Agentic capabilities | Autonomy / control | Source |
|---|---|---|---|---|
| **Numeric** | AI-first close management on a live GL | Flux explanations drafted from transaction detail, materiality thresholds to decide what needs explanation, rec prep, MCP connector (mid-June 2026) used from Claude | Human-reviewed / "semi-autonomous" per third parties | [numeric.io](https://www.numeric.io), [Flux](https://numeric.io/product/analyze), [MCP usage report](https://www.numeric.io/blog/numeric-mcp-usage-report) |
| **FloQast** | Close management leader for mid-market; $200M ARR, EY alliance (Jan 2026) **[vendor claim]** | AI Agents for prep: transform upstream data, prepare accruals, three-way match; no-code agents built and tested against your controls; "98% of 50,000+ transactions matched" testimonial | "Deterministic by design", ISO/IEC 42001 platform **[vendor claim]** | [FloQast agents](https://www.floqast.com/au/lp/ai-agents), [IT Brief](https://itbrief.co.nz/story/floqast-surpasses-200m-arr-seals-ey-ai-alliance) |
| **BlackLine** | Enterprise R2R | **Verity Prepare** (GA Jul 2026): multi-agent rec prep: reads support, flags anomalies, drafts variance explanations, assembles rec packages; Verity Collect, Accruals pipeline; white paper envisions JE and intercompany agents | Each recommendation has **reasoning, a confidence score and an audit trail**; humans keep final approval; "up to 92% less manual prep" **[vendor claim]** | [press release](https://investors.blackline.com/news-releases/news-release-details/blackline-advances-governed-ai-finance-general-availability), [IT Brief UK](https://itbrief.co.uk/story/blackline-launches-verity-prepare-for-finance-teams), [white paper](https://www.blackline.com/resources/r2r-whitepaper-ai-record-to-report/) |
| **Trintech (Cadency)** | Enterprise R2R + SOX GRC | Flux Agent, Variance Analysis Agent (Jun 2026); Data Access, Accruals Intelligence, Exception Management agents (Sep 28, 2026); JE prep with risk scoring, AI match-rule generation, rec narratives, daily close briefings | Third-party rates AI readiness 2/5 **[secondary]** | [Unite.AI](https://www.unite.ai/?p=475110), [ERP Research](https://erpresearch.com/erp-add-ons/reconciliation/trintech-cadency), [Audit Friendly](https://auditfriendly.co/software/trintech) |
| **Rillet** | AI-native ERP; $100M Series C at $1B (Aug 19, 2026), 600+ customers **[vendor claim]** | Agents *inside* the GL: invoice matching, ASC 606 rev rec from contracts, multi-entity consolidation, continuous close | Audit trails, human approval "where appropriate" | [The Next Web](https://thenextweb.com/news/rillet-100m-series-c-1bn-accounting-ai), [Forkast](https://forkast.news/rillet-raised-100m-to-put-ai-agents-inside-the-general-ledger-not-around-it/) |
| **Campfire** | AI-native GL for high-growth companies (founded 2023) | "Accounting Intelligence" / Ember assistant | | [Rillet vs Campfire](https://info.rillet.com/rillet-vs-campfire) **[secondary, competitor-authored]** |
| HighRadius, ChatFin, LiveFlow | "Autonomous close" marketing; LiveFlow agents sit on synced Ramp data and queue unusual vendors, missing receipts, coding that needs a human | Claims of full autonomy **[vendor claim]** | [ChatFin](https://chatfin.ai/blog/new-ai-agents-for-cfos/best-ai-agents-for-month-end-close-2026/), [LiveFlow](https://liveflow.com/blog/agentic-close-after-ramp-spend) |

**Benchmarks.** APQC (2018, ~2,300 orgs): top quartile closes in ≤ 4.8 calendar days, median 6.4, bottom quartile ≥ 10. Ventana (2022): 59% close within six business days. 2025 small-sample surveys spread from 1-3 to 7+ business days ([Numeric benchmarks](https://www.numeric.io/blog/how-long-does-month-end-close-take), [Eagle Rock](https://www.eaglerockcfo.com/blog/research/month-end-close-time-benchmarks-2026)). Definitions differ (calendar vs business days). We target **WD5** (five business days) for the demo company.

**Controls context.** COSO's Feb 2026 publication on internal control over generative AI calls for logs of prompts, inputs, outputs, model versions and evidence of human review; "set-and-forget" assurance is called inadequate for probabilistic models **[secondary summary]**. Practitioners frame the open question as whether control design, human oversight and documentation hold up under PCAOB AS 2201 / AS 2401 review ([Kognitos](https://www.kognitos.com/blog/sox-auditor-questions-ai-automation/), [Finrep](https://www.finrep.ai/blog/ai-journal-entry-testing-and-sox-404-controls-a-2026-practitioner-walkthrough)) **[secondary]**.

## 4. Jobs to be done (synthesized)

| # | Job (when..., I want to..., so that...) | Who |
|---|---|---|
| J1 | When transactions land, code them to the right account and dimensions without me, and only ask about the ambiguous ones | Staff accountant, AP clerk |
| J2 | When the bank statement arrives, match it to the books, explain timing differences and show me the one item nobody can explain | Staff accountant |
| J3 | Before close, find liabilities we owe but haven't recorded (POs received, recurring vendors, late invoices) and draft auto-reversing accruals | Senior accountant |
| J4 | Keep prepaid and fixed-asset schedules current and tell me when an amortization or depreciation run was missed | Staff accountant |
| J5 | Show which accounts moved materially and draft the "why" from the underlying activity, so I edit instead of write | FP&A analyst, controller |
| J6 | Tie subledgers (AP, AR) to the GL and intercompany balances to each other, and propose the true-up and eliminations | Senior accountant |
| J7 | Scan journal entries for duplicates, round amounts, weekend postings, SoD breaks and odd digit patterns before the auditors do | Controller, auditor |
| J8 | Tell me, every morning, exactly what to do next in the close and what is blocking WD5 | Everyone |
| J9 | Produce the close package (TB, statements, commentary, rec status) and lock the period with evidence | Controller, CFO |
| J10 | Let me set how much the agents may do on their own, per task, in plain language, with every change versioned | Controller |
| J11 | Prove to an auditor who did what, when, why, with which evidence and which model | Auditor |

## 5. Control model and UX patterns observed

- **Graduated autonomy, customer-set.** Ramp: auto-post within customer controls. Ramp Stack: firms choose what runs automatically and where review is required. BlackLine: humans keep final approval. → *Autonomy is a per-skill, per-tenant policy with amount and confidence thresholds.*
- **Rationale + confidence + audit trail on every recommendation** (Ramp, BlackLine). → *Proposal = payload + why + confidence + evidence + verification results.*
- **Exception-first queues.** "Only what needs a person" (Ramp), "review instead of grind" (FloQast review). → *Inbox sorted by risk and materiality; bulk-approve what passed every check.*
- **Thresholds decide what needs explanation** (Numeric flux). → *Materiality and flux thresholds are first-class ontology concepts and policy knobs.*
- **Skills as SOPs** (Ramp Stack) and **no-code agents tested against controls** (FloQast). → *SKILL.md packages with typed manifests, golden-case evals and plain-English policy rules.*
- **Assistants as a surface** (Ramp MCP/CLI, Numeric MCP). → *Domain tools exposed via MCP with the same RBAC and audit.*
- **Humans keep payments and external communication** (Ramp customers). → *Agents never move money or email counterparties; no such tools exist.*

## 6. Academic and standards grounding (used by the ontology)

| Source | Used for |
|---|---|
| McCarthy, W. E. (1982). "The REA Accounting Model: A Generalized Framework for Accounting Systems in a Shared Data Environment." *The Accounting Review* 57(3): 554-578 | Resources-Events-Agents backbone; economic events vs. bookkeeping artifacts |
| Geerts, G. L. & McCarthy, W. E. (2002). "An ontological analysis of the economic primitives of the extended-REA enterprise information architecture." *IJAIS* 3(1): 1-16 | Commitments, duality, stock-flow |
| Pacioli, L. (1494). *Summa de arithmetica*, "Particularis de computis et scripturis"; Ellerman, D. (1985/2014) on the algebra of double-entry; Ijiri, Y. (1975). *Theory of Accounting Measurement* | Double-entry axioms (duality, balance), T-account algebra |
| XBRL International: Global Ledger Taxonomy Framework (XBRL GL); FASB US GAAP Financial Reporting Taxonomy | Journal entry/line structure (`gl-cor`), statement line-item mapping |
| EDM Council: FIBO (Financial Industry Business Ontology) | Currency, legal entity, monetary amount, agreement concepts |
| COSO (2013). *Internal Control - Integrated Framework*; SOX §404; PCAOB AS 2201 | Control activities, preparer/reviewer, SoD, evidence, ICFR |
| PCAOB AS 1105 / AICPA AU-C 315 / ISA 315 (Revised 2019) | Audit assertions (existence/occurrence, completeness, accuracy/valuation, cutoff, classification, rights & obligations, presentation) |
| PCAOB AS 2105; SEC SAB 99; ISA 320 | Materiality: overall, performance, clearly trivial |
| ASC 606, 340-40, 842, 360, 830, 810 | Revenue/deferred revenue, prepaids and contract costs, leases, PP&E and depreciation, FX remeasurement and translation, consolidation and eliminations |
| Nigrini, M. (2012). *Benford's Law: Applications for Forensic Accounting, Auditing, and Fraud Detection* | First-digit tests in JE review (MAD conformity thresholds) |
| Anthropic Agent Skills (SKILL.md, progressive disclosure) | Skill packaging format |

## 7. What we build because of this

| Finding | Product decision in Bookhand | Where |
|---|---|---|
| Ramp: "surface only what needs a person"; review becomes the bottleneck | **Agent inbox** sorted by risk x amount; each card shows why, confidence, evidence and checks; one-click approve, reject-with-reason, bulk approve only for items that passed every check; keyboard-first (j/k/a/r/x) | `src/web/screens/inbox`, `src/agents/runtime/autonomy.ts` |
| Customer-set controls on auto-posting | **Autonomy levels L0-L3 per skill** set by a Controller, plus amount ceiling, min confidence, sampling rate and a materiality cap that no policy can exceed | `src/agents/runtime/autonomy.ts`, `src/web/screens/skills` |
| Rationale + confidence + audit trail (Ramp, BlackLine) | Every proposal carries `why`, `confidence`, `evidence[]`, `verification[]`; hash-chained audit log records model, skill version, policy version, ontology version | `src/agents/runtime`, `src/audit` |
| Skills as SOPs; agents tested against controls | **SKILL.md packages** with typed manifests (ontology-typed I/O, least-privilege tools, controls, autonomy, materiality) and **golden-case evals in CI** | `src/packs/accounting/skills/*` |
| Learns from history instead of rule setup | Transaction coding uses vendor history + ontology semantic profiles + plain-English rules; corrections feed vendor priors | `src/packs/accounting/algorithms/coding.ts` |
| Cash recs, prepaids, JEs, flux, close shepherding (Ramp Stack) | 12 skills covering the close, including the **close orchestrator** that runs skills across the WD calendar respecting dependencies | `src/packs/accounting/skills` |
| Accrual + auto-reversal with review table (Ramp accruals) | Accrual proposals always carry `auto_reverse_on` = WD1 of next period; reversal posted by the system | `skills/accrual-detection` |
| Thresholds decide what needs explanation (Numeric) | Flux thresholds (% and absolute, tied to performance materiality) are policy, not code | `skills/flux-analysis` |
| Humans keep payments and external comms | No tool can pay, email or change bank details; SoD rules keep vendor-master edits away from payment approval | `src/packs/accounting/tools` |
| MCP adoption among controllers | MCP server exposing the same domain tools with RBAC and audit (P2) | `src/server/mcp.ts` |
| COSO GenAI guidance: logs of prompts, inputs, outputs, model versions, human review | Run trace viewer with every step, tool call, token and cost; provider/model per run; offline engine clearly labeled | `src/web/screens/runs` |
| Ads: one claim, one number, one proof; typographic restraint; single accent | Calm, typographic UI; one accent color for "done/verified"; numbers set large with tabular figures; ads built on the same tokens | `src/web/design`, `docs/ads` |
