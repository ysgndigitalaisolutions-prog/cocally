# CoCally — Dialer status visibility ("why isn't it dialing?")

> Session log: 19 July 2026. Follow-up to [`2026-07-19-dialer-start-chain.md`](./2026-07-19-dialer-start-chain.md): an ACTIVE campaign that sits idle looked broken. Now it explains itself, including when it resumes.

## Backend

**`telephony/dialer.service.ts`** — refactored so the gate logic has one home:

- Extracted `assessCapacity(campaign)` → `CapacityVerdict` (either `{blocked, detail, resumesAt}` or `{capacity}`). Both the live `tick()` and the new read-only status path call it, so the UI can't drift from what actually gates dialing.
- Extracted `dialableFilter(campaignId)` (state dialable + due), shared by the dial loop's atomic lock query and the status count.
- New `describeStatus(campaign)` → `DialStatus`: campaign-level gates from `assessCapacity`, then the per-lead gates — nothing due (`NO_DIALABLE_LEADS`, resumes at the soonest `nextAttemptAt`) and legal hours (`OUTSIDE_CALLING_WINDOW`, resumes at the soonest `nextWindowOpen` across the due leads' distinct timezones). Carries a `metrics` block (dials today / budget, live / channel cap, available agents, leads ready).
- New `statusForTenant(tenantId)` for the list view.
- Reasons: `CAMPAIGN_NOT_ACTIVE`, `TENANT_PAUSED`, `NO_FLOW_VERSION`, `DAILY_BUDGET_REACHED`, `TENANT_QUOTA_REACHED`, `AT_CONCURRENCY_CAP`, `NO_AGENTS_AVAILABLE`, `AT_PACING_CAP`, `NO_DIALABLE_LEADS`, `OUTSIDE_CALLING_WINDOW`.
- `resumesAtTimezone` is returned alongside `resumesAt` so the UI can render the lead-local time *and* the viewer's — the first cut showed "Australia/Melbourne … 4:30 AM" (viewer's zone) which was exactly the confusion being fixed.

**`telephony/dialer.controller.ts`** (new) — `GET /dialer/status` (all campaigns in tenant) and `GET /dialer/status/:campaignId`, readable by all floor roles.

Behaviour change worth noting: the tick now also short-circuits on `NO_FLOW_VERSION`. Previously it locked leads and let `placeCall` warn-and-return, churning locks for nothing.

## Frontend

**`components/DialerStatus.tsx`** (new) — `DialerStatusBody` (compact: coloured dot + Dialing/Waiting/Idle, the reason in plain English, and a resume line) and `DialerStatusCard` (self-fetching, adds the metrics line). Polls every 10 s; a 30 s local tick keeps the countdown honest between fetches. "Waiting" (amber) = clears on its own; "Idle" (grey) = needs a human.

- **Campaigns list** — new *Dialer* column, one poll of `/dialer/status` for the whole table. (Dropped the Transcription column to keep the row readable.)
- **Campaign detail** — `DialerStatusCard` under the header, with metrics.

Renders as: `▸ Resumes Mon, Jul 20, 9:00 AM Melbourne time (Mon, Jul 20, 4:30 AM yours) · in 4h 43m`

## Verification (live)

- API + web typecheck clean; `next build` 14 routes; 14/14 API unit tests pass.
- `GET /dialer/status` with all agents offline → `NO_AGENTS_AVAILABLE` on the ACTIVE campaign, `CAMPAIGN_NOT_ACTIVE` on the DRAFT one.
- Set agent1 AVAILABLE → flips to `OUTSIDE_CALLING_WINDOW`, `resumesAt` 2026-07-19T23:00:00Z = 9:00 am Mon 20 Jul Melbourne, tz `Australia/Melbourne`. Confirms the two gates found in the previous session, in order.
- Headless-Chrome screenshots of both pages confirm the rendering above.
- agent1 restored to OFFLINE afterwards (leaving it AVAILABLE would have started a real 137-lead auto-dial at 9 am Melbourne).

## Open question raised this session: manual / human dialing

Nithin asked why a human can't also dial. Findings, not yet acted on:

- A manual trigger already exists — `POST /calls/dev-dial` (ADMIN/SUPERVISOR, wired to a button on the campaign detail page). But it calls `orchestrator.placeCall()`, i.e. it starts an **AI** call early; it does not put a human on the line. It also bypasses every compliance gate (calling window, suppression, budget) — fine as a dev tool, **not safe to expose as a product feature as-is**.
- True human dialing is blocked architecturally, not by a missing button: `config.ts` accepts `TELEPHONY_DRIVER=SIP`, but the only `CallRuntime` implementations are `SimulationRuntime` and the test-drive `InteractiveRuntime`. There is no carrier/audio path. An AI leg can be faked with text; a human's cannot.
- So preview/manual dial needs the SIP runtime first (see [`2026-07-19-live-call-build-plan.md`](./2026-07-19-live-call-build-plan.md)). When built, the design should reuse `assessCapacity`'s *legal* gates (kill switch, calling window, suppression) while skipping the *operational* ones (pacing exists to protect transfers; an agent dialing manually is already present).
