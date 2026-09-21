# Monday go-live runbook — 10 agents, live trunk

**Date:** 2026-07-27
**Audience:** whoever is running the floor on Monday morning, and whoever is on the laptop when it
breaks.
**Scope:** first live shift on a real carrier trunk with ~10 human agents. AI-fronted outbound +
manual dial + warm transfer. Everything below is written against what is actually in the repo on
2026-07-27, not what is planned.

> **Read the limitations section (4) before you promise anything to the client.** Several things a
> BPO floor would reasonably assume are present are not: predictive dialing is deliberately refused
> against a live trunk, there is no inbound routing at all, and the API is single-instance by
> design. Nothing in here is a surprise if you read it now; all of it is a surprise at 9:40am.

---

## 1. Pre-flight config checklist

Two `.env` files matter and they are **not** the same file. `apps/api/.env` drives the NestJS API.
`agent-worker/.env` drives the Python LiveKit Agents worker. Three values must be identical in both
(`LIVEKIT_*`), one must be identical in both (`ENGINE_SERVICE_TOKEN`), and one should be set in both
(`HOLD_MUSIC_URL`). A mismatch in any of them fails silently and looks like a different bug.

Full annotated list lives in `apps/api/.env.example` — this section is what breaks when each one is
wrong.

### 1a. The three that will actually ruin the morning

These are called out separately because each one produces a failure that does **not** look like a
config problem from the UI.

**(i) DNCR must be enabled AND a first wash must have completed.**

`SuppressionService.canDial()` blocks any AU-pack lead whose DNC wash record is missing or expired:

```ts
if (!wash || wash.expiresAt < new Date()) return { allowed: false, reason: 'DNC_WASH_STALE' };
```

With `DNCR_ENABLED` off (or credentials missing) no wash record is ever written, so **every single
lead** is rejected with `DNC_WASH_STALE`. The floor sits idle, agents show AVAILABLE, campaigns show
active, and nothing dials. This is correct fail-closed behaviour — an AU outbound floor dialling
unwashed numbers is the one mistake that ends the business — but the symptom reads as "the dialer is
broken".

Set, in `apps/api/.env`:

```
DNCR_ENABLED=true
DNCR_ACCOUNT_ID=<from the register>
DNCR_PASSPHRASE=<from the register>
DNCR_ENDPOINT=https://www.donotcall.gov.au/dncrtelem/rtw/washing.cfc
DNCR_BATCH_SIZE=200
DNCR_REWASH_AFTER_DAYS=25
```

⚠️ **`DNCR_ENABLED=false` means TRUE.** `config.ts` parses it with Zod's `z.coerce.boolean()`, which
is `Boolean(value)` — the literal string `"false"` is truthy. To turn it off, leave it blank or
delete the line. Same trap applies to `RECORDING_ENABLED`. This is a real footgun in the config
schema; it is documented in `.env.example` rather than fixed because `config.ts` was not in this
session's scope.

Then **verify the wash actually happened before the first dial**:

- `GET /api/v1/dncr/status` (ADMIN) → `enabled: true`, `staleNumbers: 0`, `washedNumbers` ≈ your
  loaded list size, `lastSweep` non-null.
- The sweep runs on a 15-minute `@Interval`, so after loading a list you may wait up to 15 minutes
  for the first pass. Do the list load the night before, or trigger a spot wash with
  `POST /api/v1/dncr/wash` — but note that endpoint **does not persist wash records** (it can't
  attribute an arbitrary number to a tenant), so it proves credentials work, it does not unblock the
  floor. Only the scheduled sweep unblocks the floor.
- Check the wash credit balance: `GET /api/v1/dncr/balance`. A zero balance mid-shift stops
  re-washes, and 25-day-old washes start expiring under you.

**(ii) `LIVEKIT_SIP_TRUNK_ID` must point at a non-trial trunk.**

