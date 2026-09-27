# CoCally — Full System Architecture

> Written 19 July 2026. The complete production architecture: every component, flow, and boundary. Companions: [`2026-07-19-deployment-strategy.md`](./2026-07-19-deployment-strategy.md) (infra decisions & rollout) and [`2026-07-19-cogs-model.md`](./2026-07-19-cogs-model.md) (costs). Module references are to the actual code in this repo.

## 1. Bird's-eye view

```
                                   Cloud DNS
                          app.cocally.x      api.cocally.x
                                └──────┬──────┘
                                 HTTPS / WSS
                                       │
   ┌───────────────────────────────────▼──────────────────────────────────┐
   │  APP VM  (e2-standard-2, australia-southeast1, 24/7)                 │
   │  ┌─────────┐   ┌──────────────────────────────┐   ┌──────────────┐   │
   │  │  Caddy  │──▶│  web: Next.js 16 (:3000)     │   │ api: NestJS  │   │
   │  │ 80/443  │   └──────────────────────────────┘   │ + Socket.IO  │   │
   │  │ autoTLS │──────────────────────────────────────▶ (:4000)      │   │
   │  └─────────┘                                      │ + dialer     │   │
   │                                                   └──┬───┬───┬───┘   │
   └──────────────────────────────────────────────────────┼───┼───┼───────┘
                     VPC (private)                        │   │   │
   ┌──────────────────────────────┐                       │   │   │
   │  WORKER VM (e2-standard-4)   │    room dispatch      │   │   │
   │  LiveKit agent workers ──────┼───────────────────────┘   │   │
   │  (STT→LLM→TTS loop/call)     │                           │   │
   └──────────────┬───────────────┘                           │   │
                  │ outbound WSS/WebRTC          VPC peering  │   │ HTTPS
                  ▼                                           ▼   ▼
        ┌──────────────────┐    SIP trunk     ┌─────────────────┐ ┌─────────────────┐
        │  LiveKit Cloud   │◀────────────────▶│  MongoDB Atlas  │ │ GCS recordings  │
        │  SFU + SIP + TURN│  (Twilio/Telnyx) │  M10 (Sydney)   │ │ bucket (Sydney) │
        │  + egress ───────┼─────────────────────────────────────▶ region-pinned    │
        └──────────────────┘                  └─────────────────┘ └─────────────────┘

        Firebase Auth (phone OTP/SMS)  Secret Manager      Artifact Registry
        agents + admins login          runtime secrets     Docker images (CI/CD)
```

Everything lives in `australia-southeast1` (Sydney). Two Google Cloud projects: `cocally-staging`, `cocally-prod` — separate IAM, separate Firebase user pools, separate billing views.

## 2. Monorepo layout

```
cocally/
├── apps/
│   ├── api/          NestJS 10 — REST API, Socket.IO gateway, dialer, engine
│   │   └── src/
│   │       ├── main.ts, app.module.ts
│   │       ├── common/          guards, decorators, tenant scoping
│   │       ├── schemas/         17 Mongoose schemas (see §6)
│   │       ├── seeds/           seed script
│   │       └── modules/         16 feature modules (see §5)
│   └── web/          Next.js 16 + React 19 + Tailwind 4 + Zustand + socket.io-client
├── packages/shared/  @cocally/shared — types/DTOs shared API↔web
├── docker-compose.yml   local dev (Mongo 7)
└── claude-dev/          session logs & design docs (this folder)
```

Package manager: pnpm workspaces. TS project references via `tsconfig.base.json`.

## 3. Runtime processes

