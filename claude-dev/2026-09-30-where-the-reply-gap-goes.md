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

## Decision 30 Sep: keep the worker in Sydney, bring the LLM to it (option B)
Worker now supports `LLM_PROVIDER=vertex` (Gemini on Vertex AI, regional endpoint, VM service account, no key) and `LLM_PROVIDER=gemini` (Gemini API with `GOOGLE_API_KEY`). `GEMINI_MODEL` defaults to `gemini-2.5-flash-lite`; thinking is switched off / minimal. Cerebras and Groq stay in the chain as fallbacks (2.5 s first-token timeout). `livekit-plugins-google==1.6.6` added. `setup.sh` writes `GEMINI_MODEL`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`.

To switch on: enable `aiplatform.googleapis.com`, grant `roles/aiplatform.user` to the runtime service account, set `LLM_PROVIDER=vertex` in `deploy/gcp/.env`, run `setup.sh`, push to `prod`.
Not verified: that the chosen model id is served in `australia-southeast1`, its first-token time there, and that it follows the script and calls the transfer tool as reliably as Qwen. First test calls decide.

## Gemini benchmark, 30 Sep (Gemini API key, from India, call-sized prompt + transfer tool, thinking minimal)
| Model | First token, warm median |
|---|---|
| Cerebras qwen-3.8-27b | 0.45 s |
| Cerebras gpt-oss-120b | 0.48 s |
| gemini-3.5-flash-lite | 1.04 s (0.98–1.47) |
| gemini-3.1-flash-lite | 4.4 s |
| gemini-3.5-flash | 5–65 s (throttled) |
| gemini-2.5-flash-lite | retired for new users (404) |
| gemini-3.8-flash | rejects thinking level "minimal" |
Round trip to the Gemini API for a trivial request: 0.22 s, so about 0.8 s of Flash-Lite's first token is the service itself. A Sydney endpoint can remove at most the 0.2 s: Gemini would still be slower than Cerebras with its ocean crossing. The key may be on a low tier (the 3.5-flash numbers say so), so Vertex on a paid project could differ, but nothing here suggests it beats 0.4 s.
**Conclusion: stay on Cerebras. Do not switch to Gemini for speed.** Worker default `GEMINI_MODEL` changed to `gemini-3.5-flash-lite` (2.5 is retired); the provider stays available behind `LLM_PROVIDER`.

## Vertex AI benchmark, 30 Sep (paid project cocally-509318, from India, same prompt + tool)
| Endpoint | Model | First token, warm median |
|---|---|---|
| australia-southeast1 | gemini-3.5-flash-lite | not served in this region (404) |
| australia-southeast1 | gemini-2.5-flash-lite | not served in this region (404) |
| australia-southeast1 | gemini-3.5-flash | 5.8 s (1.8–20 s) |
| global | gemini-2.5-flash-lite | 0.65 s |
| global | gemini-3.5-flash-lite | 0.79 s |
| global | gemini-3.5-flash | 0.84 s |
Trivial request round trip from India: Sydney endpoint 0.40 s, global 0.15 s. Net of network, Flash-Lite needs 0.5–0.65 s to its first token; Cerebras needs 0.45 s including its 0.25 s of network.
**Final: Gemini is not faster, and the fast Gemini models are not offered in Sydney. LLM stays on Cerebras.** Vertex AI API and `roles/aiplatform.user` are enabled on the project (harmless; leave or remove).

## Test call 29 Sep 17:57 UTC (6abbfc1f), build 5e11972
- Replies (recording): 0.8–2.0 s, typical ~1.1 s. Worker `heard`: 1.16–1.96 s, typical 1.36 s (reads ~0.3 s high against nova word timings on some turns). End of turn was slower than the previous call (0.43–1.05 s).
- Real request round trips from the Sydney VM: Deepgram 422 ms (258 ms on the 17:54 call), Cerebras 211 ms, ElevenLabs 183 ms; LiveKit media 3 ms, jitter 1 ms, no loss. Distance confirmed as the main cost of every stage.
- Missed answer: "Around $400" started 0.08 s after the AI's question ended and was never transcribed. Stall guard fired at 2.5 s (nothing heard), asked to repeat at 4.5 s; the AI's "Sorry, I didn't quite catch that" started 4.9 s after the customer finished. Was 15–17 s before the guard.
- Pattern across calls: every lost answer ("Yeah", "Both", "Around $400") began within ~1 s of the AI finishing. Framework (`audio_recognition.py`): with adaptive interruption, STT events are held while the agent speaks and, when its speech ends, dropped if they fall inside the ignore window; `_flush_held_transcripts` drops the whole buffer when an event has no timestamps. Suspected cause; needs the worker log (state changes, "flushing held transcripts") to confirm before changing `interruption.mode` / `backchannel_boundary`.
- Hand-off fix works: the specialist line followed the answer directly. Transfer returned NO_AGENT after 6.1 s (no agent Available); the customer hung up at the same moment.
- One turn recorded `llm: 0` and no served model: the LLM metric arrived before the end-of-turn metric (a preemptive draft was used) and was cleared. Metric bug, not a call bug.
- Speech-to-text heard "Simple Energy" as "simple and easy" and the spelled name as "Hey, sir. I am really simple".

## Lost answers: worker log for call 6abbfc1f (17:57 UTC) and the fix

Worker log, recording and a Flux replay of the recording, lined up:

| Source | What it shows |
|---|---|
| Recording | AI's question ends 57.83 s, customer's "Around $400" starts 57.91 s (0.08 s later) and ends 59.11 s |
| Worker log | AI `speaking -> listening` 17:59:02.15. Customer logged as speaking only 17:59:03.46-03.96, the last 0.5 s of a 1.2 s answer |
| Worker log | Stall guard at 17:59:06.46 with `interim=''`: no transcript, not even a partial, reached the turn |
| Flux replay | Same audio through Flux returns a transcript by 59.45 s, so Deepgram did hear it |

Deepgram produced text and the worker never saw it. The answer started as the
AI's last word ended, which is the window where adaptive interruption holds
transcripts (`_should_hold_stt_event`) and then drops them at flush. The
framework's trace lines are off at INFO level, so the exact drop line is not in
the log; the three lost answers on 29 Sep ("Yeah", "Both", "Around $400") all
began within about a second of the AI finishing.

Change: `INTERRUPTION_MODE` (default `vad`, was hard-coded `adaptive`). In
`vad` mode no transcript is held. Speech over 0.5 s stops the AI; a false stop
resumes after 2 s of silence. Cost: a long "yeah, yeah" over the AI can now
pause it. Set `INTERRUPTION_MODE=adaptive` to go back.

Other findings in the same log:

- Short answers are slow through Flux: "Yeah." took 1.05 s from end of speech to transcript, against about 0.5 s for full sentences.
- Deepgram is the longest network leg from Sydney: 258, 310 and 422 ms on three calls. Cerebras 211-215 ms, ElevenLabs 183-226 ms.
- Call 6abbfb4e (no answer) still reached "speaking anyway" after the 45 s wait, after the room had closed.
- Gemini is not in the LLM chain in production: `cerebras:qwen-3.8-27b -> cerebras:gpt-oss-120b -> groq`.
