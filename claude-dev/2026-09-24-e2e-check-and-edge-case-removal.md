# End-to-end functional check and edge-case removal before the Monday pilot

**Date:** 2026-09-24
**Ask:** "We ship Monday. Before we check the deployment, understand and check the functionality end to end and remove the edge cases. Put yourself in the role of the call centre / admin / dialer: do you have everything you need — screens, buttons, sounds, clean summary, impeccable voice pipeline?"

## What was done

1. Baseline: shared build, typecheck (api + web), 33 unit tests — all green on the starting tree.
2. Drove the real flow over REST + Socket.IO against the dev API (scripts in the session scratchpad, not committed): login with TOTP enrolment, clock-in, AI dial with scripted replies, transfer offer, accept, bridge, briefing, current-call recovery, disposition, then the negative paths (timeout, decline, no agent, socket drop mid-call, double accept, double disposition, malformed ids).
3. Five read-only audits in parallel over telephony/engine, workspace/presence, leads/compliance, auth/users/recordings/reports/webhooks, and a persona walk (admin, agent, voice pipeline). ~110 findings; the P0/P1s below were fixed and re-verified, the rest are listed under "Not done".
4. After the fixes: typecheck clean (api, web), 4 test files / 19 tests pass (two new test files), Next production build passes, and a third e2e pass confirms every fixed path.

## The flow, as it stands (simulation driver; the live path differs only where noted)

Admin activates a campaign → `DialerService` ticks every 5 s: kill switch → daily budget (now counted in `BUSINESS_TIMEZONE`, default Australia/Sydney) → channel cap → free agents → pacing → atomic lead lock → calling window in the lead's zone (national + per-state holidays) → suppression stack (DNC wash, opt-out, frequency cap, client list) → CLI pick → `CallOrchestratorService.placeCall`. Simulation runs AMD → disclosure → flow → scoring in-process; live hands the INVITE to LiveKit (now `waitUntilAnswered`, so answer / busy / no-answer come from the awaited INVITE and the SIP status, not from a `participant_joined` that fires while ringing) and the Python worker speaks the disclosure verbatim, posts turns to `/engine`, and calls `request_transfer`. `TransfersService` reserves an agent, pushes the card (now with the facts captured so far), waits the accept window, cascades. On accept the bridge is a conditional write against a still-live call. The agent's bar owns hold, mute, DTMF, transfer, **Hang up (any source)** and, only after the call ends, the disposition, which books/schedules first and commits the call last, then releases the SIP leg, the recording, the pacing slot and hands the agent straight back to AVAILABLE.

## Edge cases removed (verified)

### Call lifecycle
- Disposition saved the call before validating the appointment/callback time → a typo left the call un-dispositionable, no appointment, lead stuck TRANSFERRED, agent ON_CALL forever. Now: validate → book/schedule → commit; past/invalid times rejected; ownership check (agent can only close their own call); a still-live call is hung up, egress stopped, pacing slot released; agent returns to AVAILABLE (`wrapup.finished`).
- No way to hang up an AI-transferred or predictive call from the bar (only manual had a route): `POST /call-control/calls/:id/hangup` for every source, persists WRAP_UP + deadline before dropping the leg so the racing webhook is a no-op.
- Transfer accepted after the customer hung up resurrected a COMPLETED call. Bridge is now conditional; a finalised call cancels its pending offers.
- Live answer signal: `participant_joined` fires while ringing → every unanswered real call was "answered" and frequency-capped for 14 days; voicemail counted as a human answer. Now: awaited INVITE with `waitUntilAnswered`, SIP status → retry matrix, `amdClass` VOICEMAIL/IVR/FAX/SILENCE → the right outcome.
- Pacing registry leaked a slot whenever a call was closed by disposition/external transfer/sweep, and read zero after a restart. Now released on every path and rebuilt from live calls on boot.
- Lead lock reclaimed at 10 min while the conversation was still live → second INVITE to the same person. Reclaim now checks for a live call.
- Trunk outage burned an attempt per lead per hour at full pacing. FAILED no longer counts an attempt; five consecutive INVITE failures auto-pause the campaign (`campaign.auto_paused` event).
- Manual dial: double `connect()` re-dialled or tore down a ringing call (atomic DIALING→CONNECTING guard); an orphaned WRAP_UP/FAILED call locked the agent out of dialing (guard is live-states only; `current-call` re-serves an un-dispositioned WRAP_UP call so the disposition form comes back after a reload); dial of a non-dialable or already-on-a-call lead refused; `lastContactedAt` no longer stamped at dial time.
- Hung-call sweep keyed on start time killed long live calls; now keyed on last activity, skips WRAP_UP, releases resources.
- Second agent on a warm/conference call was never released when the call ended; `warmHandovers` and supervision fields are now cleared.
- Simulation call that threw mid-conversation left the call/lead stranded; now finishes as FAILED.
- Engine: transcript append is atomic (`$push`), opt-out regex widened, `TRANSFER_PENDING` reverts to IN_CONVERSATION on NO_AGENT and a HUMAN callback is scheduled in 10 min (the AI promises one), live bridge now emits `lead.qualified`/`transfer.accepted` and moves the lead to TRANSFERRED like the simulator.
- Egress webhooks were dropped (room name lives on `egressInfo`).

