# CoCally — Manual (agent-driven) dial

> Session log: 22 July 2026. Nithin asked for ViciDial-style manual dialing: a human agent picks a lead and calls it, and the automatic AI dialer must NOT dial those leads (no double-dialing).

## Scope & honest boundary

The **workflow, lead-exclusion, compliance gating, and disposition loop are real and SIP-ready.** The **voice leg is still simulated** — with `TELEPHONY_DRIVER=SIMULATION` there is no audio path for a human, so a manual "call" is created, attributed to the agent, and dispositioned exactly like a bridged AI transfer, but nobody actually talks. When the SIP `CallRuntime` lands, the agent's live WebRTC leg bridges into this same call with no workflow change. The UI states this in a banner.

## Backend

- **`lead.schema.ts`** — `manualClaimedBy?` (ObjectId) + `manualClaimedAt?`. While `manualClaimedBy` is set, the lead belongs to a human.
- **`dialer.service.ts`** — `dialableFilter` now includes `manualClaimedBy: null`. **This is the "AI won't dial them" guarantee**: a claimed lead disappears from the auto-dialer's dialable set (and from its status counts). `null` matches both missing and null, so old docs are unaffected.
- **`call.schema.ts`** — `manual: boolean` (default false); `flowVersionId` made optional (a manual call has no AI flow).
- **`manual-dial.service.ts`** (new):
  - `queue(tenant, agent, campaignId?)` — the agent's worklist: dialable leads in their campaigns (skill match, or unrestricted per XFER-01), each with a live `callableNow` verdict + `blockReason`/`resumesAt` from the legal gates.
  - `claim` / `release` — toggle manual ownership.
  - `dial` — enforces the **legal** gates (kill switch, calling window, DNC/suppression/frequency cap), claims + locks the lead, sets `preferredAgentId` (sticky), creates the manual Call (`manual:true`, `agentId`, `bridgedAt=now` so talk time counts), marks the agent `ON_CALL`, emits `presence.updated`. One live manual call per agent.
  - **Operational** gates (pacing, agent-availability, budget) are deliberately skipped — a human manually dialing is present by definition. Documented the rationale inline.
- **`manual-dial.controller.ts`** (new) — `GET /manual-dial/queue`, `POST /manual-dial/leads/:id/{claim,release,dial}` (AGENT/SUPERVISOR/ADMIN; OWNER implicit).
- **`calls.controller.ts`** — disposition now clears `manualClaimedBy`/`manualClaimedAt`/`lockedAt`, so a closed manual lead flows back to the auto-dialer per its new state. Reuses the entire existing disposition path (lead transition, HUMAN-leg recording, wrap-up presence, talk time, webhooks).

## Frontend

- **`(app)/manual-dial/page.tsx`** (new) — campaign filter, simulation banner, lead table with Claim/Release + Call per row; out-of-window rows show "opens <time>" instead of a Call button. On dial → an on-call panel with notes + the 7 dispositions (reusing the workspace disposition set). Nav entry "Manual dial" (AGENT/SUPERVISOR/ADMIN/OWNER).

## Verification (live, simulation driver)

- `GET /manual-dial/queue` as agent1 → 141 dialable Aurora leads, `callableNow:true` (past 09:00 Melbourne).
- **Auto-dialer exclusion**: claim a lead → dialer status `dialableLeads` 139 → 138. This is the core requirement, proven.
- Compliance gates fire for real: unwashed number → `DNC_WASH_STALE`; recently-contacted → `FREQUENCY_CAP`; needed a valid `DncWashRecord` (keyed by tenant+phone+countryPackCode) to get a clean dial.
- Full path on a clean lead: dial → Call created (`manual:true`), presence `ON_CALL` → disposition BOOKED → lead `BOOKED`, `manualClaimedBy` cleared, `preferredAgentId` set, presence `WRAP_UP`.
- Single-live-call guard: second dial while on a call → "Finish (disposition) your current manual call first."
- API + web typecheck clean; `next build` shows `/manual-dial`; 14/14 API tests pass.

Test-data notes: a couple of seed leads (ids `6a5cf842…`) are missing the required `listId` and 500 on any `save()` — pre-existing bad seed data, the auto-dialer chokes on them too (worth a seed fix later). I inserted valid DncWashRecords and reset a few leads' frequency state for the e2e; agent1 restored to OFFLINE afterwards.

## Not built (needs SIP — see [`2026-07-19-live-call-build-plan.md`](./2026-07-19-live-call-build-plan.md))

The agent actually speaking to the customer. That needs: a carrier/SIP trunk, the SIP `CallRuntime`, a browser WebRTC softphone, and the audio bridge. Manual dial is the control-plane bolted on top; it lights up for real the moment that foundation exists.
