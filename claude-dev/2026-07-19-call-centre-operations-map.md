# CoCally — Call Centre Operations Map

> Written 19 July 2026. Steps into the day-to-day operations of an outbound contact centre and enumerates *every job that has to happen*, by actor. Each line is tagged against what CoCally has today per [`product-features.md`](./product-features.md) and the module map in [`2026-07-19-architecture.md`](./2026-07-19-architecture.md).
>
> **Status legend** — `✅` documented as built in Phase-1 · `⚠️` partially covered / exists but thin · `❌` no coverage today.
> Status reflects the docs + module map, not a hands-on run of each feature. To be validated item by item.

---

## A. Admin / Owner — platform setup & governance

| # | Operational job | Status | Notes / gap |
|---|---|---|---|
| A1 | Create tenant, set quotas | ✅ | `tenants` module |
| A2 | Provision users, assign roles (Owner/Admin/Supervisor/Agent/QA) | ✅ | `users`, RBAC 403-verified |
| A3 | Deprovision / offboard an agent mid-shift | ⚠️ | User CRUD exists; no documented "force-logout + reassign live call" path |
| A4 | Configure AI/voice providers + credentials | ✅ | PAL, per-capability schemas, tenant vault |
| A5 | Set fallback chains per capability | ✅ | Resolution hierarchy + failover |
| A6 | Pause everything (kill switch) | ✅ | `ops` |
| A7 | Review audit log | ✅ | Append-only, Admin/QA queryable |
| A8 | Configure webhooks / API keys for integrations | ✅ | HMAC + scoped hashed keys |
| A9 | Set retention windows, apply legal hold | ✅ | GCS lifecycle + `temporaryHold` |
| A10 | **Budget/spend caps per campaign + alerting before overrun** | ⚠️ | Dialer checks a daily budget; no documented UI to set it, no threshold alerting |
| A11 | **Approve a flow before it goes live (maker/checker)** | ❌ | Publish is compliance-gated but single-actor; no second-person approval |
| A12 | **Business-hours / roster / shift definition** | ❌ | Legal calling windows exist; *staffing* schedule does not |
| A13 | **Client (end-customer) management — who owns which campaign, their SLAs** | ❌ | Tenancy is the only grouping; no client entity for a BPO running multiple clients |
| A14 | **Billing / invoicing / per-client cost rollup** | ❌ | Per-call cost is captured; no commercial layer on top |

## B. Supervisor / floor manager — running the shift

| # | Operational job | Status | Notes / gap |
|---|---|---|---|
| B1 | Live floor feed of all activity | ✅ | Socket.IO, scoped by role |
| B2 | See each agent's presence + occupancy | ✅ | Server-side presence segments |
| B3 | Start/stop/pause a campaign | ⚠️ | Campaign CRUD + kill switch; no documented per-campaign pause control |
| B4 | Adjust pacing / dials-per-agent mid-shift | ⚠️ | Pacing knobs are campaign config; unclear if hot-editable while dialing |
| B5 | **Listen in on a live call (monitor)** | ❌ | Supervisor sees transcript, cannot hear audio live |
| B6 | **Whisper to an agent mid-call** | ❌ | |
| B7 | **Barge into a call** | ❌ | |
| B8 | **Force an agent's presence state** (stuck in WRAP_UP, forgot BREAK) | ❌ | |
| B9 | **Reassign / requeue a transfer that's cascading badly** | ⚠️ | Cascade + booking fallback are automatic; no manual override |
| B10 | Watch queue health — offers waiting, no eligible agent | ⚠️ | Transfer discipline metrics exist historically; no live "queue starving" alarm |
| B11 | Intraday target tracking vs. goal | ❌ | Analytics are retrospective; no target/pacing-to-goal view |
| B12 | **Coaching: annotate a call, assign to an agent, track acknowledgement** | ❌ | Recordings + QA scores exist; no coaching workflow |

## C. Human agent — the seat

