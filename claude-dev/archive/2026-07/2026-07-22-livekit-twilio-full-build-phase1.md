# 2026-07-22 — Real Twilio+LiveKit voice build, Phase 1 (engine seam)

User committed infra (Deepgram key, Google API key, Twilio account, GCP project)
and wants the full working product, not the browser-playground workaround.

## Architecture locked — "worker runs the conversation, engine stays authoritative"
- **Dial:** NestJS orchestrator (on `TELEPHONY_DRIVER=SIP`) creates the Call doc,
  then asks LiveKit to create a room, dispatch the agent worker, and place a SIP
  outbound call to the lead through the **Twilio Elastic SIP trunk** (LiveKit
  `SipClient.createSipParticipant`). `livekit-server-sdk` (added).
- **Conversation:** Python **LiveKit Agents** worker joins the room, fetches
  `GET /engine/calls/:id/brief` (spoken instructions built from the campaign flow
  prompt + country-pack disclosure + rebuttals — authoritative, not duplicated),
  runs `AgentSession` (Deepgram STT + Google Gemini LLM + TTS). Streams transcript
  + events back to NestJS; scoring is post-call (demo tradeoff vs the build plan's
  per-turn HTTP, which stays the "tighter later" option).
- **Transfer:** worker `request_transfer` tool -> existing NestJS transfer cascade
  -> human joins the same LiveKit room (browser client SDK) -> AI worker disconnects.
- **Recording:** LiveKit egress -> GCS. **Deploy:** GCP.

## Built + verified this phase (typecheck clean)
- `apps/api` add `livekit-server-sdk`.
- `common/config.ts` telephony seam: `PUBLIC_BASE_URL`, `ENGINE_SERVICE_TOKEN`,
  `LIVEKIT_*` (+ `LIVEKIT_SIP_TRUNK_ID`), `TWILIO_*` (all optional). `.env.example` updated.
- `common/auth/service-token.guard.ts` — shared-bearer guard, fails closed.
- `modules/engine/engine.controller.ts` — `GET /engine/calls/:id/brief`
  (@Public + ServiceTokenGuard). Returns spoken `instructions`, disclosure, lead
  context, transfer window. `engine.module.ts` wired with Call/Campaign/Lead/
  FlowVersion models + CountryPacksModule.

## Blocked on user provisioning (delivered checklist) — cannot verify live from here
LiveKit Cloud project+keys; Twilio Elastic SIP trunk + number wired to LiveKit
(outbound trunk id); Deepgram + Google keys; GCP project. Next code bricks (dial
service, worker upgrade, transfer, deploy) built against real creds to verify,
not blind.
