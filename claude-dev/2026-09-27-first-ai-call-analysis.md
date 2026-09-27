# 2026-09-27 — First real AI dial on the Twilio trunk: analysis and fixes

Call: campaign "Wendy test (India)", lead Nithin (+91 9902352425), dialled 15:11:31 UTC,
answered after 20 s, ~2 min conversation, customer hung up ~15:13:36. Supervisor desk kept
showing the call as live afterwards; no human transfer happened.

## What went wrong, and what was done

| # | Finding | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | Call stuck in `IN_CONVERSATION` after hang-up; desk showed it for up to 70 min | LiveKit Cloud has no webhook registered, so `participant_left` / `room_finished` never reach the API. The hung-call sweep only closes calls idle for 60 min. | **Nithin**: LiveKit Cloud → project `cocally-wn9jxt2x` → Settings → Webhooks → `https://app.co-cally.com/api/v1/telephony/livekit/webhook`, key `APIfVWyDfjpDCsZ`. (GET on that URL is a 404 by design; POST returns 200.) |
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

## Re-test checklist

1. Register the LiveKit webhook (#1). 2. Push this commit; wait for Actions. 3. Re-run
`./deploy/gcp/seed-test-campaign.sh …` so the campaign picks up `ENERGY_SCORING`.
4. Workspace → clock in → Available (with "takes calls" on). 5. AI dial; answer as the bill
payer, say you pay too much and haven't switched; say yes to the specialist. Expect the
browser to ring. 6. Hang up: the desk row should clear within seconds.
