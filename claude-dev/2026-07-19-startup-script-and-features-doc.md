# CoCally — Startup script & product features doc

> Session log: 19 July 2026. Added a one-command local dev startup script and a full product-features document (with the prompt flow) for onboarding/reference. No application code changed.

## What changed

- **`start.sh`** (repo root): brings up MongoDB via `docker compose`, waits for its healthcheck, copies `apps/api/.env.example` → `apps/api/.env` on first run, `pnpm install`s, builds `@cocally/shared`, seeds pilot data (skipped on subsequent runs via a `.seeded` marker unless `--reseed` is passed, or skipped entirely with `--no-seed`), then runs the API and web dev servers concurrently. Ctrl-C tears down both dev processes.
- **`.gitignore`**: added `.seeded` (the marker file `start.sh` uses to avoid reseeding on every run).
- **`claude-dev/product-features.md`**: a feature-by-feature tour of the product (campaigns/flows, AI engine, telephony/dialer, warm transfer, workspace, leads, PAL, recording/QA, compliance, analytics/insights, admin/platform), ending with a full walkthrough of the prompt flow — how a conversation turn is composed, sent, and executed. Written to stand alone as onboarding/reference material; the deep prompt-engineering internals still live in `prompting-architecture.md`, which it links out to.

## Why

Nithin asked for a startup script and a document covering all product features including the prompt flow, for reference/onboarding purposes.

## Verification

- `bash -n start.sh` — syntax check passes.
- Not run end-to-end against live Docker/pnpm in this session (no code paths changed that would affect the existing verified boot sequence in `initial-build.md` §7); the script mirrors the exact command sequence already documented and manually verified in `README.md` / `initial-build.md` §11, just automated with health-wait, idempotent seeding, and concurrent process management added on top.

## Open items

- None — this was documentation/tooling only.
