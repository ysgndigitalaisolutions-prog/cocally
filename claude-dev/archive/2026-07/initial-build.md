# CoCally — Initial Build

> Session log: 19 July 2026. Full implementation of the CoCally PRD v1.0 (Phase-1 pilot scope) from an empty repository. This document records every decision, module, file, and verification from the initial build session.

---

## 1. Context

- **Input**: `CoCally_PRD_v1.pdf` — AI-first outbound contact-centre platform. AI voice agents dial leads, classify who answered (AMD), qualify in natural conversation, score live, and warm-transfer high-intent leads to human agents in a browser workspace with an AI summary card. Dual-leg recording, 100% auto-QA, country-pack compliance.
- **Starting point**: empty GitHub repo `ysgndigitalaisolutions-prog/cocally` cloned to `/Users/nithin/repos/cocally`.
- **Stack directive from Nithin**: **MongoDB + NestJS + Next.js** (matching the cocarely-prerequisite conventions: TypeScript everywhere, Mongoose, Tailwind, zustand, axios).

## 2. Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| Repo shape | pnpm monorepo: `apps/api`, `apps/web`, `packages/shared` | Shared domain contracts between API and web; single CI |
| Datastore | MongoDB only (Mongoose via `@nestjs/mongoose`) | User's stack; no Redis — dial scheduling is a Mongo-backed interval worker, fine at pilot scale (10k dials/day) |
| Backend framework | NestJS | PRD's 12 modules map 1:1 to Nest modules; DI, guards, gateways built in |
| Telephony | `CallRuntime` interface + **simulation driver** (`TELEPHONY_DRIVER=SIMULATION`) | Real carrier peering is an external dependency (PRD §7). The flow executor and AI loop are identical across sim and future SIP driver — "the agent that talks is the agent that thinks" |
| AI providers | PAL: adapter registries + config hierarchy + fallback chains | PRD's configurability core (PAL-01..12). Simulation adapters always registered → whole pilot loop runs with zero external keys |
| Realtime | Socket.IO gateway (`/ws` namespace), JWT in handshake auth | Workspace presence, floor feed, transfer offers, transcript streaming |
| Auth | JWT (global guard) + TOTP 2FA (otplib) + RBAC roles guard | NFR security; §2 role model with OWNER superuser |
| Scheduling | `@nestjs/schedule` intervals (dialer 5s, webhook drain 10s) | No extra infra |

## 3. Repository layout

```
cocally/
├── package.json                  # pnpm workspace root, onlyBuiltDependencies
├── pnpm-workspace.yaml
├── tsconfig.base.json            # strict, noUncheckedIndexedAccess
├── docker-compose.yml            # mongo:7 only
├── .github/workflows/ci.yml     # install → build shared → typecheck → tests → build web+api
├── README.md
├── claude-dev/initial-build.md  # this file
├── packages/shared/             # @cocally/shared
│   └── src/
│       ├── enums.ts             # roles, lead states, AMD classes, outcomes, node types…
│       ├── flow.ts              # zod flow-graph schema + validateFlowGraph()
│       ├── contracts.ts         # TransferCard, FloorCallCard, WS events, import report
│       ├── scoring.ts           # computeScore / scoreAction / DEFAULT_SCORING_CONFIG
│       ├── redaction.ts         # maskPhone / redactPii (REC-04: "04XX XXX 062")
│       └── __tests__/           # redaction + flow validation (10 tests)
└── apps/
    ├── api/                     # @cocally/api — NestJS
    │   └── src/
    │       ├── main.ts          # helmet, CORS, global prefix api/v1, validation pipe
    │       ├── app.module.ts    # Mongoose root, global JWT module, both guards
    │       ├── common/
    │       │   ├── config.ts    # zod-validated env
    │       │   └── auth/        # JwtAuthGuard, RolesGuard, @Roles, @Public, @CurrentUser
    │       ├── schemas/         # 16 Mongoose schema files (see §4)
    │       ├── seeds/seed.ts    # pilot tenant + users + flow + campaign + leads + washes
    │       └── modules/         # 15 modules (see §5)
    └── web/                     # @cocally/web — Next.js 16 + Tailwind 4
        └── src/
            ├── lib/             # api.ts (axios+interceptors), store.ts (zustand), socket.ts
            └── app/
                ├── login/
                └── (app)/       # sidebar shell, role-filtered nav
                    ├── dashboard/   # KPI band, funnel bars, objection table
                    ├── workspace/   # presence, floor feed, transfer card w/ countdown, dispositions
                    ├── campaigns/   # list + [id] detail w/ live setting controls + sim dial
                    ├── flows/       # flows/versions + text simulator (script or persona)
                    ├── leads/       # CSV import w/ rejects report, leads by campaign
                    ├── calls/       # list + deep-dive (redacted transcript, score timeline, compliance)
                    ├── providers/   # PAL registry view + vault key entry
                    └── audit/       # immutable audit viewer
```

