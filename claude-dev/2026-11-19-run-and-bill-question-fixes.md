# 19-23 Nov 2026: 200-call run, bill-question drop-off, fixes built

## Deployed 19 Nov (prod on `1f39ddf`)
- `f9b081f`: "I'm good. Are you?" gets "I'm doing well" back.
- `1f39ddf`: kind goodbye for someone in hospital or unwell; a callback line cut off twice is not begun a third time; the first out-of-area retailer name gets the company question once more (Ergon mishear, 18 Nov).

## 19 Nov run (Victoria, 200 calls, stopped 4:12pm Melbourne, campaign PAUSED)
- 76 voicemail, 58 failed (503 x47, 604 x11, 480 x4), 34 answered, 25 no answer, 5 busy, 2 opt-out.
- 19 people spoke, 10 heard the bill question, 0 got past it, no transfers.
- Silent hang-ups at the opening: 47% (18 Nov: 43%).
- Noise-filter A/B: 9 on, 10 off, 2 re-asks each. Inconclusive.
- TTS on every turn: Cartesia sonic-3.6 (Bronte). No backup voice used.

## Bill question review (21 Nov)
- 89 calls since 17 Nov ended at "Are you the account holder?" / "Are you the one who looks after them?".
- 10 recordings in `~/Desktop/cocally/recordings/account-holder/`.
- Main loss: someone else pays ("it's my husband", "my daughter pays", "not me", "they can't take the call"). Emma asked again or said goodbye.
- Also: a clear yes asked again ("I just said I pay them"); a phone screener's "Please stay on the line" taken as the customer (19 Nov, 4:48pm and 5:09pm).
- "Hello, are you still there?" fires after about 8 s of complete silence. On most calls nobody spoke afterwards, so the check behaves as intended.
- The "quick survey" line in two of the recordings is pre-v9 wording; v10's S2 has no "survey".

## Built 23 Nov (not deployed)
- Someone else looks after the bills, after the bill question: "No worries. Is he/she around for a quick chat, or is there a better time to call him/her?" ("they/them" when no one is named). Then:
  - yes → "Sure, take your time." and wait 30 s; their "Hello?" gets the opening, then the model asks S1 again;
  - not around → Q6 callback question;
  - a time → booked via schedule_callback.
  - "My husband and I" / "both" counts as a yes.
- "I pay them" / "that's me" after the bill question: the model is told it is a yes and moves on.
- Screener hand-off ("stay on the line", "please hold", "while I connect you") before any step is asked: stay quiet, hold the dead-air check, and greet the person when they say hello.
- Opening audio is saved to disk (`OPENING_CACHE_DIR`, default `/tmp/cocally-opening-cache` in the worker container), keyed by text, voice and audio settings. Every call in the container reuses it; a take made by a backup voice is not saved. Expected to cut Cartesia use by about two thirds.
- 123 worker tests pass (10 new).

## 23 Nov: Call Tap admin, workspace picker, Calls pagination (deployed `2bc06ec`)
- Nithin added to the Call Tap tenant as ADMIN (user `6b046b585e75c9478c2f6e79`, email + phone +919902352425). Shubham stays OWNER. Set-password link issued with `reset-password.js` (48 h).
- Sign-in: one phone can have accounts in several workspaces. The accounts the password opens are offered as "Which workspace?"; one that opens goes straight in. The sidebar shows the workspace name and "Switch workspace" (a fresh sign-in to the other account, its own password and 2FA). `GET /auth/workspaces`. Logic in `apps/api/src/modules/auth/workspace-pick.ts`, 6 tests.
- Login page: email sign-in works (it used to get "+91" put in front).
- Calls tab: 100 per page with First/Previous/Next/Last; the count and totals cover every matching call (`GET /calls?page=`). Without `page` the API returns the old plain list (lead drawer).
- Same deploy took the call fixes (`5d2ee31`): someone else looks after the bills, screener hand-off, opening audio on disk. Own-number test call still to do before customers.
- Alerts plan (not built): provider balances (Cartesia admin key, Deepgram billing:read key), Telvoq outage, daily cost; delivery channel undecided (Resend key / Telegram). Cartesia credits likely near zero: Pro is 100k/month, 18 Nov alone used ~85k.
- Login page: phone first, "Use email instead" link (`1d780d1`). Shubham signed in by phone on 6 Nov; email sign-in never worked before 23 Nov.
- Dialer (`bb41b6d`, deployed with `50860a9`): one dial at a time, a random 3-5 s apart, and 3-5 s after a line frees up (campaign `dialGapSeconds`, default {3,5}; tick every 1 s). Two calls at once take two different caller IDs (`pickCli`). Victoria: max 2 at a time on +61 3 9072 8793 / 8794.
- Caller IDs +61 3 4830 7776 and +61 485 049 494 marked QUARANTINED: Telvoq rejected all 21 calls with them on 17 Nov as INVALID_NUMBER (the Sydney +61 2 8531 6375 worked at the same time). A non-ACTIVE number can no longer be added to a campaign (API refuses; campaign page greys it out). Reinstate from Caller ID numbers if Telvoq enables them.
