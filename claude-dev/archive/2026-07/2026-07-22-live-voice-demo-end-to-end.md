# CoCally — Live voice demo, end-to-end (no SIP)

> Continues [live-voice-build-progress](2026-07-22-live-voice-build-progress.md). Closes out
> "Milestone A" into a full workspace-triggered demo: dial → real AI voice → live summary on
> the floor → transfer cascade → human bridges in with real audio.

## Decision (with Nithin)

No Twilio SIP trunk yet (needs the Twilio account off Trial + a one-time Elastic SIP Trunk
setup in the Twilio console — deferred, not attempted this session). Stood up the "no-SIP"
path instead: a person plays the lead by opening a public, no-login browser link that joins
the same LiveKit room as the AI worker over WebRTC. Real audio, real STT/LLM/TTS, real
transfer cascade — only the PSTN leg is simulated.

## What's new since the AI worker first registered

The engine `GET /engine/calls/:id/brief` endpoint and the standalone worker existed, but
nothing connected them to the workspace's transfer cascade, floor feed, or briefing panel —
those all run on `SimulationRuntime`/`FlowExecutorService`, a fully separate synchronous
text-based call runtime. This session wired the LiveKit path into the *same* orchestration
primitives (`TransfersService`, `RealtimeGateway`) so a live-voice-demo call looks identical
in the UI to a simulated one, just with real audio behind it.

### API (`apps/api`)
- **`telephony/livekit.service.ts`** (new) — `ensureRoom` (create-or-reuse a
  `call-<callId>` room, `emptyTimeout: 600`, re-applies `{callId}` metadata via
  `updateRoomMetadata` every call since `createRoom`'s metadata param is create-only and a
  no-op on an existing room) + `mintToken` (scoped LiveKit JWT per identity/role).
