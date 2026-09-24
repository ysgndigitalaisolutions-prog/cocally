# Deploying CoCally

Project: `cocally-509318`, region `australia-southeast1`. One `.env` file drives everything; one script readies the project; a push to `prod` deploys.

## Which target

| | VM (default) | Cloud Run |
|---|---|---|
| Shape | One Compute Engine VM, Docker Compose: caddy, api, web, worker, mongo | Three Cloud Run services + MongoDB Atlas |
| Monthly, Sydney | e2-standard-2 ~USD 55, e2-standard-4 ~USD 110, Mongo on the box | api + worker always on ~USD 240, plus Atlas M10 ~USD 60 |
| Ops | OS patches are yours; nightly Mongo dump is scripted | No servers; one-click revision rollback |
| Chosen for the pilot | **yes** | later, if a client wants it |

Cloud Run is expensive here because the API and worker cannot scale to zero (in-process dialer and transfer state) and the worker needs 2 vCPU always allocated. Both targets use the same images and the same `.env`.

## 1. Fill in the .env

```bash
cp deploy/gcp/.env.example deploy/gcp/.env
```

Set `DEPLOY_TARGET`, the project, VM size, optional `DOMAIN` (blank uses `<ip>.sslip.io`, which works at once with a real certificate), and the provider keys you have. Leave what you do not have blank; the API tells you at boot what is missing. `deploy/gcp/.env` and `deploy/gcp/.state/` are gitignored.

## 2. Run the setup script

```bash
gcloud auth login            # as a project Owner
brew install gh && gh auth login   # optional: lets the script set the GitHub variables itself
./deploy/gcp/setup.sh
```

What it does, all create-if-missing:
- enables APIs; creates a runtime service account and a deployer service account
- keyless GitHub Actions auth (Workload Identity Federation bound to this repo). No JSON keys, no SSH keys, no GitHub secrets
- generates `JWT_SECRET`, `VAULT_KEY`, `ENGINE_SERVICE_TOKEN` once into `deploy/gcp/.state/`
- **VM target:** static IP, firewall (80/443 public; SSH only via Identity-Aware Proxy), Ubuntu 24.04 VM with Docker installed by startup script, writes `/opt/cocally/.env.prod` from your `.env`, copies the Compose stack, installs the nightly backup cron
- **Cloud Run target:** Artifact Registry repo, Secret Manager secrets from your `.env`
- sets the repository variables in GitHub (or prints them)

Re-run it whenever `.env` changes; it updates `.env.prod` on the VM or the secret versions.

## 3. Deploy

The Deploy workflows are gated on the repository variable `DEPLOY_TARGET`, which `setup.sh` sets. Until it has run, every push to `prod` shows both Deploy workflows as **skipped**; only CI runs. `gcloud` must be logged in as an Owner of the project (`gcloud auth login`, then `gcloud config set project cocally-509318`); an account that is not a member gets "does not have permission to access projects instance".

Push to `prod`, or run the matching workflow manually: **Deploy (VM)** or **Deploy (Cloud Run)**. Each ends with a health gate on `/api/v1/ops/ready`. The VM path logs the VM into GHCR with the job's short-lived token to pull, then logs out.

## 4. Provision the first tenant

Fill `TENANT_*` and `OWNER_*` in `.env`, then:

```bash
./deploy/gcp/provision-tenant.sh
```

It prints the owner's one-time invite link (48 h). Send it over WhatsApp or SMS. The owner sets a password, signs in with their phone number, enrols an authenticator app, and invites everyone else from **Users & access**.

On Cloud Run, run the same command as a Cloud Run job with the api image (`--command node --args apps/api/dist/seeds/provision-tenant.js,...`).

## 5. Day-to-day (VM)

```bash
SSH='gcloud compute ssh cocally-app --zone australia-southeast1-b --tunnel-through-iap'
$SSH -- 'cd /opt/cocally && sudo docker compose -f docker-compose.prod.yml logs -f api'
$SSH -- 'cd /opt/cocally && sudo docker compose --env-file .env.prod -f docker-compose.prod.yml up -d api'   # restart one service
$SSH -- 'cd /opt/cocally && ./backup-mongo.sh'                                                               # ad-hoc backup
```

Roll back by re-running an earlier Deploy workflow run, or by setting `IMAGE_TAG=<sha>` on the VM and running pull + up. Change a secret by editing `.env` locally and re-running `setup.sh`, then `up -d api worker`.

### Switching to live telephony

The carrier authenticates the trunk with a username and password (SIP digest), which is what makes LiveKit's Australian SIP region usable: its gateway IPs are not published, so an IP allow-list cannot be used.

1. Fill `LIVEKIT_*`, `SIP_TRUNK_ADDRESS`, `SIP_TRUNK_USERNAME`, `SIP_TRUNK_PASSWORD`, `SIP_TRUNK_NUMBERS` (the CLIs you hold, E.164) and `SIP_TRUNK_TRANSPORT` in `.env`; re-run `setup.sh` so they reach the VM.
2. `./deploy/gcp/provision-sip-trunk.sh` (add `--inbound` if the carrier routes your DIDs to `sip:<project>.aus.sip.livekit.cloud`). It prints the outbound trunk id. Re-running updates the trunk in place.
3. Put the id in `LIVEKIT_SIP_TRUNK_ID`, set `TELEPHONY_DRIVER=SIP`, re-run `setup.sh`, then redeploy or `up -d api worker` on the VM.

While `TELEPHONY_DRIVER=SIMULATION` the worker container idles (it logs a warning once) instead of restarting, because nothing dispatches rooms to it. Voice tuning (`LLM_MODEL`, `TTS_PROVIDER`, `TTS_VOICE`, `NOISE_CANCELLATION`, `WORKER_IDLE_PROCESSES`) also lives in `.env`; see `agent-worker/README.md`.

Recording must stay off until `RECORDING_BUCKET` is set; the VM keeps a local copy under the `recordings` volume but a bucket is what gives retention and legal hold.

## 6. Access model

- Login is phone number + password. Owner, Admin, Supervisor and QA must have TOTP enrolled; the API returns `403 TWO_FACTOR_REQUIRED` on every route except enrolment until they do.
- Passwords are never issued by an admin. Invites and resets are single-use links whose token is stored hashed and expires in 48 hours.
- Deactivating a user, changing a password, resetting an authenticator or changing roles bumps the user's token version, which signs out every existing session immediately.
- Every sign-in, failed attempt, invite, reset and authenticator event is in the append-only audit log, visible to the Owner and Admin under Users & access.
- Login is limited to 10 attempts per minute per IP.

## 7. What the API refuses in production

With `NODE_ENV=production` the API exits at boot if any of these hold: `JWT_SECRET` or `VAULT_KEY` are the dev defaults, `JWT_SECRET` or `ENGINE_SERVICE_TOKEN` are under 32 characters, `MONGODB_URI` or `CORS_ORIGIN` mention localhost, or `DEMO_LEAD_TOKEN_ENABLED` is set. Booleans are strict: only `true`, `1`, `yes`, `on` enable a flag.

## 8. Known single-instance limits

Run exactly one `api` container or instance. Dialer ticks, pending transfer offers and wrap-up timers are in-process. A restart keeps live calls (they live in LiveKit) but drops in-flight transfer offers. Deploys restart the API in a few seconds; schedule them outside calling hours.
