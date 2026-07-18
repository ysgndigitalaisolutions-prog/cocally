# CoCally — Product Features

> Written 19 July 2026. A top-to-bottom tour of what CoCally does today (Phase-1 pilot scope), organised by feature area, ending with the full prompt flow that powers every AI conversation. For the deep prompt-engineering internals, see [`prompting-architecture.md`](./prompting-architecture.md); for the build history and module map, see [`initial-build.md`](./initial-build.md).

## What CoCally is

CoCally is an AI-first outbound contact-centre platform. Autonomous voice agents dial leads, detect who/what answered (human vs. voicemail vs. IVR), qualify the person in a natural back-and-forth conversation, score intent live, and — when a lead is hot enough — warm-transfer the call to a human agent in CoCally's own browser workspace, handing the agent an AI-written summary at the moment of transfer. Every call is dual-leg recorded, every call is auto-QA'd, and every action respects country-specific calling-compliance rules (do-not-call registers, calling windows, mandatory disclosures).

## 1. Campaigns & flows — how a calling program is defined

- **Flows** are visual conversation graphs: nodes (AMD-gate, SPEAK/PLAY, AI_CONVERSATION, LISTEN_CAPTURE, TRANSFER, END) connected by edges with conditions/priorities. A flow is drafted, structurally **validated** (dead-ends, missing END, bad edges are rejected), then **published** as an immutable version — you can keep iterating on a new draft while a published version keeps serving live calls.
- **Compliance is enforced at publish time**: if the lead's country pack requires a disclosure, the flow *cannot* publish without a mandatory SPEAK/PLAY node carrying it.
- **Campaigns** sit above flows and carry everything that varies by calling program without touching the conversation graph itself: the **retry matrix** (how/when to re-attempt no-answers, busy, voicemail), **scoring config** (which captured facts are worth how many points, and the transfer threshold), the **rebuttal library** (objection → guidance the AI should use), **CLI pool + rotation rules** (which outbound numbers to dial from), **voicemail/IVR policy**, **pacing knobs** (dials per available agent), **A/B splits**, **transcription mode**, and the **transfer-card summary template**.
- **Text simulator**: run a flow against a scripted or persona-driven fake customer without placing a real call — fast iteration on conversation design.
- **Live test-drive**: a chat UI that runs the *actual* production engine (same executor, same prompt composition, same scoring, same safety rails) with you typing the customer's side live, one turn at a time. Shows live score, captured facts, objections, compliance events, and the summary an agent would see on transfer. This exists specifically because a pre-scripted reply list can't exercise how an unpredictable real customer behaves.
- **Prompt preview**: on the AI node, "Preview exact prompt" shows the literal system prompt and message assembly that will be sent to the model — served by the same pure function the live engine uses, so it can never drift from reality.

## 2. The AI conversation engine

- **Conversation loop**: each customer turn is answered by an LLM call that must return a structured JSON envelope (`reply`, `intent`, `captured`, `objection`) — not free text. The engine executes the envelope rather than trying to parse prose.
- **Never re-asks an answered question**: captured facts are injected into the system prompt every turn as an explicit "already answered" list — a mechanical guarantee, not a hope that the model remembers.
- **Objection handling**: the campaign's rebuttal library (objection → guidance) is folded into the system prompt so the model has a specific playbook instead of improvising, and each objection raised/recovered is logged for analytics.
- **Structured capture & live scoring**: every turn's `captured` facts merge into the call's fact set, which recomputes a weighted propensity score in real time. Crossing the campaign's transfer threshold is what triggers a warm-transfer attempt.
- **Safety rails run before the model is even called**: regex-level guards catch do-not-call phrases (instant opt-out + polite exit) and profanity/distress (graceful exit) — compliance-critical behaviour that never depends on model output.
- **Graceful degradation**: malformed model JSON falls back to raw text as the reply with `intent: continue` — a bad model turn degrades the conversation, it never crashes the call.
- **Incremental call summary**: built up turn-by-turn (not generated after the fact) so it's ready the instant a transfer fires.

