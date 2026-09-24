# CoCally handoff: state, India test plan, deployment needs

**Date:** 2026-09-25. **Audience:** the engineer taking CoCally through live-call testing in India and then to the GCP deployment for the Australian pilot.

## 1. Where things stand

CoCally is an AI-first outbound call-centre platform: NestJS API (`apps/api`), Next.js web (`apps/web`), Python LiveKit Agents voice worker (`agent-worker/`), Mongo. The AI "fronter" dials a lead, qualifies them, and warm-transfers to a human "closer" on the floor.

| Area | State |
|---|---|
| Code | Hardened 2026-09-24/25. ~110 audit findings; P0/P1 fixed. See `2026-09-24-e2e-check-and-edge-case-removal.md`. |
| Tests | API unit tests 19/19. Two end-to-end scripts pass: pilot onboarding + AI call on the **production images** (41 checks), and the India flow on the dev API (13 checks). |
| Deployment | **Not deployed.** Deploy workflows skip until `deploy/gcp/setup.sh` has run once. CI failed on the last push (worker image); fixed locally, uncommitted. |
| Telephony | `SIMULATION` everywhere. A real LiveKit → Twilio trunk exists and completed calls to Indian numbers in July 2026, but nothing since the September changes has been proven on it. |
| Uncommitted | Everything from 2026-09-25 (see §7). Commit and push to get CI green. |

## 2. Accounts that already exist

Values live in `apps/api/.env` and `agent-worker/.env` (gitignored). Do not create new ones for testing.

| Service | What exists | Notes |
|---|---|---|
| LiveKit Cloud | Project `cocally-wn9jxt2x` (`LIVEKIT_URL`, key, secret). Outbound SIP trunk `ST_AzZWA7GCAdkr` "cocally-twilio-outbound" → `cocally-livekit-1c9f4.pstn.twilio.com`, digest auth, number `+12512999170`. No inbound trunk, no dispatch rules. | The worker uses per-room automatic dispatch (no `agent_name`), so any worker connected to the project picks up every `call-<id>` room. **Run only one worker at a time against this project.** |
| Twilio | Account "My first Twilio account", **trial**, balance USD 11.32. Elastic SIP trunk `TK0f0e…101c` with credential list `cocally-livekit-creds`, number `+12512999170`. India dialing permission enabled. Verified caller IDs: `+91 89853 50964`, `+91 74165 85225`, `+91 99023 52425`. | Trial means: **only the three verified numbers can be called**, every call is prefixed with Twilio's trial notice, and the CLI presented is the US number. Upgrading the account (add credit) removes the first two. |
| Deepgram | `DEEPGRAM_API_KEY` | STT `nova-2-phonecall`, TTS Aura-2. |
| Groq | `GROQ_API_KEY` | LLM. **Groq retired the Llama 3.x models in September 2026.** Default is now `qwen/qwen3.8-27b` (reasoning off, ~190 ms to first token). `openai/gpt-oss-120b` is the quality option via `LLM_MODEL`. |
| GCP | Project `cocally-509318` exists, but `nithinyakateela@gmail.com` cannot access it. | See §5. |

## 3. What changed for India testing (2026-09-25)

The platform was AU-only in a few places. It now supports a second country pack for internal testing:

- **`IN` country pack** (`apps/api/src/modules/country-packs/in.pack.ts`): region IN, `Asia/Kolkata`, calling window 09:00–21:00 IST every day (TRAI window), DNC **not enforced** (there is no NCPR integration; this pack is for calling our own numbers only). Seeded on API boot alongside AU.
- **Campaign form** has a Country selector when more than one pack is active. A campaign on the IN pack imports and validates `+91` numbers; an AU number is rejected on that campaign, and vice versa.
- **Phone login and opt-out** no longer assume Australia for `+CC…` numbers: a user with a `+91` phone can be invited and can log in; opt-out with a bare Indian number resolves against the tenant's leads.
- Per your instruction, the AU-specific timezone/postcode inference in `leads.service.ts` and `au-geo.ts` is **left as is**; IN leads simply get `Asia/Kolkata`.

## 4. India live-call test plan (local machine, real phones)

Goal: prove the voice pipeline on a real PSTN call before touching GCP. Everything runs on your laptop except LiveKit and Twilio.