| # | Operational job | Status | Notes / gap |
|---|---|---|---|
| C1 | Log in (phone OTP) | ✅ | Firebase OTP → app JWT |
| C2 | Go AVAILABLE / BREAK / OFFLINE | ✅ | Presence |
| C3 | Receive transfer offer with countdown, accept/decline | ✅ | Transfer card |
| C4 | Read AI summary + captured facts at moment of accept | ✅ | Transfer card payload |
| C5 | Talk to customer over browser WebRTC | ✅ | Joins same LiveKit room |
| C6 | Set disposition, close the loop | ✅ | Updates lead, stops recording, wrap-up, webhooks |
| C7 | **Mute / hold / put customer on hold with music** | ❌ | |
| C8 | **Warm-transfer onward to another human** (agent → senior/specialist) | ❌ | Only AI → human is modelled |
| C9 | **Conference in a third party** | ❌ | |
| C10 | **Manual outbound dial / click-to-call a lead** | ❌ | All dialing is dialer-initiated |
| C11 | **Callback scheduling the agent controls** (customer says "call me Thursday") | ⚠️ | `appointment` schema + callback intent exist; agent-side booking UI not documented |
| C12 | **On-call script / talk-track for the human leg** | ❌ | The AI has a prompt; the human gets a summary and nothing else |
| C13 | **Objection help / knowledge base during the human leg** | ❌ | Rebuttal library serves the AI only |
| C14 | **Edit / correct lead data during the call** | ⚠️ | Lead CRUD exists; in-call edit surface not documented |
| C15 | **After-call work notes free-text** | ⚠️ | Disposition is structured; free notes not documented |
| C16 | See own performance | ✅ | *My insights* |
| C17 | **Wrap-up timer with auto-return to AVAILABLE** | ⚠️ | WRAP_UP state exists; enforced max wrap time not documented |

## D. AI agent & the handoff

| # | Operational job | Status | Notes / gap |
|---|---|---|---|
| D1 | AMD — classify human/voicemail/IVR | ✅ | |
| D2 | Voicemail policy: silent / prerecorded / AI drop | ✅ | |
| D3 | IVR DTMF navigation | ✅ | |
| D4 | Conversation loop with JSON envelope | ✅ | |
| D5 | Never re-ask an answered question | ✅ | Mechanical, via already-answered list |
| D6 | Objection handling from rebuttal library | ✅ | |
| D7 | Live scoring → transfer threshold | ✅ | |
| D8 | Safety rails pre-LLM (opt-out, distress) | ✅ | Regex, model-independent |
| D9 | Incremental summary ready at transfer instant | ✅ | |
| D10 | Agent selection (longest-idle / skills) + atomic reserve | ✅ | |
| D11 | Offer cascade on decline/timeout → booking fallback | ✅ | |
| D12 | Bridge with minimal dead air | ⚠️ | See note below — the ~230ms figure is a simulation measurement, not real audio |
| D13 | Sticky agent preference | ✅ | |
| D14 | **Handoff when zero agents are staffed** (out of hours, everyone on break) | ⚠️ | Booking fallback exists; no documented "don't dial if nobody can take a transfer" pre-check beyond agent-aware pacing |
| D15 | **Customer explicitly asks for a human before threshold** | ❌ | Transfer is score/intent driven; no "escalate on demand" intent documented |
| D16 | **AI takes the call back if the human drops** | ❌ | |
| D17 | **Inbound calls** (customer calls the CLI back) | ❌ | Entire platform is outbound-only. **Note: this does not affect AI→human transfer — see "Transfer is not inbound" below.** |

### Two clarifications found while validating D12/D17

**1. Transfer is not an inbound call.** The AI→human handoff places no call to the agent at all. Per architecture §8, all three parties meet in **one LiveKit room**: the customer is a SIP participant (dialled outbound through the trunk), the AI is a worker process joining over WebRTC, and on accept the human agent's **browser joins the same room** over WebRTC. The AI participant then mutes/exits. No second PSTN leg, no inbound DID, no ACD.

"Inbound" in the call-centre sense means something structurally different: a stranger dials one of our DIDs from the PSTN, and that call arrives at the trunk needing DID routing → IVR → queue → ACD → agent selection. We have none of that path. The two are orthogonal — **we could ship transfers forever without ever building inbound.** What we actually lose to the inbound gap is the *callback* case (F9): a customer who rings the CLI back reaches nothing, which quietly undermines any callback the AI promises.

