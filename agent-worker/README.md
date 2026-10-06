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

### Next steps (per [`../claude-dev/archive/2026-07/2026-07-19-live-call-build-plan.md`](../claude-dev/archive/2026-07/2026-07-19-live-call-build-plan.md))

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
- **Deepgram Flux turn-taking** (`STT_MODEL=flux`, default since 28 Sep 2026): the STT decides end-of-turn from the audio and words itself (~260 ms after the person stops) and emits an *eager* end-of-turn earlier, on which the framework starts LLM + TTS (**preemptive generation**) and discards the draft if the person carries on. A mid-sentence pause is capped at 1.5 s (`eot_timeout_ms`). Measured on the nova stack the same day, turns spent ~450 ms just waiting for the final transcript (`stt` column of `timings.turns`), which Flux removes. `STT_MODEL=nova` restores nova-2-phonecall + the local end-of-turn model (`min_delay 0.3 s / max 1.5 s`). Deepgram is reached on `DEEPGRAM_HOST` (default `api.deepgram.com`, US); `api.au.deepgram.com` is the Sydney host and takes the same key.
- **Interruptions** (`INTERRUPTION_MODE=vad`, default since 30 Sep 2026): speech over 0.5 s stops the AI and a false stop resumes after 2 s of silence. `adaptive` (ML backchannel detection) holds transcripts while the AI speaks and lost answers given right as the AI finished on the 29 Sep test calls.
- **Fast LLM failover**: the Cerebras → Groq chain gives a provider 2.5 s for its first token (framework default 5 s) before trying the next, so a stalled provider costs ~3 s, not 5–6 s.
- **Short replies by contract**: the engine brief tells the model to keep every reply under 25 words and never to repeat the introduction the worker already spoke — the model re-introducing itself on turn two was a full wasted turn on the 28 Sep demo.
- **Pre-rendered disclosure**: the mandatory first line is synthesised while the phone is still ringing and played the instant the customer picks up; it already ends with "is now a good moment?", so no LLM round trip happens at the most sensitive moment.
- **Short spoken turns** (`LLM_MAX_TOKENS=160`) so TTS starts sooner; Groq `qwen/qwen3.8-27b` by default (about 190 ms to first token with reasoning off), `openai/gpt-oss-120b` via `LLM_MODEL` when nuance beats speed (about 400 to 650 ms). Reasoning is switched off explicitly for these models.
- **TTS choice by env**: Deepgram Aura-2 (default), Deepgram Flux TTS (`deepgram-flux`), ElevenLabs Flash v2.5 or Cartesia Sonic-3.6 via `TTS_PROVIDER`. First audio measured from the Sydney VM on 30 Sep 2026: Cartesia 78 ms, Flux TTS 96 ms (Sydney host), ElevenLabs 275 ms (served from Singapore). Some Cartesia websockets land on a far back-end (320 ms per sentence); the worker reopens any that take over 300 ms to connect.
- **PSTN noise cancellation** (`NOISE_CANCELLATION=1`, LiveKit BVCTelephony) so the STT hears words, not line hiss.
- **Nothing on the speech path waits on the engine**: transcript/scoring posts are fire-and-forget; the engine's per-turn fact extraction runs on the fast model tier and every provider call is time-boxed.
- **No dead air**: comfort audio/hold music plays from the moment a transfer is requested until the human agent's audio track appears.

Where the milliseconds go from Sydney (worker + LiveKit `aus`), measured 29-30 Sep 2026 as real request round trips: Deepgram US host 258-422 ms against about 30 ms on the Australian host; Cerebras about 213 ms (0.03 s of it is model time); ElevenLabs 183-275 ms; Cartesia voice 78 ms. Full tables: `claude-dev/2026-09-30-india-latency-plan.md`. Older figures follow. Measured 28 Sep 2026 (nova stack, Cerebras qwen, ElevenLabs flash): total p50 1.25 s / p95 1.5 s per turn = end-of-turn 560–620 ms (of which final-transcript wait 440–500 ms) + LLM first token 400–530 ms + TTS first byte ~250 ms. Realistic target with Flux is 0.8–1.0 s p50; the dashboard tile tells you what you actually get. Run the worker in `australia-southeast1` next to the LiveKit AU SIP region; do not run it in a US region "because the AI providers are there" — the customer's audio path matters more than the model's.

Two things outside this worker also add to what the customer hears, and neither shows in `timings.turns`:

- **Carrier media anchoring.** A Twilio termination URI without an edge (`<trunk>.pstn.twilio.com`) anchors the call's audio in the US, so an India or Australia customer's voice travels customer → US → Sydney and back on every word. Use the regional URI (`<trunk>.pstn.sydney.twilio.com`, or `.pstn.singapore.twilio.com` for India customers) as `SIP_TRUNK_ADDRESS` and re-run `provision-sip-trunk.sh`.
- **CPU next to the audio.** VAD, noise cancellation and (on the nova stack) the end-of-turn model run on the worker's CPU. On a shared `e2-standard-2` that also runs the API, web and Mongo they compete with everything else; give the worker its own cores (or a `n2-standard-4`) before tuning anything smaller.