## 3. Telephony & dialing

- **AMD (answering-machine detection)** classifies who/what picked up, driving campaign-configured voicemail policy (silent, prerecorded message, or AI-recorded drop) or IVR DTMF navigation.
- **Pacing-aware dialer** ticks continuously: kill switch check → daily budget check → channel caps → agent-availability-aware pacing → atomic lead lock (prevents double-dialing the same lead from concurrent dialer ticks) → legal calling-window check → suppression stack → CLI selection → fire.
- **Dial-time suppression stack**, checked in order: DNC/do-not-call wash (a stale wash blocks the dial rather than allowing it), permanent opt-outs, frequency caps, client-specific suppression lists.
- **Calling-window enforcement** is IANA-timezone-aware (handles DST divergence correctly — e.g. two Australian states can be on opposite sides of a legal-hours boundary at the same UTC instant) and respects public holidays.
- **CLI (caller-ID) pools**: geo-matched to the lead, rotated, with automatic "resting" of numbers whose answer rate collapses (spam-flagging mitigation).
- **Retry matrix**: campaign-defined re-attempt rules per outcome (no-answer, busy, voicemail) with next-attempt scheduling.
- **`CallRuntime` abstraction**: the AI loop, scoring, and transfer logic run identically whether the call is a real SIP call or the always-available in-process simulation driver — meaning the whole pilot loop works with zero telephony vendor and zero AI provider keys configured.

## 4. Warm transfer (AI → human handoff)

- **Eligibility & selection**: when a call crosses the scoring threshold, the engine looks for an eligible human agent using one of several selection strategies (e.g. longest-idle, skills-matched) and atomically reserves them.
- **Offer + accept-window cascade**: the agent gets a transfer card with a countdown to accept; on decline or timeout, the system cascades to the next candidate agent, and falls back to a booking flow if the agent pool is exhausted.
- **Bridging**: measured dead-air on bridge (pilot verified at ~230ms against a <1s requirement) so the human agent picks up the live call with minimal silence.
- **Transfer card**: carries the lead's name, captured facts, live score, and the AI-generated summary the moment the agent accepts.
- **Sticky-agent preference**: prefers routing a lead back to an agent they've spoken with before, where applicable.
- **Disposition close-loop**: the agent's disposition (Booked, etc.) closes the loop — updates lead state, stops the human-leg recording, returns the agent to wrap-up presence, records talk time, and queues the relevant webhooks.

## 5. Workspace (the human agent's screen)

- **Presence**: AVAILABLE / ON_CALL / WRAP_UP / BREAK / OFFLINE, tracked server-side (not client-inferred) so adherence reporting is auditable.
- **Floor feed**: supervisors see a live view of all activity; agents see activity scoped to their own campaigns (configurable display mode).
- **Realtime everything** over Socket.IO: presence changes, transfer offers, live transcript streaming, and score updates all push to connected clients instantly.
- **Transfer offer UI**: the accept/decline countdown card described above.

## 6. Leads

- **CSV import** with column mapping, an on-screen **rejects report** for rows that fail validation, in-file and cross-list deduplication, and an emergency-number blocklist.
- **Phone normalisation**: converts messy input to E.164, infers line type (mobile/landline), and derives a timezone (state/area lookup, falling back to a default) — which feeds directly into legal calling-window enforcement.
- **Lifecycle tracking**: each lead carries a full state history/timeline (new → dialing → qualified/booked/suppressed/etc.).

## 7. Provider abstraction layer (PAL) — pluggable AI/voice vendors

