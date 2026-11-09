# 25 Oct 2026 — Verbatim script, DNC gaps, voicemail, LLM switch

Branch `fix/au-script-compliance` (from `reconcile/voice-on-prod` 8754777).
Goal: a calling agent that follows the Australian Deal script exactly, with
compliant DNC handling, before today's test calls.

## What changed

| Area | Change | Files |
|---|---|---|
| Script wording | Every script and Q&A line is tagged (`[S1]`–`[S4]`, `[E1]`, `[Q1]`–`[Q7]`). The brief sends `scriptLines` (tag to exact text). The model outputs the tag and the worker's `llm_node` swaps in the exact line before TTS. | `seed-test-campaign.ts`, `engine.controller.ts` (brief), `agent.py` (`_expand_tag_stream`) |
| One question per reply | A reply ends at the first script step, at a tagged question, or at the first `?` in the model's own words. Anything after it is dropped, never spoken. Unknown `[...]` stage directions are dropped. | `agent.py` |
| DNC | One shared `OPT_OUT_PATTERN` in `lines.ts` for the live and simulation paths. It adds "DNC", "Do Not Call Register", complaint, report, ACMA and ombudsman. New `opt_out` tool backed by `POST /engine/calls/:id/opt-out`, so a reworded request still suppresses the number. Before this, the playbook's DNC answer ended with `end_call`, which wrote no suppression. | `lines.ts`, `engine.controller.ts`, `flow-executor.service.ts`, `agent.py`, seed |
| Voicemail | The worker now acts on `/amd`'s `hangup` (campaign voicemail policy). Before this, the reply was thrown away. SILENCE only hangs up if the VAD never heard speech (29 Sep false SILENCE). | `agent.py` |
| Callbacks | `schedule_callback` refuses unless the customer's last turn names a time. The brief gives the explicit UTC offset; the model had booked Melbourne at +10:30. The callback question tag is blocked once a callback is booked. | `agent.py`, `engine.controller.ts` |
| STT | nova-3 gets `language=en-AU` for +61 leads (`en` otherwise; `STT_LANGUAGE` overrides). Campaign `sttKeywords` (via the brief) are merged with `STT_KEYTERMS`. | `agent.py`, brief |
| Interruptions | `min_words: 1`. An overlap with no transcribed word (cough, line noise) no longer stops the AI. Kept at 1 because the framework drops overlapping turns shorter than `min_words`. | `agent.py` |
| LLM | Default `openai/gpt-oss-120b` on Cerebras (qwen is the fallback). See the eval below. | `agent.py`, `setup.sh`, `deploy/gcp/.env` |
| Logs | Worker log lines go in one POST per second as a batch (`lines[]`), not one POST per line. | `agent.py`, `engine.controller.ts` |
| Env | `deploy/gcp/.env` (not in git): `LLM_MODEL=openai/gpt-oss-120b`, `STT_MODEL=nova` (it still said flux), keyterms without "Wendy", plus retailers. | local only |

## Eval (text-only, real Cerebras, real prompt and tools)

The harness is in the session scratchpad, `script_eval.py`. It builds the brief's instructions from the seed and plays 8 scenarios: happy path, not the account holder, DNC Register, a reworded DNC, busy then callback, questions, not interested, and off-topic.

| Setup | Result |
|---|---|
| Old prompt + qwen-3.8-27b (what prod ran) | Hung up on "Okay." and "I'm fine.". Opted a customer out on "Hi.". DNC Register went to `end_call` with no suppression. One 3.4 s turn. |
| New prompt + qwen | Missed the transfer in both runs. |
| Old prompt + gpt-oss-120b | Every path right. |
| New prompt + gpt-oss-120b (final code) | Every path right, including busy → asks for a time → books it → ends the call. Median turn 0.41–0.42 s, p95 0.86 s. |

Bedrock Sydney: the key in `.env` now returns `401 invalid_api_key`. Its script quality is still untested. Sydney first-token times from 30 Sep: qwen3-32b 300 ms, ministral-14b 296 ms, gpt-oss-120b 713 ms (slower than Cerebras).

