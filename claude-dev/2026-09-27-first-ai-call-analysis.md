# 2026-09-27 — First real AI dial on the Twilio trunk: analysis and fixes

Call: campaign "Wendy test (India)", lead Nithin (+91 9902352425), dialled 15:11:31 UTC,
answered after 20 s, ~2 min conversation, customer hung up ~15:13:36. Supervisor desk kept
showing the call as live afterwards; no human transfer happened.

## What went wrong, and what was done

| # | Finding | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | Call stuck in `IN_CONVERSATION` after hang-up; desk showed it for up to 70 min | LiveKit Cloud has no webhook registered, so `participant_left` / `room_finished` never reach the API. The hung-call sweep only closes calls idle for 60 min. | **Done 27 Sep (Nithin)**: webhook registered in LiveKit Cloud project `cocally-wn9jxt2x` → `https://app.co-cally.com/api/v1/telephony/livekit/webhook`, key `APIfVWyDfjpDCsZ`. (GET on that URL is a 404 by design; POST returns 200.) Not yet verified with a hang-up. |
| 2 | Phantom second worker job crashed 2 min after hang-up (`room disconnected while waiting for participant`) | The desk's Monitor button joined the (already torn-down) room; LiveKit re-created it empty with no metadata and dispatched the worker. | Worker: a `call-*` room with no `callId` metadata is left immediately; a room that closes while waiting for the customer is a quiet exit, not a crash. Goes away entirely once #1 is registered (the desk will no longer list the call). |
| 3 | Disclosure spoken, then a second, differently worded greeting 17 s later; Cerebras 400 `No user query found in messages` | The scripted disclosure's await failed after the audio had played, the code fell through to `generate_reply(instructions=…)`. That call carries only system messages, which Cerebras rejects; the FallbackAdapter retried for ~17 s before Groq answered. | Worker: once `session.say` has been issued the AI never re-greets (timeout ⇒ treat as spoken). The LLM-opened path (inbound rooms, or a disclosure that truly could not play) now passes a synthetic `[call connected]` user turn so Cerebras accepts it; the marker is filtered from the transcript. |
| 4 | Every transcript line stored twice | `POST /engine/calls/:id/transcript` does an atomic `$push` **and** pushes in-memory; `recomposeSummary`/`recordOptOut` then `call.save()`, which re-issues the `$push`. | API: `call.unmarkModified('transcript')` after the in-memory push. |
| 5 | Summary showed solar facts (`owner`, `noPanels`…) all false; score stuck at 0, so the score-gated transfer could never fire | The seed campaign used `DEFAULT_SCORING_CONFIG` (solar) with an energy-bill flow. | Seed: `ENERGY_SCORING` (decisionMaker 30, payingTooMuch 25, billHigh 15, notSwitchedRecently 15, wantsSpecialist 15; transfer ≥ 70). Applied on re-run to the existing campaign. Engine `FACT_GLOSSARY` defines the new keys. |
| 6 | AMD classified a real person as `SILENCE` at 6 s | The 6 s silence watchdog started when audio went live, i.e. while the AI was still reading the ~8 s disclosure. | Worker: watchdog starts after the disclosure finishes. AMD does not gate anything on the live path, so this was cosmetic. |
| 7 | STT mis-hears ("Simply Energy" → "simply an async") | Deepgram `nova-2-phonecall`, en-US default, Indian accent on a Twilio→IN leg. | Not changed. Pilot customers are Australian; revisit with `sttKeywords` / language once real AU calls are heard. |
| 8 | Cost fields all 0 | Cost tracking not wired. | Not changed; pre-existing gap, post-pilot. |

## Why no human transfer

Two independent gates, both must pass:

1. **Trigger** — the LLM calls `request_transfer` when the customer says "yes, put me through",
   or the extracted-fact score reaches the campaign's transfer threshold. With #5 the score
   was permanently 0, so only the tool path could have fired, and the call ended before the
   script reached "Shall I put you through now?".
2. **Someone to take it** — `PresenceService.selectAgent` requires `roles: AGENT`, `presence:
   AVAILABLE`, `active`, and skills empty or containing the campaign. Being on the Supervisor
   desk does not count; the user must be clocked in on Workspace. Otherwise the AI says
   "everyone's a little busy… someone will call you back", books a 10-min HUMAN callback and
   hangs up.

## Second AI call — 15:51 UTC (call `6ab93b6d2d3081ecf5f1b30a`)