- TTS, STT, and LLM are **registries of interchangeable adapters** — ElevenLabs, Deepgram, Whisper, Anthropic, OpenAI, Gemini, Azure Speech, Google Cloud TTS, self-hosted OpenAI-compatible endpoints — plus an always-registered simulation adapter for each capability.
- **Resolution hierarchy with automatic failover**: flow node override → campaign → country pack → tenant → platform default, walking a **reorderable fallback chain** per capability; a hop with no configured credentials is skipped at runtime automatically (down to the simulation adapter, which is why calls always work in dev with zero keys).
- **Per-capability credential schemas** — the Providers page renders the right form per adapter instead of assuming every provider takes just one API key (e.g. Azure Speech needs `apiKey + region`; a self-hosted LLM needs `baseUrl + model + apiKey?`).
- **Three independently configurable LLM roles**: conversation, summary, scoring — each can point at a different model/provider.
- **Per-node LLM override**: a flow's qualification node can run a cheap/fast model while its objection-handling node runs a stronger one.
- **Secrets vault**: credentials stored per tenant as an AES-256-GCM-encrypted bundle; environment variables are the local-dev fallback only.

## 8. Recording & QA

- **Dual-leg recording**: the AI leg and the human leg are captured separately and then presented as one stitched timeline (with offset alignment) on the lead's record.
- **Automatic PII redaction**: transcripts are redacted by default in the UI (e.g. phone numbers masked to `04XX XXX 062`); raw access is available but audited.
- **100% auto-QA**: every call gets an automatic QA score against a rubric — no manual sampling required to get baseline quality signal.
- **Retention & legal hold**: region-pinned storage paths per tenant, retention-based purge, and a legal-hold flag that overrides purge.

## 9. Compliance (country packs)

- Each **country pack** (Australia shipped for pilot) encodes: DNC/wash-list rules and expiry (e.g. ACMA 30-day wash), legal calling hours, public holidays, mandatory disclosure text, and timezone hints.
- Compliance events (disclosure spoken, opt-out triggered, wash blocked a dial, etc.) are recorded per call and surfaced in the call deep-dive and dashboard.

## 10. Analytics & dashboards

- **KPI band**: dials, connect rate, transfers, bookings, cost-per-booking, average handle time, average QA score.
- **Lead funnel** and **objection intelligence**: objection frequency, rebuttal win-rate, and "bookings at risk" (leads currently stuck on an unresolved objection).
- **Outcome / AMD mix** and a **best-time-to-call heatmap**.
- **Call deep-dive**: redacted transcript, score-over-time chart, compliance event log, provider/cost breakdown per call.
- **Agent & team insights** (BPO-floor-style):
  - *My insights* (any floor role): today/7-day/month/30-day view of calls handled, bookings, conversion %, talk time, AHT, avg QA, recordings; transfer-offer discipline (offered/accepted/declined/timed-out, acceptance rate, average accept speed); hourly/daily volume timeline; disposition mix; recent calls with expandable redacted AI summary.
  - *Team insights* (Admin/Supervisor/QA/Owner): one roster row per agent with the same metrics plus live presence and occupancy %; click-through to a full member drill-down; an AI-vs-human floor timeline showing how AI-dialed volume converts into human-bridged work.
  - Presence is logged as auditable server-side segments (not inferred from the client), which is what makes occupancy % and adherence reporting trustworthy.

## 11. Administration & platform

- **RBAC**: Owner / Admin / Supervisor / Agent / QA roles, enforced at the API (verified: agents get 403 on team-level endpoints).
- **Immutable audit log**: every administrative action records actor, action, entity, and before/after state; append-only, queryable by Admin/QA.
- **Pause-everything kill switch**: an Admin/Owner can halt all dialing for a tenant instantly.
- **Multi-tenancy**: every collection is tenant-scoped and indexed accordingly; per-tenant quotas.
- **Webhooks**: HMAC-SHA256-signed delivery with exponential-backoff retry, for integrating call/booking events into external systems.
- **API keys**: scoped, SHA-256-hashed, for programmatic access.
- **Auth**: JWT sessions with TOTP-based 2FA.
- **Health**: a public health endpoint plus a live count of active channels.

---

## 12. The prompt flow — how a conversation turn actually reaches the model