`LivekitService.dialOut()` is the only SIP INVITE in the codebase and it throws
`ServiceUnavailableException` outright if the trunk id is missing. That case is loud and easy.

The quiet case is worse: a trunk backed by a **Twilio trial account** will connect, but Twilio only
allows calls to verified numbers and prepends a trial notice to every call. You get a call that
technically "works" — LiveKit reports answered, `CallProgressService` stamps `answeredAt`, the AI
starts its disclosure — over the top of a Twilio robot telling the customer this is a trial account.
Confirm the Twilio account is upgraded and the Elastic SIP Trunk is production before Monday. Do not
confirm this by reading the console; confirm it by dialling a number that is *not* on the verified
list (see the smoke test, step 1).

Also confirm `isLiveTelephony()` will return true. It needs **all four** of:
`TELEPHONY_DRIVER=SIP`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, plus
`LIVEKIT_SIP_TRUNK_ID`. Miss any one and the whole stack silently stays on `SimulationRuntime` —
calls "succeed", transcripts appear, dispositions save, and no phone anywhere rings. That is the
single most embarrassing failure mode available on Monday, because everything looks fine.

**(iii) The LiveKit webhook must be registered, at exactly this URL.**

In the LiveKit Cloud project settings, Webhooks:

```
<PUBLIC_BASE_URL>/api/v1/telephony/livekit/webhook
```

The `/api/v1` prefix is `app.setGlobalPrefix('api/v1')` in `main.ts`. Getting the path wrong is the
same as not registering it at all, and the failure is specific and total: **nothing subscribes to
call progress, so a live call never advances past RINGING.** `answeredAt` is never set, no call
reaches a terminal state, `BUSY`/`NO_ANSWER`/`DISCONNECTED` are never produced, the retry matrix
never runs, CLI health never updates, agents never get their wrap-up window, and pacing slots are
never released — so after N calls the dialer stops dialling with no error anywhere.

Verify before the floor logs in: place one test dial, then check the call document reaches
`IN_CONVERSATION` (AI) or `BRIDGED` (manual) rather than sitting in `RINGING`. If it sits, the
webhook is wrong. Check the API log for `LiveKit webhook received but LIVEKIT_API_KEY/SECRET are not
configured` (credentials) versus no webhook log lines at all (URL).

### 1b. Everything else, and what it costs you

| Var | If unset / wrong | Blast radius |
|---|---|---|
| `MONGODB_URI` | API won't start | Total |
| `JWT_SECRET` | Defaults to `dev-secret-do-not-use-in-production` | Anyone can mint a token. Set it. |
| `VAULT_KEY` | Defaults to 64 zeros | Provider API keys effectively stored in plaintext |
| `PUBLIC_BASE_URL` | Webhook URL can't be built; ngrok URL changes on restart | See (iii) |
| `ENGINE_SERVICE_TOKEN` | Worker gets 401 on every `/engine/*` call | AI calls run "blind": no brief (falls back to the generic solar prompt), no transcript on the floor feed, **no opt-out rail**, no AMD, no DTMF, no transfer. The call still happens. This is the one to double-check. |
| `DEEPGRAM_API_KEY` / `GROQ_API_KEY` (worker) | Worker crashes on start (`os.environ["GROQ_API_KEY"]`) | No AI leg at all |
| `WRAP_UP_MAX_SECONDS` | Default 90 | Too low: agents get a new call mid-disposition. Too high: seats idle after every call. 90 is right for a first day. |
| `AGENT_TRANSFER_ACCEPT_SECONDS` | Default 20 | The agent-to-agent offer window. 20s is tight if agents are tabbed away — consider 30 for day one. |
| `HOLD_MUSIC_URL` | Blank | Hold plays **silence** from the agent's browser (the browser is what publishes hold audio — see the `CallControlService` class comment). The AI→human transfer still gets a synthesised comfort tone from the worker, but hold does not. Set it. Must be a directly-fetchable mp3/ogg/wav, not a streaming page. |
| `HOPPER_LOW_THRESHOLD` | Default 50 | Supervisors don't get told the worklist is draining |
| `RECORDING_ENABLED` | Blank = off | **No audio is captured at all.** Transcripts still are. If the client expects call recordings, this must be `=true` (not `=false`, see the boolean trap) with a bucket configured, before the first call — you cannot retro-record. |
| `RECORDING_BUCKET` + `_S3_ACCESS_KEY` + `_S3_SECRET` | Missing | Egress writes locally; `RECORDINGS_DIR` becomes your only artefact store. Fine for a demo, not for a retention policy. |
| `RECORDING_S3_ENDPOINT` | Blank | Only needed for R2/MinIO/Wasabi. Leave blank for AWS. |
| `CORS_ORIGIN` | Default `http://localhost:3000` | Web app can't reach the API from any other host |