## 4. Data model (Mongoose schemas)

All tenant-scoped collections carry an indexed `tenantId` (PLAT-01 isolation).

| Schema file | Collections | Key points |
|---|---|---|
| `tenant.schema.ts` | Tenant, Client | region pinning, retention days, dial quota, kill switch, branding |
| `user.schema.ts` | User | roles[], TOTP secret (select:false), presence, availableSince (longest-idle), talkTimeTodaySeconds, skills/languages, admin IP allowlist |
| `audit-log.schema.ts` | AuditLog | append-only; actor, action, entityType, before/after (ADM-02) |
| `country-pack.schema.ts` | CountryPack | dialing rules, DNC config, calling windows, holidays, disclosures, timezone hints, residency (CP-01) |
| `provider.schema.ts` | ProviderOverride, ProviderSecret, PronunciationLexicon | override level PLATFORM/TENANT/COUNTRY_PACK/CAMPAIGN, chain[], AES-GCM ciphertext fields |
| `campaign.schema.ts` | Campaign | retry matrix, scoring config, rebuttals, CLI pool + rules, voicemail/IVR policy, pacing knobs, A/B splits, transcription mode, whisper toggle, summary template |
| `flow.schema.ts` | Flow, FlowVersion, PromptAsset | immutable published versions, per-locale prompt variants |
| `lead.schema.ts` | Lead, LeadList, LeadImport | E.164, lineType, timezone, facts{}, score, lockedAt (double-dial guard), nextAttemptAt, timeline[], dedup + dialer-scan indexes |
| `suppression.schema.ts` | SuppressionEntry, DncWashRecord | opt-out permanent; wash with expiresAt (AU 30d) |
| `call.schema.ts` | Call | transcript[] (raw + redacted text), scoreHistory[], complianceEvents[], qaScore, timings (per-call trace), costCents composition, providersUsed |
| `transfer.schema.ts` | Transfer | attempts[] cascade history, card snapshot, bridgeDeadAirMs |
| `recording.schema.ts` | Recording | leg, region, timelineOffsetMs (stitching), legalHold, purgeAfter |
| `cli-number.schema.ts` | CliNumber | geoRegion, health counters, RESTING/QUARANTINED states |
| `appointment.schema.ts` | Appointment, Callback | unique partial index prevents slot double-booking (PLAT-05) |
| `webhook.schema.ts` | WebhookSubscription, WebhookDelivery | HMAC secret, retry state |
| `api-key.schema.ts` | ApiKey | SHA-256 hash, scopes (PLAT-04) |

## 5. Backend modules → PRD mapping

