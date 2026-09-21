# Enabling human dialing — immediate requirements

**Date:** 2026-07-23
**Goal:** a human caller clicks **Call** on a lead in CoCally and a real phone rings, presenting one of
our carrier numbers, with the agent talking through their browser headset.

**Why it is urgent:** the BPO is prepared to retire VICIdial and run entirely on CoCally. Until this
lands they cannot — 20,000 of their 60,000 monthly calls are human-dialed and have nowhere to go.
**This is the gate on the deal.**

---

## 1. Current state (code-verified)

### What already works

| Piece | Where | Status |
|---|---|---|
| Real PSTN dial-out | `livekit.service.ts` `dialOut()` → `createSipParticipant` | ✅ works (AI path) |
| Room lifecycle | `livekit.service.ts` `ensureRoom()` (idempotent, sets `callId` metadata) | ✅ |
| Scoped join tokens | `livekit.service.ts` `mintToken()` | ✅ |
| **Browser audio for an agent** | `workspace/page.tsx` — `Room`, `TrackSubscribed`, autoplay-block fallback, retry | ✅ **reusable pattern** |
| `livekit-client` in web app | `apps/web/package.json` ^2.20.2 | ✅ installed |
| CLI selection + rotation | `cli.service.ts` `selectCli()` (geo-match, resting, rotation) | ✅ built, **not wired to the wire** |
| Compliance gates on manual dial | `manual-dial.service.ts` — kill switch, calling window, suppression | ✅ enforced |
| Lead claim / ownership / worklist | `manual-dial.service.ts`, `assignment.service.ts` | ✅ |
| Disposition → retry/callback/appointment | `calls.controller.ts` | ✅ |
| Hung-call sweeper | `ops/maintenance.service.ts` | ✅ |

### The actual gap

`ManualDialService.dial()` creates the `Call` document, claims the lead, sets the agent `ON_CALL`
and returns — **it never calls `livekit.dialOut()`**. It also writes `cli: undefined`.

The web page then *simulates* the call: `dialing → ringing → connected` on `setTimeout`
(`manual-dial/page.tsx`), with a comment saying so. There is no audio, no carrier leg, no real state.

Separately, `dialOut()` passes **no `from` number** to `createSipParticipant`, so every call — AI
included — presents whatever default CLI is configured on the Twilio trunk. The entire geo-matching
and rotation engine is currently decorative.

---

## 2. Requirements

### R1 — Manual dial places a real call *(blocker)*

`ManualDialService.dial()` must, after the existing compliance gates pass:

1. Select a CLI via `CliService.selectCli()` — geo-matched to `lead.state`, respecting
   `RESTING`/`QUARANTINED`
2. `ensureRoom(callId)`
3. Mint an agent token and **return it to the browser**
4. **Wait for the agent to actually be in the room** before dialling out
5. `dialOut(callId, lead.phone, { from: cli.number })`
6. `recordDial(cli._id, answered)` once the outcome is known

**Ordering is not optional.** If the SIP leg is created first, the customer can answer to silence.
The agent joins, *then* we dial.

**Acceptance:** agent clicks Call → their own phone (test number) rings → they hear each other →
the call appears on the supervisor floor feed.

### R2 — Present our CLI on the wire *(blocker)*

`LivekitService.dialOut()` takes an optional `from` and passes it into the
`createSipParticipant` options so the customer sees our number.

**Acceptance:** dialling a test mobile displays the selected CLI, not the trunk default. Changing the
lead's state changes the CLI selected (geo-match observable).

### R3 — Agent browser audio *(blocker)*

Port the `workspace/page.tsx` LiveKit pattern into `manual-dial/page.tsx`:

- Join room with the returned token
- **Publish the microphone** (the workspace bridge is receive-oriented; a manual dialler must publish
  from the start)
- Subscribe and attach remote audio
- Keep the existing autoplay-block fallback ("Enable audio" button) and retry — browsers block
  audio without a user gesture and silently failing leaves an agent on a live call hearing nothing
- Microphone permission prompt handled before the first dial, not during

**Acceptance:** two-way audio on a real call, with a visible mic-permission and audio-blocked path.

### R4 — Call control *(blocker)*

The agent needs, in the browser:

