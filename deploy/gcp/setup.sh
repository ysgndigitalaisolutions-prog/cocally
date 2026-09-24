#!/usr/bin/env bash
# Readies a GCP project for CoCally from deploy/gcp/.env, then wires GitHub so
# that a push to `prod` deploys. Idempotent: every step is create-if-missing.
#
#   cp deploy/gcp/.env.example deploy/gcp/.env   # fill it in
#   ./deploy/gcp/setup.sh
#
# Needs: gcloud (logged in as a project Owner), openssl. Optional: gh (GitHub
# CLI, logged in) to set the repository variables automatically; without it
# the values are printed for you to paste.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "deploy/gcp/.env not found. Copy .env.example and fill it in." >&2; exit 2; }
set -a; . ./.env; set +a

: "${GCP_PROJECT_ID:?}"; : "${GITHUB_REPO:?}"
DEPLOY_TARGET="${DEPLOY_TARGET:-vm}"
GCP_REGION="${GCP_REGION:-australia-southeast1}"
GCP_ZONE="${GCP_ZONE:-${GCP_REGION}-b}"
VM_NAME="cocally-app"
AR_REPO="cocally"
RUNTIME_SA="cocally-runtime"
DEPLOYER_SA="cocally-deployer"
POOL="github"; PROVIDER="github"
STATE_DIR=".state"; mkdir -p "$STATE_DIR"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

gcloud config set project "$GCP_PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_EMAIL="${RUNTIME_SA}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_EMAIL="${DEPLOYER_SA}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

# ---------------------------------------------------------------- shared
log "Enabling APIs"
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com compute.googleapis.com run.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com iap.googleapis.com >/dev/null