| Process | Where | What it runs | Scaling unit |
|---|---|---|---|
| **web** | App VM (Docker) | Next.js SSR + static; talks to API over HTTPS + WSS | Phase 2: Cloud Run |
| **api** | App VM (Docker) | REST controllers, Socket.IO gateway, `@nestjs/schedule` **dialer tick**, transfer orchestration, webhooks, compliance | Exactly **1 instance** (dialer singleton + atomic lead locks) |
| **voice workers** | Worker VM | LiveKit Agents processes: one job per live call runs the STT→safety-rails→`composeSystemPrompt`→LLM→TTS loop by calling into the same engine contract as `CallRuntime` | Vertical first; then MIG. ~10–20 concurrent calls per 4 vCPU |
| **caddy** | App VM (Docker) | TLS termination (Let's Encrypt), reverse proxy, websocket pass-through | — |
| **mongo** | Atlas (managed) | All persistent state | M10 → vertical |

The **`CallRuntime` abstraction** ([apps/api/src/modules/engine/runtime.ts](../apps/api/src/modules/engine/runtime.ts)) is the seam: the flow executor, scoring, and transfer logic are identical whether the driver is `simulation.runtime.ts` (dev, test-drive, simulator — zero vendor keys) or the LiveKit runtime (production). The LiveKit runtime is the one new production component to build; nothing above it changes.

## 4. GCP infrastructure topology

| Resource | Config | Purpose |
|---|---|---|
| VPC `cocally-vpc` | Custom, Sydney subnet | Both VMs; peered to Atlas |
| App VM | `e2-standard-2`, static external IP, Container-Optimized OS or Debian+Docker | web+api+caddy compose stack |
| Worker VM | `e2-standard-4`, **no external IP** (egress via Cloud NAT) | LiveKit agent workers; all connections outbound |
| Cloud NAT | on the VPC | Worker VM egress to LiveKit Cloud / AI providers |
| MongoDB Atlas | M10, Sydney, **VPC peering** — no public endpoint | Primary datastore, PITR backups |
| GCS `cocally-prod-recordings-au` | Regional Sydney, uniform access, public-access prevention, lifecycle rules, per-object holds | Recordings (see §12) |
| Firebase Auth | **Phone provider (SMS OTP)**, SMS region policy = AU + team countries, App Check on web | OTP identity for agents + admins (see §7) |
| Secret Manager | JWT secret, Atlas URI, vault master key, LiveKit API key/secret, provider-key KEK, webhook secrets | Materialized into compose env at deploy |
| Artifact Registry | Sydney, Docker repo | `api` and `web` images tagged by git SHA |
| Cloud DNS | `app.`, `api.` A records → App VM static IP | |
| IAP | TCP tunneling for SSH | No port 22 open to internet |
| Firewall | Ingress: 443/80 to App VM only. Worker VM: no ingress. No inbound UDP anywhere | LiveKit media is outbound-only |
| Ops Agent + Cloud Monitoring | Both VMs | Logs, metrics, uptime checks, alerting |

## 5. API module map (NestJS)

From [apps/api/src/modules/](../apps/api/src/modules/):

| Module | Responsibilities | Key files |
|---|---|---|
| `auth` | Login, JWT issue/verify, TOTP 2FA today → **Firebase phone-OTP verification** (`/auth/otp-login`, `firebase-admin` ID-token check → user lookup by phone → app JWT) | |
| `users` | User CRUD, roles (Owner/Admin/Supervisor/Agent/QA), E.164 phone provisioning | |
| `tenants` | Multi-tenancy, per-tenant quotas, kill switch | |
| `campaigns` | Retry matrix, scoring config, rebuttal library, CLI pool rules, pacing, A/B splits, voicemail/IVR policy, transfer-card template | |
| `flows` | Flow graph CRUD, structural validation, compliance-gated publish, immutable versions | |
| `engine` | Conversation engine: `flow-executor.service.ts` (node walking, envelope handling, scoring, incremental summary), `prompt.ts` (`composeSystemPrompt` — pure, shared with preview UI), `runtime.ts` (CallRuntime contract), `simulation.runtime.ts` | |
| `telephony` | `dialer.service.ts` (paced tick: kill-switch → budget → caps → agent-aware pacing → atomic lead lock → legal window → suppression stack → CLI select → fire), `call-orchestrator.service.ts` (call lifecycle, AMD policy), `cli.service.ts` (CLI pools, geo-match, rotation, resting) | |
| `workspace` | `realtime.gateway.ts` (Socket.IO), `presence.service.ts` (server-side presence segments), `transfers.service.ts` (eligibility, atomic reserve, offer cascade, bridge, disposition close-loop) | |
| `leads` | CSV import + mapping + rejects report, dedupe, E.164 normalization, line-type + timezone inference, lifecycle timeline | |
| `providers` | PAL: adapter registries (TTS/STT/LLM), resolution hierarchy with failover, per-capability credential schemas, AES-256-GCM tenant vault | |
| `recordings` | Dual-leg recording records, stitched timeline offsets, PII redaction, retention/legal hold, (prod) GCS signed-URL issuance | |
| `country-packs` | AU pack: DNC wash rules/expiry, legal hours, holidays, disclosures, tz hints | |
| `analytics` | KPI band, funnel, objection intelligence, AMD mix, heatmap, call deep-dive, agent/team insights | |
| `audit` | Append-only audit log (actor, action, before/after) | |
| `webhooks` | HMAC-SHA256 signed delivery, exponential backoff | |
| `ops` | Health endpoint, active-channel count, kill switch | |

## 6. Data layer

MongoDB (Mongoose), **every collection tenant-scoped and indexed on `tenantId`**. Schemas in [apps/api/src/schemas/](../apps/api/src/schemas/):

`tenant`, `user` (roles, phone for OTP), `lead` (E.164, line type, tz, state history), `campaign`, `flow` (draft + immutable published versions), `call` (transcript, captured facts, score timeline, compliance events, `providersUsed` + per-stage cost), `transfer` (offer cascade state), `recording` (per-leg, region-pinned path, hold flag), `cli-number` (pool, health, resting), `suppression` (DNC, opt-outs, freq caps, client lists), `country-pack`, `provider` (adapter config + encrypted credentials), `agent-activity` (presence segments — auditable occupancy), `appointment`, `audit-log` (append-only), `api-key` (SHA-256 hashed, scoped), `webhook`.

Concurrency-critical writes are atomic Mongo ops: **lead lock** (dialer tick `findOneAndUpdate` prevents double-dial) and **agent reservation** (transfer offer). No Redis needed at pilot scale — Mongo is the single coordination point.

## 7. Identity & auth

### Agent/Admin login (Firebase **phone OTP over SMS** — same flow for both, role from our DB)

```
Browser (Next.js /login)                    Firebase Auth              API (auth module)
   │ 1. enter phone ──────────────────────────▶ signInWithPhoneNumber (SMS sent)
   │ 2. enter 6-digit code ───────────────────▶ confirm
   │ 3.               ◀────────────────────────  Firebase ID token
   │ 4. POST /auth/otp-login {idToken} ─────────────────────────────────▶
   │                                             5. firebase-admin verifies token
   │                                             6. users.findOne({phone, tenantId})
   │                                                → 401 if not provisioned (no self-signup)
   │ 7.               ◀───────────────────────────  app JWT {sub, tenantId, role}
   │ 8. JWT on REST (Authorization) + Socket.IO handshake auth
```

- **Firebase authenticates, CoCally authorizes**: role and tenant come from our `user` record, never from Firebase. Human agents and admins use the identical flow — only the role on the user record differs.
- Admins provision users (with E.164 phone numbers) first; an unknown phone is rejected even with a valid OTP.
- **Session length is a cost decision.** Each SMS is ~$0.06 (AU) / ~$0.01 (India). Use **long-lived refresh tokens** so a fresh SMS fires only weekly, on a new device, or after explicit logout — not every shift. Per-login auth on AU numbers costs ~5× more (COGS §4 table).
- **App Check + reCAPTCHA** on the sign-in endpoint and an **SMS region policy** allowing only AU + team countries — without these, the phone-OTP endpoint is an SMS-pumping target that bills to us.
- Existing TOTP can remain as an optional second factor for Owner/Admin.
- Programmatic access: scoped API keys (SHA-256 hashed) — unchanged.

### Authorization
RBAC guard at the API (roles above), tenant scoping in `common/`, 403-verified on team endpoints. Immutable audit log for every admin action.

## 8. Voice & media plane (LiveKit)

Decision (deployment doc §5b): **LiveKit Cloud** — SFU, SIP bridge, TURN, egress. Trunk provider (Twilio/Telnyx) carries PSTN; telco billed separately.

**Room model — one room per call:**

| Participant | Joins via | When |
|---|---|---|
| Customer | SIP participant (LiveKit SIP outbound dial through the trunk) | At dial |
| AI agent | Worker VM process (WebRTC, outbound) — dispatched to the room by LiveKit agent dispatch | At dial |
| Human agent | Browser WebRTC (workspace UI) | On transfer accept |

**Outbound call sequence:**
1. Dialer tick selects lead + CLI → `call-orchestrator` creates the `call` record and requests a LiveKit room + SIP participant dial-out (CLI number as caller ID).
2. LiveKit dispatches an agent job to the Worker VM; the worker joins the room and attaches the `CallRuntime` for this call (campaign, flow version, lead context loaded via API).
3. **AMD**: worker classifies pickup (human/voicemail/IVR) → campaign policy: proceed / message drop / DTMF navigate / hang up + retry-matrix schedule.
4. Conversation loop per turn: STT (streaming) → safety rails (opt-out/distress regex, pre-LLM) → `composeSystemPrompt` (rebuilt fresh: node prompt + already-answered facts + rebuttals + envelope contract) → LLM (JSON envelope) → engine applies `captured`/`intent`/`objection` → score recompute → TTS speaks `reply`. Live transcript + score stream to the floor feed via the API's Socket.IO gateway.
5. **Warm transfer** (score ≥ threshold or `intent: qualified`): `transfers.service` atomically reserves an eligible agent → transfer card offer with countdown over Socket.IO → on accept, the human agent's browser **joins the same LiveKit room** (measured dead-air ~230ms) → AI participant mutes/exits → disposition close-loop on wrap-up. Decline/timeout → cascade to next agent → booking-flow fallback.
6. **Recording**: two egress tracks per call — AI leg and human leg — written by LiveKit egress **directly to the GCS bucket** under the region-pinned path `{tenantId}/{region}/{callId}/{leg}`; the `recordings` module stores offsets for the stitched timeline.

Network property: workers and browsers connect *outbound* to LiveKit Cloud; our firewall needs zero inbound UDP, ever.

## 9. AI pipeline & provider abstraction (PAL)

Per capability (STT/TTS/LLM), resolution walks: **flow-node override → campaign → country pack → tenant → platform default**, skipping hops without credentials, ending at the always-registered simulation adapter. Three independent LLM roles (conversation / summary / scoring) can target different models. Credentials per tenant in an AES-256-GCM vault (key from Secret Manager); env vars are local-dev fallback only. Every stage of every call records `providersUsed` + cost → per-call cost composition in the deep-dive (and the ground truth for the COGS model).

Default production chain (COGS doc): Deepgram Nova-3 (STT) → **Gemini 2.5 Flash-Lite** (conversation) → Deepgram Aura-2 (TTS); premium nodes may override to Gemini 2.5 Flash / ElevenLabs per flow node. Keep a second LLM adapter (Claude Haiku 4.5 or next-gen Flash) configured as the next hop in the fallback chain — model deprecation then becomes a config change, not a deploy. Note Gemini 2.5 Flash retires 2026-10-16.

## 10. Realtime layer

Socket.IO (server in `workspace/realtime.gateway.ts`, JWT-authenticated handshake, tenant-scoped rooms):

| Event family | Producers → consumers |
|---|---|
| Presence changes | presence.service → floor feed (supervisors all, agents own-campaign scope) |
| Transfer offers + countdown | transfers.service → target agent |
| Live transcript + score updates | engine (via worker → API) → supervisors / test-drive UI |
| Compliance events, kill switch | telephony/ops → dashboards |

Single API instance ⇒ no Socket.IO adapter needed. Phase 2 (multi-instance): Redis adapter (Memorystore) + LB session affinity.

## 11. Call lifecycle (end-to-end)

```
lead imported → normalized (E.164, line type, tz)
  → dialer tick: kill-switch ▸ daily budget ▸ channel caps ▸ pacing (available agents)
      ▸ atomic lead lock ▸ legal calling window (IANA tz + holidays)
      ▸ suppression stack (DNC wash ▸ opt-outs ▸ freq caps ▸ client lists) ▸ CLI select
  → LiveKit room + SIP dial → AMD gate
  → flow executor walks published flow version (SPEAK/PLAY ▸ AI_CONVERSATION ▸ LISTEN ▸ …)
  → per-turn loop (§8.4) with live scoring + incremental summary
  → outcome: transfer (▸ human leg ▸ disposition) | callback (retry matrix) | opt-out
      (instant suppression) | voicemail policy | end
  → post-call: recording legs finalized to GCS ▸ auto-QA score ▸ webhooks (HMAC)
      ▸ analytics rollups ▸ lead state history appended
```

## 12. Recording, retention, compliance

- **Storage**: GCS regional (Sydney), uniform bucket-level access, public-access prevention. Path scheme `{tenantId}/{region}/{callId}/{leg}` preserves the region-pinning contract.
- **Playback**: API mints **V4 signed URLs** (short-lived) after RBAC check; raw-audio access is audited. Browser never touches bucket credentials.
- **Retention**: GCS lifecycle rule per retention window; **legal hold** = per-object `temporaryHold`, which overrides lifecycle deletion (1:1 with the product's hold flag).
- **Transcripts**: PII-redacted by default in UI; raw access audited.
- **Compliance enforcement points**: publish-time (mandatory disclosure node), dial-time (wash freshness blocks, windows, suppression), turn-time (opt-out/distress regex before the model), record-time (compliance events per call).

## 13. Security

| Layer | Control |
|---|---|
| Edge | Caddy TLS (auto-renew), HTTP→HTTPS, security headers (helmet in API) |
| Network | Ingress 443/80 only; worker VM no external IP; SSH via IAP only; Atlas private via peering |
| Identity | Firebase phone OTP (SMS) + provisioned-user check; app JWT; RBAC guards; scoped hashed API keys |
| Secrets | Secret Manager → deploy-time env; tenant provider creds AES-256-GCM; no keys in repo/images |
| Data | Recordings private + signed URLs; PII redaction; append-only audit log; per-tenant isolation on every query |
| Abuse | App Check + reCAPTCHA + SMS region policy on phone OTP (anti SMS-pumping); webhook HMAC; kill switch |
| Supply chain | Images built in CI from lockfile, tagged by SHA, immutable in Artifact Registry |

## 14. Observability

- Ops Agent → Cloud Logging (JSON container logs) + Monitoring.
- Uptime check on `/health` (exists in `ops` module) + active-channel gauge.
- Alert policies: uptime fail, VM CPU/mem >80% sustained, Atlas connection/disk alerts, GCS error spikes, log-based alert on kill-switch activation, worker job failure rate.
- Product-level: auto-QA scores, per-call cost (`providersUsed`), answer-rate per CLI (feeds resting logic) are in-app analytics, not infra metrics.

## 15. CI/CD

GitHub Actions, Workload Identity Federation (no JSON keys):

1. **CI** (all PRs): pnpm install → typecheck → lint → `vitest` (API, uses `mongodb-memory-server`) → `next build`.
2. **Deploy**: push `main` → staging; tag `v*` → prod (environment approval gate). Build `api`+`web` images → Artifact Registry → IAP SSH → `docker compose pull && up -d` → `/health` gate → fail loudly.
3. Worker VM deploys the worker image the same way (its own compose file).
4. Rollback = redeploy previous SHA tag.

## 16. Scaling path (Phase 2 triggers & moves)

| Trigger | Move |
|---|---|
| >1 tenant with meaningful volume, or app VM >70% sustained | Split web to Cloud Run; API behind HTTPS LB |
| Concurrent calls > ~40 | Worker VM → e2-standard-8, then MIG with LiveKit worker autoscaling |
| Multi-instance API needed | Socket.IO Redis adapter (Memorystore), dialer extracted to singleton worker with leader election, LB session affinity |
| AU media-residency contract clause | LiveKit Enterprise/BYOC conversation |
| Atlas M10 saturation | Vertical (M20/M30) — no code change |

Nothing in the Phase-1 design blocks any of these; the seams (CallRuntime, PAL, single-writer dialer, stateless web) are already in place.
