# CoCally — Demo Guide & UI Parameter Reference

> Written 19 July 2026. Two parts: **(1)** a run-sheet for demoing the product, **(2)** a plain-English glossary of every parameter on screen. Companion to [`product-features.md`](./product-features.md).

## Setup (do this before the demo)

```bash
./start.sh                                  # Mongo + API + web, seeds on first run
pnpm --filter @cocally/api demo-data        # 30 days of realistic history
```

`demo-data` is **idempotent and deterministic** — it only replaces documents tagged `demoSeed: true`, and uses a fixed PRNG seed, so your rehearsal and your live demo show identical numbers. Re-run it any time to reset.

| Where | What |
|---|---|
| App | http://localhost:3000 |
| Short logins | `admin` / `1234` · `agent` / `1234` |
| Full logins | `owner@cocally.dev`, `supervisor@cocally.dev`, `qa@cocally.dev` … / `CoCally!Pilot2026` |

**Open three browser windows before you start** (use separate profiles or incognito):
1. `admin` — driving the demo
2. `agent` — the agent workspace, to receive the transfer
3. `supervisor@cocally.dev` — the live floor feed *(optional but makes the realtime layer visible)*

---

# Part 1 — The run sheet

Target ~15 minutes. The story arc: **a calling program is designed → the AI runs it → a hot lead reaches a human → the business can see everything.**

### Opening frame (say this first)

> "What you'll see is the complete platform running its real engine — the same conversation executor, prompt composition, scoring and transfer logic that will run in production. The one piece not yet connected is the telephony last mile, so no physical phone rings today. Our SIP trunk lands tomorrow and live calling is about three weeks out."

Saying this up front reads as control. Being caught by the question later reads as overselling.

### 1. Dashboard (~2 min) — "the business view"

Land on the dashboard. Point at the KPI band: **667 dials, 46% connect rate, 112 transfers, 52 bookings, $2.38 cost per booking, 82.4 avg QA.**

> "Every one of those is computed from real call records — including cost, which is broken down per call into telco, speech-to-text, text-to-speech and LLM."

Show the **best-time-to-call heatmap** — note the visible dip around midday and the lift late afternoon. That's the kind of thing that changes when you dial.

### 2. Campaign & flow (~4 min) — "how a program is defined"

