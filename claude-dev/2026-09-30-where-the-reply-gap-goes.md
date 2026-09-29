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

## Correction, 30 Sep: the stages are mostly distance, not model time
- Cerebras reports its own time per request (`time_info`): queue 3 ms + prompt 15 ms + completion 8 ms, about 0.03 s. First token still arrives after 0.38 s. A trivial `GET /v1/models` on a warm connection takes 0.25 s from India. The 2 ms measured from Sydney was a TCP handshake to Cloudflare's edge, not to the service.
- ElevenLabs API answered from `us-central1` (0.31–0.36 s per small request from India). Deepgram 0.39 s.
- Prompt size and the transfer tool barely matter on Cerebras (2,287 prompt tokens + tool: 0.38 s; 204 tokens, no tool: 0.31 s).
- Cerebras key offers only `qwen-3.8-27b` and `gpt-oss-120b`; gpt-oss is slower to first token (0.46 s).
- So "a faster model" does not exist in a useful sense: the model is 0.03 s. What is slow is that the worker (Sydney) is an ocean away from all three providers (US).
- Worker probe changed from TCP handshake to a real request round trip on a warm connection (`_origin_rtt_ms`), so the next call records the true figure from the VM.

## Options
| Option | Expected typical reply | Cost / risk |
|---|---|---|
| A. Run the worker in a US region, next to Deepgram, Cerebras and ElevenLabs (API, web and DB stay where they are) | ~0.6 s (each stage loses its ocean crossing) | One small extra VM or a second compose host; India calls already have their media in the US via Twilio. Wrong region for AU calls later. |
| B. Keep the worker in Sydney, move the LLM to Gemini Flash-Lite on Vertex `australia-southeast1` | ~1.0 s (LLM 0.39 → ~0.25 s) | Vertex AI API + role for the VM's service account; model behaviour to re-check on the script. |
| C. Groq / Fireworks / SambaNova / Together | little or none | All US-hosted: same ocean crossing as Cerebras. |
Benchmark scripts: `scratchpad/ttft.py`, `ttft2.py` (Cerebras, Gemini API, Anthropic, OpenAI; runs whichever keys are set).
