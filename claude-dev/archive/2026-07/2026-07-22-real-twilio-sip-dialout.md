# CoCally — Real Twilio SIP dial-out (live) + summary/audio fixes

> Continues [end-to-end no-SIP demo](2026-07-22-live-voice-demo-end-to-end.md). This session
> moved from a browser-simulated lead to an **actual PSTN call**, and fixed two real bugs
> the user hit while testing: the "summary" was a raw transcript dump, and the bridged
> agent's audio had no status/controls.

## Real phone dial-out — built and verified live

User verified their own number (+91 99023 52425) as a Twilio Trial "Verified Caller ID" —
the only unlock a trial account needs for calling a specific real number, no billing upgrade
required. Their Twilio account already had one number (+1 251 299 9170).

**Twilio infra created via the API directly** (account SID/token were already in `.env`):
- SIP Credential List `cocally-livekit-creds` + one credential (`cocallylivekit` / generated
  password) — this is Twilio's *termination* auth: it authorizes calls arriving at Twilio's
  SIP endpoint *from* LiveKit to be placed out to the PSTN.
- Elastic SIP Trunk `cocally-livekit-outbound` (domain `cocally-livekit-1c9f4.pstn.
  twilio.com`), with the existing Twilio number and the credential list both attached.

**LiveKit side**: `sipClient.createSipOutboundTrunk(name, address, numbers, {authUsername,
authPassword})` — `address` is the Twilio trunk's domain, `numbers` is the Twilio number
used as caller ID, auth matches the credential list above. Returned trunk id
`ST_AzZWA7GCAdkr` saved to `LIVEKIT_SIP_TRUNK_ID` in `apps/api/.env`.

### Code
- **`telephony/livekit.service.ts`** — `dialOut(callId, phoneNumber)`: `sipClient.
  createSipParticipant(trunkId, phoneNumber, roomName, { participantIdentity: 'lead-
  <callId>', playDialtone: true })`. The already-registered AI worker auto-joins the same
  room (automatic dispatch, unchanged) and ends up talking to the SIP participant instead of
  a browser tab.
- **`calls.controller.ts`** — `POST /calls/live-demo` gained `dialMode: 'browser'|'phone'` +
  `phoneNumber`; `'phone'` calls `dialOut` and skips the browser join-link response.
- **`apps/web` workspace page** — "Start live demo call" now has a Browser link / Real phone
  toggle; phone mode shows a number input (hint: Trial accounts only work for a Verified
  Caller ID) and a "📞 Dialing…" confirmation instead of a share link.
- Added `@livekit/protocol` as a direct dependency (needed the `SIPTransport` type; was only
  a transitive dep of `livekit-server-sdk` before, not resolvable from `apps/api`).

### Verified live
Placed a real call end-to-end: `POST /calls/live-demo` with `dialMode:"phone"` →
`createSipParticipant` → **the user's phone actually rang and they heard the AI's real,
campaign-specific disclosure** ("...calling on behalf of Aurora Solar — VIC Pilot... is now
a good time..."). Confirmed by the user directly, not just log inspection.

### Bug fixed while testing
`ctx.shutdown(reason=...)` in `agent-worker/agent.py` is a **synchronous** method in
`livekit-agents==1.6.6` (`-> None`, not a coroutine) — the `_handoff`/`_no_agent_close`
helpers had `await ctx.shutdown(...)`, which threw `TypeError: object NoneType can't be used
in 'await' expression` the moment either path fired (surfaced in the worker log from an
earlier NO_AGENT run, not the phone-dial run). Fixed to call it unawaited.

## Product-quality fixes from user feedback

**"The AI summary has given full transcript"** — the previous session's summary was a
literal stopgap: the last 6 raw transcript lines, not an actual summary. Replaced in
`engine.controller.ts`:
- New `recomposeSummary(call)`, run after every **customer** turn (not AI turns, since new
  facts only ever come from what the lead says): calls `PalService.llm` with `llmRole:
  'SUMMARY'` (an existing provider-chain role, previously unused by this path) to extract the
  campaign's actual configured facts (`campaign.scoring.weights` keys — dynamic per
  campaign, not hardcoded) plus an objection label and appointment slot, as JSON.
- Merges extracted facts into `lead.facts`, recomputes score via the shared `computeScore`,
  and renders `call.summary` via `interpolate(campaign.summaryTemplate, ...)` — **the exact
  same template-rendering path** `FlowExecutorService.renderSummary` uses for the simulation
  path, so a live-voice-demo call's summary looks identical to a simulated one, not a
  bespoke format.
- Also pushes a live floor-card score update (previously stuck at 0 for the whole
  live-voice-demo call).
- Failure mode: if the extraction call throws or returns unparseable JSON, the turn is
  skipped silently — never breaks the live call over a summarizer hiccup.

**"How can an agent talk?"** — was a real gap, not just confusion: no mute control, no
status feedback, and the subscribed audio was appended to a `display:none` container (some
browsers are stricter about muting/pausing hidden media than a merely zero-size one). Fixed
in the workspace page:
- Explicit `audioStatus` state machine (`connecting` → `live` / `blocked` / `error`) shown as
  a banner in the on-call panel.
- `track.attach()` now calls `.play()` and catches autoplay rejection (the room-join here is
  triggered by a socket event after Accept, not a direct click, so autoplay can still be
  blocked) — surfaces an **Enable audio** button instead of silent failure.
- Added a **Mute** toggle (`room.localParticipant.setMicrophoneEnabled`), matching the
  lead-side page's controls.
- Hidden audio container switched from `display:none` to an off-screen 1×1 `overflow:
  hidden` box.

## Verified
- `apps/api` + `apps/web` typecheck clean.
- Real call placed and confirmed heard by the user (see above).
- Worker fix compiles (`py_compile`); restarted clean, no more `TypeError` on shutdown paths.

## Not done / next
- The summary-extraction LLM call adds real latency/cost per customer turn — fine for a
  demo, worth revisiting (debounce, or batch every N turns) before any production use.
- Haven't yet tested a full real-phone call all the way through a transfer + human bridge in
  one run (prior turns verified transfer cascade and phone dial-out separately, not chained).
- Real SIP trunk is demo-grade: one shared credential, no IP ACL, `secure: false` (no TLS).
  Fine for testing: needs hardening (`secure: true` + a proper allowlist, not just a shared
  password) before any real production traffic.