### Floor / presence
- Socket disconnect forced OFFLINE immediately → every reload or Wi-Fi blip took the agent off the floor, and mid-call the disposition's release found nobody. Now a 45 s grace (`PRESENCE_DISCONNECT_GRACE_SECONDS`), and ON_CALL/RESERVED are never touched by it.
- Agent could flip to AVAILABLE/OFFLINE or clock out mid-call → double-booked or stranded. `setPresence`/`clockOut` return 409 while ON_CALL/RESERVED; the Workspace buttons are disabled with the reason.
- RESERVED orphaned by an API restart (offers are in-memory) stayed forever; a sweep releases reservations older than 3 min.
- Socket auth now applies the same live checks as HTTP (deactivated / signed-out-everywhere users are disconnected).
- `GET /workspace/me` returns `pendingOffer` so a reload mid-countdown re-renders the card.
- Decline was reported to the agent as "offer window elapsed".

### Web (agent + admin desktop)
- AI transfer offers, bridges and predictive bridges were only handled on `/workspace`; an Available agent on Manual dial / Insights / Leads silently timed the customer out. All moved into `GlobalCallBar` (mounted for the whole session), which now also **rings** (WebAudio, no asset) and flashes the tab title while any offer is waiting.
- Dispositions were offered while the customer was still connected; now only after the call has ended, with a hint.
- "Reconnecting to the floor" strip on socket loss; presence/shift/pending offer re-read on reconnect.
- Reload between dial and connect now re-issues the (guarded) connect; hold audio is only re-engaged by the agent who owns the call; a recovered WRAP_UP call comes back as the disposition form with its countdown.
- "Already dispositioned" from another tab clears the bar instead of sticking.
- Recording playback: `GET /calls/:id/recording` mints a 15-minute presigned S3 URL (hand-rolled SigV4, no SDK) and the Calls deep-dive shows an `<audio>` player.
- Live demo hidden from the nav in production builds; 401 clears the cached user too.

### Voice worker (`agent-worker/agent.py`)
- The worker joined **every** LiveKit room, including manual-dial rooms, and would speak its disclosure over a human agent's call. The brief now returns `manual: true` for human-fronted calls and the worker leaves; it also leaves rather than ad-libbing when the engine brief is unavailable.
- Disclosure is spoken verbatim (`session.say`, uninterruptible) before the LLM's first turn and logged as a `RECORDING_DISCLOSURE` compliance event via the new `POST /engine/calls/:id/compliance`.
- Transfer cascade: "let me get a specialist on the line" + hold music **before** the transfer POST (the customer used to hear dead air for the whole accept window); POST timeout raised from 30 s to cover the full cascade bound; NO_AGENT now hangs the customer up after the apology instead of leaving a silent line.
- Fails fast at boot when GROQ/DEEPGRAM/LIVEKIT keys are missing.