| Module | PRD | What's implemented |
|---|---|---|
| `auth/` | ADM/NFR | login (argon2), TOTP setup/confirm, JWT issuance |
| `users/` | §2, ADM-01 | tenant-scoped user CRUD with audit |
| `tenants/` | PLAT-01/08, ADM-03 | client CRUD, **pause-everything** kill switch |
| `audit/` | ADM-02 | append-only service + read API (ADMIN/QA) |
| `country-packs/` | CP-01/02/03 | AU pack auto-seeded on boot; `calling-windows.ts` — luxon-based `isWithinCallingWindow` / `nextWindowOpen` (handles DST divergence via IANA zones, public holidays) |
| `providers/` | PAL-01..12 | adapter interfaces (`types.ts`); simulation adapters (deterministic scripted-persona LLM); HTTP adapters (ElevenLabs TTS, Deepgram STT, Whisper STT, Anthropic/OpenAI/Gemini LLM); `PalService` — chain resolution through hierarchy, cooldown-based failover, per-call provider tracking; `VaultService` — AES-256-GCM per-tenant keys w/ env fallback |
| `flows/` | FLOW-01..05 | CRUD, draft→publish→immutable, structural validation, **compliance-node enforcement at publish** (AI-08: pack requiring disclosure → must have mandatory SPEAK/PLAY node), text simulator endpoint |
| `engine/` | AI-01..09, FLOW-01 | `runtime.ts` — `CallRuntime` interface + `interpolate()`; `flow-executor.service.ts` — graph walker (edge conditions, priorities, default edges), AI conversation loop (JSON envelope: reply/intent/captured/objection), never re-asks (facts injected into system prompt), rebuttal playbook, live scoring per turn, incremental summary, **safety rails**: opt-out regex → instant suppression write + polite exit; distress → graceful exit; dead-air → one nudge then exit (never "the line's cutting out"); `simulation.runtime.ts` — scripted or persona-LLM fake customer |
| `workspace/` | WS-01..05, XFER-01..07 | `presence.service.ts` — presence states, availability counts, 5 selection strategies, atomic reserve; `realtime.gateway.ts` — Socket.IO auth, rooms, floor feed, transcript streaming honouring PAL-10 display mode (supervisors always live; agent per campaign mode); `transfers.service.ts` — full orchestration: select → reserve → offer card → accept-window promise → cascade on decline/timeout → bridge (dead-air measured) → sticky-agent preference → FALLBACK when pool empty |
| `telephony/` | TEL-01..10 | `cli.service.ts` — geo-match, rotation, auto-rest on collapsed answer rate; `call-orchestrator.service.ts` — AMD → campaign voicemail policy (silent/prerecorded/AI drop) / IVR DTMF → flow execution with hooks writing transcript (raw+redacted)/score/compliance to Call doc + live WS events → outcome mapping → retry matrix via LeadsService → recordings → webhooks → auto-QA rubric; `dialer.service.ts` — 5s tick: kill switch → daily budgets → channel caps → availability pacing → **atomic lead lock (findOneAndUpdate)** → legal window check → suppression stack → CLI select → fire; `calls.controller.ts` — list, deep-dive (redacted by default), **disposition endpoint** (closes loop: lead state, human-leg recording, wrap-up presence, talk-time, webhooks), `dev-dial` (simulated call on demand) |
| `leads/` | LEAD-01..08 | `phone.util.ts` — libphonenumber E.164 + line type + area hint; `leads.service.ts` — CSV import (column mapping, dedup in-file + cross-list, emergency blocklist, timezone inference state→area→default, rejects report), retry matrix application, lifecycle transitions with timeline; `suppression.service.ts` — ordered dial-time stack: DNC wash (stale wash **blocks**) → opt-out → frequency cap → client suppression; instant opt-out write |
| `recordings/` | REC-01..05 | region-pinned paths `{region}/{tenant}/{lead}/{call}-{leg}`, stitched timeline offsets, whisper marking, retention purge + legal hold, audited raw access |
| `webhooks/` | PLAT-04 | subscriptions w/ one-time secret, HMAC-SHA256 signed deliveries, exponential backoff (1m→4h, 6 attempts) |
| `analytics/` | DASH-01..08 | KPI band (dials, connect rate, transfers, bookings, cost/booking, AHT, avg QA), lead funnel, objection intelligence (frequency, rebuttal win-rate, bookings-at-risk), outcome/AMD mix, best-time-to-call heatmap |
| `ops/` | PLAT-07 | public health endpoint, live channel count |

## 6. Seed data (`pnpm --filter @cocally/api seed`)

