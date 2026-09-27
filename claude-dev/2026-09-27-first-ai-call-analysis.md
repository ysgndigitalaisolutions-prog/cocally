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