Re-test after the fixes above. **The happy path worked end to end**: one disclosure, no duplicate
transcript lines, `AMD HUMAN`, every question in the ladder answered, score 85 (decisionMaker,
payingTooMuch, billHigh, notSwitchedRecently), auto-transfer, bridged to Nithin at 15:53:29,
agent hang-up at 15:54:33, `COMPLETED / ANSWERED_HUMAN`, disposition CALLBACK. AI turn latency
0.7–1.7 s (median ≈ 1.2 s; LLM 350–810 ms, TTS ≈ 255 ms).

| # | Finding | Root cause | Fix |
|---|---------|-----------|-----|
| 9 | Call bar stayed "Connected" after the customer hung up; only the agent's Hang up ended it (`removeParticipant … participant does not exist`) | The webhook is now registered, but **every delivery was rejected**: `no raw body` → `sha256 checksum of body does not match`. LiveKit posts `Content-Type: application/webhook+json`; `express.json()` only parses `application/json`, so `rawBody` was never captured. `POST` still returns 200, which hid it. | `main.ts`: route-scoped `express.json({ type: ['application/json','application/webhook+json'], verify })` on `/api/v1/telephony/livekit/webhook`. Reproduced the exact error locally with a signed event, verified the fix. |
| 10 | Call bar showed only the summary sentence, no fact checklist; lead page showed score 0 | `lead.facts` is a Mixed (`type: Object`) path; `recomposeSummary` wrote `lead.facts[key] = v` in place, which Mongoose does not track, so `save()` never persisted it (prod lead: `facts: {}`). The live path also never wrote `lead.score`. | `engine.controller.ts`: `lead.markModified('facts')`, `lead.score = score`. |
| 11 | Summary text unreadable (`decisionMaker: true; …`) | Raw template output. | Briefing labels for the energy facts + camelCase fallback (`calls.controller.ts`); call bar renders score, ✓/✗ fact list and objection, raw summary only when there are no facts. |
| 12 | Transferred without the customer answering "Shall I put you through now?" | Score-gated auto-transfer: 30+25+15+15 = 85 ≥ 70 without `wantsSpecialist`. The worker's `request_transfer` fired while the AI was still speaking the offer. | **Fixed (seed)**: `ENERGY_SCORING` now decisionMaker 25 / payingTooMuch 20 / billHigh 10 / notSwitchedRecently 10 / wantsSpecialist 35, so 70 is unreachable without the yes (max 65 → book-only). Re-run the seed to apply. |
| 13 | ~26 s from "let me get a specialist" to the human; no hold tone for the first 15 s | `request_transfer` awaited `session.say(...)` (timeout 15 s) before posting the transfer; the line queued behind the long offer utterance and timed out mid-playout, which skipped the comfort audio and delayed `_post_transfer` by 15 s. | **Fixed (worker)**: the line and the hold music are queued and the transfer is posted immediately; the cascade runs while the line plays. |
| 14 | `disclosure playout wait timed out` (20 s) and AMD at 25 s | The wait starts when the SIP track goes live, before the Twilio trial message and pickup finish. Harmless now (no re-greet). | Not changed; re-check on Telvoq (no trial message). |
| 15 | Callback due 2026-12-27 23:24 IST | Chosen deliberately by Nithin (picker default is now + 2 h). | None — working as intended. |

Tab switching: the call bar is mounted once in the app layout, so it survives page changes. The live
AI-phase view lives on the Supervisor desk; the call bar itself only appears once you are bridged.
The Workspace "Live floor" cards, however, were socket-only state: leaving the page dropped them and
coming back showed nothing until the AI's next turn. **Fixed**: the page now seeds the floor from
`GET /supervision/calls` on mount (that list now carries `leadId`, `campaignId`, `score`), and each
card shows a readable state plus minutes elapsed.

## Re-test checklist