1. **Switch the API to live telephony** in `apps/api/.env`: `TELEPHONY_DRIVER=SIP` (the trunk id is already set). Restart `pnpm dev` in `apps/api`. `GET /api/v1/ops/ready` must show `"telephony":"SIP"`.
2. **Start the worker**: `cd agent-worker && .venv/bin/python agent.py dev` (or `start`). It needs `LIVEKIT_*`, `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `ENGINE_BASE_URL=http://localhost:4000/api/v1`, `ENGINE_SERVICE_TOKEN` matching the API. It refuses to start if any are missing. Watch for "registered worker".
3. **Webhooks**: LiveKit must reach the API's webhook route for participant/egress events. Locally that means a tunnel (e.g. `ngrok http 4000`) and the tunnel URL configured as a webhook in the LiveKit Cloud project settings, pointing at `/api/v1/telephony/livekit/webhook` (check `livekit-webhook.controller.ts` for the exact path). Without it, answer/hangup are only detected through `waitUntilAnswered` and the maintenance sweep.
4. **In the web app** (`pnpm dev` in `apps/web`, login `admin`/`1234`): Campaigns → create "India test dial" with Country = India. Attach a published flow ("AI script" on the campaign page), assign the closer, import a CSV with the three verified numbers, Activate.
5. **Agent side**: second browser, login `agent`/`1234`, Clock in, go Available.
6. **Dial**: from the campaign page use the per-lead dial, or let the dialer tick place calls (it needs an Available agent and the IST calling window). Answer the phone.
7. **Check, in order**: disclosure line plays immediately on pickup; AI responds within about a second; say "yes, put me through" → the closer's Global Call Bar rings with the fact card; accept → both legs bridged; hang up → wrap-up → disposition; the call page shows transcript, QA score, summary, and the per-turn latency line; the dashboard KPI tile "AI response p50/p95" updates.
8. **Negative cases**: don't answer (should finalise as NO_ANSWER via SIP 480/408 mapping); decline the call (603 → outcome); let it go to voicemail; agent declines the transfer (AI continues, schedules callback); agent socket drop mid-call (presence must stay ON_CALL).
9. **Recording**: leave `RECORDING_ENABLED` off unless an S3 bucket is configured; playback via `GET /calls/:id/recording` is untested on real audio.

Costs: Twilio charges the trunk minutes from the USD 11 balance; Deepgram and Groq are pay-per-use on their keys.

The e2e scripts are in the session scratchpad and are worth keeping in the repo under `apps/api/e2e/` if you want repeatable runs: `pilot.mjs` (fresh tenant → booked call on the production stack) and `india.mjs`.

## 5. What is needed for GCP

The deployment is one Compute Engine VM in `australia-southeast1` running the Compose stack (Caddy TLS, api, web, worker, mongo). Everything is scripted; what is missing is access.

1. **Owner access on project `cocally-509318`** for the Google account that will run `deploy/gcp/setup.sh` (or add `nithinyakateela@gmail.com` as Owner). Then `gcloud auth login` and `gcloud config set project cocally-509318`. Billing must be enabled on the project.
2. **`deploy/gcp/.env`** is already filled for target `vm` with the LiveKit values; add the Deepgram and Groq keys and (later) the DNCR and carrier values. Blank fields are allowed.
3. **GitHub**: the script sets the repository variables itself if `gh` is installed and logged in; otherwise it prints them to paste under Settings → Variables. Until they exist, every push to `prod` shows the Deploy workflows as *skipped*.
4. Run `./deploy/gcp/setup.sh`, then push to `prod` (or run the "Deploy (VM)" workflow). The workflow ends with a health gate on `/api/v1/ops/ready`.
5. `./deploy/gcp/provision-tenant.sh` creates the first tenant, its client, and prints the owner's invite link.
6. For live telephony on the VM: `SIP_TRUNK_*` in `.env` → `./deploy/gcp/provision-sip-trunk.sh` → paste the id into `LIVEKIT_SIP_TRUNK_ID`, `TELEPHONY_DRIVER=SIP`, re-run `setup.sh`, redeploy. For India testing you can instead point the VM at the existing Twilio trunk id.

Cost: about USD 55/month for `e2e-standard-2`; `e2-standard-4` (~USD 110) for 20 concurrent AI calls.

## 6. What is needed for LiveKit

Nothing new for India testing; the existing project and trunk work. For the AU pilot:

- Decide whether production uses the same LiveKit project or a new one. A separate project is cleaner (the dev worker would otherwise pick up production rooms). If new: create it in LiveKit Cloud, note URL/key/secret, and create the trunk with `provision-sip-trunk` once the carrier credentials arrive.
- The AU carrier authenticates by **username/password**, which is required because LiveKit's `aus` SIP region has no published static IPs. Give the carrier `sip:5g5k1tqux4m.aus.sip.livekit.cloud` (production project) as our inbound endpoint if inbound is wanted.
- Optional lower-latency TTS: `TTS_PROVIDER=elevenlabs` or `cartesia` with the matching key. Untested here.

## 7. Uncommitted changes in the working tree (2026-09-25)

- Worker: env check only on `start`/`dev`; idles in simulation; Groq model switch with explicit `reasoning_effort`.
- API: Groq adapter model list and error detail; campaign `activeFlowVersionId` validation; summary `{{name}}`/`{{location}}`; `provision-tenant` creates a client (`--client-name`); `provision-sip-trunk` reads `SIP_TRUNK_ADDRESS`/`_TRANSPORT`; IN country pack; `regionOf` in phone util; opt-out lead fallback.
- Web: campaign form creates a client inline and has a Country selector; campaign page has the AI script picker and shows errors.
- Deploy: `setup.sh` passes trunk and voice settings; `provision-sip-trunk.sh`; `DEPLOY.md` sections on skipped deploys and the live-telephony switch; `.env.example` files.

## 8. Known gaps (unchanged)

Real-trunk answer/no-answer/voicemail outcomes, egress → S3 playback, whisper, ElevenLabs/Cartesia paths; supervisor roster and force-Available; CSV column-mapping UI; S3 retention; multi-instance (Redis) is out of scope for the pilot. ACMA DNCR credentials are required before any AU customer is dialled: with washing off, every AU dial is blocked.