Tests:
- `apps/api` vitest 37/37 (new: `engine/__tests__/opt-out-pattern.test.ts`).
- `agent-worker/tests/test_script_tags.py`, 15 cases, all pass.
- API `tsc` clean.

## Deploy

1. `deploy/gcp/setup.sh` from the main checkout. It writes `.env.prod` to the VM, with no restart.
2. Push to `prod`. The workflow pulls and runs `up -d` with the new env.
3. `deploy/gcp/seed-test-campaign.sh`. It publishes the tagged flow version and updates the campaign playbook. Until this runs, the brief has no `scriptLines` and the model speaks freely, as before.

## Open

- The AU network path is still caller → Telvoq London → LiveKit SIP in India → Sydney (~0.5–0.6 s round trip, estimated). Ask Telvoq for an APAC POP and digest auth so the trunk can use `destination_country=AU`.
- There is no AU campaign. The seed is the India test campaign on the IN pack. A real AU call needs a +61 lead on an AU-pack campaign, with the Telvoq trunk (`LIVEKIT_SIP_TRUNK_ID=ST_fGuwwzkowYPr`, `SIP_DIAL_PREFIX=45`).
- First real calls on nova-3 + `min_words` + gpt-oss: check `timings.workerLog` for "script lines:", "stt nova language=" and any `AMD ... hanging up`.
- To test Bedrock models: get a new Bedrock key, then rerun the eval on qwen3-32b and ministral-14b.

## 3 Nov 2026: client hand-over view (new tenant, minutes only)

Nithin is handing the app to a client on a new tenant: clean view, minutes only, no prices until pricing is revisited.

- Dashboard rebuilt on `/usage/daily`: total, ring / AI / human minutes, call counts, by day, by campaign. The old KPIs (latency, QA, abandon rate, funnel, objections) left the dashboard. Usage page redirects here.
- Money removed at the API, not only on screen: `chargeInr` and `costCents` from calls, `costPerBookingCents` from KPIs, `unitCost` from providers, `BillingController` unregistered. Tenant Providers and invoice pages deleted. Ops console keeps billing. To reopen pricing, restore these from git.
- `pickedUp` added to UsageService (outcome ANSWERED_HUMAN). On real data `answered` said 51 and a person was reached on 41: the carrier also answers lines where nobody speaks.
- Real data checks: 62 calls, all on YSGN. AI minutes 331.5 raw, 53.4 shown: four hung calls of 66-81 min are capped by UsageService, so the finaliser still misses some calls. No call has ever been classed VOICEMAIL, so the voicemail figure is unproven.

## 3 Nov 2026: voice moves to Cartesia Arlo (not deployed yet)

Nithin was not happy with Deepgram's voice, heard ElevenLabs and Cartesia at phone quality, and chose Cartesia Arlo (Australian); plain and excited both fine, excited set in `deploy/gcp/.env` with `TTS_GAIN_DB=1`.

Measured from the Sydney worker through the real plugin and the 4-socket race: 50 calls, 250 replies, no errors, median about 95 ms first audio, 2 of 50 calls stuck on a slow socket near 300 ms. ElevenLabs 269 ms, Deepgram Aura-2 200 ms in the plain HTTP test (79 ms live).

New: `TTS_EMOTION`, and `_with_tts_fallback` puts Deepgram behind any other voice vendor. Tested with a broken Cartesia key: Deepgram speaks; the first line took 1.8 s from a Mac, so the first failure is a noticeable pause.

## 4 Nov 2026: first 5 tenant leads, supervised

Nithin confirmed the tenant's Do Not Call check and said go. Retry limits deferred on purpose ("keep a track"), still off. First 5 rows of the tenant's file loaded with Melbourne timezone and no state, name or suburb; started at 3:15pm Melbourne, inside legal hours in every zone. A watcher pauses on any FAILED call, any redial, or after 5 calls.

First test call with the filter off (6aeaaf857b2dc1c26fa3dea7, on speaker): first "Hello" reached STT 6.5 s late against 50-245 ms on the last 10 calls. Cause unproven; ringback reaching STT without the filter is the leading guess.

## 4 Nov 2026: first Australian calls, voicemail and silence fixes

