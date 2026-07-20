# CoCally — Live Calling Build Plan (simulation → real PSTN)

> Written 19 July 2026. Target: first real AI-driven outbound call, then pilot-ready live calling. Companions: [`2026-07-19-architecture.md`](./2026-07-19-architecture.md) §8, [`2026-07-19-call-centre-operations-map.md`](./2026-07-19-call-centre-operations-map.md), [`2026-07-19-cogs-model.md`](./2026-07-19-cogs-model.md) §8.

## 0. Verified starting state (checked against the code, 19 July)

| Layer | State |
|---|---|
| Flow executor, scoring, incremental summary | ✅ Real — [`flow-executor.service.ts`](../apps/api/src/modules/engine/flow-executor.service.ts), 459 lines |
| Dialer, call orchestrator, CLI service | ✅ Real — 562 lines across [`telephony/`](../apps/api/src/modules/telephony/) |
| Transfer cascade, presence, disposition | ✅ Real — [`workspace/`](../apps/api/src/modules/workspace/) |
| Prompt composition | ✅ Real, pure — [`prompt.ts`](../apps/api/src/modules/engine/prompt.ts) |
| Provider adapters (ElevenLabs / Deepgram / Gemini) | ⚠️ **REST only.** [`http.adapters.ts:16`](../apps/api/src/modules/providers/adapters/http.adapters.ts#L16) states it: *"Streaming variants land with the SIP telephony driver"* |
| `CallRuntime` seam | ✅ Real — [`runtime.ts`](../apps/api/src/modules/engine/runtime.ts), simulation driver only |
| **LiveKit / SIP / WebRTC / any audio** | ❌ **Zero.** `grep -ril livekit` returns nothing; no media dependency in `apps/api/package.json` |

**Everything above the `CallRuntime` seam is real and does not change.** The work is entirely below it. That seam is why this is a ~3-week build and not a rewrite.

Accounts in hand: LiveKit Cloud ✅ · Deepgram / ElevenLabs / Gemini keys ✅ · **SIP trunk — arriving 20 July.**

## 1. Tomorrow (20 July) — the trunk handover

### ⚠️ The IP gotcha — resolve before the call

The carrier will ask which IP you send SIP from. **LiveKit Cloud originates SIP signalling from LiveKit's infrastructure, not your app VM.** Supplying the VM IP means every call fails auth.

- **Preferred: ask for SIP digest auth (username/password)** — IP-independent, survives infra changes, simpler on LiveKit's outbound trunk config.
- Fallback: obtain LiveKit Cloud's SIP signalling IP ranges and have the carrier whitelist those.
- **Verify against LiveKit's current SIP documentation before the handover** — the principle is certain, the current IP specifics should be confirmed rather than assumed.

### Checklist — do not end the call without

- [ ] SIP signalling FQDN/IP **and port** (5060, or 5061 for TLS)
- [ ] Auth method — digest credentials preferred; if IP-based, see above
- [ ] **Who supplies AU numbers** — carrier, or separate procurement?
- [ ] **CLI presentation rules** — may we present arbitrary numbers from our CLI pool? What authorisation is required? *(AU has real constraints; the entire CLI pool / geo-match / rotation feature depends on this answer)*
- [ ] Concurrent channel limit
- [ ] Codecs (G.711 µlaw/alaw, Opus) and DTMF method (expect RFC2833)
- [ ] Media IP ranges (firewall)
- [ ] Test number we may dial freely during development

## 2. Architecture decision — worker language

**Decision: Python LiveKit Agents worker, calling the NestJS engine over HTTP per turn.**

LiveKit Agents is Python-first; the mature plugins (Deepgram STT/TTS, ElevenLabs, Silero VAD, turn-detection model) live there. Our engine is TypeScript. Rather than port the engine or accept the less mature Node agents framework:

```
LiveKit room
  └─ Python agent worker
       ├─ Deepgram streaming STT  (plugin)
       ├─ VAD + turn detection    (plugin)
       ├─ LLM step ──HTTP──▶ NestJS POST /engine/turn
       │                        └─ safety rails → composeSystemPrompt → LLM
       │                           → parse envelope → merge facts → rescore
       │                           → maybe trigger transfer → return { reply }
       └─ Deepgram Aura-2 / ElevenLabs streaming TTS (plugin)
```

**Why:** keeps `composeSystemPrompt` as the single source of truth, preserving the documented guarantee that "Preview exact prompt" cannot drift from what production sends. The HTTP hop costs 20–50ms against 500ms+ of LLM inference — immaterial.

**Consequence:** a new deployable (Python worker image) and a new internal API surface (`POST /engine/turn`, service-authenticated). Both are additive.

## 3. Build sequence

### Week 1 — first real call

| # | Task | Notes |
|---|---|---|
| 1.1 | LiveKit outbound SIP trunk configured with carrier credentials | Blocked on §1 |
| 1.2 | Python worker skeleton; joins a room, echoes audio | Proves media path end to end |
| 1.3 | `POST /engine/turn` on NestJS — wraps existing executor, service auth | Thin: the logic exists |
| 1.4 | Deepgram streaming STT + VAD + turn detection in worker | Plugins, not custom code |
| 1.5 | Streaming TTS out (Aura-2 default) | |
| 1.6 | `livekit.runtime.ts` implementing `CallRuntime` | Mirrors `simulation.runtime.ts` (139 lines) |
| 1.7 | Orchestrator requests LiveKit room + SIP dial-out instead of simulation | |
| | **Milestone: one real outbound call, AI conversation, manual teardown** | |

### Week 2 — the full call lifecycle

| # | Task | Notes |
|---|---|---|
| 2.1 | **AMD on real audio** | Hardest remaining item. Budget generously; tune against recordings |
| 2.2 | Voicemail policy paths (silent / prerecorded / AI drop) | Existing REST TTS is fine for drop synthesis |
| 2.3 | Human agent browser join — LiveKit client SDK in workspace | Joins the *same room*; no second PSTN leg |
| 2.4 | **AI worker fully disconnects on transfer accept — not mute** | COGS §8: holds a worker job slot; halves concurrency if wrong |
| 2.5 | Barge-in — customer interrupts AI mid-utterance | Plugin-supported; verify explicitly, it's the top realism tell |
| 2.6 | Egress → GCS, dual-leg, region-pinned path | |
| 2.7 | Measure **real** bridge dead-air; correct the ~230ms claim | Current figure is simulation wall-time, not audio |
| | **Milestone: dial → AI → transfer → human talks → disposition → recording in GCS** | |

### Week 3 — pilot hardening

| # | Task | Notes |
|---|---|---|
| 3.1 | Retry matrix / no-answer / busy against real SIP cause codes | Map carrier codes → outcomes |
| 3.2 | Compliance on live calls: disclosure spoken, opt-out mid-call, calling windows | Regex rails already exist; verify on real audio |
| 3.3 | Concurrency test to carrier channel limit; tune worker sizing | Validates the ~10–20/4vCPU assumption |
| 3.4 | Per-call cost reconciliation vs COGS model | First real `providersUsed` data |
| 3.5 | **Human-leg QA transcript → batch post-call, not streaming** | COGS §8 — cheaper, frees worker slots |
| 3.6 | Worker VM deploy, monitoring, alerting | |
| 3.7 | Soak: sustained dialling on a real list | |
| | **Milestone: pilot-ready live calling** | |

## 4. Known risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Carrier CLI restrictions** | Could invalidate the CLI pool / rotation design | Ask tomorrow (§1). Highest-information open question |
| **AU number provisioning slower than the trunk** | Blocks everything | Confirm tomorrow whether carrier supplies numbers |
| **AMD accuracy on real audio** | False "human" → AI talks to voicemail; false "machine" → hangs up on a live customer | Week 2; tune against recorded calls, keep policy conservative |
| **End-to-end latency > ~1.5s per turn** | Conversation feels robotic; the whole product impression | Measure from week 1. Levers: streaming TTS first-chunk, regional colocation, tighter endpointing |
| IP vs digest auth confusion | ~1 day lost | §1 |
| Simulation-only assumptions leaking | Various | Everything above `CallRuntime` is already exercised — the seam is the protection |

## 5. Explicitly out of scope for this build

Not needed for live calling; from the ops map. Do **not** let these expand week 1–3:

- Inbound / ACD (ops map D17) — unrelated to transfer, which needs no inbound
- Supervisor monitor / whisper / barge (B5–B7) — cheap *after* the room exists; schedule immediately post-pilot
- Agent hold / mute / agent→agent transfer (C7–C9) — same
- Agent script panel (C12) — highest-value non-calling feature; queue next
- Predictive dialing — deliberately never (COGS/ops map: zero abandoned calls is a compliance *advantage*)
- Self-hosting LiveKit — Cloud is correct; revisit only on an AU media-residency contract clause (architecture §16)
