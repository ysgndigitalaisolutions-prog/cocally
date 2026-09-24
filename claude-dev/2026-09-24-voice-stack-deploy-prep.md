# Voice stack + deployment prep (2026-09-24)

Goal: production voice stack with the lowest latency, deployed to GCP for the pilot, using the Twilio trunk now and the AU carrier trunk later.

## Verified this session
- Groq key live. Models available: `qwen/qwen3.8-27b` (default, fastest), `openai/gpt-oss-120b` (quality). Llama 3.x gone.
- Deepgram key live (STT `nova-2-phonecall`, TTS Aura-2 `aura-2-luna-en`).
- Two LiveKit Cloud projects:
  - `demo-cocally-3347q5jp` — local dev (`apps/api/.env`, `agent-worker/.env`). Holds the only SIP trunk `ST_AzZWA7GCAdkr` → `cocally-livekit-1c9f4.pstn.twilio.com`, number `+12512999170`.
  - `cocally-wn9jxt2x` — production (`deploy/gcp/.env`). **No trunk yet.** Keep prod here so the dev worker never picks up prod rooms.
- Twilio: trial, USD 11.32, trunk `TK0f0e541056004dc501448c028f9f101c`, credential list `cocally-livekit-creds` user `cocallylivekit`. AU, IN, US dialing enabled. Trial = only verified numbers reachable, trial notice on every call.
- GCP: `nithinyakateela@gmail.com` still has no access to `cocally-509318`. `gh` not installed. `lk` CLI not installed.

## Done
- `deploy/gcp/.env` regenerated from the current template (old one lacked the voice + SIP_TRUNK sections). Kept all existing values; filled Deepgram/Groq keys, `LLM_MODEL=qwen/qwen3.8-27b`, `TTS_PROVIDER=deepgram`, `NOISE_CANCELLATION=1`, `WORKER_IDLE_PROCESSES=2`, `BUSINESS_TIMEZONE=Australia/Sydney`, Twilio trunk address/username/CLI. Still blank: `SIP_TRUNK_PASSWORD`, `LIVEKIT_SIP_TRUNK_ID`, DNCR, recording, tenant. `TELEPHONY_DRIVER` stays SIMULATION until the trunk is provisioned in the prod project.

## Blocked on Nithin
GCP Owner access; Twilio credential password (or permission to create a new credential); Twilio upgrade + AU number; TTS choice (Deepgram proven vs ElevenLabs/Cartesia key for lower TTFB, untested); DNCR creds for AU dials; tenant/owner details.

## Deploy sequence once unblocked
`gcloud auth login` → `./deploy/gcp/setup.sh` → push `prod` / run Deploy (VM) → `./deploy/gcp/provision-sip-trunk.sh` → set `LIVEKIT_SIP_TRUNK_ID`, `TELEPHONY_DRIVER=SIP` → re-run `setup.sh`, `up -d api worker` → India test calls from the VM → `provision-tenant.sh`.

## Later the same day
- Nithin granted `nithinyakateela@gmail.com` Owner at the org level and ran `setup.sh`: VM `cocally-app` in australia-southeast1-b, static IP 35.244.108.69. Project number 1041761530506, WIF provider `projects/1041761530506/locations/global/workloadIdentityPools/github/providers/github`, SAs `cocally-deployer@` / `cocally-runtime@`.
- New prod LiveKit key (cocally-wn9jxt2x) verified and stored in `deploy/gcp/.env`.
- `DNCR_BYPASS` flag added (config, suppression check, boot log, ops/ready, setup.sh, env files). tsc clean, 19/19 tests.
- `deploy/gcp/.env`: DOMAIN=app.co-cally.com, tenant YSGN/ysgn, owner Nithin +919902352425.
- Blocked by session permissions: creating the Twilio SIP credential, `git commit`/`push`, re-running `setup.sh`. Handed to Nithin as a runbook. GitHub repository variables are still unset (no `gh`), so the Deploy workflow skips until they are.
- ElevenLabs key received (restricted key: TTS works, `voices_read`/`user_read` missing; the plugin does not need them). Bug fixed in `agent.py`: the LiveKit plugin reads `ELEVEN_API_KEY`, so the key is now passed explicitly via `api_key=`; before this fix `TTS_PROVIDER=elevenlabs` silently fell back to Deepgram.
- Local timing (same sentence, warm): Deepgram Aura-2 first audio ~320 ms, full utterance ~1.8 s; ElevenLabs Flash v2.5 first audio ~340 ms, full utterance ~0.42 s. First-byte equal; ElevenLabs delivers the whole turn 4x sooner and has the better voice. `TTS_PROVIDER=elevenlabs` set in `deploy/gcp/.env`; revert to `deepgram` by env if a real call shows a problem.
- Twilio account shows Suspended in the console (API still says active). Advised a fresh, upgraded Twilio account; Nithin is on it.