Telvoq: 5 mobiles in 0409 072xxx-073xxx all returned SIP 503 regardless of caller ID format; prefix 25 returns "auth required", prefix 45 stays. Caller ID on trunk `ST_fGuwwzkowYPr` is now `61285316375` (from Telvoq, no plus). Numbers in 0409 12x and 13x connected, both to mailboxes: the first app calls on the AU route. The 503 block is still unexplained.

Both mailboxes passed as HUMAN, because AMD latched on the first word, and the second held the line 3 min 18 s until ended by hand. Fixes: machine-only phrases overturn HUMAN in the first 20 s; `_DeadAirWatch` re-checks after 8 s of silence and cuts the call 7 s later. Backtest: 47 calls, 261 customer lines, only the 2 real mailboxes flagged. Silence timing could not be replayed from transcripts.

Also shipped: ElevenLabs Charlie as first voice backup, Deepgram second; `_hunt_fast_socket` retries Cartesia during ringing (one real sample stayed slow after a swap, so its benefit is unproven; a blocked loop at job start can make a fast socket look slow). First-reply 6.5 s STT delay seen once and not reproduced, no fix shipped. To restart on the VM always pin IMAGE_TAG.

## 5 Nov 2026: caller IDs on the campaign, Vendors page, correct call counts

- Worker crash: fb4e84f read `qualifier` before it existed, so every call died at pick-up. 4 answered calls got silence (1 real person, 3 mailboxes per the recordings). Fixed in 9ceeff7. Rule: a call to Nithin's number must work before customers after any worker deploy.
- Campaign page has a Caller IDs section (`cliPool`); Calls page shows the number used; numbers need a plus, stay in the campaign's country, and reach Telvoq without the plus.
- Ops Vendors page: key check, last real use, billing failures from call logs. No vendor gives a balance with today's keys, so it warns on failures, not low credit. Google billing status is not read: using the recordings account for it was blocked.
- Dashboard tiles add up: Picked up, Voicemail, No answer, Failed (`usage-buckets.ts`). Old "No answer" was a remainder holding 6 SIP 503s.
- `finalAmdClass` decides what answered at call end from the whole transcript; an unclassified silent call is no longer a person. Replay on 58 answered calls: no conversation became a mailbox.
- 5 mailbox records corrected by hand to ANSWERED_VOICEMAIL. Still open: Telvoq 503s on 6 of 12 mobiles, first-reply delay seen once, retry limits off, no new tenant yet.

## 5 Nov 2026: connect gate, Calls screen, real prices

- AU calls now reach "To connect your call, press N". Nithin confirmed pressing it is the agreement with the vendor. Worker reads the digit from final transcripts, presses via DTMF (max 3), stays silent, greets when the handset speaks, hangs up after 45 s of nothing. Not yet proven on a real call.
- Noise filter back on: with it off, a lone first "Hello" hit about 6 s STT delay twice; never with it on.
- Calls page is full width with a popup, shows caller ID and plain results. Score, latency and compliance panels removed from it.
- Rate card shows source and confidence. Billing checked in the browser: Google `cocally` project only, Oct INR 7,507.52; Gemini token rates confirmed. LiveKit, Cartesia, Deepgram, Atlas not yet read. Telvoq is not our cost.
- 5 calls on 5 Nov were wrongly saved as answered by a person (4 gates, 1 business message); records not corrected yet. Google lists Gemini 2.5 Flash as retired 20 Oct 2026; one failure with fallback seen on 5 Nov, cause unchecked.

## 5 Nov 2026: gate tail, instant redial

With the filter on only "press seven." reached STT on 8 gate calls, as partials, so the gate press never fired and the AI looped "Sorry, I didn't catch that". Gate detection now takes a short phrase ending "press <digit>", partials included, debounced. The 3-at-once test also rang 2 people twice within a minute: an answered call set no wait. Answered now waits 24 h and no retry is under 30 min. LiveKit billed 185 SIP minutes for October against 25.6 in our database: unexplained.

## 5 Nov 2026: parallel calls, gate press, classification

