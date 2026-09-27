# 2026-07-22 — LiveKit voice-agent demo (easiest path) + telephony config seam

## Decision
User wants a real voice-AI demo, "easiest to demo", not AU-specific, Twilio
optional. Chosen path: **LiveKit Cloud + LiveKit Agents Python worker + hosted
LiveKit Agents Playground** — talk to the AI in-browser via mic, NO phone / SIP
trunk / Twilio / frontend code. PSTN (Twilio Elastic SIP trunk + LiveKit SIP) is
a deliberate later add-on. Matches the existing plan
([2026-07-19-live-call-build-plan.md](2026-07-19-live-call-build-plan.md),
[2026-07-19-deployment-strategy.md](2026-07-19-deployment-strategy.md) §5b:
LiveKit Cloud, no self-hosting).

### Architecture clarification (corrected user's mental model)
Twilio and LiveKit are different layers, not alternatives: LiveKit Cloud = media
plane + SIP bridge + hosts the AI agent; a carrier SIP trunk (Twilio Elastic SIP
Trunking / Telnyx) = the PSTN connection + numbers that LiveKit SIP dials
through. Real calls need BOTH. The browser demo needs NEITHER.

## Built
- `agent-worker/agent.py` — standalone LiveKit Agents voice worker: solar
  qualifier grounded in the seeded flow (mandatory AI+recording disclosure, then
  one-question-at-a-time qualification). Deepgram STT + OpenAI LLM + ElevenLabs
  TTS + Silero VAD, `AgentSession` API (livekit-agents 1.x).
- `agent-worker/requirements.txt`, `.env.example`, `README.md` (run steps +
  playground + next steps).
- `apps/api/src/common/config.ts` — telephony config seam for later PSTN:
  `PUBLIC_BASE_URL`, `ENGINE_SERVICE_TOKEN`, `LIVEKIT_*` (+ `LIVEKIT_SIP_TRUNK_ID`),
  `TWILIO_*`. All optional (only needed when `TELEPHONY_DRIVER=SIP`).

## Verified
- `apps/api` typecheck clean; `python3 -m py_compile agent-worker/agent.py` OK.

## NOT verified (needs user infra — cannot run from this session)
- Live worker run: needs their LiveKit Cloud creds + Deepgram/ElevenLabs/OpenAI
  keys + a Python env + a mic. Code follows current LiveKit patterns but is
  unrun. Verify `livekit-agents` version matches import paths on first `pip install`.

## Next steps
1. Run the worker + playground to confirm the conversation (user).
2. Engine integration: worker calls NestJS `POST /engine/turn` (not yet built) so
   prompt/facts/scoring stay single-source-of-truth.
3. PSTN: LiveKit SIP + Twilio Elastic SIP trunk; implement `livekit.runtime.ts`
   (`CallRuntime`) + branch `call-orchestrator.service.ts:75` on `telephonyDriver`.
4. Warm transfer: human joins same room via LiveKit client SDK; AI worker
   disconnects on accept.