This is the mechanism behind section 2 above, spelled out end to end. It's implemented as a pure function, `composeSystemPrompt` in [`apps/api/src/modules/engine/prompt.ts`](../apps/api/src/modules/engine/prompt.ts), shared by the live engine and by the "Preview exact prompt" UI — so what you preview is guaranteed to be what gets sent.

**Where you author the prompt:** Flow editor → `AI_CONVERSATION` node → the node prompt (persona, goal, what to qualify, tone). Campaign-level inputs — rebuttal library, scoring config, summary template — layer on top without touching the node prompt itself.

**What's sent, every turn:**

```
[system]  ← rebuilt from scratch on every single turn:
  1. Node prompt, with {{variables}} interpolated (lead + campaign fields)
  2. "You have already identified yourself as an AI assistant." (if enabled)
  3. ALREADY ANSWERED list, built from live captured facts
     e.g. "owner=true, billHigh=true" — never re-ask these
  4. OBJECTION PLAYBOOK, from the campaign rebuttal library
  5. The JSON envelope contract the reply must conform to

[user]       customer utterance, turn 1  (raw STT text)
[assistant]  model's JSON envelope reply, turn 1
[user]       customer utterance, turn 2
[assistant]  envelope, turn 2
…full rolling history, one pair per turn (not a summary)…
[user]       newest customer utterance   ← the turn being answered now
```

Request parameters: `jsonMode: true`, `temperature 0.6`, `maxTokens 400`.

**Why the system prompt is rebuilt every turn, not built once:** it's the only way the "already answered" list can include a fact captured seconds ago — this is what mechanically guarantees the AI never re-asks a question it already has the answer to, rather than relying on the model to remember correctly.

**Why full history instead of a summary:** at pilot scale (≤16 turns of short exchanges) the full log is small, and it gives the model perfect memory of what's already been said — critical for not contradicting the customer later (e.g. "I already got a call today" must never be re-litigated).

**The reply envelope** — the model's only allowed output shape:

```json
{
  "reply":     "what the AI says next — spoken via TTS",
  "intent":    "continue | qualified | objection | opt_out | callback | end",
  "captured":  { "owner": true, "billHigh": true },
  "objection": "not_interested"  // or null
}
```

**What the engine does with each field** (in `flow-executor.service.ts` → `runConversation`):

| Field | Effect |
|---|---|
| `reply` | Spoken to the customer via the TTS chain; appended to transcript + recording |
| `captured` | Merged into the call's structured facts → recomputes the weighted score → streams to the supervisor floor feed → updates the running summary |
| `intent` | `qualified` (or score past threshold) exits the node onto the flow's transfer edge; `opt_out` writes an instant suppression + polite goodbye; `callback`/`end` follow their own edges |
| `objection` | Logged for objection analytics; marked recovered if the conversation moves past it |

**Ahead of all of this**, the raw customer utterance passes safety rails: a do-not-call phrase triggers an instant opt-out + exit, and profanity/distress triggers a graceful exit — regex-level, so these never depend on the model behaving correctly. And if the model's JSON is malformed, the engine falls back to treating the raw text as `reply` with `intent: continue` rather than failing the call.

**One full turn, end to end:**

```
customer speaks
  → STT chain (provider chain: e.g. deepgram → whisper → simulation)
  → safety rails (opt-out / distress regex)
  → composeSystemPrompt(node prompt, live facts, rebuttals)   [rebuilt fresh]
  → LLM chain (per-node override → campaign → tenant → platform, with failover)
  → parse envelope
  → apply captured facts → recompute score → maybe pre-reserve an agent
  → TTS chain speaks `reply`
  → repeat, or exit the node via intent/score → flow edges decide what's next
```

Which provider actually served each stage of each call is recorded (`providersUsed`) alongside its cost, so per-call cost composition (telco + STT + TTS + LLM) is always inspectable.

See [`prompting-architecture.md`](./prompting-architecture.md) for the provider-credential model and the interactive test-drive mechanics in more depth.
