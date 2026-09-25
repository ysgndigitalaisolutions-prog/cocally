#!/usr/bin/env bash
# Creates (or updates) the LiveKit SIP trunk on the VM from the carrier's
# username/password credentials in deploy/gcp/.env, then prints the trunk id.
# Paste it into LIVEKIT_SIP_TRUNK_ID, set TELEPHONY_DRIVER=SIP, re-run setup.sh
# and redeploy (or `up -d api worker` on the VM).
#
#   ./deploy/gcp/provision-sip-trunk.sh            # outbound only
#   ./deploy/gcp/provision-sip-trunk.sh --inbound  # also inbound trunk + dispatch rule
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
: "${SIP_TRUNK_ADDRESS:?set SIP_TRUNK_ADDRESS in deploy/gcp/.env}"; : "${SIP_TRUNK_NUMBERS:?}"   # username/password optional (IP allow-list carriers)
GCP_ZONE="${GCP_ZONE:-${GCP_REGION:-australia-southeast1}-b}"
gcloud config set project "$GCP_PROJECT_ID" >/dev/null
# Credentials come from .env.prod inside the container (env_file), so they never appear on the ssh command line.
gcloud compute ssh cocally-app --zone="$GCP_ZONE" --tunnel-through-iap --quiet --command \
  "cd /opt/cocally && sudo docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T api \
     node apps/api/dist/seeds/provision-sip-trunk.js --name 'Carrier AU' $*"