**Not in `config.ts`, but read at runtime:** `DTMF_OPT_OUT_DIGIT` (read directly from
`process.env` in `engine.controller.ts`, default `9`). It is the digit that means "remove me from
your list". Every AU script says "press 9 to be removed", so the default is correct — but know it
exists, because it is not in `.env.example` and it is not in the config schema.

### 1c. Worker-side checklist (`agent-worker/.env`)

```
LIVEKIT_URL=            # identical to the API's
LIVEKIT_API_KEY=        # identical to the API's
LIVEKIT_API_SECRET=     # identical to the API's
DEEPGRAM_API_KEY=
GROQ_API_KEY=
ENGINE_BASE_URL=https://<api-host>/api/v1     # note the /api/v1
ENGINE_SERVICE_TOKEN=   # identical to the API's
HOLD_MUSIC_URL=         # same file the API points at
```

`ENGINE_BASE_URL` without `/api/v1` produces a 404 on every engine call, which the worker logs as a
warning and swallows — the call proceeds with the fallback prompt and no compliance rail. Check the
worker log for `brief fetch ... -> HTTP 404` on the first call and stop if you see it.

---

## 2. Order of operations, Monday morning

Do these in order. Several steps only prove anything if the earlier ones already passed.

**T-1 evening (do not leave this to the morning):**

1. Import the day's lead lists. Confirm each lead has a `listId` (240 seeded leads predate that
   field and will crash `applyOutcome` — see `2026-07-25-global-call-bar-modern-dialer-ux.md`).
2. Confirm `DNCR_ENABLED=true` with real credentials, then wait for a sweep and check
   `GET /api/v1/dncr/status` shows `staleNumbers: 0`. **If it is not zero, the floor cannot work
   tomorrow.** No amount of morning heroics fixes this in five minutes; the sweep is 15-minutely and
   the register is rate-limited by batch.
3. Confirm the CLI pool: `GET /api/v1/cli` — every number `ACTIVE`, none `QUARANTINED` or `RESTING`.
4. Set campaign status to paused. You want to start the day by *un*pausing, not by discovering the
   dialer already ran at 6am against yesterday's config.

**Morning, ~45 minutes before the floor:**

5. Start Mongo, API, web (`./start.sh --no-seed` locally; whatever your process manager is in prod).
   Confirm `GET /api/v1/ops/health`.
6. Start the Python worker (`python agent.py start` — `dev` mode has hot reload you do not want on a
   live shift). Confirm it registers with LiveKit in the worker log.
7. Confirm the LiveKit webhook registration (section 1a-iii). Do this *now*, not after the first
   call.
8. Run the full smoke test in section 3, on real numbers you own, with the floor still logged out.
   Budget 25 minutes. Do not skip a step because the previous one worked.
9. Only then: agents log in, clock in, set AVAILABLE.
10. Unpause **one** campaign with a small worklist first. Watch the first five calls end to end
    before unpausing anything else.
11. A supervisor sits on the floor feed (`/supervisor`) for the first hour, watching for calls stuck
    in `RINGING` (webhook problem), calls stuck in `TRANSFER_PENDING` (nobody accepting), and
    `CARRIER_BLOCKED` bursts (a CLI being labelled — five in fifteen minutes auto-quarantines the
    number).

