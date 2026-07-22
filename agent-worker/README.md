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
  ElevenLabs / OpenAI / Google needed. Model: `llama-3.3-70b-versatile` — swap in
  `agent.py`.

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