1. Webhook registered (#1, done). 2. Push this commit; wait for Actions. 3. Re-run
`./deploy/gcp/seed-test-campaign.sh …` so the campaign picks up `ENERGY_SCORING`.
4. Workspace → clock in → Available (with "takes calls" on). 5. AI dial; answer as the bill
payer, say you pay too much and haven't switched; say yes to the specialist. Expect the
browser to ring. 6. Hang up: the desk row should clear within seconds.

## Database moved to MongoDB Atlas (evening, 27 Sep)

- Atlas `Cluster0` upgraded Free → **Flex**, AWS Sydney `ap-southeast-2`, backups on. DB user `cocally_vm`; URI (with `/cocally`) in `deploy/gcp/.env` only.
- VM data copied with `mongodump` → `mongorestore`; Atlas verified: 28 collections, 1 tenant, 2 users, 1 campaign, 3 leads, 8 calls.
- **Bug found:** `setup.sh` never wrote `MONGODB_URI` into `.env.prod`, and compose defaulted to `mongodb://mongo:27017`, so the VM would have stayed on the local DB silently. Fixed: setup.sh requires and writes it; compose requires it (`${MONGODB_URI:?…}`); the `mongo` service and `mongo_data` volume are gone from the stack; `backup-mongo.sh` now dumps Atlas via a throwaway `mongo:7` container.
- Rollout order: `setup.sh` first, then push (`--remove-orphans` removes the old container). The `cocally-prod_mongo_data` volume stays on disk as a fallback; delete after a week.
- The Atlas password appeared in chat via an editor selection; rotate the `cocally_vm` password after the pilot settles.
- Docs: `deploy/DEPLOY.md` §1a (Atlas setup + migration), `.env.example`, `.env.prod.example`.

## Call recordings turned on (night, 27 Sep)

- Bucket `gs://cocally-509318-recordings` (australia-southeast1, uniform access, public access prevented).
- Writer: service account `cocally-recordings@…` with `roles/storage.objectCreator` on that bucket only; HMAC key in `deploy/gcp/.env` (`RECORDING_*`, endpoint `https://storage.googleapis.com`).
- The org enforces `iam.disableServiceAccountKeyCreation`; it was reset for this project only (Nithin granted himself Organization Policy Administrator). Took ~20 min to propagate.
- Live after `setup.sh` + redeploy. Files land as `<tenantId>/<date>/<callId>.ogg`. The in-app Recordings page reads the local dir, not the bucket — play from the Cloud Console for now.
- To do: say "this call is recorded" in the disclosure; bucket lifecycle rule once the client's retention period is known.

## Call bar cleanup

The expanded call bar was one long column ending in small outline buttons, and nothing said it only closes once an outcome is logged. Now two columns: customer context on the left (summary + score, objection, rebuttals collapsible), actions on the right (live controls with keypad tucked away; after the call, a "Log the outcome" panel with the wrap-up timer, notes, filled Booked/Callback buttons and the other outcomes below, Do not call in red). Behaviour unchanged.

## Cost work (28 Sep, early hours)

Pricing check against the quote given to Shubham Mantri (₹8.50/AI min, ₹0.80/dial, ₹50k advance, carrier billed to the client): our AI minute costs ≈ ₹5.90 at ₹98/$ (ElevenLabs ≈ half). Leaks were ringing (AI joined before answer), voicemail (~25 s of full stack before detection, disclosure spoken to the machine) and the unbilled human leg.

- **AI joins on answer.** Worker registers as `AGENT_NAME=cocally-ai` (explicit dispatch); the API dispatches it from `CallProgressService.markAnswered` (atomic `aiDispatchedAt` claim, so the webhook + INVITE both reporting the answer can't send two AIs). Dispatch failure hangs the call up rather than leaving silence. Live-demo dispatches explicitly. Manual / predictive calls no longer get an AI dispatched at all. Recording now starts on answer, not before the INVITE.
- **Voicemail hang-up.** `POST /engine/calls/:id/amd` returns `hangup: true` for VOICEMAIL unless the campaign's policy is `AI_DROP`; the worker force-interrupts the disclosure, drops the SIP leg and exits. Outcome is ANSWERED_VOICEMAIL (24 h retry) as before.
- **Per-tenant voice.** `Tenant.voice {provider, voiceId}` goes out in the brief; `_build_tts(provider, voice)` falls back to env and then Deepgram. `Tenant.billing` holds the ₹ rates.
- **Platform screen** (`/platform`, `PLATFORM_ADMIN_EMAILS` only — not a role): per-tenant dials, answered, voicemail, transfers, AI/agent minutes, cost breakdown (usage × editable rate card in `PlatformSettings`), billed ₹, margin, fixed cost; edit voice, billing, pause, daily quota (audited in the tenant's log). Durations are capped where the finaliser missed a hang-up (AI time ends at last transcript line + 30 s). Checked read-only against Atlas: Sept tests = 10.2 AI min, ≈ ₹45.

Watch on the first live call: the gap between the customer's "hello" and the disclosure (dispatch + session start, expected ~1–2 s).

### Voicemail detection tightened (same night)

- Keeps listening for 5 s after the AI joins: a first guess of HUMAN ("Hi, it's Sam…") is upgraded to VOICEMAIL if "leave a message" etc. follows (`Qualifier.on_transcript`).
- Carrier announcements ("switched off", "not reachable", "out of coverage", "the number you have dialled…", "not in service", "please try again later") count as VOICEMAIL → hang up, 24 h retry. A person saying "I'm busy" stays HUMAN.
- Silence: nothing said for 10 s after the opening line → SILENCE → API returns `hangup` → worker hangs up (outcome NO_ANSWER).
- Limitation: STT is English. A Hindi/regional carrier announcement is still transcribed as *something*, so it reads as HUMAN and neither rule fires; the carrier usually drops those calls within ~15–20 s. Only the English version (usually played after the Hindi one) matches.

## Billing: advance ledger, invoices, tenant Usage & billing page (28 Sep)

- `Tenant.billing` is now `{ tiers[], monthlyAdvanceInr, advanceRule (CARRY_FORWARD | MONTHLY), gstPercent, billTo }`; old flat rates are read as one band. Defaults = the pilot quote (Standard ₹8.50/₹0.80; Growth from 10,000 AI min ₹8.00/₹0.70; ₹50k advance; carry forward; 18% GST). The month's total AI minutes picks the band for ALL its usage (whole-volume, not graduated). AI time billed per second.
- `CreditEntry` ledger (ADVANCE / USAGE / EXPIRY / ADJUSTMENT / REVERSAL, never edited) → balance. `Invoice` per tenant per IST month: DRAFT (refreshable from calls) → ISSUED (numbered CC-YYYY-NNNN, advance drawn at issue, MONTHLY rule expires the rest) → PAID; VOID returns the credit.
- Super admin: Platform → client → "Billing & invoices" tab (running bill, invoice actions, record advance / adjustment, ledger, billing terms, printable invoice at /platform/invoices/:id); sender details editable. Every money action is in the tenant's audit log.
- Tenant OWNER/ADMIN: new "Usage & billing" (/usage): usage figures, the running bill, band and distance to the next, advance balance + history, per-campaign breakdown, issued invoices (printable). Never shows CoCally cost or drafts.
- Verified on in-memory Mongo: 12,000 AI min + 10,000 dials → Growth, ₹1,03,000 − ₹50,000 advance + GST = ₹62,540; void restores credit; monthly rule expires the unused advance. API boots with the new module; web `next build` passes.
- Quote wording still to settle with the client: carry-forward (Terms) vs same-month (Section 2); implemented carry-forward, switchable per tenant.

## Ops console (28 Sep)

Full guide: `claude-dev/2026-09-28-ops-console.md`.

Replaced the in-app Platform screen and the `PLATFORM_ADMIN_EMAILS` allow-list with a separate console at `/ops`:

- **Operators** (`operators` collection): not tenant users; own sign-in at `/ops/login`; TOTP enrolment forced at first sign-in; tokens signed with a key derived from JWT_SECRET (`OPS_JWT_SECRET`), so tenant and ops tokens can't cross. First operator via `./deploy/gcp/create-operator.sh --email … --name …` (one-time link, 48 h); more from Ops → Settings.
- **API** `/api/v1/operator/*` (`modules/operator`): overview + alerts (overdue invoices, paused/deactivated, billing not confirmed, usage above advance), tenants (create with owner invite, edit, pause, deactivate → sessions killed + login refused), tenant users (invite, reset link, reset 2FA, roles, deactivate; last owner protected; phones unique across tenants), campaigns (read-only), billing (moved from /platform), invoices across tenants, calls across tenants (filters, per-call cost and billed amount, redacted transcript by default, unredacted + recording playback audited), rate card, seller details, operators, audit.
- **Audit**: `opsauditlogs` for every operator action; tenant-affecting ones mirrored into the tenant's `auditlogs` as `ops.*` by "<email> (CoCally)".
- **Web** `/ops` (own layout and token key `cocally.ops.token`): Overview, Tenants (+ New), tenant page tabs (Billing & invoices, Calls, Users, Campaigns, Settings, Our cost, Audit), Calls + call detail, Invoices + print, Audit log, Settings (rate card, sender details, operators, my account). Tenant "Usage & billing" (/usage) stays.
- Verified: 48-step HTTP end-to-end test on in-memory Mongo (all pass), API boots, web `next build` passes.
- Recording playback needs the bucket writer SA to read too: `roles/storage.objectViewer` on `gs://cocally-509318-recordings` (not yet granted).
- The YSGN tenant is CoCally's own test tenant; each client BPO gets its own tenant from the console.
