# CRM hardening for a live human-dialer BPO (15 seats, 100k+ calls)

**Date:** 2026-07-22
**Scope:** CRM / lead-management / analytics layer. Telephony media plane (real SIP dial-out, AMD, audio recording, audio bridge) deliberately deferred to a later phase.

---

## Why this session happened

A full CRM-perspective audit was run across four domains (lead management, telephony/dialer,
analytics/monitoring, and product intent). It surfaced a **strategic mismatch** worth recording:

- **The design docs** architect CoCally as *"the fronter is an AI"* — the AI dials everything,
  and the ~10 humans **only receive warm transfers**. They never dial.
- **The actual operating model** is a classic **human-dialer BPO**: ~15 callers actively dialing,
  100k+ calls. The recently-added `manual-dial` module was the first step in that pivot.

These are different products with different blocker lists. This session re-prioritised around the
human-dialer model and closed its blockers.

## The headline finding (still open)

**The entire telephony media layer is simulation.** There is no PSTN origination anywhere:
`placeCall` instantiates `SimulationRuntime`; the `SIP` driver is declared in config but not
implemented; `amdClassify()` returns a pre-seeded class; `captureLeg` writes the *transcript to a
.txt file*, not audio; a "transfer" flips DB state without bridging media. This was consciously
left out of scope — see *Not done* below.

---

## What was fixed

### 1. The 15-agent collision (the biggest human-dialer blocker)

`ManualDialService.queue()` returned **the same score-sorted top-200 leads to every agent**. With
15 callers on that screen, everyone raced for the same records and 14 lost every click.

Introduced **lead ownership** as a first-class concept, deliberately distinct from the two existing
near-miss fields:

| Field | Meaning | Lifetime |
|---|---|---|
| `manualClaimedBy` | transient lock for one call | minutes |
| `preferredAgentId` | callback stickiness | per promise |
| **`ownerId`** *(new)* | **who this lead belongs to** | until worked or reclaimed |

- New `AssignmentService` with **pull-based** top-up (`topUp`), not supervisor push. An agent draws
  work only when their queue runs low, so leads aren't stranded in the queue of someone who logged
  off, and a fast closer isn't throttled by an even split.
- Each draw is an atomic `findOneAndUpdate` guarded on `ownerId: null` — two agents topping up
  simultaneously can never take the same lead; the loser just draws the next one.
- `reclaimStale` (every 15 min) returns leads held >12h to the pool, so an agent who logs off
  holding 25 leads doesn't slowly starve the floor.
- Ownership enforced server-side in `loadClaimable` too, so a stale browser tab can't dial
  another agent's lead.
- Terminal dispositions (BOOKED/DNC/EXHAUSTED/NURTURE) release ownership back to the pool.

**Verified:** 20 concurrent worklist fetches across 2 agents → each stable at exactly 25 leads,
**zero over-assignment, zero cross-agent overlap.**

### 2. CSV import could not ingest a real list

Two independent blockers:
- One `findOne` + one `create` **per row** — ~200k serialised round-trips for a 100k list.
- Express's default **100 kB body limit** (~2,000 leads) → every real import died on a bare `413`.

Rewrote as two passes: normalise entirely in memory, then batched dedup (`$in`) + unordered
`insertMany` at 1,000 rows/batch — ~2 round-trips per 1,000 rows. Raised the body limit to 64 MB.
Also stopped storing the whole raw CSV row in `custom` (it duplicated every mapped field on every
document — real money at 100k leads); only genuinely unmapped columns are kept now.

**Verified end-to-end against the live API:**

| Test | Result |
|---|---|
| 5,000 rows | 0.55s — 4,407 accepted |
| Re-import same file | 0 accepted, **4,407 correctly deduped** |
| **100,000 rows (5.9 MB)** | **8.9s — 88,994 accepted** |

### 3. The booking system was orphaned dead code

`Appointment` and `Callback` schemas existed, were well-designed, and were **never registered in
any module or written to**. A BOOKED disposition only flipped lead state and fired a webhook — the
booking existed nowhere a client could be shown or billed for. A CALLBACK only set
`lead.nextAttemptAt`, so agents had no worklist of what they'd promised.

New `SchedulingService` wires both, and the disposition handler now creates real records:
- **Callbacks** — real tasks with an agent worklist (`/leads/callbacks/mine`), a supervisor
  overdue-exception report (`/leads/callbacks/overdue`), past-date validation, supersede-on-repromise,
  and auto-resolution when the lead is dispositioned some other way. A HUMAN callback pins ownership
  to the promising agent — the customer expects that voice back.
- **Appointments** — created on BOOKED, with the existing unique partial index now actually
  protecting a populated collection.

**Verified:** callback created → appears in agent's book → past-dated rejected. Appointment booked →
**second booking of the same slot correctly rejected with 409.**

### 4. Jobs that were defined but never ran

