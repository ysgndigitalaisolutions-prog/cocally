# CoCally — Call filters, campaign team & insights, presence timeout

> Session log: 20 July 2026. Batch of requests from Nithin: call filtering, admin visibility of transfer offers vs. acceptances, a credentials file, monthly agent metrics, campaign team assignment, campaign-level insights, and how agent session timeouts are handled.

## 1. Presence timeout — a real gap, now fixed

**There was no timeout of any kind.** No heartbeat, no `lastSeenAt`, no sweep. An agent who set themselves AVAILABLE and closed their laptop stayed AVAILABLE indefinitely: the dialer kept counting them for pacing (`freeAgents × dialsPerAvailableAgent`) and every transfer offered to them burned the full accept window before cascading. JWT expiry (`JWT_EXPIRES_IN=8h`) is unrelated — the token dying never touched presence.

- `user.schema.ts` — new `lastSeenAt`.
- `config.ts` — `PRESENCE_TIMEOUT_MINUTES` (default 5).
- `presence.service.ts` — `heartbeat()` (touches `lastSeenAt` only; deliberately cannot revive a swept presence, so a backgrounded tab can't put someone back on the floor); `@Interval(60_000) sweepStalePresence()` signs out staffed agents past the cutoff via `setPresence(..., 'OFFLINE')` so the AgentActivity segment closes properly and adherence stays accurate.
- Sweepable states: `AVAILABLE`, `WRAP_UP`, `BREAK`. **Not** `ON_CALL`/`RESERVED` — those are owned by an in-flight call or transfer cascade with their own timeouts.
- `POST /workspace/heartbeat`; client beats every 30 s from the authenticated layout (`(app)/layout.tsx`) so it covers every page, not just Workspace.

Verified live: backdated `lastSeenAt` 20 min → agent flipped to OFFLINE within 25 s of the next sweep. Then backdated again while heartbeating every 10 s → stayed AVAILABLE across 80 s (past two sweep cycles).

## 2. Calls page filters

- `GET /calls` gained `agentId` (incl. `unassigned` = AI-only calls that never bridged), `outcome`, `disposition`, `amdClass`, `from`, `to`. A bare `to=YYYY-MM-DD` is widened to end-of-day, otherwise "19 Jul → 19 Jul" would return nothing. Response now includes `agentName`, resolved via one batched user lookup.
- `/calls` UI: campaign / agent / outcome / disposition / answered-by selects, from–to dates, Today · 7 days · 30 days quick ranges, Clear filters, active-filter count, and an Agent column ("AI only" when never bridged).
- **Filter options come from `@cocally/shared` enums** (`CALL_OUTCOMES`, `DISPOSITIONS`, `AMD_CLASSES`). First cut hardcoded guesses (`QUALIFIED`, `NURTURE`, `DNC`) that matched nothing in the data — caught because `outcome=QUALIFIED` returned 0 rows while the real values are `ANSWERED_HUMAN`, `CALLBACK_REQUESTED`, etc.
- `GET /users` widened to QA so QA users can populate the agent filter.

## 3. Transfer offers vs. acceptances (already existed)

`agent-insights.service.ts` already aggregated `offered / accepted / declined / timedOut / acceptanceRate / avgAcceptSeconds`, shown per-agent in `AgentInsightsView` and on the team roster. Only gap: the roster showed offers + acceptance % but not the raw accepted count. Added an **Accepted** column and renamed **Offers → Calls sent**.

## 4. Month-by-month agent metrics

Backend already supported `granularity=month`. Added a **By month** range preset (rolling 12 months, `granularity: 'month'`) to `RANGE_PRESETS` — flows through My insights, Team insights and member drill-downs, which all share `rangeForPreset`.

## 5. Campaign team assignment (new)

Routing eligibility was already skill-based (`user.skills` contains the campaign id, **or** the agent has no skills at all → eligible for everything), but there was no UI.

- `GET /campaigns/:id/team` → per-agent `{assigned, unrestricted, presence}`; `POST /campaigns/:id/team {agentIds}` sets it atomically with one audit record (`campaign.team.set`).
- `CampaignTeamAssignment.tsx` on the campaign page. It surfaces the fallback explicitly — with nobody assigned, transfers go to every unrestricted agent, and agents marked "any" keep receiving this campaign until they're assigned somewhere. That behaviour is easy to misread as a bug.

## 6. Campaign-level insights (new UI)

`/analytics/{kpis,funnel,objections,outcomes,heatmap}` already accepted `campaignId`; nothing consumed it per-campaign. `CampaignInsights.tsx` adds a Today/7d/30d/All-time KPI band (dials, connect rate, transfers, bookings, cost/booking, avg QA + AHT), lead funnel bars and an objections table to the campaign page.

Bug caught in review: the objections table rendered `NaN%` — the component assumed a `recovered` field, but the API returns `rebuttalWinRate`.

## 7. Credentials

[`LOGINS.md`](./LOGINS.md) — short demo logins (`admin`/`agent`, `1234`, skipped when `NODE_ENV=production`), the six full pilot accounts (`CoCally!Pilot2026`), what each role can see, and the pilot-loop walkthrough.

## Verification

- API + web typecheck clean, `next build` 14 routes, 14/14 API tests pass.
- Live: team assignment round-tripped (assign agent1 → `assigned=true, unrestricted=false` → cleared back); `agentId` filter returned only Alex Agent's calls; `agentId=unassigned` returned AI-only rows; `from`/`to` day filter correct; `disposition=BOOKED` → 52 rows; campaign KPIs `dials 644 / connect 46% / transfers 108 / bookings 51 / $2.32 per booking / QA 82.4`.
- Screenshots of `/calls` and the campaign page confirm rendering.
- All test state restored: agent1 back to OFFLINE, campaign team cleared to empty. Note the calling window is now **open** (it is past 09:00 Melbourne), so leaving an agent AVAILABLE will start real auto-dialing — that is why presence was reset.