Campaigns → *Aurora Solar — VIC Pilot*. Walk the config briefly (see Part 2 for what each field means — don't read them all out, pick three).

Open the flow — *AU Solar Qualification v1*. Show the graph: AMD gate → disclosure → AI conversation → transfer → end.

Two moments worth landing:

- **Publish validation** — a flow with a dead end or missing END is rejected structurally, not by convention.
- **Compliance gating** — if the country pack mandates a disclosure, the flow *cannot publish* without it. Compliance is enforced by the system, not by remembering.

Then click **"Preview exact prompt"** on the AI node:

> "This is literally what goes to the model — and it's served by the same function the live engine calls, so the preview can never drift from production."

### 3. Live test-drive (~4 min) — **the centrepiece**

Open the test-drive on the published flow version. You type the customer's side.

Suggested script — this reliably crosses the transfer threshold:

| You type (as the customer) | What to point at |
|---|---|
| "Yeah, go on then." | Conversation starts; disclosure already logged as a compliance event |
| "Yes, we own the place." | **A fact is captured** — watch the score move |
| "About nine hundred a quarter." | Score jumps; this is the qualifying fact |
| "Look, I'm not really interested." | **Objection detected** — the AI uses the campaign's rebuttal, not improvisation |
| "Alright, what would it involve?" | Objection marked recovered; score crosses threshold → **transfer fires** |

Call out along the way:
- The **already-answered list** — ask the same question twice as the customer and the AI won't re-ask it. That's mechanical, not the model remembering.
- The **live score** with the reason for each movement.

### 4. The transfer (~3 min) — "AI to human"

Switch to the `agent` window (set presence **AVAILABLE** beforehand). The transfer card appears with a countdown.

> "The agent gets the lead's name, the captured facts, the live score, and an AI-written summary — at the moment they accept, not after."

Accept it. Show the summary. Set a disposition of **Booked**.

> "That disposition closes the loop — it updates the lead, stops the recording, returns the agent to wrap-up, records talk time, and fires the webhook."

If the supervisor window is open, show the floor feed reflecting all of this live.

### 5. Evidence & insight (~2 min) — "can the business trust it?"

- **Calls → deep-dive**: transcript (PII redacted by default — point at the masked phone number), score-over-time, compliance event log, per-call provider and cost breakdown.
- **Insights → Team**: per-agent metrics, occupancy from server-side presence segments, transfer-offer discipline, and the AI-vs-human timeline.
- **Audit**: every admin action, append-only.

Close on: *"100% of calls are auto-QA'd — there's no sampling."*

### Questions you should expect

| Question | Honest answer |
|---|---|
| "Can it call my mobile now?" | No — telephony is ~3 weeks out. Everything above it is built and running. |
| "Is the AI conversation real?" | Yes — real engine, real prompt composition, real scoring. The *voice* layer is what's pending. |
| "Can a supervisor listen to a live call?" | Not yet. All three parties share one room, so it's a fast follow — see the ops map. |
| "What about inbound calls?" | Outbound only today. Note that transfers don't need inbound. |
| "How much per call?" | ~₹22 platform cost for a 3-min AI + 6-min human call, plus ~₹57 telco. See the COGS doc. |

---

# Part 2 — What every parameter means

## Campaign settings

| Parameter | Plain English | Why it matters |
|---|---|---|
| **Retry matrix** | For each failure type (no answer, busy, voicemail), how many times to retry and how long to wait. | Too aggressive annoys people and burns numbers; too passive wastes the list. |
| **Scoring config** | Which captured facts are worth how many points, and the **transfer threshold** to hit. | This single number decides how many calls reach a human. Raise it → fewer, hotter transfers. |
| **Rebuttal library** | Objection label → the guidance the AI should use. | Injected into the prompt each turn, so the AI has a playbook instead of improvising. Also what the objection analytics groups by. |
| **CLI pool + rotation** | Which outbound numbers to present, and how to cycle them. | Geo-matched numbers get answered more. Rotation avoids one number being spam-flagged. |
| **Pacing** | Dials per available agent. | Guards against dialling more hot leads than you have humans to receive. |
| **A/B split** | Percentage of traffic to each flow variant. | Test a script change on 20% before committing. |
| **Voicemail / IVR policy** | What to do when a machine answers: hang up silently, play a recording, or navigate the menu. | Determines whether voicemail hits are wasted or useful. |
| **Transcription mode** | Whether/how calls are transcribed. | Drives QA and cost — transcription is a real line item. |
| **Transfer-card template** | What the human agent sees at handoff. | The agent's only context. Worth tuning. |
| **Daily budget / channel caps** | Spend and concurrency ceilings. | Hard stops before a runaway costs money. |

## Flow node types

| Node | What it does |
|---|---|
| **AMD gate** | Branches on who/what answered — human, voicemail, IVR, fax, silence. |
| **SPEAK / PLAY** | Says fixed text or plays audio. Mandatory disclosures live here. |
| **AI_CONVERSATION** | The open-ended qualifying conversation. Carries the prompt. |
| **LISTEN_CAPTURE** | Captures a specific answer (e.g. a DTMF key press). |
| **TRANSFER** | Hands to a human agent. |
| **END** | Terminates. Every path must reach one — validation enforces it. |

## Dashboard metrics

| Metric | Definition |
|---|---|
| **Dials** | Total call attempts. |
| **Connects** | Calls where AMD classified a **human**. Not the same as "answered". |
| **Connect rate** | Connects ÷ dials. Health of your list and your numbers. |
| **Transfers** | Calls that reached a human agent. |
| **Bookings** | Calls dispositioned `BOOKED`. |
| **Qualify-to-book** | Bookings ÷ connects. Conversion quality. |
| **Cost per booking** | Total call cost ÷ bookings. The number that decides whether the unit economics work. |
| **AHT** (avg handle time) | Mean call duration from answer to end. |
| **Avg QA score** | Mean automatic QA score, 0–100, against the rubric. Every call is scored. |

## Funnel states (lead lifecycle)

`FRESH` → never attempted · `ATTEMPTED` → dialled, no conversation · `CONTACTED` → spoke, low score · `QUALIFIED` → scored well, below transfer threshold · `TRANSFERRED` → reached a human · `BOOKED` → appointment made · `CALLBACK` → asked to be called later · `NURTURE` → not now · `EXHAUSTED` → retries used up · `DNC` → opted out, never call again.

> ⚠️ Not to be confused with `lead.state`, which is the **geographic** state (VIC/NSW). The lifecycle field is `state_`.

## Objection intelligence

| Metric | Meaning |
|---|---|
| **Frequency** | How often this objection came up. |
| **Rebuttal win rate** | Share where the conversation continued productively after it. **Low rate = the rebuttal isn't working — rewrite it.** |
| **Bookings at risk** | High-scoring leads currently stuck on an unresolved objection. Your follow-up list. |

## AMD classes

`HUMAN` (a person — the only one that counts as a connect) · `VOICEMAIL` · `IVR` (phone menu) · `FAX` · `SILENCE` (answered but nothing heard).

## Dispositions (agent's outcome)

`BOOKED` · `CALLBACK` · `NOT_INTERESTED` · `NOT_QUALIFIED` · `WRONG_NUMBER` · `DO_NOT_CALL` (triggers permanent suppression) · `FOLLOW_UP`.

## Presence states

`AVAILABLE` (ready) · `RESERVED` (being offered a transfer) · `ON_CALL` · `WRAP_UP` (post-call admin) · `BREAK` · `OFFLINE`.

**Occupancy %** = time in ON_CALL ÷ time logged in. Trustworthy because presence is recorded server-side as auditable segments, not inferred from the browser.

## CLI (caller ID) health

`ACTIVE` (in rotation) · `RESTING` (answer rate collapsed — parked to recover) · `QUARANTINED` (likely spam-flagged, withdrawn).
**Answer rate 7d** is what drives automatic resting.

## Per-call cost breakdown

`telco` (the phone minutes) · `stt` (speech-to-text) · `tts` (text-to-speech — usually the largest AI line) · `llm` (the language model — now the *smallest* line). See the COGS doc for rates.

---

## Known cosmetic quirk

KPI **bookings (52)** counts *calls* dispositioned BOOKED; funnel **booked (18)** counts *leads* whose current state is BOOKED. Leads are dialled more than once in the generated history, and a lead's state reflects its most recent call — so the two legitimately differ. If it's likely to be picked up in the room, either explain it in one line or say the word and I'll make the generator hold a lead's terminal state once booked.