- **`calls.controller.ts`**:
  - `POST /calls/live-demo` (AGENT/SUPERVISOR/ADMIN) — creates a real `Call` doc + LiveKit
    room, posts a floor card, returns `{ callId, leadJoinPath }`.
  - `GET /calls/:id/lead-token` (`@Public`, no login — a demo lead isn't a CoCally user).
  - `GET /calls/:id/agent-token` (authenticated) — the bridged agent's join token.
  - Disposition now unconditionally clears the floor card (idempotent) since a
    live-voice-demo call has no `SimulationRuntime` `finally` block to do it.
- **`engine.controller.ts`** — two new service-token-guarded endpoints so the Python worker
  drives the exact same UI signals the simulation path does:
  - `POST /engine/calls/:id/transcript` — appends a transcript line, recomputes `call.summary`
    as a rolling excerpt of the last 6 lines (no LLM summarizer in this path — an honest,
    live stand-in for the simulation path's composed summary), emits `transcript.segment` +
    `call.summary.updated` via `RealtimeGateway`.
  - `POST /engine/calls/:id/transfer` — calls `TransfersService.requestTransfer` (same
    cascade/card/bridge/sticky-agent logic the simulation path uses) and returns
    `BRIDGED`/`NO_AGENT`/`FAILED` to the worker.
  - `EngineModule` now imports `WorkspaceModule` for `TransfersService` + `RealtimeGateway`.
- **`common/config.ts`** — **the API never actually loaded `.env`** (no `dotenv` anywhere in
  the codebase); every previously-"verified" LiveKit/Deepgram config check in earlier
  sessions was against the standalone Python worker only, never the NestJS process. Added
  `dotenv` (loaded at the top of `config.ts`, not `main.ts`, so seed scripts/tests get it
  too) + `optionalString()`/`optionalUrl()` Zod preprocessors so a blank-but-declared
  `.env` var (`PUBLIC_BASE_URL=`) doesn't fail `.url()` validation as it did on first boot.

### Worker (`agent-worker/agent.py`)
- `request_transfer` tool now actually calls `POST /engine/calls/:id/transfer` and reacts to
  the result: on `BRIDGED`, says a short handoff line then `ctx.shutdown()` after a 3s grace
  window (so the human's browser has time to connect+publish before the AI leg drops); on
  `NO_AGENT`/`FAILED`, apologises and closes instead of leaving the lead on hold forever.
- `session.on("conversation_item_added")` posts every AI/customer turn to
  `POST /engine/calls/:id/transcript` — the LiveKit-worker equivalent of
  `FlowExecutorService`'s `onLine` hook in the simulation path.
- **Fixed a live bug surfaced by finally running this against the real
  `livekit-agents==1.6.6`** (never actually run end-to-end before): `openai.LLM.with_groq(...)`
  no longer exists in this plugin version — rebuilt as `openai.LLM(model=..., base_url=
  "https://api.groq.com/openai/v1", api_key=os.environ["GROQ_API_KEY"])`.

### Web (`apps/web`)
- Added `livekit-client`.
- **`app/demo/lead/[callId]/page.tsx`** (new, public route outside `(app)`) — the link a
  person opens to play the lead: mic join/mute/leave, no login, no nav chrome.
- **Workspace page**: "Start live demo call" card (campaign + lead pickers off the existing
  `/manual-dial/queue` endpoint, `POST /calls/live-demo`, copyable join link). On
  `transfer.bridged` for this agent, auto-fetches `/calls/:id/agent-token` and joins the same
  LiveKit room with `livekit-client` (mic published, subscribed audio auto-attached to a
  hidden container) — layered onto the existing summary/script/disposition panel unchanged.
  Falls back silently (`onCallAudioLive: false`) for simulation-path transfers, which have no
  LiveKit room.

## Verified live (real LiveKit Cloud + Deepgram + Groq creds, local Mongo via docker compose)
- `POST /calls/live-demo` → real `Call` doc + LiveKit room.
- `GET /calls/:id/lead-token` → valid JWT once `dotenv`/config fixes landed.
- A test participant joining as `lead-<callId>` triggers automatic worker dispatch (no
  explicit `AgentDispatchClient` call needed — the worker registers with no `agent_name`,
  i.e. any-room dispatch).
- Worker fetched the **real** brief and spoke the actual lead's name + the actual campaign's
  disclosure/qualification prompt (`"...calling on behalf of Aurora Solar — VIC Pilot...
  Priya, is now a good time..."`), not the fallback `DEFAULT_INSTRUCTIONS`.
- `GET /calls/:id/briefing` reflected the worker's posted transcript as the live summary,
  identical shape to the simulation path.
- `POST /engine/calls/:id/transfer` reached `TransfersService.requestTransfer` and returned a
  real cascade verdict (`NO_AGENT` in this run — no agent had this campaign in their skill
  set from the seed data, not a bug in the new wiring).
- Session ended cleanly on lead disconnect (`closing agent session due to participant
  disconnect`), no crash.
- `apps/api` + `apps/web` typecheck clean; existing vitest suite (14 tests) still green.

## Not verified this session
- A real bridged transfer through to a human joining with audio (blocked on seed data —
  no agent in this tenant has the Aurora Solar campaign assigned as a skill; wiring itself
  mirrors the already-working simulation-path bridge exactly).
- Actual two-person audio (verified dispatch + brief + transcript pipeline with a headless
  `livekit.rtc` test participant, not a live microphone).
- Real Twilio SIP dial-out — still deliberately deferred; needs the Twilio account off
  Trial + an Elastic SIP Trunk pointed at LiveKit's SIP URI.

## Next
1. Give at least one seeded agent the Aurora Solar campaign as a skill (or clear
   `skills` to unrestricted) so a live-voice-demo transfer actually bridges, then verify a
   real human joins with audio.
2. Recording → GCS (LiveKit egress) — untouched this session.
3. Real Twilio SIP trunk, when ready to move off the browser-simulated lead.
