#!/usr/bin/env bash
# One-time bootstrap of a GCP project for the Cloud Run deployment.
# Run by a project Owner with gcloud installed and logged in:
#   ./deploy/gcp/setup.sh cocally-509318
#
# Creates: APIs, Artifact Registry repo, runtime + deployer service accounts,
# Workload Identity Federation for GitHub Actions (no JSON keys), and the
# Secret Manager secrets the services read. Prints the values to put into
# GitHub. Safe to re-run: every step is create-if-missing.
set -euo pipefail

PROJECT_ID="${1:?usage: setup.sh <project-id> [region] [github-owner/repo]}"
REGION="${2:-australia-southeast1}"
GITHUB_REPO="${3:-ysgndigitalaisolutions-prog/cocally}"
AR_REPO="cocally"
RUNTIME_SA="cocally-runtime"
DEPLOYER_SA="cocally-deployer"
POOL="github"
PROVIDER="github"

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_EMAIL="${DEPLOYER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

log() { printf '\n==> %s\n' "$*"; }

log "Enabling APIs"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com cloudresourcemanager.googleapis.com sts.googleapis.com

log "Artifact Registry repo ${AR_REPO} in ${REGION}"
gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION" \
    --description="CoCally images"

log "Service accounts"
gcloud iam service-accounts describe "$RUNTIME_EMAIL" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$RUNTIME_SA" --display-name="CoCally Cloud Run runtime"
gcloud iam service-accounts describe "$DEPLOYER_EMAIL" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$DEPLOYER_SA" --display-name="CoCally GitHub deployer"

# Runtime: read secrets only.
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${RUNTIME_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" --condition=None >/dev/null
# Deployer: push images, deploy services, act as the runtime SA.
for role in roles/run.admin roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${DEPLOYER_EMAIL}" \
    --role="$role" --condition=None >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_EMAIL" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" --role="roles/iam.serviceAccountUser" >/dev/null

log "Workload Identity Federation for ${GITHUB_REPO}"
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global \
  --workload-identity-pool="$POOL" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global \
    --workload-identity-pool="$POOL" --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${GITHUB_REPO}'"
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_EMAIL" --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" >/dev/null

log "Secrets"
ensure_secret() { # name value
  if gcloud secrets describe "$1" >/dev/null 2>&1; then
    echo "  $1: exists (unchanged)"
  else
    printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=user-managed \
      --locations="$REGION" >/dev/null
    echo "  $1: created"
  fi
}
# Generated once; never printed.
ensure_secret JWT_SECRET "$(openssl rand -hex 32)"
ensure_secret VAULT_KEY "$(openssl rand -hex 32)"
ensure_secret ENGINE_SERVICE_TOKEN "$(openssl rand -hex 32)"
# Supplied values. Blank creates a placeholder that makes the API refuse to boot
# until you set a real version:  printf '%s' 'value' | gcloud secrets versions add NAME --data-file=-
for name in MONGODB_URI LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_SIP_TRUNK_ID \
            DEEPGRAM_API_KEY GROQ_API_KEY ANTHROPIC_API_KEY DNCR_ACCOUNT_ID DNCR_PASSPHRASE; do
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    echo "  $name: exists (unchanged)"
  else
    read -r -s -p "  $name (blank = placeholder): " value; echo
    ensure_secret "$name" "${value:-unset}"
  fi
done

cat <<EOF

Done. Add these to the GitHub repository ${GITHUB_REPO}:

  Settings -> Secrets and variables -> Actions -> Variables
    GCP_PROJECT_ID      = ${PROJECT_ID}
    GCP_PROJECT_NUMBER  = ${PROJECT_NUMBER}
    GCP_REGION          = ${REGION}
    GCP_WIF_PROVIDER    = ${WIF_PROVIDER}
    GCP_DEPLOYER_SA     = ${DEPLOYER_EMAIL}
    GCP_RUNTIME_SA      = ${RUNTIME_EMAIL}
    TELEPHONY_DRIVER    = SIMULATION        (change to SIP when the trunk is live)

Service URLs (deterministic, no domain needed for the pilot):
    API  https://cocally-api-${PROJECT_NUMBER}.${REGION}.run.app
    Web  https://cocally-web-${PROJECT_NUMBER}.${REGION}.run.app

Then push to the prod branch, or run the "Deploy (Cloud Run)" workflow.
EOF
