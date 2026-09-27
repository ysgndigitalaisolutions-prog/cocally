# CoCally — Market Research, Positioning & What To Build

> Written 19 July 2026, from a four-track parallel web research sweep: (1) AI voice-agent platforms, (2) AI SDR / sales dialers, (3) incumbent dialers/CCaaS + BPO economics, (4) demand side + regulation. Sources inline. This doc drives the website revamp and should drive roadmap priority. Pricing figures for private companies come from third-party trackers — treat as estimates.

---

## 1. The pain, ranked (each with a number)

1. **Speed-to-lead failure.** Average B2B lead response time is **42 hours**; calling within 5 minutes makes a lead **21× more likely to qualify** and **100× more likely to connect** vs 30 minutes (MIT/InsideSales + HBR). Humans structurally cannot call every web lead in under a minute, at 9pm, on Saturday. AI can. This is the sharpest, most measurable pain in the market.
2. **Human qualification economics are broken.** A US SDR costs **$110–160K/yr fully loaded**, takes **3.2 months to ramp**, stays **~14 months** (Bridge Group). Call-centre attrition ran **40–45% in 2025** (69–73% in year one). Offshore seats are $1.5–2.5K/mo and agencies resell their output at **$150–600 per appointment**. Cost per qualified conversation: **$450–800 (US floor)**, **$60–150 (offshore)** — vs **~$2.50–5 all-in for an AI leg** at ~$0.12/min.
3. **Spam labeling is strangling outbound.** ~5.4% average cold-call connect rate (Gong, 300M calls); **>95% of "Spam Likely" calls go unanswered** (Hiya); ~1 in 4 legitimate business numbers carries flag risk; one 200K-call study saw conversion fall 4.8% → 2.3% YoY. Every outbound incumbent now sells reputation-management as a paid SKU (Convoso, ReadyMode iQ, Ytel "Trust Center" at $499/mo) — the problem is structural.
4. **QA is blind.** Manual QA samples **1–2% of calls**; in regulated verticals "99% of calls are a fine waiting to happen." TCPA damages are $500–1,500/call, uncapped, with an active plaintiff's bar.
5. **No-shows.** 35–45% of booked B2B demos no-show; SDR-booked meetings show at only 55–65%. Confirmation/reminder calls are the known fix nobody staffs.

## 2. The competitive map — four camps, one empty seat

**a) Developer voice-AI infra — Bland, Retell, Vapi, Synthflow, ElevenLabs Agents.**
Cheap minutes ($0.05–0.14 headline), no operations. Universal complaints: real cost is **$0.13–0.33/min across 4–6 vendor bills**, Discord-grade support, latency spikes, platform updates breaking live agents. None ships: campaign/list ops, compliance, number-reputation management, QA console, or — critically — **any product for the human who receives a transfer**. Funding is huge (Bland >$100M, Vapi $500M valuation, ElevenLabs $11B) but all of it deepens the *infra* moat, not the *operations* moat. They are our suppliers' competitors, not our category.

**b) Enterprise inbound CX — Sierra ($15.8B), Parloa ($3B), PolyAI.**
Outcome-priced ("per resolution"), $150K–350K+/yr, sales-led, **inbound DNA**. They validate outcome pricing and will not come down-market or outbound.

**c) AI SDRs & parallel dialers — 11x, Artisan, AiSDR; Nooks, Orum, Salesfinity.**
The hype casualty zone. 11x: fake customer logos, ~70–80% churn, CEO out (TechCrunch, Mar 2025). Air.ai: **FTC-banned from selling business opportunities (Mar 2026)**, ~$19M consumer losses. Artisan: brand controversy, opaque pricing. Email AI SDRs produce fake pipeline; buyers repositioned the whole category from "autonomous rep" to "copilot." Parallel dialers ($3–5K/seat/yr **on top of** a ~$90K human) multiply dials, not conversations — and accelerate number burn ("all of our numbers are spam" — r/sales). **The market's trust currency is now verifiable outcomes: recorded, scored, compliant transfers.**