- Tenant **Sunrise Connect (Pilot)**, client **Aurora Solar Retail**
- Users (password `CoCally!Pilot2026`): owner@ / admin@ / supervisor@ / agent1@ / agent2@ / qa@cocally.dev
- 2 CLIs (VIC +61390001000, NSW +61280001000)
- Published flow **AU Solar Qualification v1**: AMD → mandatory disclosure (recording + AI identification) → AI qualification → transfer → book-fallback → ends
- Campaign **Aurora Solar — VIC Pilot** (PAUSED; activate to start the dialer)
- 5 leads across VIC/NSW/QLD timezones, all with fresh 30-day ACMA washes

## 7. End-to-end verification (all performed live)

1. **Boot**: API on :4000 (all routes mapped, Mongo connected), health `{"status":"ok"}`.
2. **Fallback path**: dev-dial with scripted replies → AMD HUMAN → disclosure spoken (compliance event recorded) → qualification captured `owner/billHigh/dwellingHouse/appointmentInterest` → score 40→60→70 → transfer requested → no agent AVAILABLE → cascade exhausted → FALLBACK → book-fallback line → lead `QUALIFIED`, auto-QA 90/100.
3. **Warm-transfer path**: agent1 AVAILABLE → dial → offer created → **accepted within window → transfer BRIDGED, dead-air 231ms** (NFR ≤1s), card carried name "Jack OBrien" + score 70 → agent presence ON_CALL.
4. **Disposition close-loop**: BOOKED → call COMPLETED, lead **BOOKED**, agent → WRAP_UP with talk time recorded, **2 recordings (AI + HUMAN legs)** on the lead timeline, `appointment.booked` + `call.completed` webhooks queued.
5. **Analytics**: KPIs (3 dials, 100% connect, 1 booking, avg QA 90) and funnel correct.
6. **Web**: production build clean (12 routes), login page 200.

## 8. Tests (24 passing)

- `packages/shared`: PII redaction (PRD format `04XX XXX 062`), flow-graph validation (dead-ends, missing END, bad edges)
- `apps/api`: calling windows — Tue OK, Sunday blocked, before-9/after-20 blocked, Saturday cap, public holiday blocked, **QLD callable while NSW blocked at the same UTC instant (DST divergence)**, next-window-open incl. holiday skip; phone normalisation (04xx, 61-prefix, dashes/parens, garbage rejection)

## 9. Bugs found & fixed during the session

| Bug | Fix |
|---|---|
| `barisInterruptible` typo in flow schema | renamed `interruptible` |
| Stray `Callback && CallbackSchema.index(...)` expression | removed guard |
| `SimulationRuntime.sendDtmf()` signature mismatch vs orchestrator call | added `digits` param |
| TS2742/TS7056 declaration-emit errors on lean() results | `declaration: false` in api tsconfig (app, not lib) |
| Transfers KPI counted live `state=BRIDGED` → dropped to 0 after disposition | count `agentId` presence instead |
| Persona-mode simulation with no real LLM keys: both conversation sides voiced by the same `SimulationLlm` assistant script → circular 16-turn calls that never qualified (found when UI "Dial (sim)" appeared to do nothing) | added `deterministicPersonaReply()` local fake-customer responder in `SimulationRuntime`; PAL-routed persona only when a real provider key exists (`preferRealLlmPersona`) |

**Debugging note:** `mongosh`'s `findOne(filter, projection, options)` silently ignores `options.sort` — use `find().sort().limit(1)` when inspecting "newest" documents, or you'll diagnose against stale data (cost us two false loops in this session). Also: killing/restarting the API disconnects workspace sockets, which sets agents OFFLINE server-side while their UI still shows AVAILABLE — refresh the workspace tab after API restarts.

## 13. Post-review upgrade: real provider credentials + flow/prompt editor

Nithin's review flagged two gaps: (a) the Providers page assumed every provider takes one API key, (b) flows had no way to author prompts or see what reaches the model. Both rebuilt:

**PAL credentials (per-provider schemas):**
- `CredentialField[]` schema on every adapter (`types.ts`): ElevenLabs/Deepgram/Anthropic/Gemini = `apiKey`; OpenAI GPT/Whisper = `apiKey + baseUrl` (Azure OpenAI / self-hosted); Azure Speech = `apiKey + region`; self-hosted LLM = `baseUrl + model + apiKey?`
- New adapters: Google Cloud TTS, Azure Speech STT, Self-hosted OpenAI-compatible LLM
- Vault now encrypts a JSON credential **bundle** per provider (AES-256-GCM), with read-time migration of old single-string records; adapters receive `ProviderCredentials` objects
- `GET /providers` returns full registry (schemas, models, languages, params, configured flags) + resolved fallback chains per capability and per LLM role; `PUT /providers/chains` edits chains (validated, audited); `GET /providers/:id/voices` = live voice picker
- Providers page rebuilt: schema-driven credential forms, configured badges, reorderable chains (▲▼) with per-hop model selection, LLM role tabs, no-creds warnings

**Flow editor + prompt transparency:**
- Prompt composition extracted to pure `engine/prompt.ts` (`composeSystemPrompt`, `ENVELOPE_CONTRACT`) — shared by the live engine and the preview endpoint so the preview cannot drift from reality
- Fixed a real defect while extracting: the system prompt was built once per node entry; now **rebuilt every turn** so the ALREADY-ANSWERED list includes facts captured mid-call (mechanical AI-03 enforcement)
- `POST /flows/prompt-preview` returns the exact composed system prompt, the rolling message-assembly example, the envelope contract, and engine notes
- New `/flows/[id]` editor page: node list + per-type editors (AI prompt/exit intents/capture vars/max turns/per-node LLM override; SPEAK text + mandatory toggle; TRANSFER strategy/window/whisper; LISTEN_CAPTURE; END outcome), edges viewer, validate / save-draft / publish, and the "what the model actually receives" preview panel

Full explanation of the prompting pipeline: see `claude-dev/prompting-architecture.md`.

## 14. Interactive test-drive (real-conversation simulation)

Nithin's review: "analyse how a real-life conversation happens and then how we simulate this based on the responses" — scripted reply lists can't capture an unpredictable customer. Replaced with a **live test-drive**:

- `flows/sim-session.service.ts`: `InteractiveRuntime` implements `CallRuntime` with `listen()` suspended on a promise until the admin's typed reply arrives; sessions are in-memory, tenant-scoped, 30-min TTL. The REAL `FlowExecutorService` drives the session — nothing mocked but the phone line.
- Endpoints: `POST /flows/versions/:id/test-drive` (starts; returns AI's opening lines), `POST /flows/test-drive/:sid/reply`, `POST /flows/test-drive/:sid/end`.
- Flow editor right panel now tabs **Live test-drive** (chat bubbles, live score/facts/objections/compliance/summary, auto-saves dirty draft before starting) and **Prompt preview**.
- Fixed: flow editor showed infinite "Loading…" for freshly created flows with zero versions — now seeds a starter template graph (AMD → mandatory disclosure → AI qualify → transfer → fallback → ends) marked unsaved.
- Verified via API: AMD → disclosure → 4 customer turns → score 0→40→60→70 → auto transfer → `TRANSFERRED`.

(Parallel session concurrently added agent-insights: `AgentActivity` schema + presence session logging + `/insights`, `/team` pages — not this session's work, left intact.)

## 15. Prompt → workflow generation with toggleable default steps

Modeled on ElevenLabs' agent workflow builder, per Nithin's request: describe a campaign in plain language → get a complete, saved, editable flow.

- `flows/flow-generator.service.ts`: **structure is deterministic** (AMD branch → optional default steps → mandatory disclosure → AI qualify → transfer → fallback → typed ends, with canvas positions) so generated flows always validate and execute; **content is LLM-written** (conversation prompt, disclosure, voicemail drop, fallback/goodbye lines, capture variables) from the description via the PAL conversation chain, with a template fallback when no LLM key is configured (`contentSource: llm|template` returned).
- **Two default call-handling steps, on by default, each toggleable at generation and editable/deletable as ordinary nodes afterwards:**
  - *Voicemail drop* (TEL-05): AMD=VOICEMAIL → SPEAK drop message → END(VOICEMAIL_DROPPED)
  - *IVR keypress* (TEL-06): AMD=IVR → SEND_DTMF("1", loop-guarded) → AMD re-check → HUMAN continues to disclosure, else end
- `POST /flows/generate` creates the flow + draft version and returns it; flows page has a "✨ Generate a flow from a prompt" card with the two toggles, redirecting into the editor.
- Test-drive realism: `InteractiveRuntime.amdClassify` returns HUMAN on the re-check after a DTMF keypress, mirroring a real "press 1 to connect".
- Verified: generation with both toggles (13 nodes), IVR-off variant omits the keypress nodes; test-drive through the voicemail path ends `VOICEMAIL_DROPPED`; through the IVR path: `IVR → DTMF 1 → re-check HUMAN → disclosure → conversation with live scoring`.

## 16. UX cleanup: leads↔campaigns connected, presence made unambiguous

Nithin flagged: Network Error in the web app, leads/campaigns feeling disconnected and cluttered, and agent online status unclear.

- **Network Error root cause**: two dev API instances raced for :4000 (`EADDRINUSE`), then both died — nothing listening. Killed strays, single clean restart. (Recurring hazard with parallel sessions — always `pkill -f ts-node-dev` + verify `lsof -ti :4000` before `pnpm dev`.)
- **Leads ↔ campaigns**: `POST /leads/import` now accepts `campaignId` (preferred) — the campaign's active list is found or auto-created (`"{campaign} — leads"`); `listId` still works for advanced use. Leads page rebuilt campaign-first: campaign selector + link to the campaign hub, collapsed import panel that always targets the selected campaign, state-count chips doubling as filters, next-attempt column, empty-state hint.
- **Campaign detail as hub**: header shows pack, lead count, **available-agent count** and live channel count; activate/pause inline; live team strip with presence dots; links to Manage leads. Auto-refreshes every 10s.
- **Presence clarity**: new `GET /workspace/me` (own server-truth presence) and `GET /workspace/team` (roster with presence/idle/talk-time). Workspace page: syncs presence from the server on load (never trusts stale local state — the earlier restart-desync bug class is gone), pulsing status banner ("You are Available — you will receive warm-transfer offers"), live Team panel driven by `presence.updated` socket events + 15s poll fallback.

## 10. Deliberately deferred (fast-follow / external deps)

- **SIP media driver** — blocked on carrier answers (PRD §7: IP pairing, DTMF method, capacity). `CallRuntime` interface is the seam; drachtio/FreeSWITCH implementation slots in without touching executor/AI/transfer code.
- Streaming voice STT/TTS + barge-in at media layer (REST adapters exist; streaming lands with SIP driver)
- Drag-and-drop flow canvas (builder API is complete: draft/validate/publish/simulate; UI is list-based)
- Supervisor monitor/whisper/barge (XFER-07, Should)
- SMS follow-ups, calendar integrations (PLAT-05/06, Should)
- Billing rollups UI (PLAT-03; cost fields already composed per call)
- Additional country packs (UK/US/IN/NZ — config exercises per CP-04)
- Eval-suite CI gate (PLAT-09; persona simulator exists, wiring into CI pending)

## 11. How to run

```bash
pnpm install
docker compose up -d
cp apps/api/.env.example apps/api/.env
pnpm --filter @cocally/shared build
pnpm --filter @cocally/api seed
pnpm --filter @cocally/api dev     # :4000
pnpm --filter @cocally/web dev     # :3000
```

Demo: sign in as agent1 → Workspace → AVAILABLE. As admin → Campaigns → detail → **Dial (sim)**. Accept the transfer card in the agent window, disposition **Booked**, check Dashboard/Calls.

## 12. Status at end of session

- Full workspace typecheck ✅ · API build ✅ · Web production build ✅ · 24/24 unit tests ✅ · E2E pilot loop verified live ✅
- Nothing committed to git yet (awaiting go-ahead).
