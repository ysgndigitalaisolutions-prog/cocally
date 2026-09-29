# Reconcile: voice path from the hotfix line, everything else from pre-hotfix prod

**Date:** 2026-09-29. Branch `reconcile/voice-on-prod` = merge of `origin/prod` (hotfix line, 7e8bfdc) into `prod-before-hotfix` (a2ef4b9), pushed to `prod`.

## Rule applied (Nithin, 29 Sep)
Voice-related code from the hotfix line; the rest (ops console, billing, invoices, tenants, operator users, client usage page, call bar, lead state, docs archive) from pre-hotfix prod.

## Resolution
| Area | Taken from | Notes |
|---|---|---|
| `agent-worker/agent.py` | hotfix + today's fixes | Flux/VAD turns, stall guard, SIP-answer greeting, GCS recording, plus the transfer-close fix and `ENDPOINT_MIN_DELAY` below. |
| Worker `AGENT_NAME` (explicit dispatch) | dropped | Hotfix worker registers without a name and waits for `sip.callStatus == active` itself. |
| API `LIVEKIT_AGENT_NAME` + `dispatchAi` on answer | kept but **off by default** (`''`) | `call-progress.service.ts` only dispatches when a name is set. Setting one without a matching worker leaves calls silent. |
| AMD `hangup` reply from `/engine/calls/:id/amd` | API kept, worker ignores it | Voicemail/silence stays advisory (the false 26 s SILENCE hang-up is not back). |
| Per-tenant voice in the brief (`voice`) | API kept, worker ignores it | Worker uses env `TTS_PROVIDER`/`TTS_VOICE`. Port later if the Platform voice setting is needed. |
| Network-announcement AMD patterns, 5 s voicemail window | not carried | Old-prod worker features; bring back behind a switch if wanted. |
| Recording start | old prod: on answer (`markAnswered`) | Uses the hotfix's native GCS upload in `livekit.service.ts`. |
| Engine brief | auto-merged | Hotfix lines ("already greeted", 25-word rule, `sttModel`) plus old-prod tenant/voice fields. |
| Deploy (`setup.sh`, compose, backups) | identical to hotfix | `deploy/gcp/.env.example` keeps the quoted `MONGODB_URI=''` hint. |

Checks: `pnpm -r typecheck` clean; tests shared 20, web 17, api 19 all pass; worker compiles and imports.

## Worker changes in this commit
- **Failed transfer closes cleanly.** On NO_AGENT / DECLINED / FAILED the worker interrupts, speaks the approved apology itself, waits for it, then hangs up. The tool raises `StopResponse`, so the model no longer writes its own reply (28 Sep 19:10 bug: "Noted. One more..." cut off by the hang-up).
- **Model is silent during a transfer or close.** `on_user_turn_completed` raises `StopResponse` once a transfer or close has started; the customer's words are still posted, so an opt-out while waiting still hits the opt-out rail.
- **`ENDPOINT_MIN_DELAY`** (default 0.2 s, was 0.3) for Flux in VAD mode. Raise it if test calls show the AI cutting in on pauses.

## After deploy
One test call; check `timings.turns` end-of-turn drops from ~0.5 s toward ~0.4 s and no mid-sentence cut-ins. Ops console needs an operator user (`deploy/gcp/create-operator.sh`).

## Ops console: per-tenant latency (added 29 Sep, same day)

**Tenant → Latency tab** (`TenantLatency.tsx`, `GET /operator/tenants/:id/latency?from&to`). Today / 7 / 30 days:
- Headline: typical turn gap (p50), worst 5% (p95), share of replies under 1 s, pickup → first AI word.
- "Where the time goes": p50/p90/p95/max for end of turn, LLM first token, voice first audio, total gap, pickup → first word, AMD decision.
- By provider stack (stt · llm · tts), by the model that actually answered (fallbacks show here), by day (IST), and per call with a stage bar, max, stalls and stall-guard fires.
- Targets: green ≤ 1 s, amber > 1.5 s, red stall > 5 s (`LATENCY_TARGETS` in `ops-calls.service.ts`). Only "reply" turns (customer spoke, eou > 0) count; AI-initiated turns after a tool call are counted separately.

**Call page → Voice timings**: every turn with its stage bar, the served model and prompt tokens, plus worker events. The call detail previously read `turnMetrics`/`metrics`, which never existed; it now reads `timings.turns`.

**Worker → API**: `llmServed` (provider/model from the LLM metrics metadata) and `promptTokens` per turn; `POST /engine/calls/:id/events` with `answered`, `greeting` (pickup → first AI audio), `stall_guard`, `transfer` (result + wait). Stored in `timings.events` (last 100).

**Recording playback**: ops and tenant recording links now sign Google Cloud Storage URLs (`common/gcs-sign.ts`, `common/recording-url.ts`), for all three stored URI shapes (s3://, https GCS, bare key). Signature verified against the bucket 29 Sep; it returns 403 until the recordings service account gets read access:
`gcloud storage buckets add-iam-policy-binding gs://cocally-509318-recordings --member=serviceAccount:cocally-recordings@cocally-509318.iam.gserviceaccount.com --role=roles/storage.objectViewer`
