# Where the reply gap goes, and what shortens it

**Date:** 2026-09-30 (work done late 29 Sep IST). Call analysed: 6abbec25 (29 Sep 16:49 UTC), build 31b7c11.

## Measured
| | Typical | Source |
|---|---|---|
| End of turn | 0.49 s | worker metrics |
| LLM first token (Cerebras qwen-3.8-27b, ~1.3k prompt tokens) | 0.39 s | worker metrics |
| Voice first audio (ElevenLabs Flash v2.5) | 0.27 s | worker metrics |
| Sum of stages | 1.18 s | |
| Gap in the recording (customer's last word → AI's first) | 0.7–1.4 s, typical ~0.9 s | nova-3 word timings on the room recording |
| Network from the Sydney VM | Deepgram 185 ms, ElevenLabs 30 ms, Cerebras 2 ms, LiveKit media 5 ms | worker probes |

## Finding: Flux gives no head start
Replayed the call audio through Flux (`scratchpad/flux_probe.py`) at three settings (eager/final 0.5/0.7, 0.3/0.6, 0.4/0.5).
- On 8 of 10 turns `EagerEndOfTurn` and `EndOfTurn` arrive in the same instant: confidence jumps from under 0.3 straight past 0.7. Preemptive generation therefore starts when the turn ends, not before it. LLM and voice run after end of turn, not during it.
- Flux decides about 0.25 s after the last word. Add the 185 ms Deepgram round trip and that is the 0.45–0.5 s end of turn we measure. Our own waits (VAD 0.25 s, endpoint 0.2 s) are not the binding limit; the transcript's arrival is. (Correction to the earlier note that the waits were the floor.)
- Lower eager thresholds (0.3) fire earlier on a few turns but also fire mid-sentence ("Yes." … "you can talk now"), and 0.4/0.5 split one sentence into two turns. Not worth it.

## What shortens the gap (server side)
| Change | Expected | Needs |
|---|---|---|
| LLM on Groq (same Qwen model) | ~0.15–0.2 s off (measured first token 0.12–0.29 s vs 0.35–0.5 s) | Groq paid tier (free tier rate-limits after 3 requests); `LLM_PROVIDER=groq` |
| Voice on Cartesia Sonic | ~0.1 s off (to verify on a call) | Cartesia key; `TTS_PROVIDER=cartesia`, voice id; client must accept the voice |
| Shorter prompt (1.2–1.5k tokens per turn) | small | prompt stays as is per Nithin unless agreed |
| Speech-to-text near Sydney | ~0.15 s off | parked (Sydney work later) |

Each is an env switch; the Latency tab compares stacks, so: switch one thing, make 2–3 calls, compare.

## Shipped with this note
- `heardMs` per turn: customer stops → AI's first audio, measured directly in the worker (VAD end of speech, corrected for its 0.25 s silence window, to the agent's first audio). Stored as `timings.turns[].heard`, shown on the call page as "heard", aggregated as `summary.heard` in the tenant latency API (UI for the tenant view still to add). This is the number to judge by; the sum of stages overstates.
- Score-triggered transfer now cuts the model's in-flight reply (call 6abbec25: one more question, then the hand-off line).

## Open
- Scoring uses lead-wide facts: call 6abbed4e transferred after one reply on the previous call's score of 85. Reset the test lead before each call until scoring is per call.
- `providersUsed` missing on 6abbed4e (short call closed by the no-agent path).
