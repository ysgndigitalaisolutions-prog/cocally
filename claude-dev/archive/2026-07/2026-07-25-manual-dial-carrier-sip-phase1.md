# Manual dial → real carrier call (Phase 1 of human-dialing-requirements.md)

**Date:** 2026-07-25
**Goal:** implement R1–R4 from `2026-07-23-human-dialing-requirements.md` — a human agent clicks
Call on a lead and a real phone rings over a carrier SIP trunk, with two-way browser audio and call
control. Carrier is generic (not decided) — anything LiveKit can point an outbound SIP trunk at.

## What changed

### Backend

- **`livekit.service.ts`**
  - `dialOut(callId, phoneNumber, { from })` now threads a CLI number into `fromNumber` on
    `createSipParticipant` (R2) and sets `waitUntilAnswered: false` so the request returns
    immediately instead of blocking on pickup.
  - Added `hangup(callId)`: removes the SIP participant, then deletes the room (R4).
  - Added `sipParticipantIdentity(callId)` helper (`lead-${callId}`) shared by dial-out and hangup.

- **`manual-dial.service.ts`** — split the old one-shot `dial()` into two steps, per R1's ordering
  requirement (agent must be in the room before the carrier is dialled or the customer can answer to
  silence):
  - `dial()`: runs the existing compliance gates, claims the lead, selects a CLI via
    `CliService.selectCli()`, creates the `Call` (state `DIALING`), opens the LiveKit room, mints the
    agent's join token — returns all of it to the browser. Does **not** call the carrier yet.
  - `connect(tenantId, agentId, callId)`: called once the browser confirms it has joined and
    published its mic. Calls `livekit.dialOut()` with the CLI selected in `dial()`, sets state
    `RINGING`.
  - `hangup(tenantId, agentId, callId)`: ends the SIP leg + room, sets state `WRAP_UP`. Call stays
    open for disposition — hanging up is call control, not call closure.
  - Both new methods reuse a `loadOwnedCall` guard (same tenant, same agent, not yet dispositioned).

- **`manual-dial.controller.ts`**: added `POST manual-dial/calls/:id/connect` and
  `POST manual-dial/calls/:id/hangup`.

### Frontend (`apps/web/.../manual-dial/page.tsx`)

Replaced the `setTimeout` phase simulation with a real LiveKit `Room` connection, following the same
pattern already proven in `workspace/page.tsx`:

- `active` now carries `livekitUrl` / `livekitToken` / `roomName` / `cli` from `dial()`.
- A connection effect: `room.connect()` → publish mic → **then** `POST .../connect`. Phase flows off
  real events (`RoomEvent.TrackSubscribed` on the SIP participant's identity ⇒ `connected`;
  `ParticipantDisconnected` / `Disconnected` ⇒ `ended`) instead of timers.
- Added Hang up, Mute, and a DTMF keypad (`LocalParticipant.publishDtmf`, RFC4733 codes) — needed for
  business IVRs per `ivrPolicy`.
- Added the autoplay-block "Enable audio" fallback (same as workspace).
- Disposition now also covers the `ended` phase (no-answer/busy/disconnected), since automatic outcome
  detection from SIP status codes is R5 (Phase 2), not built here — the agent manually logs what
  happened for now.
- Removed the "runs in simulation" notice card.

## What this does NOT do (explicitly out of scope, tracked in the requirements doc)

- **R5** — real outcomes (busy/no-answer/disconnected) auto-detected from SIP status and fed into
  `LeadsService.applyOutcome()` / the retry matrix. Today the agent manually dispositions.
- **R6** — recording to GCS (still writes a `.txt` transcript).
- **R7** — `maxConcurrentCalls` enforcement on the manual path; browser-close cleanup of a dangling SIP
  leg.
- **R8** — manual calls on the supervisor floor feed; `CliService.recordDial()` health feedback from
  manual answer/no-answer (the auto-dialer path already does this; the manual path does not yet).

## Carrier setup (generic, not tied to Twilio)

No app-side carrier-specific code was needed — `LIVEKIT_SIP_TRUNK_ID` already points at whatever
outbound trunk was created on the LiveKit side via `createSipOutboundTrunk` (IP-authenticated or
registered, either works — LiveKit abstracts it). Local dev already has a trunk configured
(`apps/api/.env` → `LIVEKIT_SIP_TRUNK_ID=ST_AzZWA7GCAdkr`, currently against Twilio Elastic SIP).
Swapping carriers is a LiveKit-side trunk reconfiguration, not a CoCally code change.

## Verification

- `tsc --noEmit` clean on both `apps/api` and `apps/web`.
- Not yet tested against a live phone call — needs a real dial to confirm ordering (agent joins before
  INVITE), CLI presentation, and the connected/ended phase transitions actually fire from real LiveKit
  events end-to-end.
