# CoCally — Version history (July 2026)

This file condenses the July 2026 session logs. It covers 38 files written between 19 and 27 July, before the September pilot push.
The original files are in [`archive/2026-07/`](archive/2026-07/), unchanged, and in git history.

**Still kept as live docs at the top level** (edited in September): the `2026-09-*` session logs, [`data-model.md`](data-model.md), [`LOGINS.md`](LOGINS.md) and [`2026-07-19-demo-guide.md`](2026-07-19-demo-guide.md).

> Anything marked **(superseded)** has been overtaken by later work. The main changes are: **India is the default market**, not Australia. **The Telvoq trunk** was proven on 2026-09-25 and replaced the Twilio trunk. **MongoDB Atlas** replaced local Mongo. The **LLM is Groq**, not Gemini. The pilot went live on **2026-09-28**, not in July.

---

## At a glance

| Ver | Date | Theme | Headline |
|---|---|---|---|
| 0.1 | 07-19 | Foundation | PRD v1 Phase-1 built from an empty repo. Simulation-only `CallRuntime`, flows, dialer gates, PAL, warm transfer, agent insights, flow canvas, architecture, COGS, GTM, marketing site |
| 0.2 | 07-20 | Floor ops | Presence heartbeat and stale-sweep, call filters, campaign team assignment, campaign insights |
| 0.3 | 07-22 | CRM + live voice | Human-dialer BPO reframe (lead ownership, 100k CSV import, callbacks, maintenance jobs). Manual dial. LiveKit worker with Groq + Deepgram. **First real PSTN call** over a Twilio SIP trunk |
| 0.4 | 07-23 | Business case | Progress audit, 60k-dial COGS, INR rate card, human-dialing requirements (deal gate), PMF analysis |
| 0.5 | 07-25 | Dialer parity | Real manual dial over carrier SIP, predictive dialer (simulated), CLI quarantine, CSV reports, global call bar, India pricing and pilot quote |
| 0.6 | 07-27 | Go-live prep | 10-agent live-trunk runbook: pre-flight, smoke test, rollback ladder (superseded by the Sept go-live) |

---

## Key decisions still in force

- **The `CallRuntime` seam** (`engine/runtime.ts`): flow executor, AI loop, scoring and transfer logic are the same for simulation and real telephony.
- **One LiveKit room per call.**
  - The customer is a SIP participant.
  - The AI is a Python LiveKit Agents worker (`agent-worker/agent.py`).
  - On transfer the human's browser joins the same room and the AI **disconnects** rather than muting.
  - An AI→human transfer is a room join, not an inbound call.