---

## 3. Smoke test — do this by hand, in this order

Use two browsers (or a normal + incognito window) so you can be an agent and a supervisor at once.
Use a real mobile you are holding as "the customer". Say the times out loud — several of these
checks are about *what silence sounds like*, and you cannot see that in a log.

### 3.1 One manual dial, end to end

1. Log in as an agent → `/manual-dial` → claim a lead → **Dial**.
2. **Your phone should ring.** If it doesn't: `isLiveTelephony()` is false, or the trunk is wrong.
3. Answer. Talk both ways. Confirm two-way audio.
4. Confirm the **global call bar** appears (docked, bottom) with the lead name, phone, CLI and a
   running timer.
5. Hang up **from the phone** (not from the UI). This is the far-end-hangup path that used to be
   invisible to the agent's UI: confirm within a second or two the agent's bar shows the call ended
   and the agent goes to `WRAP_UP` with a countdown.
6. Save a disposition. Confirm the agent returns to `AVAILABLE`.

**What this proves:** trunk works, webhook works (steps 5–6 are entirely webhook-driven), CLI
selection works, wrap-up works.

### 3.2 One AI call, end to end, with transfer

1. Second agent logged in and `AVAILABLE`.
2. Admin → Campaigns → the pilot campaign → dial a lead whose number is your second phone.
3. Answer and **say "Hello?" immediately**. Two things to check:
   - The AI's first words are the AI + recording disclosure, and they arrive without a long dead
     gap. (The worker holds its greeting until your audio track is actually live — a gap here means
     the SIP participant appeared before pickup and the wait worked, which is correct.)
   - In the worker log you should see one `AMD HUMAN in <n>ms` line. `<n>` should be a few hundred
     milliseconds, not seconds. This is reported once per call and is advisory only — it records
     what answered, it does not change call state.
4. Qualify normally (own the home, no panels, high bill, house, yes to an assessment) until the
   score crosses the transfer threshold.
5. The moment the AI says "give me just one moment": **listen.** You must hear hold music (or a
   soft periodic tone) continuously until the human agent's voice arrives. **You must not hear
   silence.** This is the specific defect this build set out to kill — the old worker slept six
   seconds and the customer heard nothing through the accept window, the cascade and the agent's
   WebRTC handshake.
6. Agent accepts the transfer card → confirm the customer hears the human within a second or two of
   the comfort audio stopping, with no gap in between.
7. Confirm the agent's briefing panel shows the AI's summary and extracted facts.
8. Disposition.

**Also test the compliance rail here, on a second AI call:** answer, and after the disclosure say
**"take me off your list"**. Confirm:
- The AI stops whatever it was saying, speaks the removal line, and the call ends. It must **not**
  transfer you to a human, even if you had already qualified.
- `GET /api/v1/leads/...` (or the lead drawer) shows the number suppressed, `outcome: OPT_OUT`, and
  a `OPT_OUT_DETECTED` compliance event on the call.
- Try dialling that lead again — it must be blocked.

Then **press 9** on a third call. Same expected result, with a `DTMF_OPT_OUT` compliance event.
(This one is the rail with no model, no transcription and no prompt in it anywhere — if the spoken
rail ever regresses, this is the one that still has to work.)

### 3.3 Supervisor monitor / whisper / barge

With an agent on a live call (either 3.1 or 3.2):

1. Supervisor → `/supervisor` → find the live call → **Monitor**.
   - Supervisor hears both sides. Neither agent nor customer hears the supervisor.
   - The supervisor must **not** appear in the agent's participant list (monitor tokens are minted
     `hidden: true`).
