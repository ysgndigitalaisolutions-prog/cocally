# CoCally — progress & next steps

**Date:** 2026-07-23
**Purpose:** where the platform actually stands, and what has to happen before a live BPO can use it.

---

## 1. The operating-model decision (important context)

The original design docs describe CoCally as **"the fronter is an AI"** — the AI dials everything and the
humans *only* receive warm transfers; they never dial. The business has since moved to a
**human-dialer BPO**: ~15 callers actively dialing, with the AI fronting a portion of the volume.

These are different products with different requirements. Work from 22–23 July re-prioritised around
the human-dialer model. **The design docs have not been updated to match** — worth reconciling, or the
next person to read them will build the wrong thing.

---

## 2. Where we actually stand

### ✅ Production-shaped: the CRM / workflow layer

| Area | Status |
|---|---|
| Lead import at scale | 100k rows in **8.9s** (was ~178k serialised round-trips + a 100 kB body cap) |
| Lead browse | Cursor pagination + search over a 100k book (17 ms first page, 10 ms deep page) |
| **Lead ownership & assignment** | Pull-based, atomic; **verified zero collision** across 20 concurrent fetches |
| Callbacks | Real tasks, agent worklist, overdue supervisor report |
| Appointments | Created on BOOKED; double-booking rejected (409) |
| Notes / edit / tags / recycling | Endpoints + lead-detail drawer |
| Dispositions | Close the loop into retry matrix → lead state → analytics |
| **Compliance** | DNC + suppression stack, per-timezone calling windows, opt-out, kill switch — **genuinely enforced** |
| Analytics | KPIs, agent occupancy/AHT, **abandon rate**, list health; cached (273 ms → 8 ms) |
| Presence / transfer cascade | Reservation, cascade, accept-window, briefing card |
| RBAC / audit | Append-only audit log |

### ❌ Not real yet: the telephony media plane

| Capability | Status |
|---|---|
| **Manual dial → real phone call** | ❌ Creates the DB record only; never calls `livekit.dialOut()` |
| CLI pool → the wire | ❌ `dialOut()` sends no `from` number; geo-matching/rotation is disconnected |
| AMD (machine detection) | ❌ Returns a pre-seeded value |
| Call recording | ❌ Writes a `.txt` transcript, not audio |
| AI→human **audio** bridge | ❌ Orchestration is excellent; no media moves |
| Supervisor listen / whisper / barge | ❌ Does not exist |
| Inbound / ACD | ❌ Nothing answers a callback to our DID |

AI dial-out to a real phone **does** work (`dialOut()` → `createSipParticipant` over the Twilio
Elastic SIP trunk), which is what the current demo exercises.

### ⚠️ Structural limits

- **Single API instance only.** Concurrency counts, transfer offers, RR cursor, socket registry, CLI
  rotation and the analytics cache are all in-process. Correct today (the dialer requires a
  singleton) but going multi-instance means Redis for all of them together.
- **DNC registry wash is a stub** — no ACMA client, no scheduler.
- **No report export** anywhere — a hard requirement for BPO client reporting.
- **No human QA** — auto-QA is an uncalibrated deterministic rubric.
- **Test coverage is 2 files / 14 tests.** The new services are verified end-to-end by hand only.

---

## 3. Next steps, in priority order

### P0 — before any real calling

1. **Manual dial places a real call.**
   - Select CLI from the pool → `ensureRoom()` → mint agent token (browser joins **first**) →
     `dialOut()` into the same room. Add ringback while the SIP leg connects.
2. **Thread the CLI into the SIP `From`.** Until this lands, every call presents the trunk default and
   the entire geo-matching / rotation engine is decorative.
3. **Carrier status-callback + hung-call reconciliation.** Real calls need a source of truth for what
   happened on the wire. (A hung-call sweeper now exists; carrier callbacks do not.)
4. **Recording → GCS** via LiveKit egress, replacing the `.txt` transcript.

### P0 — number reputation (highest business value)

Once a DID is labelled, **>95% of "Spam Likely" calls go unanswered**, and remediation takes days to
weeks with no carrier obligation to remove the label. STIR/SHAKEN does **not** prevent labelling.

5. **Real answer-rate health** — rolling 7-day window with a minimum sample size (today's counters are
   too noisy). `recordDial` was hardcoded `answered: true`, so the existing heuristic could never
   fire; that is fixed, but the window is still naive.