**d) Incumbent dialers/CCaaS — Five9, Genesys, NICE, Convoso, VICIdial, ReadyMode.**
Per-seat economics ($75–600/seat/mo, Five9 has a 50-seat minimum) mean **every dollar of AI displacement cannibalizes 2–5× its value in seat revenue** — so AI is priced as a protective add-on (Genesys tokens, NICE $0.25/session). Their AI proof points are all *inbound containment*. Implementations run 5+ months (Genesys G2 average). Closest analog: **Convoso's Voso.ai** (AI qualifies → transfers to humans) — but it's an upsell on a seat-based dialer. VICIdial is the displacement floor: "free" but $150–400/agent/mo all-in, zero AI, zero built-in compliance.

**The empty seat:** a full-stack **AI-fronter → human-closer operating product** — AI does every dial and every qualification; humans do only the conversations that matter, in a purpose-built closer workspace; compliance, QA, and number reputation are the platform's job. Regal.ai ($83–106M raised) is nearest but enterprise-B2C, sales-gated, with year-old warm transfer. Nobody owns the seam — and the seam is where revenue happens.

## 3. Regulation: tailwind if we build for it, tail risk if we don't

- **US:** FCC (Feb 2024) confirmed AI voices = "artificial voice" under TCPA → **prior express written consent for AI telemarketing**; $500–1,500/call. Consent-revocation rule live (Apr 2025, any-means, ≤10 business days). One-to-one consent rule vacated (11th Cir., Jan 2025) — relief for lead-gen. FCC in-call AI-disclosure rule is proposed and expected to land. **15+ state mini-TCPAs** (FL, OK, TX, WA, MD…) with private rights of action.
- **EU:** AI Act **Article 50 applies Aug 2, 2026** — voice bots must audibly disclose they're AI; fines to €15M/3% turnover.
- **UK:** PECR fine cap raised to **£17.5M or 4% of global turnover** (Feb 2026).
- **AU:** DNCR + Telemarketing Standard (hours, ID, opt-out); consent **stale after 3 months**; ACMA fined V Marketing A$1.5M + A$60K personally against its director (Apr 2025). AI voice flagged in ACMA's 2025–26 priorities.
- **US abandonment safe harbor** (≤3% per campaign/30 days) is the predictive-dialer tax — our AI-fronter model produces **zero abandoned calls structurally**, a genuine compliance advantage worth saying loudly.

**Implication:** "we make it impossible to place an illegal call" is a board-level pitch no infra vendor can copy without rebuilding. Compliance must be sold as *the product*, not a checkbox: consent-provenance ledger, policy engine per jurisdiction, AI disclosure by default, any-means revocation captured by the AI itself, 100% recorded + QA'd evidence.

## 4. Market size & momentum

- Contact-centre software: ~$72.6B (2025) → ~$173B (2030), 18.9% CAGR (Mordor).
- Outbound telemarketing BPO: ~$11.5–13.2B, flat — mature and ripe for cost disruption.
- Voice AI agents: ~$2.4–2.5B (2024/25) → $35–47B (2033/34), ~35–39% CAGR.
- AI-handled calls cost **$0.30–0.50 vs $6–12 human**; Forrester TEI on enterprise voice AI: 391% 3-yr ROI.
- Qualified/Piper acquired by Salesforce (closed early 2026); Vogent absorbed by Aircall — consolidation is on.

## 5. Positioning (the decision)

**Category:** *The AI front line for revenue teams* — AI calls, qualifies and scores every lead; humans close. Not "AI cold caller," not "voice AI API," not "AI SDR."

**Lead message: speed-to-lead + qualified conversations, with proof.**
- *"Every lead called in seconds. Only real buyers reach your team."*
- The wedge use-cases (in order): **(1) inbound web-lead qualification** (<60s callback; consent captured at form-fill; cleanest legal posture; clearest ROI), **(2) database reactivation** (aged leads, lapsed quotes — existing-relationship lists), **(3) appointment setting + no-show-killing confirmations**, **(4) B2B qualification front line**. **Avoid marketing pure cold consumer outbound** — legally hostile, reputationally toxic post-Air.ai, economically degrading.
- **Verticals:** solar & home services, insurance, real estate/mortgage, education. (Financial services = phase 2; heaviest regulatory overlay.)