log "Service accounts"
gcloud iam service-accounts describe "$RUNTIME_EMAIL" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$RUNTIME_SA" --display-name="CoCally runtime" >/dev/null
gcloud iam service-accounts describe "$DEPLOYER_EMAIL" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$DEPLOYER_SA" --display-name="CoCally GitHub deployer" >/dev/null
bind_project() { gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" --member="$1" --role="$2" --condition=None >/dev/null; }
bind_project "serviceAccount:${DEPLOYER_EMAIL}" roles/artifactregistry.writer
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_EMAIL" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" --role=roles/iam.serviceAccountUser >/dev/null

log "Keyless GitHub -> GCP auth (Workload Identity Federation) for ${GITHUB_REPO}"
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions" >/dev/null
gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global --workload-identity-pool="$POOL" \
    --display-name="GitHub" --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='${GITHUB_REPO}'" >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_EMAIL" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" >/dev/null

# Generated once, kept locally in .state so re-runs reuse them.
gen_secret() { local f="$STATE_DIR/$1"; [ -s "$f" ] || openssl rand -hex 32 > "$f"; cat "$f"; }
JWT_SECRET="$(gen_secret JWT_SECRET)"; VAULT_KEY="$(gen_secret VAULT_KEY)"; ENGINE_SERVICE_TOKEN="$(gen_secret ENGINE_SERVICE_TOKEN)"

VARS=()   # NAME=VALUE pairs for GitHub repository variables
set_var() { VARS+=("$1=$2"); }
set_var DEPLOY_TARGET "$DEPLOY_TARGET"
set_var GCP_PROJECT_ID "$GCP_PROJECT_ID"
set_var GCP_PROJECT_NUMBER "$PROJECT_NUMBER"
set_var GCP_REGION "$GCP_REGION"
set_var GCP_WIF_PROVIDER "$WIF_PROVIDER"
set_var GCP_DEPLOYER_SA "$DEPLOYER_EMAIL"
set_var GCP_RUNTIME_SA "$RUNTIME_EMAIL"
set_var TELEPHONY_DRIVER "${TELEPHONY_DRIVER:-SIMULATION}"

# ---------------------------------------------------------------- vm target
if [ "$DEPLOY_TARGET" = "vm" ]; then
  log "Static IP + firewall"
  gcloud compute addresses describe cocally-ip --region="$GCP_REGION" >/dev/null 2>&1 ||
    gcloud compute addresses create cocally-ip --region="$GCP_REGION" >/dev/null
  IP="$(gcloud compute addresses describe cocally-ip --region="$GCP_REGION" --format='value(address)')"
  gcloud compute firewall-rules describe cocally-web >/dev/null 2>&1 ||
    gcloud compute firewall-rules create cocally-web --allow=tcp:80,tcp:443,udp:443 --target-tags=cocally-web \
      --source-ranges=0.0.0.0/0 --description="CoCally public HTTP/HTTPS" >/dev/null
  # SSH only through Identity-Aware Proxy; port 22 is never open to the internet.
  gcloud compute firewall-rules describe cocally-iap-ssh >/dev/null 2>&1 ||
    gcloud compute firewall-rules create cocally-iap-ssh --allow=tcp:22 --target-tags=cocally-web \
      --source-ranges=35.235.240.0/20 --description="SSH via IAP only" >/dev/null

  APP_DOMAIN="${DOMAIN:-${IP}.sslip.io}"

  log "VM ${VM_NAME} (${VM_MACHINE_TYPE:-e2-standard-2}, ${GCP_ZONE})"
  if ! gcloud compute instances describe "$VM_NAME" --zone="$GCP_ZONE" >/dev/null 2>&1; then
    cat > "$STATE_DIR/startup.sh" <<'STARTUP'
#!/usr/bin/env bash
set -euo pipefail
if ! command -v docker >/dev/null; then
  apt-get update && apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com | sh
fi
mkdir -p /opt/cocally/backups
chmod 755 /opt/cocally
STARTUP
    gcloud compute instances create "$VM_NAME" --zone="$GCP_ZONE" \
      --machine-type="${VM_MACHINE_TYPE:-e2-standard-2}" \
      --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
      --boot-disk-size="${VM_DISK_GB:-50}GB" --boot-disk-type=pd-balanced \
      --address=cocally-ip --tags=cocally-web \
      --service-account="$RUNTIME_EMAIL" --scopes=cloud-platform \
      --metadata=enable-oslogin=TRUE --metadata-from-file=startup-script="$STATE_DIR/startup.sh" \
      --shielded-secure-boot >/dev/null
    echo "  created; waiting for Docker install"
    sleep 60
  fi

  # Deployer can SSH as an admin through IAP (OS Login), nothing else.
  bind_project "serviceAccount:${DEPLOYER_EMAIL}" roles/compute.osAdminLogin
  bind_project "serviceAccount:${DEPLOYER_EMAIL}" roles/iap.tunnelResourceAccessor
  bind_project "serviceAccount:${DEPLOYER_EMAIL}" roles/compute.viewer

  log "Writing .env.prod and copying the stack to the VM"
  cat > "$STATE_DIR/.env.prod" <<ENV
# Generated by deploy/gcp/setup.sh $(date -u +%FT%TZ). Lives only on the VM at /opt/cocally/.env.prod.
DOMAIN=${APP_DOMAIN}
IMAGE_REGISTRY=ghcr.io/${GITHUB_REPO%%/*}
IMAGE_TAG=latest
JWT_SECRET=${JWT_SECRET}
VAULT_KEY=${VAULT_KEY}
ENGINE_SERVICE_TOKEN=${ENGINE_SERVICE_TOKEN}
TELEPHONY_DRIVER=${TELEPHONY_DRIVER:-SIMULATION}
LIVEKIT_URL=${LIVEKIT_URL:-}
LIVEKIT_API_KEY=${LIVEKIT_API_KEY:-}
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET:-}
LIVEKIT_SIP_TRUNK_ID=${LIVEKIT_SIP_TRUNK_ID:-}
SIP_TRUNK_ADDRESS=${SIP_TRUNK_ADDRESS:-}
SIP_TRUNK_USERNAME=${SIP_TRUNK_USERNAME:-}
SIP_TRUNK_PASSWORD=${SIP_TRUNK_PASSWORD:-}
SIP_TRUNK_NUMBERS=${SIP_TRUNK_NUMBERS:-}
SIP_TRUNK_TRANSPORT=${SIP_TRUNK_TRANSPORT:-udp}
HOLD_MUSIC_URL=${HOLD_MUSIC_URL:-}
BUSINESS_TIMEZONE=${BUSINESS_TIMEZONE:-Australia/Sydney}
DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-}
GROQ_API_KEY=${GROQ_API_KEY:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY:-}
CARTESIA_API_KEY=${CARTESIA_API_KEY:-}
# Voice pipeline knobs (agent-worker/README.md, "Latency"):
LLM_MODEL=${LLM_MODEL:-qwen/qwen3.8-27b}
TTS_PROVIDER=${TTS_PROVIDER:-deepgram}
TTS_VOICE=${TTS_VOICE:-}
NOISE_CANCELLATION=${NOISE_CANCELLATION:-1}
WORKER_IDLE_PROCESSES=${WORKER_IDLE_PROCESSES:-2}
DNCR_ENABLED=$([ -n "${DNCR_ACCOUNT_ID:-}" ] && echo true || echo "")
DNCR_BYPASS=${DNCR_BYPASS:-}
DNCR_ACCOUNT_ID=${DNCR_ACCOUNT_ID:-}
DNCR_PASSPHRASE=${DNCR_PASSPHRASE:-}
RECORDING_ENABLED=$([ -n "${RECORDING_BUCKET:-}" ] && echo true || echo "")
RECORDING_BUCKET=${RECORDING_BUCKET:-}
RECORDING_S3_REGION=${RECORDING_S3_REGION:-}
RECORDING_S3_ACCESS_KEY=${RECORDING_S3_ACCESS_KEY:-}
RECORDING_S3_SECRET=${RECORDING_S3_SECRET:-}
RECORDING_S3_ENDPOINT=${RECORDING_S3_ENDPOINT:-}
ENV
  chmod 600 "$STATE_DIR/.env.prod"
  SSH=(gcloud compute ssh "$VM_NAME" --zone="$GCP_ZONE" --tunnel-through-iap --quiet --command)
  for i in 1 2 3 4 5 6; do "${SSH[@]}" "sudo test -d /opt/cocally" 2>/dev/null && break; echo "  waiting for VM ssh…"; sleep 15; done
  "${SSH[@]}" "sudo chown \$(whoami) /opt/cocally && sudo usermod -aG docker \$(whoami)"
  gcloud compute scp --zone="$GCP_ZONE" --tunnel-through-iap --quiet \
    ../docker-compose.prod.yml ../Caddyfile ../backup-mongo.sh "$STATE_DIR/.env.prod" "$VM_NAME":/opt/cocally/ >/dev/null
  "${SSH[@]}" "chmod 600 /opt/cocally/.env.prod && chmod +x /opt/cocally/backup-mongo.sh && (crontab -l 2>/dev/null | grep -q backup-mongo || (crontab -l 2>/dev/null; echo '15 16 * * * /opt/cocally/backup-mongo.sh >> /opt/cocally/backups/backup.log 2>&1') | crontab -)"

  set_var VM_NAME "$VM_NAME"
  set_var GCP_ZONE "$GCP_ZONE"
  set_var APP_DOMAIN "$APP_DOMAIN"
  PUBLIC_URL="https://${APP_DOMAIN}"
fi

# ---------------------------------------------------------------- cloudrun target
if [ "$DEPLOY_TARGET" = "cloudrun" ]; then
  log "Artifact Registry + Cloud Run permissions"
  gcloud artifacts repositories describe "$AR_REPO" --location="$GCP_REGION" >/dev/null 2>&1 ||
    gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$GCP_REGION" >/dev/null
  bind_project "serviceAccount:${DEPLOYER_EMAIL}" roles/run.admin
  bind_project "serviceAccount:${RUNTIME_EMAIL}" roles/secretmanager.secretAccessor

  log "Secret Manager"
  put_secret() { # name value
    if gcloud secrets describe "$1" >/dev/null 2>&1; then
      printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
    else
      printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=user-managed --locations="$GCP_REGION" >/dev/null
    fi
    echo "  $1"
  }
  put_secret JWT_SECRET "$JWT_SECRET"; put_secret VAULT_KEY "$VAULT_KEY"; put_secret ENGINE_SERVICE_TOKEN "$ENGINE_SERVICE_TOKEN"
  for name in MONGODB_URI LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_SIP_TRUNK_ID \
              DEEPGRAM_API_KEY GROQ_API_KEY ANTHROPIC_API_KEY DNCR_ACCOUNT_ID DNCR_PASSPHRASE; do
    put_secret "$name" "${!name:-unset}"
  done
  PUBLIC_URL="https://cocally-web-${PROJECT_NUMBER}.${GCP_REGION}.run.app"
fi

# ---------------------------------------------------------------- GitHub
log "GitHub repository variables"
if have gh && gh auth status >/dev/null 2>&1; then
  for kv in "${VARS[@]}"; do gh variable set "${kv%%=*}" --repo "$GITHUB_REPO" --body "${kv#*=}" >/dev/null && echo "  set ${kv%%=*}"; done
  GH_DONE=1
else
  echo "  gh CLI not available (brew install gh && gh auth login). Set these under"
  echo "  https://github.com/${GITHUB_REPO}/settings/variables/actions :"
  for kv in "${VARS[@]}"; do echo "    ${kv%%=*} = ${kv#*=}"; done
  GH_DONE=0
fi

cat <<EOF

==============================================================================
Ready. Target: ${DEPLOY_TARGET}   Project: ${GCP_PROJECT_ID} (${PROJECT_NUMBER})
App URL after first deploy: ${PUBLIC_URL}
$( [ "$DEPLOY_TARGET" = vm ] && echo "VM: ${VM_NAME} in ${GCP_ZONE}, static IP ${IP}. DOMAIN=${APP_DOMAIN}$( [ -z "${DOMAIN:-}" ] && echo ' (sslip.io; set DOMAIN in .env and re-run to use your own hostname, then point its A record at the IP)')" )
$( [ "$GH_DONE" = 1 ] && echo "GitHub variables set. Push to prod (or run the Deploy workflow) to deploy." || echo "After setting the GitHub variables, push to prod (or run the Deploy workflow)." )
$( [ -n "${TENANT_SLUG:-}" ] && [ "$DEPLOY_TARGET" = vm ] && echo "Then provision the tenant:  ./deploy/gcp/provision-tenant.sh" )
$( [ -n "${SIP_TRUNK_ADDRESS:-}" ] && [ -z "${LIVEKIT_SIP_TRUNK_ID:-}" ] && [ "$DEPLOY_TARGET" = vm ] && echo "Then create the LiveKit trunk from the carrier credentials:  ./deploy/gcp/provision-sip-trunk.sh" )
Secrets generated by this script are in deploy/gcp/.state (gitignored). Keep that folder private.
==============================================================================
EOF
