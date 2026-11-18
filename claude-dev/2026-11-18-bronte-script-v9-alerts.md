# 18 Nov 2026: Bronte voice, script v9/v10, call alerts, Telvoq 480 outage

## Deployed
- `95bb7df`: Cartesia Bronte as Emma (Leda backup), "!" read as a full stop, `TTS_EMOTION` cleared on the VM. `.env.prod.bak-20261118-leda` on the VM.
- `ca9563c`: call alerts in the API (ops Settings → Call alerts): every N minutes (default 15) checks carrier refusals, silent AI, voice/STT/LLM failover, lost transfers, stalled dialler. Emails need `RESEND_API_KEY` (not set yet), so alerts are only stored and shown for now.
- `acd438a`: ask before transferring (S5 consent; no transfer without a yes, a no books a callback), bare yes/no third ask, noise-filter A/B by call id (`NOISE_CANCELLATION_AB=1` on the VM, `.env.prod.bak-20261118-v9`), opening audio cached per text, "pack off" ends the call.
- Not deployed: `f9b081f` ("I'm good. Are you?" gets "I'm doing well" back). Test tomorrow.

## Script (flow versions, Victoria + AU test + CallTap list test)
- v8: "looks after the bills", bill/company questions without "electricity" (Viiga said gas only on 17 Nov).
- v9: shorter S1-S4, no "survey", S5 consent question, E2 retirement-village close, Q1 "free service" answer (campaign rebuttals; old ones kept in `rebuttalsBeforeV9`).
- v10: S3 without "A rough guess is fine." (live). Rollback = point campaigns at the earlier version id.

## Results
- 701 calls. Silent hang-ups at the opening fell from 63% (17 Nov, Leda) to 43% (Bronte, calm reading); 13% get past the account-holder question both days.
- Telvoq: 25% congestion (503/604), then SIP 480 on every call from 16:42 Melbourne (~139 calls) until paused; Telvoq fixed it, run resumed. 480 added to the run's stop rule and the alert checks.
- Geoffrey O'Leary (Morwell): AGL, both fuels, $300+, score 100. STT heard "I am" as "Hi, Anne" and "AGL" as "Hi, Gale" (recording re-transcribed correctly, live and batch); he hung up 3 s after "please hold". Needs a human callback.

## Open
- Hospital / unwell → kind goodbye; a callback line cut off repeatedly looped 6 times (6:07pm call).
- Noise-filter A/B: too few calls yet (4 on, 8 off).
- Gemini 429s on ~5% of calls (Cerebras covers). Consider the global endpoint.
- Cartesia: ~40k credits left before the 29 Nov renewal; the opening cache should cut use by about two thirds.
- Transfers: 5 qualified in two days, 0 handed over. Agents must be logged in.

## Evening redial (18:17-19:10 Melbourne)
- Redialled the 258 leads whose latest call today was refused by Telvoq (480 ×144, 503 ×79, 604 ×35). Fresh leads were held with `heldForRedial18` and released at the end (0 left marked).
- 604 = "does not exist anywhere": 9 of 9 failed again, so all 35 were set aside until 18 Dec (`sip604Hold18`).
- 233 calls: 96 voicemail, 79 failed again (mostly the 503 numbers), 38 people, 19 no answer.
- Lost a qualified lead (6:54pm, "only power", ~$200) to an STT mishear: the company answer came out as "Meter Ergon?", which the out-of-area rule (Ergon = Queensland) closed. Fix: for VIC leads, a QLD-only retailer gets the company question again.
