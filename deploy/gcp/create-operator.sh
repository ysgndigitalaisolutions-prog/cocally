#!/usr/bin/env bash
# Creates a CoCally ops-console operator on the VM (or re-issues their
# set-password link) and prints the one-time link. Usage:
#   ./deploy/gcp/create-operator.sh --email you@company.com --name "Your Name"
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
GCP_ZONE="${GCP_ZONE:-${GCP_REGION:-australia-southeast1}-b}"
[ $# -gt 0 ] || { echo 'Usage: ./deploy/gcp/create-operator.sh --email you@company.com --name "Your Name"'; exit 2; }
ARGS=""
for a in "$@"; do ARGS="$ARGS '${a//\'/}'"; done
gcloud config set project "$GCP_PROJECT_ID" >/dev/null
gcloud compute ssh cocally-app --zone="$GCP_ZONE" --tunnel-through-iap --quiet --command \
  "cd /opt/cocally && sudo docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T api \
     node apps/api/dist/seeds/create-operator.js $ARGS"