| Control | Behaviour |
|---|---|
| **Hang up** | Ends the SIP participant and the room; call moves to `WRAP_UP` |
| **Mute / unmute** | Local track enable/disable |
| **DTMF keypad** | Sends digits over SIP — needed for business IVRs (`ivrPolicy` already models this; `sendDtmf` exists on the runtime interface as a no-op) |

Today the only way a manual call ends is dispositioning it, which is not a real call control.

**Acceptance:** agent can end a live call from the UI; the customer's line drops; the lead and agent
states settle correctly.

### R5 — Real call state, not simulated *(blocker)*

Replace the `setTimeout` phase simulation with real events:

- Subscribe to LiveKit SIP participant state → `RINGING`, `ANSWERED`, `HANGUP`, failure causes
- Map to the existing `CALL_STATES` and to real `CallOutcome` values (`NO_ANSWER`, `BUSY`,
  `DISCONNECTED`, `FAILED`, `ANSWERED_HUMAN`)
- Feed `LeadsService.applyOutcome()` so the retry matrix finally receives true outcomes

Note: `BUSY` / `NO_ANSWER` / `DISCONNECTED` are defined in the retry matrix but **unreachable today**
— the simulation never produces them. This is the first time that logic gets exercised for real.

**Acceptance:** dialling a busy/unanswered/invalid number produces the correct outcome and the
correct `nextAttemptAt` from the campaign retry matrix.

### R6 — Recording to GCS *(important, likely compliance-blocking)*

LiveKit egress → GCS bucket, replacing `recordings.service.ts` `captureLeg()`, which currently writes
the **transcript to a `.txt` file** rather than audio. Wire the resulting object into the existing
`Recording` schema so retention (`purgeAfter`, now scheduled) and legal hold apply.

For an AU BPO, recorded calls are the compliance evidence — treat this as blocking for go-live even
though it is not blocking for a demo.

### R7 — Concurrency and safety *(important)*

- Enforce `maxConcurrentCalls` on the manual path (today only the auto-dialer checks capacity)
- Keep one-live-manual-call-per-agent (already enforced)
- On agent disconnect / browser close: end the SIP leg rather than leaving a customer on a dead room
- Carrier CPS throttling before ramping volume

### R8 — Operator visibility *(important)*

- Manual calls appear on the supervisor floor feed like AI calls
- `recordDial` results feed CLI health so answer-rate decay is detected on human traffic too
  (human dialing is 1/3 of volume — excluding it blinds the reputation system)

---

## 3. Sequencing

| Phase | Contents | Outcome |
|---|---|---|
| **1 — Talk** | R1, R2, R3 | An agent can call a real phone and hold a conversation |
| **2 — Control** | R4, R5 | Production-usable: hang up, mute, DTMF, true outcomes feeding retry |
| **3 — Compliant** | R6, R7, R8 | Recorded, capacity-safe, visible to supervisors — ready for a live floor |

Phase 1 is the demo. **Phases 1–3 together are what lets the BPO retire VICIdial.**

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| **Twilio trial account** only dials Verified Caller IDs | Upgrade before any real testing; confirm AU DIDs provisioned |
| Agent joins late → customer answers to silence | R1 ordering; hold dial until room-joined confirmed |
| Browser autoplay policy blocks audio silently | Reuse the workspace fallback — do not skip it |
| Poor BPO network → jitter, dropped calls | ~60 kbps/participant; test on their actual network before cutover |
| CLI not authorised by carrier | Confirm we may present each DID before dialling with it |
| Retry matrix never exercised with real outcomes | Test busy/no-answer/invalid explicitly in Phase 2 |

## 5. Explicitly out of scope here

Inbound/ACD (a returned call still reaches nothing), supervisor listen/whisper/barge, call-screening
(`Telstra Call Guardian`-style) detection, Redis/multi-instance, and the DNC register wash. All
tracked in `2026-07-23-progress-and-next-steps.md`.

## 6. Commercial note

Until Phase 1–3 ship, the honest structure for the BPO is **phased migration**: run AI campaigns on
CoCally now, keep VICIdial for manual dialing, cut the manual floor over when Phase 3 lands and
retire VICIdial then. Bill at a reduced rate until full cutover. Promising a full cutover date before
Phase 1 exists would be a mistake.
