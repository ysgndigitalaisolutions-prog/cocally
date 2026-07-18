# CoCally — Agent & Team Insights (BPO-style)

> Session log: 19 July 2026. Requirements designed "from the shoes of a BPO floor" and implemented end-to-end: per-agent performance insights for human agents, and per-member roster insights for admins/supervisors.

---

## 1. Requirements (designed this session)

### Persona: Human agent ("how is my day going?")

| Req | Requirement |
|---|---|
| AGT-01 | My day at a glance: calls handled, bookings, conversion %, talk time, average handle time, avg QA score, recordings count — for today / 7 days / this month / 30 days |
| AGT-02 | Transfer discipline: offers received, accepted, declined, timed out; acceptance rate; average time-to-accept |
| AGT-03 | Volume timeline: calls + bookings per hour (today) or per day/month (longer ranges) |
| AGT-04 | Activity & occupancy: time available / on-call / wrap-up / break, logged-in total, occupancy % ((on-call + wrap-up) / staffed time) — live, counts the open segment up to now |
| AGT-05 | Outcome mix: my dispositions breakdown |
| AGT-06 | My recent calls: when, duration, disposition, lead score, QA, recordings per call, expandable AI summary (PII-redacted) |

### Persona: Admin / Supervisor ("who performs, who needs coaching, is AI feeding the floor?")

| Req | Requirement |
|---|---|
| ADM-INS-01 | Team roster: one row per member — handled, booked, conversion, talk time, AHT, offers, acceptance rate, avg QA, recordings, occupancy, live presence |
| ADM-INS-02 | Member drill-down: the full agent view (AGT-01..06) for any member |
| ADM-INS-03 | AI-vs-human floor timeline per hour/day/month: AI dials, connects, AI-resolved, human-bridged, bookings — how AI volume converts into floor work |
| ADM-INS-04 | Same range presets + hour/day/month granularity everywhere |
| ADM-INS-05 | RBAC: agents see only `me`; team/member views require ADMIN / SUPERVISOR / QA / OWNER (verified 403 for agents). Summaries served PII-redacted |
| ADM-INS-06 | Presence sessions logged server-side (auditable adherence, not client-inferred) |

## 2. Implementation

### Backend

- **`schemas/agent-activity.schema.ts`** (new) — `AgentActivity`: one doc per contiguous presence state `{tenantId, userId, state, startedAt, endedAt?, durationSeconds?}`; open segment has no `endedAt`. Indexes `{tenantId,userId,startedAt}`, `{userId,endedAt}`.
- **`workspace/presence.service.ts`** — every transition (`setPresence`, `reserve`, `release`, `markOnCall`) now runs through `findOneAndUpdate(new:false)` to learn the previous state + tenant, then `logSegment()`: closes the open segment (pipeline update with `$dateDiff`) and opens one for the new state. OFFLINE closes without opening.
- **`analytics/agent-insights.service.ts`** (new) — aggregations:
  - `memberStats`: calls by `{tenantId, agentId, bridgedAt range}` → handled/booked/talk/AHT/QA; transfer attempts unwound from the cascade history → offered/accepted/declined/timed-out + avg accept speed; activity seconds by state clipped to range (open segments count to *now*); `$dateTrunc` timeline; dispositions; recent 25 calls with `$lookup` recordings count; range-wide recordings count.
  - `teamStats`: same aggregates grouped per agent, merged over the active AGENT roster; plus tenant floor timeline (dials / connects / AI-resolved / human-bridged / booked per bucket) and totals.
- **`analytics/agent-insights.controller.ts`** (new) — `GET /analytics/agents/me` (all floor roles), `GET /analytics/agents/team`, `GET /analytics/agents/:id` (ADMIN/SUPERVISOR/QA/OWNER). Query `from`, `to`, `granularity=hour|day|month` (validated, 400 otherwise; default last 30 days / day).
- **`call.schema.ts`** — new index `{tenantId, agentId, bridgedAt}` for the per-agent scans.

### Frontend

- **`components/AgentInsightsView.tsx`** (new) — shared per-agent view: range presets (Today→hour, 7d/This month/30d→day), 8 KPI tiles, stacked calls/bookings timeline bars, activity split bar + occupancy, transfer-offer counters, dispositions bars, recent-calls table with expandable redacted summary. Auto-refreshes every 15 s.
- **`(app)/insights/page.tsx`** — "My insights" (`target="me"`).
- **`(app)/team/page.tsx`** — team totals, AI-vs-human stacked timeline, member roster table; row click → drill-down.
- **`(app)/team/[id]/page.tsx`** — member drill-down reusing the shared view.
- **Nav** — `My insights` (AGENT/SUPERVISOR/ADMIN/OWNER), `Team insights` (OWNER/ADMIN/SUPERVISOR/QA).

## 3. Bug found & fixed (pre-existing, surfaced by the new insights)

Transfer cascade attempts stayed `PENDING` forever: `attempts` is a Mixed (`[Object]`) array, so mutating `attempt.result`/`resolvedAt` in memory never persisted (`markModified('attempts')` was missing) — acceptance rate always computed 0. Additionally `decline()` wrote a *second* doc instance that the cascade loop's later `save()` overwrote. Fix: `markModified` in the loop, and decline now flags a `declinedOffers` set consumed by the loop instead of double-writing the doc.

## 4. Verification (live)

- Typecheck + prod builds clean (api, web — 14 routes incl. `/insights`, `/team`, `/team/[id]`); 24/24 unit tests still pass.
- E2E script (scratchpad): agent1 AVAILABLE → sim dial → transfer offered → accept via REST → bridged → 10 s talk → disposition BOOKED → presence AVAILABLE → BREAK, then:
  - `/analytics/agents/me`: handled 4, booked 3, conversion 75 %, talk 46 s, AHT 11 s, avg QA 82.5, 7 recordings; transfers accepted 1 (persists post-fix); activity on-call 29 s / break 83 s, occupancy 85 %, live open-segment counting.
  - `/analytics/agents/team`: roster rows for both agents (idle agent all-zero), floor timeline `dials 12 / connects 12 / aiResolved 9 / humanBridged 3 / booked 2`.
  - `/analytics/agents/:id` with `granularity=hour`: correct hourly buckets.
  - RBAC: team endpoint as AGENT → 403; `granularity=week` → 400.

## 5. Notes / deferred

- `PENDING` shows in dispositions for bridged-but-never-dispositioned calls — useful signal (wrap-up leakage), kept intentionally.
- Deferred: CSV export of team stats, per-campaign filter on the insights endpoints, adherence targets/alerts (needs shift schedules), talk-time reset job for `talkTimeTodaySeconds` at local midnight.
