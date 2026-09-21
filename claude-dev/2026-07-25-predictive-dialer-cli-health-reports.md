# Predictive dialer, CLI health/quarantine, CSV reports

**Date:** 2026-07-25
**Goal:** close the remaining ViciDial-parity gaps that don't depend on the carrier/LiveKit wiring
(deferred per user request), sized for a 10-30 concurrent-operator BPO floor. Grounded in ViciDial's
actual "adaptive" dialing algorithm and the FCC/TCPA abandoned-call rule (researched — see below).

## Why this, now

The prior session's gap analysis (`2026-07-23-progress-and-next-steps.md`) identified that CoCally's
existing "auto-dialer" (`DialerService`) always fronts calls with the AI, then warm-transfers. That is
**not** what a human-dialer BPO's 20k/month manual-dial volume actually needs replaced — ViciDial's
core value for that workload is **predictive/ratio dialing straight to a human agent**, with no AI leg
at all. That was a genuine missing feature, not just an unwired one, so it's the centerpiece of this
session.

## What was researched

- **ViciDial's "adaptive" algorithm**: not literally predictive — it recalculates a dial ratio
  (lines per logged-in agent) roughly every 15s off drop rate, agent availability, and connect rate
  (`AST_VDadapt.pl`). `ADAPT_HARD_LIMIT` auto-lowers the ratio toward a floor whenever abandonment
  approaches the configured cap. [ViciDial predictive dialing algorithm](https://vicidial.org/VICIDIALforum/viewtopic.php?t=97), [VICIdial auto-dial level tuning](https://vicistack.com/blog/vicidial-auto-dial-level-tuning/)
- **FCC/TCPA abandoned-call rule**: ≤3% of calls answered by a person may be abandoned, calculated
  **per campaign** over a rolling 30-day window; a call is "abandoned" if not connected to a rep
  within **2 seconds** of the greeting. [FCC 12-21](https://apps.fcc.gov/edocs_public/attachmatch/FCC-12-21A1.pdf), [Call Abandon Rate: the FCC 3% limit](https://smartdialtech.com/articles/call-abandon-rate-fcc-3-percent-guide)

CoCally's implementation mirrors both: a 15s-throttled ratio governor with a hard floor/ceiling, and a
distinct `ABANDONED` outcome tracked separately from `NO_ANSWER` so the compliance math is never
polluted by ordinary no-answers.

## What was built

### 1. Predictive (ratio/adaptive) dialer for the human-agent floor — the centerpiece

- **`packages/shared`**: `ABANDONED` added to `CALL_OUTCOMES`; new `PredictiveDialingConfig` and
  `PredictiveBridgeCard` types; new socket events `predictive.call.bridged` / `predictive.call.ended`.
- **Schemas**: `Campaign.predictiveDialing` (enabled, method, ratio, min/max ratio, max abandon %,
  abandon timeout). `Call.predictive: boolean`. `ComplianceEvent` gained `ABANDONED_CALL_NOTICE`.
- **`predictive-dialer.service.ts`** (new): ticks every 5s over campaigns with predictive dialing
  enabled. Per lead: locks it, checks the legal calling window + suppression stack (same gates as
  `DialerService`), selects a CLI, AMD-classifies (via the existing `SimulationRuntime` — same seam
  the SIP runtime will slot into later). A human answer goes straight to `connectHuman()`: one
  best-eligible free agent is reserved and bridged **immediately**, no offer/countdown card — unlike
  `TransfersService`'s AI-warm-transfer cascade, the customer is already live, so every extra second
  is abandon-rate risk. If nobody is free, the call is `ABANDONED` (logged as a compliance event, fed
  into a fast 5-minute retry rather than the generic no-answer matrix). `adjustRatio()` is the
  governor described above, throttled to ~15s.
- **`DialerService`** gets a new gate: `PREDICTIVE_MODE_ACTIVE` — a campaign is AI-fronted or
  human-predictive, never both, so the two lock-and-place loops can't race the same lead pool.
- **`LeadsService.applyOutcome`**: new `ABANDONED` branch — the lead WAS reached (state → CONTACTED),
  just not staffed in time, so it retries in 5 minutes rather than exhausting like other misses.
- Endpoints: `GET /predictive-dialer/status[/:campaignId]` (live ratio, abandon rate, eligible/free
  agent counts). Config itself rides the existing generic `PATCH /campaigns/:id` (added
  `predictiveDialing` + `cliPool` to the editable whitelist).
- **Frontend**: campaign detail page gets a "Predictive dialing" panel (enable toggle, method, ratio
  bounds, abandon cap, live status card). Workspace page listens for `predictive.call.bridged` and
  shows an instant screen-pop (no accept step) — reuses the existing `/calls/:id/briefing`,
  `/calls/:id/agent-token`, and `/calls/:id/disposition` endpoints untouched, since none of them were
  AI-leg-specific to begin with.

**Explicitly stubbed for later (carrier/LiveKit deferred per this session's scope):** `placeCall()`
does AMD-classify via simulation but never calls `livekit.dialOut()` — same intentional gap as
`ManualDialService.dial()`/`connect()` from the prior session. Wiring it in is a few lines once the
carrier trunk is live; the compliance/pacing/bridging logic above does not change.

### 2. CLI (caller-ID) health, auto-quarantine, audited reinstate

Progress doc flagged this as **"highest business value"** — a carrier-labelled DID gets >95% of calls
unanswered, no forced remediation timeline.

- Two distinct mechanisms, previously conflated into one same-day heuristic:
  - `RESTING` (unchanged): same-day circuit breaker in `recordDial()`, auto-wakes after 24h.
  - `QUARANTINED` (new): `recomputeHealth()` runs every 15 min, aggregates each number's real 7-day
    answer rate from the `Call` collection (min 20-dial sample), and quarantines below an 8% rate.
    Does **not** auto-wake — requires `reinstate()` with a reason, always audit-logged
    (`AuditService`). Manual `quarantine()` also exposed for a supervisor acting on a carrier phone
    call, same audit trail.
- New `CliController`: `GET/POST /cli`, `POST /cli/:id/reinstate`, `POST /cli/:id/quarantine` — there
  was previously **no HTTP endpoint at all** for CLI management, only unused service methods.
- New `/cli-numbers` admin page: pool table with status/today's rate/7-day rate/quarantine reason,
  add-number form, reinstate/quarantine actions with a required reason field.
- No email/webhook carrier alerting wired (no SMTP/webhook target configured) — the dashboard + audit
  log is the notification of record for now; noted as a fast-follow, not silently dropped.

### 3. CSV report export

Progress doc: **"no report export anywhere — a hard requirement for BPO client reporting."**

- `common/csv.ts`: small RFC-4180 CSV writer (quoting, BOM for Excel).
- New `ReportsModule`/`ReportsService`/`ReportsController`: `GET /reports/{calls,leads,campaign-summary}.csv`,
  filterable by campaign + date range, modelled on `analytics.service.ts`'s existing aggregation
  patterns (dials, connects, abandon rate, bookings, AHT, QA score).
- New `/reports` page — downloads via `api.get(..., {responseType:'blob'})` + a Blob URL, since the
  API uses bearer-token auth (a plain `<a href>` can't carry the JWT).

## Verification

- `tsc --noEmit` clean across `packages/shared`, `apps/api`, `apps/web`.
- Full `tsc -p tsconfig.build.json` (API) and `next build` (web, all 18 routes incl. the 2 new pages)
  both succeed.
- Existing test suite (14 tests) still passes.
- **Not tested against real concurrent load or a live call** — this is business logic + schema +
  endpoints + UI, verified by type-correctness and build success, not integration-tested. The
  predictive dialer's bridging path (presence reserve/release, disposition, talk-time) reuses
  `TransfersService`/`calls.controller.ts` code paths that are already exercised by the AI-transfer
  flow, which is the strongest evidence of correctness available without a live floor to test against.

## Explicitly deferred (not in this pass)

- Actual carrier dial-out for predictive/AI-fronted calls (LiveKit `dialOut()` wiring) — per this
  session's scope.
- Carrier email/webhook alerting on CLI quarantine.
- Inbound/ACD, supervisor listen/whisper/barge, real call recording — all still LiveKit-dependent,
  unchanged from the prior session's list.
- DNC registry wash (real ACMA client) — no government API access to build against.
- Redis/multi-instance — re-assessed this session: **not actually needed at 10-30 operators** on a
  single Node/Mongo instance; the existing in-process locks (atomic `findOneAndUpdate`) are correct
  under concurrency, just not multi-instance-safe. This is a scaling concern for hundreds of agents or
  multi-region, not the stated 10-30.
- Automated tests for the new concurrency-sensitive paths (lead locking races between AI/predictive/
  manual dialers, agent reserve/release races) — the highest-value next addition once there's time to
  spin up `mongodb-memory-server`-backed integration tests, per the prior session's P2 #16.