*Variant worth noting:* if we ever want to reach a human agent on their **phone** rather than in the browser (remote/mobile agents, browser-less floors), that is an **outbound** dial to the agent plus a room bridge — still not inbound.

**2. The media plane is designed, not built.** `grep -ri livekit apps/api/src apps/web/src packages` returns **zero matches**. Everything above the `CallRuntime` seam — cascade, reservation, disposition close-loop, transfer card — is real and running on the simulation runtime; the LiveKit room, SIP dial-out, WebRTC join, and egress are all still to be built (architecture §3 says as much: "the LiveKit runtime is the one new production component to build").

Consequence for the dead-air claim: [`transfers.service.ts:107`](../apps/api/src/modules/workspace/transfers.service.ts#L107) computes `bridgeDeadAirMs = Date.now() - handoffStarted` — elapsed JavaScript wall-time in simulation, **not measured audio silence on a real call**. The "pilot verified at ~230ms against a <1s requirement" line in [`product-features.md`](./product-features.md) §4 overstates this and should be reworded until it's measured on real audio. Real-world bridge latency will be dominated by WebRTC join + track subscription, which the current number does not model at all.

## E. Campaigns & lead lists

| # | Operational job | Status | Notes / gap |
|---|---|---|---|
| E1 | Design conversation flow visually | ✅ | Flow canvas |
| E2 | Validate structure, publish immutable version | ✅ | |
| E3 | Compliance-gated publish (mandatory disclosure) | ✅ | |
| E4 | Test with scripted simulator | ✅ | |
| E5 | Live test-drive on the real engine | ✅ | |
| E6 | Preview exact prompt | ✅ | |
| E7 | Configure retry matrix, scoring, rebuttals, pacing, A/B splits | ✅ | Campaign config |
| E8 | CSV import with mapping + rejects report | ✅ | |
| E9 | Dedupe (in-file + cross-list), emergency-number blocklist | ✅ | |
| E10 | E.164 normalise, line-type + timezone inference | ✅ | |
| E11 | Lead lifecycle timeline | ✅ | |
| E12 | **Lead prioritisation / list ordering** (fresh-first, score-first, aged) | ❌ | No documented ordering strategy — dialer picks by lock, not by priority |
| E13 | **Sub-list / segment management within a campaign** | ❌ | |
| E14 | **Move leads between campaigns; recycle a list** | ❌ | |
| E15 | **List exhaustion alarm** ("campaign has 2h of dialable leads left") | ❌ | |
| E16 | **API / CRM lead ingestion** (not just CSV) | ⚠️ | Scoped API keys exist; a documented leads-ingest endpoint contract does not |
| E17 | **Lead export / return-to-client file** | ❌ | |
| E18 | A/B split evaluation — which variant won | ⚠️ | Splits configurable; no documented comparison report |

## F. Numbers (CLI / DID) operations

| # | Operational job | Status | Notes / gap |
|---|---|---|---|
| F1 | CLI pools, geo-matched to lead | ✅ | |
| F2 | Rotation rules | ✅ | |
| F3 | Auto-resting of numbers with collapsed answer rate | ✅ | Spam-flag mitigation |
| F4 | Answer-rate per CLI visibility | ✅ | Analytics |
| F5 | **Number procurement / porting workflow** | ❌ | Numbers assumed to exist |
| F6 | **Spam-label detection & remediation** (carrier reputation, registration) | ⚠️ | Resting is the only mitigation; no reputation monitoring or branded-caller-ID |
| F7 | **Trunk/carrier failover** | ❌ | Single trunk assumed (Twilio/Telnyx) |
| F8 | **Concurrent-channel cap management + alarm** | ⚠️ | Dialer checks channel caps; no operator-facing alarm |
| F9 | **Inbound routing for callbacks to a CLI** | ❌ | See D17 |

## G. Data operations

| # | Operational job | Status | Notes / gap |
|---|---|---|---|
| G1 | Dual-leg recording, stitched timeline | ✅ | |
| G2 | PII redaction by default, audited raw access | ✅ | |
| G3 | Region-pinned storage, retention purge, legal hold | ✅ | |
| G4 | Per-call cost composition (telco + STT + TTS + LLM) | ✅ | `providersUsed` |
| G5 | Immutable audit log | ✅ | |
| G6 | **DSAR / right-to-erasure for a specific customer** | ❌ | Retention is time-based; no per-subject deletion workflow |
| G7 | **Bulk data export for a client offboarding** | ❌ | |
| G8 | **Suppression list import from client** | ⚠️ | Client-specific suppression lists exist in the stack; import path not documented |
| G9 | DNC wash freshness enforcement | ✅ | Stale wash blocks the dial |

## H. Insights delivered to humans

| # | Operational job | Status | Notes / gap |
|---|---|---|---|
| H1 | KPI band (dials, connect, transfers, bookings, CPB, AHT, QA) | ✅ | |
| H2 | Lead funnel | ✅ | |
| H3 | Objection intelligence + bookings-at-risk | ✅ | |
| H4 | Outcome / AMD mix | ✅ | |
| H5 | Best-time-to-call heatmap | ✅ | |
| H6 | Call deep-dive (transcript, score curve, compliance, cost) | ✅ | |
| H7 | My insights (agent self-service) | ✅ | |
| H8 | Team insights + member drill-down + AI-vs-human timeline | ✅ | |
| H9 | 100% auto-QA against a rubric | ✅ | |
| H10 | **Scheduled report delivery (email/Slack digest)** | ❌ | All insight is pull, none is push |
| H11 | **Alerting on metric breach** (connect rate collapse, QA drop, cost spike) | ❌ | Infra alerting exists; *business* metric alerting does not |
| H12 | **Client-facing report / shareable summary** | ❌ | |
| H13 | **QA calibration** (do human reviewers agree with the auto-QA rubric?) | ❌ | Auto-QA is unchallenged |
| H14 | **Manual QA review + dispute/appeal flow** | ❌ | |
| H15 | **Cohort / period comparison** (this week vs last) | ⚠️ | Period selectors exist; explicit comparison not documented |

## I. Compliance operations

| # | Operational job | Status | Notes / gap |
|---|---|---|---|
| I1 | Country pack: DNC rules, hours, holidays, disclosures, tz | ✅ | AU shipped |
| I2 | Calling-window enforcement, DST-correct | ✅ | |
| I3 | Suppression stack at dial time | ✅ | |
| I4 | Opt-out → instant permanent suppression | ✅ | |
| I5 | Compliance events per call, surfaced in UI | ✅ | |
| I6 | **Complaint intake & handling workflow** | ❌ | |
| I7 | **Regulator evidence pack for a specific call/period** | ⚠️ | All raw material exists; no one-click pack |
| I8 | **Second country pack** (India/UK/US) | ❌ | AU only |
| I9 | **AI-disclosure verification** — prove the AI identified itself | ⚠️ | Prompt flag + compliance events; no dedicated assertion in QA rubric |

---

## Top gaps, ranked by "a real floor stops working without it"

1. **Supervisor live-call control** — monitor / whisper / barge (B5–B7). Every BPO floor manager expects this on day one.
2. **Human-leg tooling** — hold, agent→agent transfer, talk-track, in-call knowledge (C7, C8, C12, C13). Today the human gets a summary and is on their own.
3. **Inbound** (D17, F9). Outbound-only means a customer who calls back hits nothing.
4. **Staffing model** — roster/shift (A12) and the "don't dial when nobody can take the transfer" guarantee (D14).
5. **Push insight** — scheduled reports and business-metric alerting (H10, H11). Pull-only dashboards get looked at once a week.
6. **List operations** — prioritisation, recycling, exhaustion alarm (E12–E15). Determines whether the dialer feeds itself.
7. **BPO commercial layer** — client entity, SLA, billing rollup (A13, A14). Blocks selling this to anyone running more than one client.
8. **QA credibility** — calibration and manual review (H13, H14). 100% auto-QA is only worth something once someone has checked the rubric agrees with humans.

---

## VICIdial parity comparison

> VICIdial (GPLv2, Asterisk-based) is the de-facto reference for what an outbound floor expects a dialler to do — it's been in production on BPO floors for ~20 years, so its feature list is a good proxy for "table stakes". **Caveat: the VICIdial detail below is from knowledge of the project, not verified against a running install or the current release notes. Version-specific claims should be checked before any of this is quoted externally.**

### The paradigm difference — and why VICIdial's own model maps onto ours

VICIdial already has the AI→human handoff pattern, under a different name: **fronter → closer**. A fronter agent qualifies on a cheap seat, then warm-transfers to a closer on an expensive seat, passing lead context in the agent screen. CoCally's proposition is precisely *"the fronter is an AI."*

That reframing is useful because it tells us which VICIdial features we inherit as requirements and which we don't:

- Everything on the **closer's** screen is still required — we just haven't built it.
- Everything that exists to keep the **fronter** busy (predictive overdial, hopper depth, pause codes, time clock) partially dissolves, because our fronter is software that costs cents per minute and is never idle.

### What VICIdial has that CoCally does not

| Area | VICIdial capability | CoCally | Verdict |
|---|---|---|---|
| **Dialing modes** | Manual, preview, ratio, and three adaptive/predictive modes | Automatic paced dialing only | Preview + manual are real gaps; predictive is arguably obsolete for us (see below) |
| **Inbound** | Full ACD: in-groups, skills-based routing, queue priority, DID routing, IVR call menus, queue announcements | None | **Largest single gap** |
| **Blended** | One agent takes inbound and outbound in the same session | N/A | Follows from inbound |
| **Agent phone controls** | Hold, mute, park, blind transfer, warm transfer, 3-way conference, hangup, redial | Accept, talk, dispose | **Core gap** (C7–C9) |
| **Agent→agent transfer** | Transfer to another agent, an in-group, or an external number | None | **Core gap** |
| **Scripts** | Per-campaign agent script with `--A--variable--B--` lead-field substitution, plus web-form/URL launch into a CRM | AI has a prompt; human has a summary | **Core gap** (C12) |
| **Callbacks** | Personal callbacks (same agent) and "anyone" callbacks, with a callback queue the agent sees on login | `appointment` schema + callback intent exist; no agent-facing callback queue | Partial |
| **Supervisor live control** | Listen (ChanSpy), whisper, barge, force-pause, force-logout, move agent to another campaign, agent chat | Watch transcript + presence only | **Core gap** (B5–B8) |
| **Pause codes** | Structured reason codes for every pause, reported on | BREAK is a single undifferentiated state | Gap — kills adherence reporting granularity |
| **Time clock** | Agent clock-in/out, shift tracking, payroll-grade time reports | Presence segments only | Gap (A12) |
| **Lists** | Multiple lists per campaign, list-level active toggle, lead ordering strategies (down/up count, random, by field), SQL lead filters, recycling rules, lead reset | One implicit pool; no ordering, no filters, no recycling | **Core gap** (E12–E15) |
| **Hopper** | Pre-loaded dialable-lead buffer with depth monitoring — the operational early-warning for list exhaustion | None | Gap (E15) |
| **Custom lead fields** | Arbitrary per-list custom fields, surfaced in the agent screen and scripts | Fixed lead schema + captured facts | Gap |
| **Reporting** | Dozens of built-in reports plus real-time screens; most exportable to CSV | ~8 analytics surfaces, richer per surface, no export | Different shape — ours is better-designed, far narrower, and **not exportable** |
| **Carriers** | Multiple carrier/trunk definitions, per-campaign carrier selection, failover | Single trunk assumed | Gap (F7) |
| **CID control** | CID groups, area-code-matched CID, per-list CID override | CLI pools with geo-match + rotation + resting | **We're ahead here** |
| **Multi-server** | Cluster of dialler/Asterisk servers with load balancing | Single API instance by design (Phase 2 path documented) | Fine at pilot scale |
| **API** | Non-Agent API (lead insert, campaign control, list management) and Agent API (control the agent screen externally) | Scoped API keys; no documented lead-ingest or control contract | Gap (E16) |
| **Music on hold / voicemail boxes** | Standard Asterisk features | None | Follows from hold/inbound gaps |

### What CoCally has that VICIdial does not

| Capability | Why it matters |
|---|---|
| **Autonomous AI first leg** | The entire premise. VICIdial has no conversational AI — the fronter is always a paid human. |
| **Visual flow designer with structural validation + immutable published versions** | VICIdial scripts are text with variable substitution; there's no conversation graph, no validation, no versioning. |
| **Live scoring → threshold-triggered transfer** | VICIdial transfers when the human decides. Ours is a computed propensity score with a configurable threshold. |
| **AI-written summary delivered at the moment of accept** | VICIdial passes lead fields; it cannot pass "here's what they said and what they care about". |
| **Provider abstraction with failover across STT/TTS/LLM vendors** | No analogue. |
| **100% automatic QA on every call** | VICIdial QA is manual sampling. (Though ours is uncalibrated — see H13.) |
| **Compliance-gated flow publish** | Disclosure requirements are enforced at publish time, structurally. VICIdial relies on the script author. |
| **Per-call cost composition (telco + STT + TTS + LLM)** | Enables cost-per-booking as a first-class metric. |
| **Objection intelligence / rebuttal win-rate** | Emerges from structured capture; nothing equivalent in a manual-notes world. |
| **PII redaction by default + region-pinned storage + legal hold** | VICIdial gives you raw recordings on disk and leaves governance to you. |

### What VICIdial has that we deliberately should not build

**Predictive dialing and its entire apparatus.** Predictive overdial exists because human agents are the scarce, expensive resource: you dial more lines than you have agents, and you accept an abandoned-call rate (regulated — AU/UK/US all cap it) as the cost of keeping seats warm. Our fronter is software. It is never idle, costs cents per minute, and scales by adding a worker process.

So we should not build: adaptive dial ratios, drop/abandon-rate management, "safe harbour" abandon messages, or agent-idle-time optimisation. **And we should say so loudly** — "zero abandoned calls, structurally" is a genuine compliance advantage over every predictive dialler on the market, not merely a missing feature.

Note the nuance: agent-aware pacing still matters for us, but for the opposite reason. VICIdial paces to keep agents *busy*; we pace to ensure a human is *available to receive a transfer* (D14). Same knob, inverted objective.

### Verdict — are we giving all the functionality?

**No — not close, on the human and telephony operations side.** Rough shape of it:

- **AI / conversation / compliance / cost layers**: we are well beyond VICIdial. It has no equivalent.
- **Campaign & flow authoring**: ahead — visual, validated, versioned.
- **Number management**: ahead — geo-match, rotation, auto-resting.
- **Human agent seat**: substantially behind. A VICIdial agent has hold, transfer, conference, script, callback queue, custom fields, manual dial. Ours has accept and dispose.
- **Supervisor tooling**: substantially behind. Monitor/whisper/barge is the single most-expected feature we lack.
- **List operations**: substantially behind. No ordering, filters, recycling, or hopper-depth warning.
- **Inbound**: absent entirely, where VICIdial is a full ACD.
- **Reporting**: ours is better designed and much narrower, and cannot export.

A floor manager migrating from VICIdial would find the AI remarkable and then immediately ask for six things on day one and be told no.

### Minimum parity set to be credible on a BPO floor

Ordered by "they will ask for this in the first hour":

1. **Supervisor monitor / whisper / barge** — all three participants are already in one LiveKit room, so this is a room-subscription and track-publish problem, not a telephony problem. Cheapest high-value item on the list.
2. **Agent hold + mute + agent→agent warm transfer** — same room model, same argument.
3. **Agent script / talk-track panel** on the human leg, with lead-field substitution and the campaign's rebuttal library exposed to the human, not just the AI.
4. **Pause codes** replacing the single BREAK state — small change, unblocks credible adherence reporting.
5. **List ordering + filters + a hopper-depth / exhaustion alarm.**
6. **Agent-facing callback queue** on top of the existing `appointment` schema.
7. **CSV export on every analytics surface** — trivially cheap, and its absence reads as a toy to anyone who reports upward.
8. **Inbound ACD** — the big one, and the only item here that is a genuine project rather than a feature.

Items 1–4 and 7 are, on the current architecture, comparatively small. That is worth knowing: most of the credibility gap is cheap to close, and the expensive item (inbound) can wait for a customer who actually needs it.

---

## Validation log

Walk the table item by item; record corrections here as they're confirmed.

| Date | Item | Claimed status | Verified status | Note |
|---|---|---|---|---|
| | | | | |