2. Switch to **Whisper**. Supervisor speaks.
   - The **agent** hears it. The **customer must not.** Verify this with the customer's own ears,
     not by trusting the UI. Whisper isolation works by unsubscribing the customer's SIP leg from
     the supervisor's tracks, and it has to be re-applied once the supervisor's track actually
     exists — so a whisper that leaks to the customer is a real, plausible failure, not a
     theoretical one.
3. Switch to **Barge**. Supervisor speaks. Now everyone hears them.
4. **Detach.** Confirm the call continues normally and the supervisor's audio is gone.

### 3.4 Hold

1. Agent on a live call → **Hold**.
2. The customer must hear hold music (this comes from `HOLD_MUSIC_URL` via the *agent's browser*, not
   the server). If they hear silence, `HOLD_MUSIC_URL` is unset or unreachable.
3. Agent talks to a colleague. Customer must not hear it.
4. **Resume.** Two-way audio returns.
5. Note the limitation while you are here: if the agent's browser tab dies while on hold, the music
   dies with it and the customer hears silence, while the server still says `ON_HOLD`. There is no
   server-side publisher for hold. Brief the floor: *do not refresh while a customer is on hold.*

### 3.5 Agent-to-agent transfer

1. Agent A on a live call → transfer to Agent B (who must be `AVAILABLE`).
2. Agent B gets an offer card with a countdown (`AGENT_TRANSFER_ACCEPT_SECONDS`, default 20).
3. B accepts → confirm the customer is talking to B, and A is released to `WRAP_UP`.
4. Repeat once and let the offer **expire** without accepting. Confirm the call stays with A and A
   is told, rather than the customer being dropped.

### 3.6 Page reload mid-call

1. Agent on a live call. **Reload the page.**
2. The global call bar must come back with the call still live — it is mounted in the app layout and
   restores from `GET /api/v1/workspace/me/current-call`.
3. Confirm two-way audio survives (the browser rejoins the LiveKit room; expect a brief gap).
4. Confirm the disposition form still works afterwards.

If the bar does not come back, the agent has a live customer with no way to hang up or disposition
them from the UI. That is a stop-the-line bug — do not open the floor.

---

## 4. Known limitations — brief the floor on all of these

Say these out loud at the morning standup. Every one of them will otherwise be reported as a bug at
the worst possible moment.

**Predictive / ratio dialing is deliberately switched off against a live trunk.**
`PredictiveDialerService.dialCampaign()` returns immediately when `isLiveTelephony()` is true, with
one warning per campaign in the API log. This is not an oversight and must not be "fixed" on the
day: that dialer still fakes its calls through `SimulationRuntime` and never sends an INVITE, so
against a real trunk it would burn through the lead pool placing no calls, bridge agents to nobody,
and report healthy connect rates while doing it. Monday is **manual dial + AI-fronted dialing only.**
If the campaign has predictive enabled, its worklist will simply not move — that is the guard
working.

