#!/usr/bin/env bash
# Prints a one-time password-reset link for a user on the VM.
#   ./deploy/gcp/reset-password.sh +919902352425
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
ID="${1:?usage: reset-password.sh <+CC phone | email>}"
GCP_ZONE="${GCP_ZONE:-${GCP_REGION:-australia-southeast1}-b}"
gcloud config set project "$GCP_PROJECT_ID" >/dev/null
gcloud compute ssh cocally-app --zone="$GCP_ZONE" --tunnel-through-iap --quiet --command \
  "cd /opt/cocally && sudo docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T api \
     node apps/api/dist/seeds/reset-password.js --identifier '$ID'"
