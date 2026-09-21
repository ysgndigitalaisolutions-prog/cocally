# Deploying CoCally

Target for the pilot: **Google Cloud Run** in project `cocally-509318`, region `australia-southeast1`. A push to `prod` runs tests, builds the three images into Artifact Registry and deploys them. A single-VM Docker Compose path is kept as a manual alternative (sections A onward).

```
GitHub (prod branch)
  └─ deploy-cloudrun.yml: test → build 3 images → Artifact Registry → gcloud run deploy ×3 → readiness gate
                                        │
        Cloud Run (Sydney)              │
          cocally-api     min=max=1, CPU always on, websockets, public       ← browsers, LiveKit webhooks, worker
          cocally-worker  min=max=1, CPU always on, ingress internal          → LiveKit Cloud, api
          cocally-web     scale 0..3, public
        MongoDB Atlas (Sydney)          ← MONGODB_URI secret
        Secret Manager                  ← all secrets; the runtime SA can only read them
```

## 1. One-time project setup (10 minutes, done by a project Owner)

```bash
gcloud auth login
./deploy/gcp/setup.sh cocally-509318
```

The script enables APIs, creates the Artifact Registry repo, a runtime service account (reads secrets only), a deployer service account, keyless auth from GitHub Actions (Workload Identity Federation, no JSON keys), and the Secret Manager secrets. It generates `JWT_SECRET`, `VAULT_KEY` and `ENGINE_SERVICE_TOKEN` itself and prompts for the rest; anything left blank becomes a placeholder that makes the API refuse to boot until a real value is added:

```bash
printf '%s' 'mongodb+srv://...' | gcloud secrets versions add MONGODB_URI --data-file=-
```

It ends by printing the repository **variables** to set in GitHub (Settings → Secrets and variables → Actions → Variables). There are no GitHub secrets in this path.

**MongoDB:** Cloud Run has no disk, so the database is MongoDB Atlas. Create a cluster in GCP `australia-southeast1` (M0 free tier is enough to smoke-test, M10 for the pilot), a database user, allow access from anywhere or from the Cloud Run egress, and put the connection string in the `MONGODB_URI` secret.

## 2. Deploy

Push to `prod` or run **Deploy (Cloud Run)** manually. Service URLs are deterministic and need no domain:

- Web `https://cocally-web-<project-number>.australia-southeast1.run.app`
- API `https://cocally-api-<project-number>.australia-southeast1.run.app`

A custom domain can be mapped to the web service later; the API URL is baked into the web image, so mapping the API to a domain means one rebuild.

## 3. Provision the client's tenant

Run the provisioning command as a one-off Cloud Run job using the API image. It prints the owner's one-time invite link:

```bash
PROJECT=cocally-509318; REGION=australia-southeast1
IMAGE=$REGION-docker.pkg.dev/$PROJECT/cocally/api:latest
gcloud run jobs create cocally-provision --project $PROJECT --region $REGION --image $IMAGE \
  --service-account cocally-runtime@$PROJECT.iam.gserviceaccount.com \
  --set-env-vars NODE_ENV=production,CORS_ORIGIN=https://cocally-web-<project-number>.$REGION.run.app \
  --set-secrets MONGODB_URI=MONGODB_URI:latest,JWT_SECRET=JWT_SECRET:latest,VAULT_KEY=VAULT_KEY:latest,ENGINE_SERVICE_TOKEN=ENGINE_SERVICE_TOKEN:latest \
  --command node --args apps/api/dist/seeds/provision-tenant.js,--name,"Acme BPO",--slug,acme,--owner-name,"Jane Citizen",--owner-phone,+61412000104
gcloud run jobs execute cocally-provision --project $PROJECT --region $REGION --wait
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="cocally-provision"' --project $PROJECT --limit 20 --format 'value(textPayload)'
```

Send the link to the owner over WhatsApp or SMS. It works once and expires in 48 hours. The owner sets a password, signs in with their phone number, must enrol an authenticator app, and then invites everyone else from **Users & access**.

## A4. Day-to-day on Cloud Run

| Task | How |
|---|---|
| Logs | Cloud Console → Cloud Run → service → Logs, or `gcloud run services logs read cocally-api --region australia-southeast1` |
| Roll back | Cloud Run → service → Revisions → route 100% to the previous revision (one click) |
| Rotate a secret | `gcloud secrets versions add NAME --data-file=-` then redeploy (`workflow_dispatch`) so `latest` is picked up |
| Switch to live telephony | set repository variable `TELEPHONY_DRIVER=SIP`, add real `LIVEKIT_*` secret versions, redeploy |
| Backups | Atlas continuous backup (M10) or daily snapshot (M2+); M0 has none |

Recordings: with `RECORDING_ENABLED` on, LiveKit egress writes to the bucket in `RECORDING_BUCKET`; the local `RECORDINGS_DIR` on Cloud Run is `/tmp` and does not survive a restart, so the bucket is required before recording is enabled.