Three well-written methods had **zero callers** — `CliService.wakeRested`,
`CliService.resetDailyCounters` (whose own docstring said *"called by the ops scheduler"*, which did
not exist), and `RecordingsService.purgeExpired`. Silent failures: rested CLI numbers never woke,
daily counters grew unbounded, and the retention promise was never enforced.

New `MaintenanceService` is that missing scheduler, plus:
- **`talkTimeTodaySeconds` daily reset.** This was only ever `$inc`'d, so "today" silently became
  lifetime. Worse than a dashboard bug: it's the sort key for the `LEAST_TALK_TIME` routing
  strategy, so without a reset it **permanently biases work toward whoever joined the floor most
  recently**.
- **Hung-call sweeper.** Live-call bookkeeping is an in-process map, so a crash mid-call left the
  `Call` parked in `IN_CONVERSATION` forever — inflating concurrency counts and holding the agent's
  lead. Leads already had a 10-min lock reclaim; calls had no equivalent.

Also fixed `recordDial(cli, true)` — the answered flag was **hardcoded true**, so the "rest a number
below 5% answer rate" spam heuristic could never fire no matter how badly a number performed.
`placeCall` now returns `{ answered }` and the dialer reports the truth (including on failure).

### 5. Missing CRM surface area

Added: lead edit (`PATCH`), audited manual state override (guarded so a DNC-registered lead can't be
silently reopened), a `LeadNote` collection with add/list, bulk tagging, supervisor bulk reassign,
and **list recycling** — `NURTURE`/`EXHAUSTED` were dead ends, so a list could only ever shrink.
Schema gained `email`, `altPhones`, `source`, `tags`, `ownerId`.

The embedded `timeline` array is now **capped at 300 entries** via a schema pre-save hook, centrally
rather than at ~10 push sites — it was append-only everywhere and would have crept toward the 16 MB
BSON ceiling on heavily-redialled leads.

### 6. Analytics that would not survive 100k calls

Every panel is a live full-collection `$group`, recomputed every 10–15s **per viewing supervisor**.

- Added `allowDiskUse(true)` — a `$group` over 100k+ docs can breach MongoDB's 100 MB aggregation
  limit and fail outright.
- Added a 20s TTL cache. With 15 supervisors polling, this collapses several full scans per second
  into one per window. **Measured: 273ms → 8ms.**
- Aligned indexes to actual query shapes (tenant-wide scans, disposition/outcome filters, agent
  productivity, the hung-call sweep) plus lead-side hot paths that were unindexed
  (`lastContactedAt` frequency-cap, owner worklist, `updatedAt` sort).
- **New `pacing-health`** — abandon rate, the outbound floor's key compliance-adjacent KPI, which
  was measured nowhere. Grounded in real `Transfer` states (`FALLBACK`/`TIMED_OUT` = AI qualified a
  live human with no closer to take them).
- **New `list-health`** — penetration, remaining workable, and `availableNow`/`hopperDry` so a floor
  manager can see before the seats run dry.

> ⚠️ **Live finding: the seeded data shows a 9.85% abandon rate** (13 `FALLBACK` of 132 transfers) —
> roughly 3× the ~3% cap most outbound regimes enforce. Previously invisible. Worth investigating
> against real traffic once the media plane lands.

---

### 7. Frontend — surfacing all of the above

The API work above was invisible to actual users, so the three screens that matter were wired up.

