#!/usr/bin/env bash
# Seeds the "Wendy test (India)" campaign + flow + own-number leads into the
# tenant on the VM. Re-runnable. Usage:
#   ./deploy/gcp/seed-test-campaign.sh                      # uses TENANT_SLUG/OWNER_PHONE/OWNER_NAME from .env
#   ./deploy/gcp/seed-test-campaign.sh --phone +91... --phone +91...
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
: "${TENANT_SLUG:?set TENANT_SLUG in deploy/gcp/.env}"
GCP_ZONE="${GCP_ZONE:-${GCP_REGION:-australia-southeast1}-b}"
PHONES="$*"; [ -n "$PHONES" ] || PHONES="--phone ${OWNER_PHONE:?}"
gcloud config set project "$GCP_PROJECT_ID" >/dev/null
gcloud compute ssh cocally-app --zone="$GCP_ZONE" --tunnel-through-iap --quiet --command \
  "cd /opt/cocally && sudo docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T api \
     node apps/api/dist/seeds/seed-test-campaign.js --tenant-slug '$TENANT_SLUG' --first-name '${OWNER_NAME:-Nithin}' $PHONES"
