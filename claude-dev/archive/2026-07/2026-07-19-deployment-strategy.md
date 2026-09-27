# CoCally — GCP Deployment Strategy (Phase-1 Pilot)

> Written 19 July 2026. Decisions: GCP hosting, Firebase phone-OTP auth for agents **and** admins, recordings in Cloud Storage, MongoDB, compute on a VM, LiveKit Cloud for media. This doc is the strategy; companions: [`2026-07-19-architecture.md`](./2026-07-19-architecture.md) (full system architecture) and [`2026-07-19-cogs-model.md`](./2026-07-19-cogs-model.md) (COGS, per-minute rates, 5k–20k min/mo pricing tiers — telco billed separately).

## 0. Summary of the architecture

```
                        Cloud DNS  (app.cocally.example)
                             │
                     HTTPS (Caddy, auto-TLS)
                             │
        ┌────────────────────┴────────────────────┐
        │   Compute Engine VM (australia-southeast1)  │
        │   Docker Compose:                        │
        │     • web  (Next.js, :3000)              │
        │     • api  (NestJS + Socket.IO, :4000)   │
        │     • caddy (reverse proxy, 80/443)      │
        └──────┬───────────────┬──────────────┬────┘
               │               │              │
        MongoDB Atlas    Cloud Storage   Firebase Auth
        (M10, Sydney,    (recordings,    (phone OTP/SMS,
        private/VPC)     region-pinned)  verified via
                                         firebase-admin)
```

Everything sits in **`australia-southeast1` (Sydney)** — the pilot is Australia-focused, compliance requires region-pinned recording storage, and co-locating VM + Atlas + GCS keeps latency and egress cost down.

## 1. Why a VM (and not Cloud Run) for Phase 1

The workload shape actually argues *for* the VM the user suggested:

- **The dialer is a continuously ticking scheduler** (`@nestjs/schedule`) — it must run 24/7 in exactly one process. Serverless scale-to-zero or scale-out both break it (zero = no dialing; N>1 = double-dialing unless the atomic lead lock carries all coordination).
- **Socket.IO floor feed / transfer offers** want long-lived websockets and sticky sessions. Fine on one VM, extra machinery (Redis adapter + session affinity) anywhere else.
- Single-tenant pilot scale doesn't need horizontal scaling yet.

**Decided: the VM runs 24/7 (no nightly shutdown).** Stopping it 12 h/night saves only ~$25–30/mo but takes the dashboard/API down with it — an admin checking insights overnight would hit a dead page. The dialer already idles outside legal AU calling windows via the compliance layer, so overnight the box is nearly free anyway. Revisit only as part of the Phase-2 Cloud Run split (web/API on Cloud Run scale-to-zero, dialer as a schedulable worker).

**Choice:** one `e2-standard-2` (2 vCPU / 8 GB) VM, Container-Optimized OS or Debian + Docker, running the compose stack. Staging can be an `e2-small` in the same or a separate project.

Scale-out later (Phase 2+) is a known path, not a rewrite: move web to Cloud Run, add Socket.IO Redis adapter (Memorystore), split the dialer into a singleton worker, put a Google HTTPS LB in front. Nothing in Phase 1 blocks that.

## 2. Environments & projects

| | Project | Purpose |
|---|---|---|
| `cocally-staging` | staging | free-tier-ish sizing, Atlas M0/M2, same topology |
| `cocally-prod` | prod | the stack above |

