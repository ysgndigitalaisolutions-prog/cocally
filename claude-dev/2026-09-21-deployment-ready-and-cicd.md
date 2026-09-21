# Deployment-ready build + CI/CD

**Date:** 2026-09-21
**Ask:** make the repo deployment ready including CI/CD pipelines.

## What was built

### Containers
- `apps/api/Dockerfile` — multi-stage, pnpm workspace-aware, prod-only deps, non-root, healthcheck on `/api/v1/ops/ready`. Seeds compile into `dist/seeds/seed.js`.
- `apps/web/Dockerfile` — Next.js standalone output (`next.config.ts` gained `output: 'standalone'` + monorepo tracing root). `NEXT_PUBLIC_API_URL` is a build arg.
- `agent-worker/Dockerfile` — python 3.12-slim, model weights pre-downloaded, non-root, `python agent.py start`.
- `.dockerignore` at the root.

### Stack (`deploy/`)
- `docker-compose.prod.yml` — caddy, api, web, worker, mongo:7 with volumes, healthchecks, log rotation. Images from GHCR, tag = git SHA.
- `Caddyfile` — TLS via Let's Encrypt, `/api/*` and `/socket.io/*` to the API, everything else to web, security headers.
- `.env.prod.example`, `backup-mongo.sh` (nightly dump, 14-day local retention, optional rclone off-box), `DEPLOY.md` runbook.

### Pipelines (`.github/workflows/`)
- `ci.yml` — on main/prod pushes and PRs: typecheck, tests, web + api build; Python worker install + compile; Docker build of all three images (no push) with GHA layer cache.
- `deploy.yml` — on push to `prod` or manual: test → build and push 3 images to GHCR (sha + latest) → scp compose files → ssh `compose pull && up -d` with a job-scoped GHCR login → health gate on `/ops/ready`. Uses a `production` environment so reviewers can be required.

### API hardening (the blockers from the readiness audit)
- `config.ts`: `NODE_ENV`; strict `envBool()` replaces `z.coerce.boolean()` (the string "false" is now false); in production the schema refuses dev `JWT_SECRET`/`VAULT_KEY`, short `JWT_SECRET`/`ENGINE_SERVICE_TOKEN`, localhost `MONGODB_URI`/`CORS_ORIGIN`, and `DEMO_LEAD_TOKEN_ENABLED`. `CORS_ORIGIN` is comma-separated; `TRUST_PROXY` added.
- `main.ts`: 64 MB body limit now only on `/leads/import`; 1 MB elsewhere; trust proxy behind Caddy; multi-origin CORS.
- `@nestjs/throttler`: 600 req/min per IP globally, 10/min on login.
- `calls.controller.ts` lead-token: gated by `DEMO_LEAD_TOKEN_ENABLED`, and only for a live call under 30 minutes old.
- `service-token.guard.ts`: `timingSafeEqual`.
- `realtime.gateway.ts`: websocket CORS uses the configured origins instead of reflecting any.
- `ops.controller.ts`: `GET /ops/ready` (503 until Mongo connected; reports env, telephony mode, dncr, recording).

## Verified
- `tsc --noEmit` clean on api and web; 33 tests pass.
- Production config: boots with dev defaults → fails naming JWT_SECRET, VAULT_KEY, MONGODB_URI, CORS_ORIGIN; boots with proper values → ok. `RECORDING_ENABLED=false` → false, `DNCR_ENABLED=TRUE` → true.
- Login throttle: 10 × 401 then 429. Lead-token → 404. 2 MB body on login → 413.
- Dev API restarted on the new code; `/ops/ready` returns ready.
- Docker builds: see the end of this file.

## Not done / next
- Redis-backed locks and shared state for multi-instance (documented single-instance limit instead).
- Provider `fetch()` timeouts, structured logging, error tracking, more tests.
- Recording adapter to a bucket is env-driven but unverified against a real bucket.
- A real VM has not been provisioned; the first `prod` push will exercise deploy.yml for real. Secrets/variables needed are listed in DEPLOY.md.

## Docker build + production stack smoke test (results)

- First build failed: a stale `tsconfig.tsbuildinfo` was copied into the context, so `tsc` emitted nothing. Fixed by ignoring `**/*.tsbuildinfo` in `.dockerignore`.
- Second failure: `express` is imported directly in `main.ts` but was only a transitive dependency; the pruned production install could not resolve it. Added `express` + `@types/express` to `apps/api`.
- All three images build: api 93 MB, web 76 MB, worker 261 MB (compressed).
- `docker-compose.prod.yml` brought up locally from those images with `NODE_ENV=production`, random secrets and a placeholder origin: mongo healthy, api healthy via `/ops/ready` reporting `env: production`, web 200 through Caddy, API 200 through Caddy, seed ran inside the container and skipped the `admin/1234` demo logins, pilot login returned a JWT, demo login returned 401.
- Production guard confirmed in the container: with `DOMAIN=localhost` the API refused to boot naming `CORS_ORIGIN`.
- Worker container restarts in a loop without LiveKit credentials (expected; it needs `LIVEKIT_*` in `.env.prod`).
- `deploy.yml`'s deploy job is skipped until the `APP_DOMAIN` repository variable exists, so pushes to `prod` build and publish images now and only ship once the VM is configured.