- 5 at once on 2 vCPUs: every call gets an AI now (capacity counts calls, 5 warm processes), but CPU saturates for about 35 s and the greeting breaks up. Operate at 3.
- LiveKit moved to Ship: 2 concurrent recordings was the Build limit.
- Gate press works: of 26 presses, 9 reached voicemail, 8 dropped at about 20 s, 9 at about 2 s. No press has reached a person yet. Telvoq asked about the 2 s drops and the 503s.
- "My bill is fine": code forces rebuttal (Q4), callback offer (Q6), goodbye (E1).
- Classification: `connect_gate` was refused by the API's event list, gate and mailbox words never reached the transcript, so 22 calls showed as Human with 1 real. Worker now posts `heard`; new Gate tile.
- Recording starts before the dial (it lost the first 2.3 s when started on answer); playback skips the ring.

## 6 Nov 2026: Call Tap onboarding, CallTap list, voice and opening

- Call Tap tenant onboarded (owner Shubham signed in); client Australian Deal; paused campaign copied, 3 dials per agent. DNCR bypass kept on by Nithin's decision.
- Server resized to e2-standard-4 (3 parallel saturated 2 vCPUs). Nightly scale-down approved in principle, needs the IAM grant.
- Telvoq: max 3 calls at once. API now caps the Australian line at 3 across all tenants (AU_LINE_MAX_CALLS).
- CallTap 10K list (all NSW, all DNCR N): 115 calls over 4 runs. Real people mostly hang up in the first 5 s.
  Causes found in turn: talk-over (wait for hello), "how are you" without who (name opening), robotic voice
  (Cartesia Arlo -> Google Chirp 3 HD en-AU Leda as "Emma"), and a ~1 s gap after their hello (pre-rendered
  opening, 0.1 s pause: 0.43 s measured on a test call).
- Opening now: "Hi, it's Emma from Australian Deal. How are you doing today?"; S1 "I'm calling about your
  electricity bill. Are you the account holder?"
- Also: Excel/CSV lead import with column matching (Leads page and campaign page), AI call-screen handling,
  objection ladder for "don't need it", abuse -> apology + hang-up, no playbook answer given twice, sortable Calls.
- First gate press that reached a person: Sarah Freig, 6 Nov 08:01 UTC.

## 9 Nov: fixes from the 200 test calls

200 dials today (campaign limit is 200 a day, so the second run stopped at 100 of 200): about 22 real people, 0 transfers.

- **Opt-out:** "I don't want you ringing me up" matched nothing and got the next script line. The wording is wider, in `lines.ts` and `_OPT_OUT_REQUEST` in the worker (keep in step). The worker now decides before the model gets the turn. "Leave me alone" now suppresses the number instead of only apologising.
- **Their goodbye:** gets E1 and a hang-up. Before, `end_call` was refused and the model made up a rude reply.
- **Made-up lines:** model words matching no script line are replaced by the current step's question (Q7 first if they asked something) and logged as a `blocked_line` event. The third in a call gets E1. Confirming a booked callback is the one exception. Reactions in front of a tag can't accuse, promise or quote numbers.
- **"Are you an AI?":** answered yes in code, then the specialist offer and the question they were on, logged as AI_IDENTIFICATION. Not wanting an AI, or asking for a person, goes to the transfer with "No problem, I'll connect you with a specialist now." With no agent free they then hear the existing busy line and a callback is booked.
- **After a gate:** the carrier's "please stay on the line" no longer takes the greeting, and a hello from the person gets the introduction.
- **Labels:** 9 Nov mailbox and carrier wording added to both classifiers. Against 77 recent human-labelled calls it relabels 7, all machines. Past calls keep their labels.
- **Clarity:** `_VoiceShaper` runs a 21 ms linear-phase filter (high-pass 200 Hz, +5 dB around 2.2 kHz) before the gain. On an own-number recording, the 1-3.4 kHz share went from -14.8 to -10.5 dB. Costs 0.25 ms per 100 ms of speech. `TTS_CLARITY=0` turns it off. VM gain stays at 1 dB until heard on a call.

Tests: `agent-worker/tests/test_call_rails.py`. `test_guards.py`'s own main stops early and misses later tests, so run them all through an import.