Two separate GCP projects (not one project with two VMs): clean IAM separation, separate Firebase Auth user pools (you don't want test OTP users in the prod pool), separate billing visibility.

## 3. Database — MongoDB Atlas (not self-hosted)

- **Atlas M10** on GCP `australia-southeast1`, with **VPC peering or Private Service Connect** to the VM's VPC — no public DB endpoint.
- Why not Mongo on the VM: recordings metadata, call transcripts, and the audit log are the business; Atlas gives point-in-time backups, monitoring, and painless vertical scaling for ~USD 60/mo. Self-hosted Mongo on the same VM is acceptable for **staging only**.
- Keep `mongodb-memory-server` for tests; local dev keeps docker-compose Mongo. Only the `MONGO_URI` env var changes per environment.

## 4. Auth — Firebase **phone OTP (SMS)** for agents *and* admins

- Firebase Auth (in each GCP project) with the **Phone** provider enabled.
- **Flow:** client (Next.js) calls `signInWithPhoneNumber` → user enters the SMS code → Firebase ID token → `POST /auth/otp-login` → API verifies with `firebase-admin` → looks up the user **by phone number in our own users collection** → issues the existing app JWT with the user's RBAC role.
- Key principle: **Firebase authenticates, CoCally authorizes.** Possessing a phone that passes OTP means nothing unless that number exists on a provisioned user (Owner/Admin/Supervisor/Agent/QA). No self-signup path; admins provision users (with E.164 numbers) first.
- Admin login is the same flow — role comes from our user record, not from anything Firebase-side. Optionally keep the existing TOTP as a *second* factor for Owner/Admin later; not required for pilot.
- **Session length is a cost decision:** each SMS is ~$0.06 (AU) / ~$0.01 (India). Use long-lived refresh tokens so a fresh SMS fires weekly / on new device rather than every shift — ~₹780/mo instead of ~₹3,900/mo at 30 agents (COGS §4).
- Firebase Admin SDK credentials via the VM's attached service account (no JSON key files).
- **App Check / reCAPTCHA on the web client and an SMS region policy allowing only AU + your team's countries** — the phone-OTP endpoint is an SMS-pumping target and the messages bill to us.

## 5. Recordings — Cloud Storage

- Bucket per environment: `cocally-prod-recordings-au`, **regional, `australia-southeast1`**, uniform bucket-level access, public access prevention enforced.
- Object layout matches the existing region-pinned path scheme: `{tenantId}/{region}/{callId}/{leg}.wav` (or whatever the recording module already emits — keep its path contract).
- **API writes** via the VM's service account (`roles/storage.objectAdmin` on this bucket only).
- **Playback** via short-lived **V4 signed URLs** minted by the API after RBAC + audit check — the browser never gets bucket credentials, and raw (unredacted-audio) access stays auditable exactly as the product doc requires.
- **Retention:** GCS lifecycle rule deletes objects past the retention window; **legal hold** maps 1:1 to GCS per-object holds (`temporaryHold`), which override lifecycle deletion — the semantics we need exist natively.
- Versioning off (recordings are immutable), CMEK optional later if a client demands it.

## 5b. Voice media plane — LiveKit Cloud (not self-hosted)

- **Decided: LiveKit Cloud (standard tier)** for the SFU, SIP bridge (paired with an AU trunk provider like Twilio/Telnyx), TURN, and egress. Self-hosting the LiveKit stack means running SFU + SIP + TURN + egress + Redis with open UDP ranges and real media capacity planning — and an under-provisioned media server fails as choppy audio on live sales calls, the worst possible pilot failure mode.
- **Egress recording writes directly to our GCS recordings bucket** — slots into the region-pinned recording design unchanged.
- Because workers connect *outbound* to LiveKit Cloud over WebSocket/WebRTC, our VMs need no inbound UDP: the firewall stays 80/443-only, permanently.
- **Agent workers still run on our GCP compute** (the per-call streaming STT → LLM → TTS loop). Concurrency planning:
  - Pilot: ~10 human agents × 2–4 paced dials → **20–40 concurrent channels**, ~15–30 live AI conversations at peak.
  - With cloud STT/TTS/LLM providers, workers are I/O-bound: plan **~10–20 concurrent sessions per 4 vCPU**.
  - **Dedicated `e2-standard-4` worker VM** (~$110/mo Sydney), separate from the app VM so call spikes can't starve the API/dashboard. Scale vertically first, then a managed instance group.
- **Enterprise tier trigger, not now:** only needed if a client contract requires live call *media* (not just recordings) to stay in AU — that's a data-residency/BYOC conversation. Standard Cloud per-participant-minute pricing is a rounding error next to telco + STT/TTS/LLM costs.

## 6. Secrets & config

- **GCP Secret Manager** holds: Atlas URI, JWT signing secret, tenant-vault master key (AES-256-GCM key), provider API keys' encryption key, webhook signing secrets.
- The VM's service account gets `secretAccessor` on exactly those secrets; a small boot script materializes them into the compose env at deploy time. No secrets in the repo, image, or instance metadata.
- Non-secret config stays in per-env `.env` files in the deploy directory.

## 7. Networking & TLS

- Static external IP + Cloud DNS `A` records: `app.` (web) and `api.` (API + websockets) — or single host with path routing; Caddy handles either.
- **Caddy** as the reverse proxy: automatic Let's Encrypt certs, HTTP→HTTPS redirect, websocket pass-through to the API for Socket.IO.
- Firewall: ingress only `80/443` to the app VM (and `22` restricted to IAP — use **IAP tunneling for SSH**, no open SSH to the world). All telephony/media is outbound to LiveKit Cloud, so no inbound UDP is ever needed.
- **Worker VM has no external IP** — no ingress at all; egress to LiveKit Cloud and AI providers via **Cloud NAT**.

## 8. CI/CD

- **GitHub Actions**, two workflows:
  1. **CI** (every PR): pnpm install → typecheck → lint → `vitest` → `next build`.
  2. **Deploy** (push to `main` → staging; tag `v*` → prod, with manual approval environment gate): build `api` and `web` Docker images → push to **Artifact Registry** (`australia-southeast1`) → SSH to VM via IAP → `docker compose pull && docker compose up -d` → hit `/health` and fail loudly if it doesn't come up.
- Auth from GitHub to GCP via **Workload Identity Federation** (no long-lived JSON keys in GitHub secrets).
- Rollback = re-deploy the previous image tag (images are immutable and tagged by git SHA).
- Brief downtime (seconds) during `compose up` is acceptable for pilot; zero-downtime comes with the Phase-2 LB split.

## 9. Observability & ops

- **Ops Agent** on the VM → Cloud Logging + Monitoring (containers log JSON to stdout).
- **Uptime check** on `/health` (which already exists) + alerting policy → email/Slack.
- Alerts worth having day 1: uptime failure, VM CPU/memory sustained >80%, Atlas alerts (connections, disk), GCS 4xx/5xx spikes, and a log-based alert on the kill-switch being flipped.
- Daily Atlas backup (built-in) + weekly VM boot-disk snapshot schedule (the VM is cattle-ish; recordings and data live off-box).

## 10. Cost (prod, monthly, rough USD)

| Item | Est. |
|---|---|
| e2-standard-2 app VM + 50 GB disk (24/7) | ~$55 |
| e2-standard-4 agent-worker VM | ~$110 |
| LiveKit Cloud (participant-minutes) + SIP trunk | usage-based; minor vs. STT/TTS/LLM |
| Static IP, egress, snapshots | ~$10–20 |
| MongoDB Atlas M10 | ~$60 |
| GCS recordings (first ~100 GB + ops) | ~$5 |
| Firebase phone OTP SMS (AU, per verification) | ~$0.06 × verifications |
| Secret Manager, Artifact Registry, Logging | ~$5–10 |
| Firebase phone OTP SMS (weekly re-auth policy) | ~$8–15 |
| **Total** | **~$260–295/mo** + per-minute AI/media costs (telco billed separately) |

Full per-minute COGS and 5k/10k/15k/20k min-per-month pricing tiers (Basic vs Premium stacks): see [`2026-07-19-cogs-model.md`](./2026-07-19-cogs-model.md).

Staging on smaller sizing: ~$30–40/mo.

## 11. Rollout order

1. Create the two GCP projects, enable APIs (Compute, Storage, Secret Manager, Firebase, Artifact Registry), set up billing alerts.
2. Atlas cluster + VPC peering; move staging to it.
3. Firebase Auth phone provider + `firebase-admin` integration in the API (`/auth/otp-login`), user-provisioning with phone numbers, web login UI swap.
4. GCS recording storage adapter (write, signed-URL read, lifecycle, holds) behind the existing recording module interface.
5. VM + Caddy + compose stack, Secret Manager wiring; deploy staging end-to-end.
6. CI/CD workflows; then prod project bring-up, DNS cutover, uptime checks/alerts.

## Open decision points (defaults chosen, flag if wrong)

- **Region** assumed `australia-southeast1` (Sydney) given the AU pilot.
- **Atlas vs self-hosted Mongo in prod** — strategy assumes Atlas M10 (~$60/mo). Self-hosting on the VM saves that at the cost of owning backups/restores of compliance-relevant data.
- **OTP channel: SMS phone OTP** for both agents and admins (confirmed). Budget scales with headcount × login frequency — see the re-auth policy table in COGS §4.
- **Single domain vs `app.`/`api.` split** — assumed split; either works with Caddy.
