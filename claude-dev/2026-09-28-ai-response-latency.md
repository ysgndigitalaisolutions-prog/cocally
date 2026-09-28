# 2026-09-28 — AI response latency after the client demo

The client's feedback after today's demo: the AI takes noticeably long to answer; they want the
most responsive agent possible. This note records what the calls actually measured, what was
changed, and what still needs an operator decision.

## What the demo calls measured

Every AI turn posts `eou / stt / llm / tts / total` to `POST /engine/calls/:id/metrics`
(`calls.timings.turns`). Read back for the two demo calls (08:21 and 08:25 UTC, campaign
"Wendy test (India)") and the earlier test calls the same morning:

| Call (UTC) | Turns | total p50 / p95 | end-of-turn p50 | of which transcript wait | LLM first token p50 / p95 | TTS first byte |
|---|---|---|---|---|---|---|
| 08:25 (Shubham) | 5 | 1325 / 1508 ms | 559 ms | 459 ms | 508 / 519 ms | 254 ms |
| 08:21 | 9 | 1243 / 1512 ms | 617 ms | 494 ms | 533 / 619 ms | 238 ms |
| 07:11 | 10 | 1269 / 1531 ms | 560 ms | 441 ms | 412 / 702 ms | 254 ms |
| 27 Sep 15:51 | 11 | 1152 / 1338 ms | 508 ms | 404 ms | 443 / 581 ms | 258 ms |

Stack on all of them: Deepgram `nova-2-phonecall` + local end-of-turn model, Cerebras
`qwen-3.8-27b`, ElevenLabs `eleven_flash_v2_5`, worker on the Sydney VM.

Reading of the numbers:

1. **The end-of-turn step is the biggest slice, and ~80 % of it is waiting for Deepgram's final
   transcript** (440–500 ms after the person stops speaking). The end-of-turn model and the
   0.3 s minimum delay add only ~100 ms on top. Tuning VAD/endpointing knobs would not have moved
   this; the STT itself had to change.
2. **LLM first token 400–530 ms p50, 600–900 ms p95** — Cerebras from Sydney (≈150 ms RTT +
   ≈370 ms model). Groq is faster (~190 ms) but its on-demand rate limit killed the first live
   call, so it stays the fallback.
3. **TTS ≈ 250 ms**, flat. ElevenLabs flash from Sydney; Cartesia/Deepgram would land in the same
   place because the RTT dominates.
4. **Outliers**: the 06:47 call had transcript waits of 12.9 s, 3.7 s and 1.9 s — the known
   Deepgram nova stall on a noisy line (the customer said "Hello?" three times). One 07:11 turn
   waited 1.6 s for the transcript.
5. **A wasted turn**: on the Shubham call the AI re-introduced itself on turn two ("To clarify,
   I'm an AI assistant calling on behalf of…") because the brief told the model "your FIRST turn
   must disclose", although the worker had already spoken the scripted disclosure.
6. **Not in the metrics at all**: the audio path. The Twilio trunk address has no edge
   (`cocally-livekit-1c9f4.pstn.twilio.com`), so Twilio anchors media in the US; an India
   customer's voice goes India → US → Sydney and back on every word, on top of the numbers above.

## What was changed (this commit)

| Change | Where | Expected effect |
|---|---|---|
| **Deepgram Flux** (`STTv2`, `flux-general-en`) with `eager_eot_threshold=0.5`, `eot_threshold=0.7`, `eot_timeout_ms=1500`; turn detection `"stt"`, `min_delay` 0.1 s. `STT_MODEL=nova` restores the previous stack. | `agent-worker/agent.py` `_build_stt` | Removes the ~450 ms transcript wait: Flux emits end-of-turn ~260 ms after speech ends and an *eager* end-of-turn earlier, on which the LLM + TTS start (preemptive generation). Mid-sentence pauses capped at 1.5 s instead of 2–3 s. Target ≈ 0.8–1.0 s p50 per turn. |
| `STT_KEYTERMS` (comma list) passed to Deepgram as `keyterm` | `agent.py`, `deploy/gcp/.env`, `setup.sh`, `.env.example` | Fewer mis-hears of retailer names ("Simply Energy" → "simply an async"), so fewer "sorry, did you say…" turns. Set to the AU retailers the seeded prompt names. |
| nova path: `max_delay` 2.0 → 1.5 s; VAD `min_silence_duration` 0.35 → 0.25 s | `agent.py` | Shorter worst-case wait when the end-of-turn model is unsure; earlier end-of-speech anchor. |
| LLM `FallbackAdapter(attempt_timeout=2.5, retry_interval=0.2)` (framework default 5 s / 0.5 s) | `agent.py` `_make_llm` | A stalled Cerebras costs ~3 s before Groq answers, not 5–6 s. 2.5 s is >2× Cerebras' measured p95. |
| Brief: "You have ALREADY introduced yourself… never repeat" + "keep every reply under 25 words: one acknowledgement, then one question" | `engine.controller.ts` `brief()` | No repeated introduction; shorter spoken turns, which is most of what "feels quick" once the gap is under a second. |
| Metrics carry `sttModel`; stored as `providersUsed.stt` | `agent.py`, `engine.controller.ts` | The dashboard/deep-dive can tell Flux calls from nova calls when comparing. |

Verified locally: `py_compile`, `_build_stt()` constructs the Flux stack and the turn-handling
options offline, `_make_llm()` builds the chain with the new timeouts, API `typecheck` and
`vitest` pass. Not verified: a real call on Flux — do the first one with the desk open and
compare `timings.turns` (the `stt` column should drop to ~0–150 ms).

## Operator decisions still open (not code)

1. **Twilio regional edge** — set `SIP_TRUNK_ADDRESS=cocally-livekit-1c9f4.pstn.sydney.twilio.com`
   (or `.pstn.singapore.twilio.com` while demos are to India numbers), re-run
   `./deploy/gcp/provision-sip-trunk.sh`, paste the trunk id. This is the one change that
   shortens the *audio* path; likely worth 100–300 ms per direction on India calls. Telvoq will
   supersede it for the AU pilot.
2. **Worker CPU** — the worker shares the `e2-standard-2` with API, web and Mongo. VAD, noise
   cancellation and (nova only) the end-of-turn model run on those cores. If the Flux call still
   shows end-of-turn > 400 ms, move the worker to its own VM / `n2-standard-4` before tuning
   anything else.
3. **Groq paid tier** — if the client wants the last 200 ms, Groq `qwen/qwen3.8-27b` at a paid
   rate limit is the fastest first token we have measured (~190 ms + RTT); set
   `LLM_PROVIDER=groq` once the limit is raised. Cerebras stays as fallback either way.
4. **Fillers** ("Mm-hm", "Got it") spoken while the LLM thinks were considered and not done: with
   the gap heading under a second they would sound more robotic, not less. Revisit only if Flux +
   the edge change still leave a visible pause.

## How to check after deploy

```
# per-turn metrics for the latest AI calls (read-only)
cd apps/api && NODE_PATH=$PWD/node_modules MONGODB_URI=... node <scratchpad>/latency-report.js
```
The worker log prints `starting agent (… stt=flux …)` per call and `eou_delay=… transcription_delay=…`
per turn (warnings when over the 1.0 s / 1.0 s / 0.5 s budgets).