### Leads / compliance
- Every manual dial tripped the 14-day frequency cap for the lead itself (a promised callback was refused the next day). `lastContactedAt` is stamped on an answered disposition; CALLBACK-state leads bypass the cap.
- DO_NOT_CALL disposition never wrote a suppression entry (re-import would dial them again). It does now; `POST /leads/opt-out` normalises the phone (a typed `0412 345 678` used to suppress nobody).
- WA/NT leads defaulted to Sydney/Adelaide time (dialled at 6am Perth). Timezone now inferred from postcode ranges and full state names before the area code.
- CSV import: UTF-8 BOM no longer rejects every row; a ragged row no longer aborts the file; foreign numbers are rejected (they sat DNC_WASH_STALE forever); emergency blocklist is an equality check (`0412 345 000` was rejected).
- Per-state 2026 public holidays (WA King's Birthday is **launch day, 28 Sep**; NSW/SA/QLD holidays 5 Oct) keyed by zone, and the stored pack is refreshed from code on boot.
- Unique `{tenant, campaign, phone}` index so a double-clicked import cannot duplicate leads.
- `PATCH /campaigns/:id` was completely unvalidated (a string budget stalled the dialer; a retry rule with no delay retried a lead every 10 min forever). Zod-validated now. Human-only (predictive) campaigns can be activated without a flow. Predictive status card says plainly that predictive dialing is not available on the live trunk.

### Auth / platform
- ADMIN could take over any OWNER (reset link, 2FA reset, demote/deactivate); last active owner cannot be removed.
- Login throttle 10/min per IP locked a NATed floor out at 9am → 60/min; global 600 → 3000/min.
- TOTP accepts ±1 step of clock drift. JWT default 8 h → 12 h (a shift). Malformed ids and duplicate keys return 400/409 instead of 500 (global filter). `unhandledRejection` is logged, not fatal. Webhook drain is re-entrant-safe with an atomic claim. Simulation adapters are dropped from provider chains in production / on a live trunk. Reports' bare "to" date includes the whole day. `POST /tenants/pause` and `PATCH /users/:id` validated. Seed refuses to run in production. Container `TZ=Australia/Sydney`; daily rollover cron in the business zone.

## Do I have everything I need? (persona verdict after fixes)

- **Agent:** offer card anywhere + ring + countdown, accept/decline, hear/mute/hold/DTMF/transfer/hang-up, briefing with facts and rebuttals, disposition after the call, wrap-up countdown, reload-proof. Missing: mic/speaker device picker; a denied mic permission still reads as "Could not connect the call".
- **Admin/supervisor:** start/pause, dialer status with reasons, floor feed, listen/whisper/barge, calls with transcript **and audio**, reports with correct date ranges. Missing: a tenant-wide pause button (route exists), force-Available/force-logout for a stuck agent, a roster on the supervisor desk, CSV column mapping UI, bulk lead tools.
- **Voice pipeline:** deterministic disclosure, server-side opt-out rails (regex + DTMF), comfort audio through the cascade, scripted hand-off, worker leaves human rooms. Still unproven on the real trunk: `waitUntilAnswered` + SIP status extraction, egress → S3, and the whisper text (built, never played).
- **Summary quality:** the card/briefing is a template ("Lead X in Y. Score. Facts… Opener…"), readable but not prose. A real LLM summary role exists in PAL; not switched on for the card.

## Not done (ordered)
1. Live-trunk soak of the answer/no-answer/voicemail paths (needs the carrier trunk).
2. Supervisor desk: roster, force-Available, force-logout, tenant pause button; admins opening Manual dial still draw 25 leads each into their own book (`assignment.topUp`).
3. CSV import UI: header mapping, more than 5 rejects shown, SUPERVISOR 403 surfaced.
4. Recording retention/legal hold acts on transcript rows, not the S3 object.
5. Per-tenant PAL health state; provider fetch timeouts.
6. Multi-instance state (Redis) — still single-instance by design.
7. Cosmetic: requirement tags (DASH-07 etc.) in user-facing copy; "Calls sent/Accepted" labels; CSV formula escaping in exports.

## Files
55 modified + 5 new (`common/http/malformed-id.filter.ts`, `common/s3-presign.ts`, `leads/au-geo.ts`, two test files). Nothing committed in this session.

## Later the same day: voice latency pass + carrier digest auth

**Ask:** "top-class voice calling infra, ultra-low latency"; and the carrier can do username/password on the trunk.

Worker (`agent-worker/agent.py`): models prewarmed per process (`prewarm_fnc`, `WORKER_IDLE_PROCESSES`); word-level end-of-turn model wired into `turn_handling` (was installed but unused); disclosure pre-synthesised while ringing and played on pickup, ending with the "good moment?" question so the first LLM round trip is gone; `LLM_MODEL`/`LLM_MAX_TOKENS` (160) and `TTS_PROVIDER` (deepgram | elevenlabs flash | cartesia sonic) env switches; LiveKit BVCTelephony noise cancellation; per-turn EOU/LLM/TTS metrics posted to the engine; `ENGINE_BASE_URL` normalised (compose had `http://api:4000` without `/api/v1`, so every brief fetch would have 404'd in prod — also fixed in compose). Requirements pinned to 1.6.6.

Engine/API: `POST /engine/calls/:id/metrics` → `timings.turnLatencies` + last 200 turn breakdowns; KPIs gain `voiceLatencyP50Ms/P95Ms/voiceTurns` (Mongo 7 `$percentile`), dashboard tile "AI response p50 / p95", calls deep-dive latency line; per-turn fact extraction on the fast model tier (`speedTier: 'fast'` → llama-3.1-8b / haiku / 4o-mini); every provider `fetch` time-boxed at 20 s.

Trunk: `apps/api/src/seeds/provision-sip-trunk.ts` creates/updates the LiveKit outbound trunk with SIP digest auth (`--username/--password`, transport, CLI numbers, optional SRTP) and, with `--inbound`, an inbound trunk + per-call dispatch rule; prints `LIVEKIT_SIP_TRUNK_ID`. Env docs added (`SIP_TRUNK_*`, worker latency knobs).

Verified: API/web typecheck, 19 tests, metrics route stores and slices, KPI endpoint returns p50 1043 ms / p95 1410 ms over 4,340 existing simulated turns. Not run: a real trunk call (needs the carrier credentials) and the ElevenLabs/Cartesia plugins (installed as optional deps, untested here).
