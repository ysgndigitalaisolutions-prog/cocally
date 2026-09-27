# 2026-07-22 — LiveKit voice agent WORKING (Groq + Deepgram), Milestone A

Continues [phase 1](2026-07-22-livekit-twilio-full-build-phase1.md). User provided
real creds (LiveKit, Deepgram, Twilio, Groq); deferred Elastic SIP for now.

## Verified against real endpoints
- LiveKit rooms + SIP API reachable; **worker registers** with the Cloud project
  (`registered worker`, region India South).
- Deepgram STT + Aura TTS (aura-asteria-en) → real audio, HTTP 200.
- Groq `llama-3.3-70b-versatile` → chat completes. (Also available on the account:
  llama-3.1-8b-instant, openai/gpt-oss-120b/20b, qwen3.6-27b.)
- Twilio: authenticates, **Trial** account.

## Stack (final)
- STT: Deepgram nova-2 · TTS: Deepgram Aura (aura-asteria-en) · LLM: **Groq
  llama-3.3-70b-versatile** via the OpenAI-compatible plugin
  (`openai.LLM.with_groq`). No ElevenLabs/OpenAI/Google.
- Worker: `agent-worker/agent.py` — Silero VAD + turn-detector, `request_transfer`
  function tool, optional per-call brief fetch from the engine, `from __future__
  import annotations` for py3.9 safety.

## Environment gotcha (resolved)
System Python is 3.9.6; livekit-agents 1.x needs **3.10+** (imports `TypeAlias`).
No brew/pyenv/conda present → installed **uv** (user-space) + Python 3.12.13,
rebuilt the venv. Imports + boot verified on 3.12. `.env` cleaned of pasted Twilio
address lines that broke dotenv parsing.

## How to run the demo (no phone)
```
cd agent-worker
./.venv/bin/python agent.py download-files   # one-time
./.venv/bin/python agent.py dev              # registers with LiveKit
```
Then open https://agents-playground.livekit.io, connect to the project, allow mic,
and talk. The agent gives the AI+recording disclosure and qualifies.

## Not done
Live mic conversation is the user's to run. Real phone calls (Elastic SIP trunk),
engine event streaming (transcript/score/transfer), recording→GCS, and GCP deploy
remain — deferred per user.
