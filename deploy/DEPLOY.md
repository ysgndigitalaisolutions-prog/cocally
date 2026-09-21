# Deploying CoCally

One VM, Docker Compose, Caddy for TLS, images built by GitHub Actions and pushed to GitHub Container Registry. Pushing to the `prod` branch deploys.

```
GitHub (prod branch)
  └─ deploy.yml: test → build 3 images → push to ghcr.io → ssh to VM → compose pull/up → health gate
                                                                 │
                                          VM (Sydney)  /opt/cocally
                                            caddy :80/:443 ── /api/*, /socket.io/* → api:4000
                                                            └─ everything else     → web:3000
                                            worker  (outbound to LiveKit Cloud, no inbound port)
                                            mongo   (volume mongo_data, nightly dump to ./backups)
```

## 1. One-time VM setup

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

## 2. GitHub configuration

Repository **secrets**: `DEPLOY_HOST`, `DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY` (the private key whose public half is on the VM).

Repository **variable**: `APP_DOMAIN` (same value as `DOMAIN` in `.env.prod`). It is baked into the web image as the API base URL, so changing the domain means a rebuild.

Create a `production` environment under Settings → Environments and add required reviewers if you want a manual approval before each deploy.

GHCR packages are private by default. The deploy step logs the VM into GHCR with the job's token for the pull, then logs out, so no long-lived registry credential lives on the VM.

## 3. First deploy

Push to `prod` (or run the Deploy workflow manually). The workflow ends with a health gate on `/api/v1/ops/ready`.

Then seed the tenant and users once:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api node apps/api/dist/seeds/seed.js
```

The seed refuses the `admin/1234` demo logins when `NODE_ENV=production`. Change the pilot password immediately after first login.

## 4. Day-to-day

| Task | Command (in /opt/cocally) |
|---|---|
| Logs | `docker compose -f docker-compose.prod.yml logs -f api` |
| Restart one service | `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d api` |
| Roll back | set `IMAGE_TAG=<previous sha>` in the environment and run pull + up, or re-run the earlier Deploy workflow |
| Backup | `./backup-mongo.sh` (add to cron nightly; set `BACKUP_BUCKET` and install rclone to copy off-box) |
| Restore | `docker compose ... exec -T mongo mongorestore --archive --gzip --drop < backups/<file>` |
| Rotate a secret | edit `.env.prod`, then `up -d api worker` |

## 5. What the API refuses in production

With `NODE_ENV=production` the API exits at boot if any of these hold: `JWT_SECRET` or `VAULT_KEY` are the dev defaults, `JWT_SECRET` or `ENGINE_SERVICE_TOKEN` are under 32 characters, `MONGODB_URI` or `CORS_ORIGIN` mention localhost, or `DEMO_LEAD_TOKEN_ENABLED` is set. Booleans are strict: only `true`, `1`, `yes`, `on` enable a flag. `RECORDING_ENABLED=false` now means off.

## 6. Known single-instance limits

Run exactly one `api` container. Dialer ticks, pending transfer offers and wrap-up timers are in-process. A restart keeps live calls (they live in LiveKit) but drops in-flight transfer offers. Deploys therefore restart the API in a few seconds; schedule them outside calling hours.

## 7. Moving to Cloud Run later

The same images run on Cloud Run with `min-instances=1 max-instances=1` and CPU always allocated for `api` and `worker`. Swap the deploy job's ssh step for `gcloud run deploy` and point `MONGODB_URI` at Atlas. Nothing in the images changes.
