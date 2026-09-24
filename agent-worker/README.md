# CoCally — LiveKit voice agent (demo worker)

The **easiest** live voice demo of the CoCally AI qualification agent. You talk to
it in your browser through the hosted LiveKit Agents Playground — **no phone, no
SIP trunk, no Twilio, no frontend code.** Real streaming speech-to-text → LLM →
text-to-speech with barge-in.

```
Your browser mic  ──WebRTC──▶  LiveKit Cloud room  ◀──  this Python agent worker
(LiveKit Playground)                                     (Deepgram + LLM + ElevenLabs)
```

## Prerequisites

- **Python 3.10+** (livekit-agents needs it). If you only have 3.9, install
  [uv](https://docs.astral.sh/uv/) and run `uv python install 3.12`.
- A **LiveKit Cloud** project — grab `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET` from the dashboard.
- **Deepgram** (STT + Aura TTS) and **Groq** (`GROQ_API_KEY`, runs the LLM). No
  ElevenLabs / OpenAI / Google needed. Model: `qwen/qwen3.8-27b` (set `LLM_MODEL`;
  Groq retired the Llama 3.x models in 2026).

## Run it

```bash
cd agent-worker
# with uv (recommended):
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
# or with a 3.10+ python: python -m venv .venv && ./.venv/bin/pip install -r requirements.txt

cp .env.example .env          # fill LiveKit + DEEPGRAM_API_KEY + GROQ_API_KEY
./.venv/bin/python agent.py download-files   # one-time: VAD + turn-detector models
./.venv/bin/python agent.py dev
```

You should see `registered worker … url: wss://…livekit.cloud`.

## Talk to it

1. Open **https://agents-playground.livekit.io**.
2. Connect it to your LiveKit Cloud project (it reads the same project keys, or
   sign in with your LiveKit account).
3. Allow mic access and start talking — the agent gives its disclosure and begins
   qualifying, exactly like the seeded solar flow.

That's the whole demo. Stop the worker with Ctrl-C.

## What this is (and isn't)

- **Is:** a standalone, on-brand voice agent proving the AI conversation quality —
  the product's core "wow" — with the least possible setup.
- **Isn't (yet):** wired into the CoCally engine, and it doesn't place real phone
  calls. Those are the next two steps:

### Next steps (per [`../claude-dev/2026-07-19-live-call-build-plan.md`](../claude-dev/2026-07-19-live-call-build-plan.md))

1. **Engine integration** — replace the inline `INSTRUCTIONS`/LLM with a call to
   the NestJS `POST /engine/turn` each turn, so `composeSystemPrompt`, fact
   capture, and scoring stay the single source of truth (worker auths with
   `ENGINE_SERVICE_TOKEN`).
2. **Real phone calls** — pair **LiveKit SIP** with a carrier trunk (e.g. **Twilio
   Elastic SIP Trunk**) to dial actual phones, and have the CoCally orchestrator
   request the room + SIP dial-out via `livekit.runtime.ts` (the `CallRuntime`
   seam is already there; `TELEPHONY_DRIVER=SIP` selects it). LiveKit Cloud stays
   the media plane — no self-hosting for demos.
3. **Warm transfer** — a human joins the same LiveKit room (browser WebRTC via the
   LiveKit client SDK) and the AI worker disconnects on accept.


## Latency: how the voice loop is tuned (pilot 2026-09)

Voice-to-voice latency = end-of-turn detection → LLM first token → TTS first byte, plus network. Every turn is measured by the worker (`metrics_collected`) and posted to `POST /engine/calls/:id/metrics`; the dashboard shows p50/p95 and each call's deep-dive shows the breakdown. Budget per stage is logged as a warning when exceeded (`LATENCY_BUDGET_S`).

What is in place:

- **Prewarmed processes** (`prewarm_fnc`, `WORKER_IDLE_PROCESSES`): Silero VAD and the end-of-turn model are loaded once per process, not per call.
- **Word-level end-of-turn model** (`turn_detector` English) with dynamic endpointing `min_delay 0.3 s / max 2.0 s`, adaptive interruption (backchannels do not cut the agent off), **preemptive LLM + TTS** (generation starts before the turn is confirmed).
- **Pre-rendered disclosure**: the mandatory first line is synthesised while the phone is still ringing and played the instant the customer picks up; it already ends with "is now a good moment?", so no LLM round trip happens at the most sensitive moment.
- **Short spoken turns** (`LLM_MAX_TOKENS=160`) so TTS starts sooner; Groq `qwen/qwen3.8-27b` by default (about 190 ms to first token with reasoning off), `openai/gpt-oss-120b` via `LLM_MODEL` when nuance beats speed (about 400 to 650 ms). Reasoning is switched off explicitly for these models.
- **TTS choice by env**: Deepgram Aura-2 (default), ElevenLabs Flash v2.5 (~75 ms TTFB) or Cartesia Sonic-2 (~90 ms) via `TTS_PROVIDER`.
- **PSTN noise cancellation** (`NOISE_CANCELLATION=1`, LiveKit BVCTelephony) so the STT hears words, not line hiss.
- **Nothing on the speech path waits on the engine**: transcript/scoring posts are fire-and-forget; the engine's per-turn fact extraction runs on the fast model tier and every provider call is time-boxed.
- **No dead air**: comfort audio/hold music plays from the moment a transfer is requested until the human agent's audio track appears.

Where the milliseconds go from Sydney (worker + LiveKit `aus`): Deepgram and Groq are US-hosted, so expect ~150 ms RTT on each of STT-final, LLM and TTS. Realistic target is 700–900 ms p50 voice-to-voice; the dashboard tile tells you what you actually get. Run the worker in `australia-southeast1` next to the LiveKit AU SIP region; do not run it in a US region "because the AI providers are there" — the customer's audio path matters more than the model's.