---

# A. Alternative: single VM with Docker Compose

Manual workflow **Deploy (VM)**. Kept for a client who wants everything on one box.

## A1. One-time VM setup

Any Ubuntu 24.04 VM with 4 vCPU / 16 GB in Sydney (Vultr, DigitalOcean, GCP e2-standard-4). Open inbound 80 and 443 only. SSH via key.

```bash
# as root
apt-get update && apt-get install -y ca-certificates curl
curl -fsSL https://get.docker.com | sh
useradd -m -s /bin/bash deploy && usermod -aG docker deploy
mkdir -p /opt/cocally/backups && chown -R deploy:deploy /opt/cocally
# put the CI deploy public key in /home/deploy/.ssh/authorized_keys
```

As `deploy`, in `/opt/cocally`:

```bash
cp .env.prod.example .env.prod      # from deploy/ in the repo
openssl rand -hex 32                # run three times: JWT_SECRET, VAULT_KEY, ENGINE_SERVICE_TOKEN
nano .env.prod                      # DOMAIN, IMAGE_REGISTRY, secrets, provider keys
```

Point the DNS A record for `DOMAIN` at the VM before the first deploy, or Caddy cannot obtain a certificate.

## A2. GitHub configuration

Repository **secrets**: `DEPLOY_HOST`, `DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY` (the private key whose public half is on the VM).

Repository **variable**: `APP_DOMAIN` (same value as `DOMAIN` in `.env.prod`). It is baked into the web image as the API base URL, so changing the domain means a rebuild.

Create a `production` environment under Settings → Environments and add required reviewers if you want a manual approval before each deploy.

GHCR packages are private by default. The deploy step logs the VM into GHCR with the job's token for the pull, then logs out, so no long-lived registry credential lives on the VM.

## A3. First deploy

Run the **Deploy (VM)** workflow manually. It ends with a health gate on `/api/v1/ops/ready`.

Then provision the client's tenant and first owner. No password is created; the command prints a one-time link:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api \
  node apps/api/dist/seeds/provision-tenant.js \
  --name "Acme BPO" --slug acme --owner-name "Jane Citizen" --owner-phone "+61412000104"
```

Send the link to the owner over WhatsApp or SMS. It works once and expires in 48 hours. The owner sets a password, signs in with their phone number, and is required to enrol an authenticator app (TOTP) before anything else loads. They then invite everyone else from **Users & access**, which hands them a one-time link per person the same way.

Do not run `seed.js` in production. It creates the demo tenant with a shared password.

## A4. Day-to-day

| Task | Command (in /opt/cocally) |
|---|---|
| Logs | `docker compose -f docker-compose.prod.yml logs -f api` |
| Restart one service | `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d api` |
| Roll back | set `IMAGE_TAG=<previous sha>` in the environment and run pull + up, or re-run the earlier Deploy workflow |
| Backup | `./backup-mongo.sh` (add to cron nightly; set `BACKUP_BUCKET` and install rclone to copy off-box) |
| Restore | `docker compose ... exec -T mongo mongorestore --archive --gzip --drop < backups/<file>` |
| Rotate a secret | edit `.env.prod`, then `up -d api worker` |

## B. Access model

- Login is phone number + password. Owner, Admin, Supervisor and QA must have TOTP enrolled; the API returns `403 TWO_FACTOR_REQUIRED` on every route except enrolment until they do.
- Passwords are never issued by an admin. Invites and resets are single-use links whose token is stored hashed and expires in 48 hours.
- Deactivating a user, changing a password, resetting an authenticator or changing roles bumps the user's token version, which signs out every existing session immediately.
- Every sign-in, failed attempt, invite, reset and authenticator event is in the append-only audit log, visible to the Owner and Admin under Users & access.
- Login is limited to 10 attempts per minute per IP.

## C. What the API refuses in production

With `NODE_ENV=production` the API exits at boot if any of these hold: `JWT_SECRET` or `VAULT_KEY` are the dev defaults, `JWT_SECRET` or `ENGINE_SERVICE_TOKEN` are under 32 characters, `MONGODB_URI` or `CORS_ORIGIN` mention localhost, or `DEMO_LEAD_TOKEN_ENABLED` is set. Booleans are strict: only `true`, `1`, `yes`, `on` enable a flag. `RECORDING_ENABLED=false` now means off.

## D. Known single-instance limits

Run exactly one `api` container. Dialer ticks, pending transfer offers and wrap-up timers are in-process. A restart keeps live calls (they live in LiveKit) but drops in-flight transfer offers. Deploys therefore restart the API in a few seconds; schedule them outside calling hours.

## E. Notes on the Cloud Run shape

`api` and `worker` run with `min-instances=1 max-instances=1` and CPU always allocated so the in-process schedulers keep ticking; `api` has a 60-minute request timeout and session affinity for Socket.IO. The worker listens on Cloud Run's `PORT` for health checks only and has internal-only ingress. The same images run on the VM path unchanged.