**Manual dial** (the caller's daily screen):
- **Callback book** at the top — the most time-sensitive thing on the page, with overdue items
  badged red and a one-click *Call* straight from the promise.
- **Dispositions that need a date now ask for one.** BOOKED and CALLBACK previously logged with no
  time, which is exactly why bookings created no appointment and callbacks created no task. Both now
  stage a `datetime-local` step (defaulting to +2h for a callback, +24h for a booking) before they
  can be logged.
- Header reframed from "pick a lead" to "your personal worklist" — it now describes ownership
  honestly, since no other caller can see these leads.

**Leads** (supervisor):
- Swapped to the cursor-paginated `/leads/search`, with debounced free-text search and a server-side
  state filter. The old state chips counted **only the loaded page**, which was actively misleading
  on an 89k book; they're replaced by real campaign-wide totals from `list-health`.
- New tiles: total, penetration, workable left, **available now** (turns red on `hopperDry`), and
  exhausted/DNC. Plus an *Assigned worklists* strip showing what each seat is holding.
- Owner and Source columns, and a **Recycle worked-out** action for NURTURE/EXHAUSTED.

**Dashboard** (floor health):
- An exception strip carrying **abandon rate** (red above the 3% guideline), no-closer-available
  count, bridged count, and **overdue callbacks** floor-wide.

**Lead detail drawer** (`components/LeadDrawer.tsx`) — the CRM record behind a row, opened by
clicking any lead. Four tabs: **Details** (inline edit of contact fields, imported custom columns,
plus supervisor-only owner reassign and state move), **Notes** (add/read), **Timeline** (the full
event history newest-first), and **Calls** (per-lead call history).
Added a `leadId` filter to `GET /calls` to support the last one — it's covered by the existing
`{leadId, startedAt}` index. The drawer degrades gracefully for AGENT users, who are not permitted
to list calls: that 403 is caught rather than blanking the drawer.

### 8. A compliance bug found by testing the drawer

Writing the drawer's state-change control exposed a **real defect in the DNC guard added earlier in
this session**. The guard read:

```ts
if (from === 'DNC' && to !== 'DNC') {
  if (lead.dncListed) throw new BadRequestException(...);
}
```

`dncListed` means *"on the national register"*, set by the DNC wash. But a direct opt-out —
`SuppressionService.optOut`, i.e. the customer saying "don't call me again" — writes a
`SuppressionEntry` and flips the lead to `DNC` **without ever setting `dncListed`**. So the guard
silently failed on the most common and most legally sensitive case: a supervisor could move an
opted-out person straight back into the dialable pool. Verified failing, then fixed to check for an
active `OPT_OUT` suppression entry as well as the register flag.

`recycle()` carried the identical flaw (`dncListed: { $ne: true }` as its only protection). It now
excludes `DNC`-state leads outright and subtracts opted-out numbers explicitly. Verified: a bulk
recycle moved 48 leads while correctly leaving the opted-out lead in DNC.

## Verification

- `pnpm typecheck` clean (api **and** web); `pnpm test` 14/14 pass.
- **Nest boots successfully** — full DI graph resolves; all 32 new/existing lead + analytics routes
  map, with specific paths correctly ordered ahead of the `:id` catch-all (no shadowing).
- Live end-to-end against the running API: import at 5k and 100k, dedup, cursor pagination over an
  89k book (17ms first page, 10ms deep page), concurrent worklist assignment, callbacks,
  double-booking rejection, and both new analytics endpoints.
- **Disposition paths driven with the exact payloads the new UI sends:**
  - `BOOKED` + `scheduledFor` + `durationMinutes` → appointment created and linked to the call.
  - `CALLBACK` + `scheduledFor` → lead moved to `CALLBACK`, `nextAttemptAt` set to the promise,
    ownership retained by the promising agent, timeline records `CALLBACK_SCHEDULED` → `DISPOSITION`.
- `/leads`, `/manual-dial`, `/dashboard`, `/workspace`, `/calls`, `/team`, `/insights` all compile
  and serve 200.
- Every endpoint the drawer calls driven live: lead fetch, per-lead call history via the new
  `leadId` filter, note create/list, `PATCH` edit, owner reassign (to an agent and back to the
  pool), audited state move, and the DNC guard both failing and then blocking.
- Two behaviours confirmed incidentally: a `BOOKED` disposition **released ownership back to the
  pool** as designed, and an imported lead stored `custom: ['vendor']` only — confirming the import
  no longer duplicates every mapped column onto every document.
- Incidentally confirmed the **legal calling-window gate works**: at 00:15 local every lead in the
  worklist was correctly non-callable with *"Outside legal calling hours (Australia/Melbourne)"* and
  a resume time, rather than allowing an illegal dial.

## Not done (deliberately deferred)

1. **The whole telephony media plane** — real SIP/Twilio origination, real AMD, audio recording
   (currently a .txt transcript), real audio bridge. Out of scope this session.
2. **Multi-instance safety.** Concurrency counts, transfer offers, the RR cursor, the socket
   registry, CLI rotation and the new analytics cache are all in-process. The API is single-instance
   today (the dialer requires it), so this is *correct but capped* — going multi-instance means
   Redis for all of the above together.
3. **Supervisor live monitoring** (listen/whisper/barge) and a **human QA workflow** — neither
   exists for production calls; auto-QA is an uncalibrated deterministic rubric.
4. **DNC registry wash** is still a stub with no ACMA client and no scheduler.
5. **No CSV/report export** anywhere — a hard requirement for BPO client reporting.
6. **Pre-aggregated rollups.** Caching + indexes + `allowDiskUse` buy real headroom, but the correct
   long-term shape is hourly/daily materialised rollups rather than scanning raw `calls` forever.
7. **Remaining frontend.** Supervisor **bulk** distribute/reassign (multi-select on the list) and
   **bulk tagging** are still API-only — the drawer does one lead at a time. The manual-dial
   "no audio leg" simulation banner still applies.
8. **Test coverage.** The new services are verified end-to-end against a live API but have no
   automated tests; the suite is still the original 2 files / 14 tests. The DNC-guard defect in §8
   is exactly the kind of bug a DB-backed test would have caught at write time — worth adding
   `mongodb-memory-server` and covering assignment, scheduling, and the suppression guards.

## Housekeeping

- `claude-dev/LOGINS.md` contains a **live Deepgram API key** in a tracked file. Should be rotated
  and moved to `.env`/Secret Manager.
- Docs claim "24/24 unit tests"; the suite actually has **2 files / 14 tests**. Coverage of the new
  services is end-to-end only — worth adding DB-backed tests.
