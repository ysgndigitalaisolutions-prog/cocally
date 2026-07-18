#!/usr/bin/env bash
#
# CoCally local dev startup: brings up Mongo, installs deps, builds the
# shared package, seeds pilot data (first run only), then runs the API
# and web dev servers together. Ctrl-C stops both.
#
# Usage:
#   ./start.sh              # normal start
#   ./start.sh --reseed     # force re-run the seed script
#   ./start.sh --no-seed    # skip seeding entirely
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

RESEED=false
NO_SEED=false
for arg in "$@"; do
  case "$arg" in
    --reseed) RESEED=true ;;
    --no-seed) NO_SEED=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required (npm i -g pnpm)" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required (for MongoDB)" >&2; exit 1; }

log "Starting MongoDB (docker compose)"
docker compose up -d

log "Waiting for MongoDB to be healthy"
for i in $(seq 1 30); do
  status="$(docker compose ps --format '{{.Health}}' mongo 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  sleep 1
done
[ "$status" = "healthy" ] || { echo "MongoDB did not become healthy in time" >&2; exit 1; }

if [ ! -f apps/api/.env ]; then
  log "Creating apps/api/.env from .env.example"
  cp apps/api/.env.example apps/api/.env
fi

log "Installing dependencies (pnpm install)"
pnpm install

log "Building @cocally/shared"
pnpm --filter @cocally/shared build

SEEDED_MARKER=".seeded"
if [ "$NO_SEED" = false ]; then
  if [ "$RESEED" = true ] || [ ! -f "$SEEDED_MARKER" ]; then
    log "Seeding pilot tenant/users/flow/campaign/leads"
    pnpm --filter @cocally/api seed
    touch "$SEEDED_MARKER"
  else
    log "Already seeded (use --reseed to force) — skipping"
  fi
fi

cleanup() {
  log "Shutting down dev servers"
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT INT TERM

log "Starting API (:4000) and Web (:3000)"
pnpm --filter @cocally/api dev &
pnpm --filter @cocally/web dev &

echo
echo "  API      http://localhost:4000"
echo "  Web      http://localhost:3000"
echo "  Login    owner@cocally.dev / CoCally!Pilot2026 (see README for all seeded users)"
echo
echo "Press Ctrl-C to stop both servers."

wait