6. **Auto-quarantine** on answer-rate collapse — `selectCli` already filters to `ACTIVE`, so
   quarantine excludes it automatically.
7. **Carrier alerting** — email/webhook to the carrier with the affected DID and evidence
   (dial count, answer-rate trend), plus internal notification.
8. **Manual reinstate with audit** — a number returns to rotation only when someone confirms it is
   cleared. Never dial from a suspect DID until fixed.
9. **CLI pool health dashboard** — per-DID answer rate, so decay is visible before the carrier calls.

> Guardrail: keep any single DID under ~150–200 dials/day.

### P1 — call screening ("press a key to connect")

Common in AU via **Telstra Call Guardian**: unknown callers must **say their name and press `#`**
before the phone rings. Note it needs *audio plus* a keypress, so DTMF alone will not pass it.

**A distinction the platform must make:**

| Type | Example | Auto-respond? |
|---|---|---|
| Business IVR | "Press 3 for accounts" | ✅ What `ivrPolicy` is for |
| Consumer anti-robocall challenge | "Say your name and press #" | ⚠️ Exists *specifically* to stop automated calls |

**Recommendation:** detect the challenge and **route to a human agent** who responds legitimately,
rather than auto-defeating it. Auto-defeating means the AI asserts it is human to a control designed
to filter non-humans — under the DNC Register Act and the Reducing Scam Calls Industry Code that is
the behaviour carriers terminate trunks for. **Needs legal sign-off before building either path.**

Technically feasible: `sendDtmf` already exists on the runtime interface (no-op in simulation).
The hard part is *classifying* a screening challenge vs a business IVR.

10. Add a **`SCREENED` outcome** and its own cost bucket, so "connected but never reached a human"
    becomes a visible waste metric rather than hiding inside connect rate.

### P1 — operational hardening

11. **Redis** for shared state (unblocks >1 API instance).
12. **DNC registry wash** — real ACMA client + scheduler. Today every number is either stale-blocked
    or never washed.
13. **Report export** (CSV) for client reporting.
14. **Supervisor live monitoring** — listen / whisper / barge. Cheap once the room genuinely exists.
15. **Inbound / ACD** — a customer returning a missed call currently reaches nothing.

### P2 — quality

16. **Automated tests.** Add `mongodb-memory-server` and cover assignment, scheduling, and the
    suppression guards. A DB-backed test would have caught the DNC opt-out bypass (below) at write
    time instead of hours later.
17. Human QA workflow + rubric calibration.
18. Pre-aggregated analytics rollups (caching + indexes bought headroom, not a permanent fix).
19. Bulk supervisor actions (multi-select distribute / reassign / tag).

---

## 4. Recent defects worth remembering

- **DNC opt-out bypass** *(found and fixed 23 Jul)* — the reopen guard checked `lead.dncListed`, which
  means "on the national register". A direct opt-out writes a `SuppressionEntry` and sets the lead to
  `DNC` **without ever setting that flag**, so a supervisor could move an opted-out person back into
  the dialable pool. `recycle()` had the identical flaw. Both now check for an active `OPT_OUT` entry.
- **`talkTimeTodaySeconds` never reset** — not just a wrong dashboard number: it is the sort key for
  `LEAST_TALK_TIME` routing, so it permanently biased work toward whoever joined the floor most
  recently. Now reset at midnight.
- **`recordDial(cli, true)` hardcoded** — CLI spam-detection could never fire.
- **Three scheduled jobs had zero callers** (`wakeRested`, `resetDailyCounters`, `purgeExpired`) — one
  had a docstring referencing an ops scheduler that did not exist.

## 5. Housekeeping

- `claude-dev/LOGINS.md` contains a **live Deepgram API key** in a tracked file — rotate it and move
  it to `.env` / Secret Manager.
- Docs claim "24/24 unit tests"; the suite is **2 files / 14 tests**.
- Dev database was reset on 23 Jul: synthetic load-test leads removed, **100 realistic leads** seeded
  on *Aurora Solar — VIC Pilot* (`source: "Aurora Q3 list"`). Original 246 seed leads and 752 calls
  preserved. The 100k benchmark is no longer reproducible against this DB — re-run against a
  throwaway campaign if needed.