**Three differentiators, in this order:**
1. **The human seam is the product.** Live intent scoring → warm transfer with an AI briefing → closer workspace → disposition loop. Nobody else builds for the receiving human.
2. **Compliance as product.** Consent ledger, DNC wash, calling windows, AI disclosure by default, instant opt-out before the model is consulted, zero structural abandonment, audit evidence per call.
3. **Receipts, not claims.** Post-11x/Air.ai, every transfer must be verifiable: dual-leg recording, transcript, score history, auto-QA, compliance log, per-call cost. "If it's not provable, it didn't happen."

**Pricing posture:** transparent, usage-based, **no seats, no seat minimums** (antithesis of Five9); outcome-aligned pilots (per qualified transfer — undercut the $150–600/appointment BPO market with software margins). Aloware's published outcome menu ($3–25/qualified lead, $8–40/booked appointment) is the reference model. COGS supports it: AI leg ≈ $0.037/min ex-telco (₹3.63), true all-in transferred call ≈ $0.81 incl. telco.

**Honesty constraints for all marketing** (post-FTC environment): no fabricated customers/testimonials; the "230ms bridge" figure is a simulation measurement — say "sub-second," not a precise number, until measured on real audio; label indicative pricing as indicative.

## 6. What to build (beyond current scope), priority-ordered

Day-one table stakes buyers will demand (BPO/inside-sales research + ops-map gaps):
1. **Speed-to-lead ingestion** — webhook/API lead intake with dial-in-<60s SLA (ops map E16). This *is* wedge #1; today only CSV import exists.
2. **Number-reputation ops as managed service** — DID health monitoring, spam-label detection/remediation, branded caller ID partnerships, STIR/SHAKEN attestation (F6). We have rotation/resting; monitoring and branding are missing. Every incumbent monetizes this; buyers switch over it.
3. **Supervisor live-call control** — monitor/whisper/barge (B5–B7). "BPO ops managers will not run what they cannot supervise." Cheap on the LiveKit room model.
4. **Closer-seat tooling** — hold/mute, agent→agent transfer, on-screen talk-track with the rebuttal library exposed to the human, callback queue (C7–C13).
5. **Consent-provenance ledger + US/EU/UK country packs** — consent records (timestamp, disclosure text, source, 5-yr retention), state mini-TCPA policy packs, AI-disclosure assertion in the QA rubric (I8, I9). Turns the Q4-2026 FCC rule into a sales event.
6. **CRM sync** (Salesforce/HubSpot/GoHighLevel) + lead recycling/prioritisation/exhaustion alarms (E12–E15).
7. **Outcome-billing infrastructure** — meter qualified transfers/appointments, not just minutes (A14).
8. **Push insight** — scheduled digests + metric-breach alerts (H10–H11).
9. **Inbound callback path** for CLIs (F9) — minimal DID routing so an AI-promised callback isn't a dead end; full ACD can wait for a customer who needs it.
10. **Real-time agent assist on the human leg** (premium tier; already costed in COGS §8) — the differentiated follow-on, not the launch feature.

## 7. Sources (primary ones)

- MIT/InsideSales Lead Response study; HBR 42-hour follow-up — speed-to-lead stats
- Bridge Group 2025 SDR Metrics (ramp/tenure); SalesHive/Cykel (SDR loaded cost)
- Gong Labs 300M-call connect-rate data; Hiya spam-label reports; SkipCall benchmarks
- FTC v. Air AI (Aug 2025 complaint; Mar 2026 ban); TechCrunch on 11x (Mar 2025)
- FCC AI/TCPA Declaratory Ruling (Feb 2024) + AI-disclosure NPRM; 11th Cir. IMC v. FCC; EU AI Act Art. 50; ACMA enforcement reports
- Fortune/TechCrunch/CNBC funding coverage (Bland, Vapi, Parloa, ElevenLabs, Sierra)
- Five9/Genesys/NICE/Convoso/ReadyMode pricing pages + third-party TCO trackers (Platform28, CloudTalk, MarketBetter — estimates)
- Aloware outcome-based pricing pages; Leadium/Salesar appointment-setting price guides
