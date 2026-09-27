# CoCally — Live voice build: progress tracker

> Consolidated status of the real Twilio/LiveKit voice build (22 July 2026).
> Granular logs: [phase 1 engine seam](2026-07-22-livekit-twilio-full-build-phase1.md),
> [worker working](2026-07-22-livekit-voice-agent-working.md),
> [easiest-demo pivot](2026-07-22-livekit-voice-agent-demo.md),
> [**end-to-end no-SIP demo**](2026-07-22-live-voice-demo-end-to-end.md) — dial trigger,
> live summary, transfer cascade, and human audio bridge wired into the workspace.
> [**real Twilio SIP dial-out**](2026-07-22-real-twilio-sip-dialout.md) — actual PSTN call
> placed and heard by the user, plus summary/audio fixes.
> Original plan: [live-call-build-plan](2026-07-19-live-call-build-plan.md).

## Goal
Full working AI-voice demo: outbound call → AI qualifies (streaming STT→LLM→TTS,
barge-in) → warm transfer to a human → disposition + recording. LiveKit Cloud for
media; deploy on GCP. User supplied real creds (LiveKit, Deepgram, Twilio, Groq).

## Architecture (locked)
"Worker runs the conversation; the engine stays the source of truth."
- **Dial (deferred):** NestJS orchestrator on `TELEPHONY_DRIVER=SIP` → LiveKit
  room + agent dispatch + SIP dial-out to the lead via a Twilio **Elastic SIP
  trunk**. Uses `livekit-server-sdk`.
- **Conversation:** Python **LiveKit Agents** worker joins the room, fetches
  `GET /engine/calls/:id/brief` (authoritative spoken prompt + disclosure +
  rebuttals), runs `AgentSession`. Scoring post-call.
- **Transfer:** worker `request_transfer` tool → existing NestJS cascade → human
  joins the same room → AI worker disconnects.
- **Recording:** LiveKit egress → GCS.

## Stack (final, all verified)
| Layer | Choice | Verified |
|---|---|---|
| STT | Deepgram nova-2 | ✅ HTTP 200 |
| TTS | Deepgram Aura (aura-asteria-en) | ✅ real audio |
| LLM | **Groq llama-3.3-70b-versatile** (OpenAI-compatible plugin) | ✅ completes |
| Media | LiveKit Cloud (`demo-cocally-…`) | ✅ worker registers |
| Trunk | Twilio (Trial) — Elastic SIP deferred | auth ✅ |
| VAD/turn | Silero + turn-detector | ✅ models downloaded |

Alt models on the Groq account: llama-3.1-8b-instant, openai/gpt-oss-120b/20b,
qwen3.6-27b.

## Done + verified
- **Worker** (`agent-worker/`): agent.py (Deepgram STT+TTS, Groq LLM, VAD,
  turn-detector, `request_transfer` tool, optional engine brief fetch),
  requirements.txt, .env, README. Boots on Python 3.12 and **registers with
  LiveKit Cloud**.
- **Engine seam** (`apps/api`): `GET /engine/calls/:id/brief` (`EngineController`,
  service-token auth via `ServiceTokenGuard`, fails closed); config vars for
  LiveKit/Twilio/public-url/engine-token; `livekit-server-sdk` added. Typecheck clean.
- **Secrets:** `apps/api/.env` + `agent-worker/.env` populated, gitignored;
  shared `ENGINE_SERVICE_TOKEN` generated + mirrored.
- **Env fix:** installed uv + Python 3.12.13 (system was 3.9.6, too old for
  livekit-agents 1.x).

## Milestone A — READY (no phone)
Talk to the agent in-browser:
```
cd agent-worker && ./.venv/bin/python agent.py dev
```
then open https://agents-playground.livekit.io → connect to the project → allow
mic → talk. (Live mic conversation is the user's to run; everything up to it is
verified.)

## Not done / next
1. Run the CoCally API so the worker pulls the authoritative brief (vs built-in default).
2. Engine event streaming: worker → API for transcript/score on the floor feed.
3. Real phone calls: Twilio Elastic SIP trunk + LiveKit outbound trunk + orchestrator
   `TELEPHONY_DRIVER=SIP` dial path. (Deferred by user; Trial account also needs
   upgrade for arbitrary destinations.)
4. Warm transfer (human joins room) + recording → GCS.
5. GCP deploy (worker + api + web).
