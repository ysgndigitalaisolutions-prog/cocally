#!/usr/bin/env bash
# Provisions the first tenant + owner on the VM after the first deploy, using
# TENANT_* / OWNER_* from deploy/gcp/.env. Prints the owner's one-time invite link.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
: "${TENANT_NAME:?set TENANT_NAME in deploy/gcp/.env}"; : "${TENANT_SLUG:?}"; : "${OWNER_NAME:?}"; : "${OWNER_PHONE:?}"
GCP_ZONE="${GCP_ZONE:-${GCP_REGION:-australia-southeast1}-b}"
gcloud config set project "$GCP_PROJECT_ID" >/dev/null
gcloud compute ssh cocally-app --zone="$GCP_ZONE" --tunnel-through-iap --quiet --command \
  "cd /opt/cocally && sudo docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T api \
     node apps/api/dist/seeds/provision-tenant.js --name '$TENANT_NAME' --slug '$TENANT_SLUG' \
     --owner-name '$OWNER_NAME' --owner-phone '$OWNER_PHONE'"