**Single API instance.** Pending transfer offers and wrap-up deadlines live in in-process `Map`s
(`TransfersService.pendingOffers`, `CallControlService`). One instance is fine for ten seats. Two
instances behind a load balancer means an offer accepted on B is unknown to A, and transfers start
failing at random. **Do not scale the API horizontally on Monday.** If it needs to restart, expect
in-flight transfer offers and wrap-up timers to be lost (live calls survive — they are in LiveKit,
not in the API's memory).

**No inbound routing.** Nothing in the codebase handles an inbound call. The CLI pool numbers are
presented as caller ID but **do not answer callbacks** — a customer who rings back gets whatever the
carrier does with an unrouted number. If the client cares about callbacks, they need a forwarding
rule at the Twilio level today, not a CoCally feature.

**Hold audio is produced by the agent's browser**, not the server (section 3.4). Tab dies → silence.

**Recording is room-composite and audio-only**, started when the customer's SIP leg joins. If
`RECORDING_ENABLED` was off when the call started, that call has no audio, permanently.

**The AI's opt-out close hangs up the customer's leg from the worker.** That path uses the LiveKit
server API from inside the Python worker (`ctx.api.room.remove_participant`) and has not been
exercised against a real carrier leg yet. If it fails it is logged and swallowed, and the customer
sits on a silent line until the API's own teardown catches it. **Watch the first live opt-out.**

**AMD is advisory.** The worker classifies from the first STT partial and reports it; the API only
records `amdClass`/`amdLatencyMs`. Nothing drops voicemails or hangs up on machines. A VOICEMAIL
classification means the AI is currently talking to an answering machine and will keep doing so.
Fax answers land in `SILENCE` — there is no tone analysis.

**Wrap-up is enforced by a sweep, not a timer per agent.** An agent who leaves the tab will still be
returned to `AVAILABLE` at the deadline, mid-disposition notes and all.

---

## 5. Rollback — it has gone wrong and it is 11am

Escalate in this order. Each step is more disruptive than the last; do not jump to the bottom.

**Level 0 — one call is wrong.** Agent hangs up and dispositions. Note the callId. Move on. Do not
debug live with a customer connected.

**Level 1 — one campaign is misbehaving** (wrong prompt, bad list, transfers not landing).
`POST /api/v1/campaigns/:id/status` → paused. In-flight calls finish normally; no new ones start.
The rest of the floor is untouched. This is the cheapest real intervention and should be your
default reflex.

**Level 2 — the AI leg is the problem** (bad prompt, LLM/TTS provider degraded, transfer hand-off
misbehaving). Stop the Python worker. **The API keeps running and manual dial keeps working** — the
worker is a separate process and manual dials never involve it. Move the floor to manual dial for
the rest of the shift. AI-fronted campaigns will place calls with no agent to run them, so pause
those too.

**Level 3 — live telephony is the problem** (trunk misconfigured, carrier rejecting, CLIs being
blocked en masse). Set `TELEPHONY_DRIVER=SIMULATION` in `apps/api/.env` and restart the API. Every
dial path reverts to `SimulationRuntime`: no carrier, no cost, no customer contact. Nothing rings.
Use this when you need the platform up (reports, dispositions, QA on this morning's calls) but must
guarantee nothing dials out. **Tell the floor explicitly** that calls are now simulated — the UI
does not shout about it, and an agent will otherwise spend twenty minutes wondering why nobody
answers.

**Level 4 — compliance incident** (a number was dialled that should not have been; opt-out did not
take). Stop dialling entirely: pause every campaign, then set `TELEPHONY_DRIVER=SIMULATION` and
restart. Pull `call.complianceEvents` and the audit log for the affected calls *before* anything
else runs and mutates state. Do not restart the worker until you know what happened — its log is the
only record of what the AI actually decided to say.

**Level 5 — the API is unhealthy** (crash-looping, Mongo unavailable). Live calls in LiveKit survive
an API restart; the *records* of them do not advance until the webhook subscriber is back. Restart
the API, then reconcile: any call still in a non-terminal state after the room is gone will be
finalised by the next `room_finished` webhook, or left stuck. Check for calls in `DIALING`/`RINGING`
with a `startedAt` older than an hour and close them by hand — each one is holding a pacing slot and
a locked lead.

**Do not, mid-shift:**
- Re-run the seed script (`--reseed`) against the live database.
- Change `DNCR_REWASH_AFTER_DAYS` downward — it will invalidate existing washes and stop the floor.
- Start a second API instance to "share load" (see section 4).
- Deploy anything. The build that started the shift finishes the shift.

---

## Honest readiness assessment

What has been tested end to end: the simulated path, thoroughly. The live LiveKit + Twilio path has
been built against and reasoned about carefully, but **the transfer hand-off comfort audio, the
STT-first AMD report, the DTMF forward and the opt-out hangup have not been heard on a real carrier
leg.** They are all wrapped so that a failure degrades rather than drops the call, but "degrades"
still means a customer noticing something. Section 3's smoke test exists precisely to catch these
before the floor does, and it should be run on real numbers, listening with real ears, every
morning for the first week — not once.