- **"The worker runs the conversation; the engine stays authoritative."** The worker pulls `GET /engine/calls/:id/brief` and pushes `POST /engine/calls/:id/transcript` and `/transfer`, authenticated with `ServiceTokenGuard` (shared `ENGINE_SERVICE_TOKEN`).
- **The system prompt is rebuilt every turn** by `composeSystemPrompt`. It combines the node prompt, the disclosure, the ALREADY ANSWERED facts, the objection playbook and the JSON envelope contract `{reply, intent, captured, objection}`, and it carries the full turn history.
- **Dialer gate order:** kill switch → budgets → concurrency → availability pacing → atomic lead lock → legal calling window (lead's timezone) → suppression/DNC/opt-out → CLI select. `assessCapacity()` is shared with `GET /dialer/status`, so the UI and the dialer can't disagree.
- **Single API instance.** Mongo `findOneAndUpdate` handles all coordination. Redis was judged unnecessary at 10–30 operators on 07-25.
- **VM, not Cloud Run**, because the dialer is a 24/7 singleton tick and Socket.IO needs sticky sockets.
- **LiveKit Cloud, not self-hosted**: revisit only above ~100 concurrent channels.
- **Voice stack:** Deepgram nova STT, Deepgram Aura TTS, Groq `llama-3.3-70b-versatile` (called through `openai.LLM(base_url=groq)` because `with_groq` was removed in livekit-agents 1.6.6), Silero VAD and turn-detector.
- **The LLM is about 3% of AI-leg cost.** TTS, LiveKit and STT dominate, and **the telco rate is the biggest cost lever**.
- **Carrier-agnostic SIP.** Only `LIVEKIT_SIP_TRUNK_ID` matters, so changing carrier means reconfiguring the LiveKit trunk, not changing code.
- **Pricing for deal #1:** charge per AI minute plus a per-dial fee, and don't charge for the human leg. See the 07-25 pilot quote below.

## Superseded decisions

| Then (July) | Now |
|---|---|
| AU-first GTM, AU country pack, Sydney region, ACMA DNCR wash | India is the default (see Sept logs) |
| Twilio Elastic SIP trunk (`ST_AzZWA7GCAdkr`, Trial) | Telvoq trunk, proven 2026-09-25 |
| Gemini 2.5 Flash-Lite as the default LLM | Groq `llama-3.3-70b-versatile` |
| Local Mongo via docker compose in `start.sh` | MongoDB Atlas (commit `0800fcd`) |
| argon2 + TOTP auth | Firebase phone OTP → app JWT |
| drachtio/FreeSWITCH SIP driver plan | LiveKit Cloud SIP |
| "230ms bridge dead-air" | That was simulation wall-time; say "sub-second" |
| "Never build predictive dialing" (07-19) | Predictive dialer built 07-25, but simulated only and refused on a live trunk |
| ₹45 per AI connect (07-23 rate card) | ₹8.50 per AI-min + ₹0.80 per dial (07-25 pilot quote) |
| Redis needed before scaling | Not needed at 10–30 seats |
| "Monday" go-live, 07-27 | Pilot go-live 2026-09-28 |

## Open items carried out of July

Check each against the Sept logs before acting on it.

- Restore the password min length (FE `minLength` and BE `MinLength`) from 4 to **8** before production.
- `z.coerce.boolean()` footgun: `DNCR_ENABLED=false` and `RECORDING_ENABLED=false` parse as **true**.
- `JWT_SECRET` and `VAULT_KEY` have insecure defaults. `DTMF_OPT_OUT_DIGIT` is read outside the config schema.
- A Deepgram key was once committed in `LOGINS.md`. It's gone from the file but still in git history, so **rotate it** if that hasn't been done.
- The test suite is 2 files / 14 tests; older docs claim "24/24". DB-backed tests via `mongodb-memory-server` are still deferred.
- Not built as of July:
  - inbound/ACD (callbacks to CLIs reach nothing)
  - voicemail drop (AMD is advisory only)
  - carrier alerting for CLI quarantine
  - per-lead recording timeline UI
- `recomposeSummary` runs an LLM call after every customer turn, which costs latency and money. Debounce or batch it.
- Lead `timeline` is capped at 300 entries. Seeds without a `listId` used to crash `lead.save()`, so check imports.

---

## Detailed log

### 0.1 — 2026-07-19 · Foundation

#### Initial build of PRD v1.0 Phase-1 (`initial-build.md`)
- Stack:
  - pnpm monorepo: `apps/api` (NestJS + Mongoose), `apps/web` (Next.js 16, Tailwind 4, zustand, socket.io-client), `packages/shared` (`@cocally/shared`: zod flow schema, scoring, redaction, WS contracts).
  - MongoDB only. `@nestjs/schedule` runs the dialer tick every 5s and the webhook drain every 10s.
- `CallRuntime` interface with `simulation.runtime.ts` (`TELEPHONY_DRIVER=SIMULATION`).
- PAL: adapter registries, a config hierarchy and fallback chains. Simulation adapters make everything run with zero keys.
- 16 schemas:
  - Call: raw and redacted transcript, scoreHistory, complianceEvents, costCents, providersUsed.
  - Lead: `lockedAt` guard.
  - Transfer: `attempts[]` cascade.
- Safety rails (opt-out/distress regex) run before the LLM. Webhooks are HMAC-SHA256 with backoff from 1m to 4h.
- Later in the session:
  - AES-256-GCM credential vault with per-provider `CredentialField[]`.
  - `POST /flows/prompt-preview`.
  - Live test-drive (`InteractiveRuntime`).
  - `POST /flows/generate`: deterministic structure with LLM-written content.
- Ops hazard: two dev APIs racing for :4000. Run `pkill -f ts-node-dev` and check `lsof -ti :4000`.

#### Prompting architecture (`prompting-architecture.md`)
- Request params: `jsonMode`, temperature 0.6, maxTokens 400. The full history is sent because calls run to 16 short turns or fewer.
- `flow-executor.service.ts` `runConversation` applies the envelope:
  - `captured` → facts → score
  - `qualified` or crossing the threshold → transfer edge
  - `opt_out` → instant suppression
  - malformed JSON → raw text treated as `continue`
- Three independently configurable LLM roles: conversation, summary and scoring.
- Test-drive: `POST /flows/versions/:id/test-drive`, `/flows/test-drive/:sid/reply`, `/end`.

#### Agent & team insights (`agent-insights.md`)
- `agent-activity.schema.ts` stores one document per presence segment, logged by `presence.service.ts`.
- `analytics/agent-insights.service.ts` backs `GET /analytics/agents/me|team|:id`. Agents get 403 on team data.
- Occupancy = (on-call + wrap-up) / staffed time.
- Fixed transfer `attempts` never persisting (`markModified`), which had kept the acceptance rate at 0.

#### Product features tour (`product-features.md`)
- Snapshot of Phase-1 scope:
  - flow node types: AMD, SPEAK/PLAY, AI_CONVERSATION, LISTEN_CAPTURE, TRANSFER, END
  - campaigns: retry matrix, scoring, rebuttals, CLI pools, A/B splits
  - warm transfer: 5 agent-selection strategies, atomic reserve, offer cascade, sticky agent
  - PII redaction and 100% auto-QA
- PAL resolution order: node → campaign → country pack → tenant → platform.

#### Full system architecture (`2026-07-19-architecture.md`)
- App VM `e2-standard-2`: Caddy, web on :3000 and a single API instance on :4000.
- Worker VM `e2-standard-4`: no external IP, Cloud NAT, about 10–20 calls per 4 vCPU.
- Other services: LiveKit Cloud, Atlas M10, GCS, Firebase Auth, Secret Manager, Artifact Registry.
- Egress path: `{tenantId}/{region}/{callId}/{leg}`, with V4 signed URLs and `temporaryHold` for legal hold.
- Firebase phone OTP → `POST /auth/otp-login` → app JWT ("Firebase authenticates, CoCally authorizes").
- CI/CD: GitHub Actions + WIF. `main` deploys staging; `v*` tags deploy prod behind an approval gate.
- Phase-2 triggers: worker MIG above ~40 concurrent calls; Redis and a leader-elected dialer for multi-instance.
- (superseded) Sydney region, AU bucket naming, Gemini default.

#### GCP deployment strategy (`2026-07-19-deployment-strategy.md`)
- Separate projects `cocally-staging` and `cocally-prod`. Atlas M10 over private networking. Secret Manager materialised into the compose env.
- The VM runs 24/7; a nightly shutdown would only save about $25–30/mo.
- Cost: prod about $260–295/mo plus usage; staging about $30–40/mo.

#### COGS & AI cost model (`2026-07-19-cogs-model.md`) — superseded by the 07-23 COGS model
- AI leg **$0.037/min buffered (₹3.63)**. Split: TTS 41%, LiveKit 27%, STT 26%, LLM 3%.
- Human leg $0.019/min. Fixed prod cost $385/mo.
- A transferred call (3 min AI + 6 min human) costs about $0.81, of which telco is about 72%.
- Firebase OTP costs $0.01 per SMS in India.

#### Call-centre operations map + VICIdial parity (`2026-07-19-call-centre-operations-map.md`)
- Every operational job listed by actor (Admin, Supervisor, Agent, AI, Campaigns, Numbers, Data, Insights, Compliance) with ✅/⚠️/❌.
- Minimum parity set, in order: monitor/whisper/barge, hold/mute/agent→agent transfer, script panel, pause codes, list ordering and hopper alarm, callback queue, CSV export, inbound ACD.
- Most of this was built by 07-27.

#### Market research & positioning (`2026-07-19-market-research-and-positioning.md`)
- Pains:
  - 42h average speed-to-lead; calling within 5 min makes a lead 21× more likely to qualify.
  - >95% of "Spam Likely" calls go unanswered.
  - QA samples only 1–2% of calls.
- Competitor camps:
  - voice-AI infrastructure (Bland, Retell, Vapi)
  - enterprise inbound (Sierra, Parloa, PolyAI)
  - AI SDRs, where trust has collapsed
  - seat-based incumbents (Five9, Convoso, VICIdial)
  - The open position is an AI-fronter → human-closer product.
- Positioning line: "The AI front line for revenue teams". Pricing is usage-based with no seats. Honesty rule: no fake customers.

#### Australia GTM strategy (`2026-07-19-aus-gtm-strategy.md`) — (superseded)
- BPO-channel-first "become their engine" pitch, with AU direct sales as the second motion.
- The BPO-channel logic still applies regardless of market.

#### Marketing website (`2026-07-19-marketing-website.md`)
- Static `website/` folder (no build step), hosted on Cloudflare Pages; the domain is at GoDaddy.
- SEO: JSON-LD, `llms.txt`, sitemap.
- Visuals: product palette (navy `#0b1220`, amber `#f5a623`).
- Messaging:
  - Hero: "AI calls every lead in seconds…".
  - Every "230ms" claim reads "sub-second".
- The demo form posts to FormSubmit.
- Open: real pricing (the AUD placeholders are superseded), the `hello@` mailbox, logos.

#### Dialer start chain · status visibility · flow canvas · energy flow · live-call plan · start.sh
- **Dialer start chain** (`2026-07-19-dialer-start-chain.md`):
  - "Humans never dial" in AI mode.
  - The idle-pilot cause was all agents OFFLINE plus leads outside their calling window.
  - `POST /workspace/presence` takes `state`.
- **Status visibility** (`2026-07-19-dialer-status-visibility.md`):
  - Reason codes such as `NO_AGENTS_AVAILABLE`, `OUTSIDE_CALLING_WINDOW`, `NO_FLOW_VERSION` and `AT_PACING_CAP`, served by `GET /dialer/status[/:campaignId]` and shown in `DialerStatus.tsx`.
  - `POST /calls/dev-dial` bypasses the compliance gates and is not a product feature.
- **Flow canvas** (`2026-07-19-flow-canvas.md`): dependency-free SVG `FlowCanvas.tsx` with longest-path layout. Positions persist in `localStorage` (`cocally-flow-layout-<flowId>`). No structural editing.
- **Energy Bill Review flow** (`2026-07-19-energy-bill-flow.md`):
  - Built from a real BPO transcript; Mongo id `6a5d05e00ef7c7980ab7c8f4`, and it is not in the repo.
  - Captures retailer, bill, solar, life support, concession card and NMI; capturing the NMI qualifies the lead.
- **Live-call build plan** (`2026-07-19-live-call-build-plan.md`):
  - 3-week plan below the `CallRuntime` seam: Python LiveKit worker, `livekit.runtime.ts`, AMD on real audio, egress to GCS, SIP cause-code retries.
  - LiveKit Cloud originates SIP from its own IPs, so prefer digest auth on the trunk.
- **start.sh** (`2026-07-19-startup-script-and-features-doc.md`): boots Mongo (superseded by Atlas), copies `.env`, runs pnpm install and builds shared, seeds once via a `.seeded` marker (`--reseed`/`--no-seed`), then runs the API and web servers.

### 0.2 — 2026-07-20 · Floor ops (`2026-07-20-filters-team-insights-presence.md`)
- **Presence timeout:**
  - `user.lastSeenAt`, `PRESENCE_TIMEOUT_MINUTES=5`.
  - `POST /workspace/heartbeat` fires every 30s.
  - A 60s sweep moves AVAILABLE/WRAP_UP/BREAK agents to OFFLINE; ON_CALL/RESERVED are never swept.
- **`GET /calls` filters:** `agentId` (incl. `unassigned`), `outcome`, `disposition`, `amdClass`, `from`/`to`. Filter options come from the shared enums.
- **Campaign team:** `GET/POST /campaigns/:id/team`, atomic and audited. Agents with no skills are eligible for every campaign.
- **Other:** `CampaignInsights.tsx`; roster "Accepted" column; "By month" range preset.

### 0.3 — 2026-07-22 · CRM hardening + live voice

#### Demo login, insights seeding, dashboard filter (`2026-07-22-login-fix-insights-dashboard-filter.md`)
- Login takes a username and a 4-character password (restore to 8 for prod).
- `pnpm --filter @cocally/api demo-data` seeds 719 calls and 113 transfers.
- Dashboard gets a Today/7d/30d/All range filter.

#### Manual dial (`2026-07-22-manual-dial.md`)
- `manual-dial.service.ts` provides queue, claim, release and dial:
  - `dial` enforces the legal gates and skips the operational ones.
  - One live manual call per agent.
- `lead.manualClaimedBy`: the AI dialer never touches claimed leads.
- The voice leg was simulated until 07-25.

#### Transfer opener + on-call briefing (`2026-07-22-transfer-card-and-oncall-briefing.md`)
- `buildOpener(lead, objection)` gives the agent a natural first line.
- `GET /calls/:id/briefing` gives agents the summary, facts and rebuttals. It avoids the socket race and doesn't grant campaign access.

#### CRM hardening for a human-dialer BPO (`2026-07-22-crm-hardening-for-human-dialer-bpo.md`)
- Reframed around a real BPO: about 15 human callers and 100k+ calls.
- `ownerId` lead ownership:
  - `AssignmentService.topUp` is atomic.
  - `reclaimStale` releases leads held more than 12h.
- CSV import: batched `insertMany`, 100k rows in 8.9s.
- `SchedulingService`: callbacks and appointments; double-booking returns 409.
- `MaintenanceService`:
  - `wakeRested`, daily counter resets and `purgeExpired`
  - stuck-call sweep
- CRM features: `PATCH` and audited override, notes, bulk tag/reassign, recycling, `LeadDrawer.tsx`.
- Analytics: 20s cache, `pacing-health` and `list-health`.
- **Compliance fix:** the DNC guard and `recycle()` now check for an active `OPT_OUT` suppression, not just `dncListed`.

#### Live voice, in five steps
1. **Playground demo** (`2026-07-22-livekit-voice-agent-demo.md`): `agent-worker/agent.py` running in LiveKit's Agents Playground. `config.ts` gains `LIVEKIT_*`, `TWILIO_*`, `ENGINE_SERVICE_TOKEN` and `PUBLIC_BASE_URL`.
2. **Engine seam** (`2026-07-22-livekit-twilio-full-build-phase1.md`): `service-token.guard.ts` (fails closed) and `GET /engine/calls/:id/brief`.
3. **Worker working** (`2026-07-22-livekit-voice-agent-working.md`): Groq + Deepgram in LiveKit's India South region. Needs Python 3.10+ (uv, 3.12). Run `agent.py download-files`, then `agent.py dev`.
4. **Browser end-to-end** (`2026-07-22-live-voice-demo-end-to-end.md`):
   - `livekit.service.ts` (`ensureRoom`, `mintToken`).
   - `POST /calls/live-demo`, public `/demo/lead/[callId]`, and the transcript and transfer engine endpoints.
   - **Root cause found: the API had never loaded `.env`.** Fixed by loading dotenv in `config.ts`.
5. **First real PSTN call** (`2026-07-22-real-twilio-sip-dialout.md`):
   - `dialOut()` via `createSipParticipant` over the Twilio trunk. The user's phone rang and played the disclosure.
   - `ctx.shutdown()` is synchronous in livekit-agents 1.6.6.
   - `recomposeSummary` merges LLM-extracted facts into `lead.facts`, rescores and renders `summaryTemplate`.
   - Agent audio got an autoplay fallback and a mute toggle.
- Progress tracker for all five steps: `2026-07-22-live-voice-build-progress.md`.

### 0.4 — 2026-07-23 · Business case

#### Progress audit & next steps (`2026-07-23-progress-and-next-steps.md`)
- The CRM layer was production-shaped. The media plane was not yet real:
  - manual dial never called `dialOut`
  - no CLI was sent in `From`
  - AMD was faked
  - recordings were `.txt` files
  - there was no audio bridge
- P0 list:
  - real manual dial
  - CLI on the wire
  - carrier status callbacks
  - GCS recording
  - number reputation: 7-day answer rate, auto-quarantine, and ≤150–200 dials/day per DID

#### COGS at 60k dials/month (`2026-07-23-cogs-60k-calls.md`)
- About **$2,116/mo**, of which telco is 65%.
- Unit costs: $0.035 per dial, $0.35 per connect, $1.76 per transfer.
- Moving the carrier from Twilio AU retail to a $0.01 wholesale rate would save about $1,065/mo (the AU telco figures are superseded).

#### INR platform rate card (`2026-07-23-rate-card-inr.md`) — (superseded by 07-25)
- Platform COGS ₹77k/mo. **AI marginal cost ₹2.87/min**: TTS ₹1.35, LiveKit ₹0.96, STT ₹0.46, LLM ₹0.09.
- Cost per call type:

  | Call type | Cost |
  |---|---|
  | Unconnected | ₹0.72 |
  | Human connect | ₹4.04 |
  | AI connect | ₹6.17 |
  | AI + transfer | ₹9.64 |

#### Human-dialing requirements (`2026-07-23-human-dialing-requirements.md`)
- The deal gate for retiring VICIdial (20k of the BPO's 60k calls/month are human-dialed).
- Requirements:
  - R1 real dial (ordered: selectCli → room → agent joins → `dialOut`)
  - R2 CLI on the wire
  - R3 browser audio
  - R4 hangup/mute/DTMF
  - R5 SIP outcomes
  - R6 GCS egress
  - R7 concurrency/CPS limits
  - R8 floor feed
- Migrate in phases, and don't promise a cutover date.

#### PMF analysis (`2026-07-23-pmf-analysis.md`)
- Premise: automate the roughly 90% of dials that reach nobody, and keep the regulated close human.
- Wedge: one lead DB, two dialing modes, and a warm-transfer screen-pop.
- Best first buyer: lead-gen agencies. Top verticals: edtech admissions and insurance renewals.
- Revenue model: ₹1 per dial + ₹8–11 per connected minute.
- India regulation: TRAI/DLT registration is table stakes.
- Artifact: https://claude.ai/code/artifact/f1e93b86-29cb-43a3-9fdd-7e6c96c6deab

#### Run demo (`2026-07-23-run-demo.md`)
- Health check: `GET /api/v1/ops/health`. If `start.sh` fails with EADDRINUSE, the dev servers are already running.

### 0.5 — 2026-07-25 · Dialer parity + pricing

#### Manual dial over carrier SIP, Phase 1 (`2026-07-25-manual-dial-carrier-sip-phase1.md`)
- The manual-dial API is split into three calls:
  - `dial()`: gates, CLI, room and token
  - `connect()`: runs after the browser publishes its mic, then calls `dialOut(from: CLI)`
  - `hangup()` → `WRAP_UP`
- `manual-dial/page.tsx` runs a real LiveKit `Room` with DTMF (RFC4733).
- R1–R4 are done. Only `tsc` verified it; there was no live call.

#### Predictive dialer, CLI health, CSV reports (`2026-07-25-predictive-dialer-cli-health-reports.md`)
- `predictive-dialer.service.ts`:
  - ViciDial-style adaptive ratio
  - 3% abandon cap
  - `ABANDONED` outcome with a compliance event
  - `PREDICTIVE_MODE_ACTIVE` keeps a campaign either AI-fronted or predictive
  - AMD is simulated, so it is refused on a live trunk
- CLI `QUARANTINED` status: 7-day answer rate below 8% with at least 20 dials. `reinstate()` is audited. Admin page at `/cli-numbers`.
- `ReportsModule`: `GET /reports/{calls,leads,campaign-summary}.csv`.

#### Global call bar (`2026-07-25-global-call-bar-modern-dialer-ux.md`)
- `GlobalCallBar.tsx` in `(app)/layout.tsx`, backed by `activeCall` in the store. One state machine covers transfer, manual and predictive calls.
- Restores after a reload via `GET /workspace/me/current-call`.
- Fixed: `DEFAULT_PREDICTIVE_DIALING` backfill on `.lean()` reads; 240 leads with no `listId` that crashed the API.

#### India pricing for the first client (`2026-07-25-india-pricing-first-client.md`)
- Market band: AI voice ₹4–8/min; human tele-caller ₹8–20/min fully loaded.
- The earlier ₹45 per connect was about 2× the market.
- Offer: ₹5 per AI-min + ₹20k base + ₹800 per human seat. Floor: ₹4/min.

#### Pilot quote template (`2026-07-25-client-quote-pilot.md`) — current commercial terms
- ₹55,000 onboarding advance, credited against usage.
- **₹8.50 per live AI-min + ₹0.80 per dial.** The human leg is free; telephony is passed through at cost; GST extra.
- Example: 400 dials/day + 200 AI-min/day ≈ ₹52,520/mo.
- Volume tiers: ₹8.00 per AI-min at 10k+ min, ₹7.00 at 50k+.

### 0.6 — 2026-07-27 · Go-live runbook (`2026-07-27-monday-golive-runbook.md`) — (superseded by the Sept go-live, but the checklist is still useful)
- **Pre-flight:**
  - `LIVEKIT_*`, `ENGINE_SERVICE_TOKEN` and `HOLD_MUSIC_URL` must match in `apps/api/.env` and `agent-worker/.env`.
  - The LiveKit webhook goes at `<PUBLIC_BASE_URL>/api/v1/telephony/livekit/webhook`; without it, calls stick in `RINGING`.
  - `ENGINE_BASE_URL` must include `/api/v1`.
- **Smoke test:**
  - manual dial, and the AI call's disclosure and AMD
  - hold music during transfer
  - opt-out by phrase and by pressing 9
  - supervisor monitor/whisper/barge
  - hold, agent→agent transfer, reload restore
- **Rollback ladder:**
  - L0: disposition the call
  - L1: pause the campaign
  - L2: stop the worker (manual only)
  - L3: `TELEPHONY_DRIVER=SIMULATION`
  - L4: compliance incident, freeze everything and preserve logs
  - L5: restart the API and close stale `DIALING`/`RINGING` calls
  - No reseeds, second instances or deploys mid-shift.
- **Limits:**
  - in-process Maps (single instance)
  - no inbound
  - hold audio depends on the agent's tab
  - AMD is advisory
  - wrap-up is enforced by a sweep
