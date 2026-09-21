# Production readiness check + e2e positive flow (simulation)

**Date:** 2026-09-21
**Ask:** "how production grade is this, and deploy and check the full positive flow."
**Result:** the positive flow works end to end in simulation. The codebase is not deployable to production as-is; seven blockers listed below.

## What was run

- `pnpm --filter @cocally/shared build`, `tsc --noEmit` on api and web: clean.
- `pnpm -r test`: 5 files, 33 tests, all pass (shared 19, api 14).
- Mongo via docker compose, API `pnpm dev` on :4000, existing seed data.
- Flow driven over the REST API as admin + agent1, transfer id read from the `transfers` collection because the offer is only pushed over Socket.IO.

## Positive flow, verified step by step

| Step | Observed |
|---|---|
| Health | `GET /ops/health` → ok, db connected |
| Login | admin (`admin`/`1234`), agent1 → JWTs |
| Agent | clock-in, presence AVAILABLE |
| Dial | `POST /calls/dev-dial` (Aurora Solar VIC, lead Hugo) with scripted qualifying replies |
| AI leg | AMD HUMAN in 800 ms, disclosure spoken and logged as compliance event, score 10 on turn 1, summary built |
| Transfer | `transfers` doc OFFERED at t+1 s, agent presence RESERVED; `POST /workspace/transfers/:id/accept` → ok |
| Bridge | call BRIDGED, agent ON_CALL, briefing card returns lead, location, score, facts, summary, rebuttals |
| Disposition | `POST /calls/:id/disposition` BOOKED with `scheduledFor` + `durationMinutes` → ok |
| Close-loop | call COMPLETED with endedAt, agent WRAP_UP, appointment created (30 min), 2 recording records, my-insights shows handled 1 / booked 1 / talk 34 s, transfers offered 2 accepted 1 timed-out 1 |

First attempt timed out on purpose (I did not accept in the 12 s window): call went COMPLETED, agent returned to AVAILABLE. Cascade and timeout path therefore also observed.

Gaps noticed while driving it: `GET /workspace/me` does not expose the pending transfer offer, so a client that misses the socket event cannot recover it; `webhookdeliveries` had 0 rows for the call (no subscription configured, so expected); lead `state` is the geographic state, not lifecycle, which confuses API consumers.

## Production readiness (read-only audit, file refs in the audit output)

### Blockers
1. `GET /calls/:id/lead-token` is `@Public()`, no tenant scope, mints a 2 h publish+subscribe LiveKit token for any call id. Anyone with a call id can join a live customer call.
2. `JWT_SECRET` and `VAULT_KEY` have working defaults in `common/config.ts`. A deploy that forgets them boots and every token is forgeable; provider secrets are encrypted under a known key.
3. `z.coerce.boolean()` on `RECORDING_ENABLED` and `DNCR_ENABLED`: the string "false" is true.
4. No rate limiting or login lockout; 64 MB body limit on unauthenticated routes.
5. Nothing deployable: no Dockerfiles for api/web/worker, compose runs Mongo only, CI builds and tests but never ships an image, no TLS/reverse-proxy config, no migrations step.
6. All schedulers are `@Interval` in-process with a per-process boolean guard. Two replicas = two dialers, duplicate webhook deliveries, duplicate DNCR washes.
7. Live-call state (active calls, pending transfers, wrap-up deadlines, socket registry, analytics cache) is process-local. Restart loses in-flight offers; a second instance splits them.

### Should fix before a paying client
- Tick bodies have `try/finally` with no `catch`; a Mongo blip becomes an unhandled rejection and kills the process on Node 20.
- 13 provider `fetch()` calls with no timeout (Deepgram, ElevenLabs, OpenAI, Anthropic, Groq, Google). DNCR and webhooks do it right.
- Untyped bodies on tenants, cli, flows controllers bypass the global ValidationPipe.
- Service token compared with `!==`, not timing-safe. WebSocket CORS reflects any origin. JWT in localStorage, 8 h, no revocation.
- No structured logging, request ids, error tracking, metrics, or readiness probe.
- No migration framework, no backup runbook, recordings default to local disk.
- Tests: 33 cases, none for auth, dialer, DNCR, engine, transfers, controllers. Web has none. Python worker has none and is not in CI.
- Python deps unpinned (`~=`), no lockfile.
- `claude-dev/LOGINS.md` contains a live Deepgram API key, and it is already in commit 064cd9a. Rotate the key now and remove the line; the repo history keeps it unless rewritten.
- Untracked `_backup-*`, `_to_delete/`, `_incoming/` folders; ~40 modified files uncommitted, so CI has not seen the current tree.

### Solid
- Every controller route carries `@Roles` except 8 intentional `@Public` routes; RolesGuard is default-deny; tenant scoping consistent.
- LiveKit webhook signature verification is correct on raw body; outbound webhooks HMAC-signed with per-subscription secrets.
- Mongo indexes tenant-first and thorough. Global ValidationPipe with whitelist. helmet, argon2, TOTP 2FA, shutdown hooks.
- Env centralised and zod-validated; `isLiveTelephony()` requires SIP driver + all LiveKit vars before any real INVITE.
- Python worker: bounded timeouts, bearer auth to the engine, never-kill-the-call error handling.

## Verdict

Pilot-grade for a single instance behind a trusted network with hand-holding. Not production-grade. The seven blockers are roughly one week of work (items 1 to 4 are a day; 5 is two to three days; 6 and 7 mean Redis-backed locks and state, two to three days, or a documented single-instance deployment with an accepted restart risk for the pilot).
