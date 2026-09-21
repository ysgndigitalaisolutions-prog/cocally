# Persistent global call bar — matching modern dialer UX

**Date:** 2026-07-25
**Goal:** compare CoCally's dialing experience against current (2026) dialer/softphone products and close
the gap — asked directly: "compare with the latest ones out there at present and try to map or give a
seamless experience for the dialers."

## What the comparison found

Researched current power-dialer UX (Orum, Nooks, Aircall, Aloware, Kixie — see prior turn's sources).
Two patterns stood out as directly applicable:

1. **Persistent utility bar, not a full-page takeover.** Aircall/Aloware embed a docked call bar so
   reps never leave what they're doing to place or handle a call.
2. **Context-first — the lead's story on screen, not a blank dialer.**

Checked CoCally against both and found a real gap: **the "on call" UI was duplicated across two pages**
(`workspace/page.tsx` for AI-transfer bridges, `manual-dial/page.tsx` for manual calls, and the newly-added
predictive-bridge case had nowhere coherent to render). Each had its own LiveKit `Room`, its own mute/DTMF,
its own disposition form. Worse: `activeCallId` in the zustand store was already global, but the UI that
*rendered* it lived inside `workspace/page.tsx`'s JSX — so a call survived route changes in *state* but not
*on screen*. An agent who clicked over to Leads mid-call would see the call vanish, though it was still
live server-side.

## What changed

- **`lib/store.ts`**: `activeCallId: string | null` → `activeCall: ActiveCallInfo | null` (adds `source:
  'transfer' | 'manual' | 'predictive'`, `leadName`, `phone`, `cli`, and manual-dial's pre-fetched
  `livekitUrl`/`livekitToken`).
- **`components/GlobalCallBar.tsx`** (new): the one place a live call is ever rendered. Mounted once in
  `(app)/layout.tsx`, fixed-position docked bar, collapsed to a slim strip by default (lead name, phone,
  phase dot, timer) and expandable to the full panel (briefing/facts/rebuttals, notes, dispositions, mute,
  DTMF keypad, hang up). Handles all three call sources through one state machine — they differ only in
  how the call *starts* (manual needs a `connect()` round trip after the room joins; transfer/predictive are
  already bridged server-side) — audio, disposition, and everything after that is identical code now.
- **`workspace/page.tsx`**: stripped down to presence, the transfer *offer* card (accept/decline —
  pre-call, still belongs here), team roster, live floor. On `transfer.bridged` / `predictive.call.bridged`
  it now calls `setActiveCall(...)` instead of running its own audio/briefing/disposition logic.
- **`manual-dial/page.tsx`**: stripped to the worklist + callbacks. `dialById()` sets `activeCall` with
  `source: 'manual'` and the join info `dial()` already returned; the bar takes it from there.
- **`(app)/layout.tsx`**: mounts `<GlobalCallBar />` as a layout-level sibling, so it survives client-side
  navigation between any two pages under `(app)/`.

## A real crash found and fixed while verifying this

Drove the whole flow with Playwright (login → agent goes Available → admin triggers a simulated dial →
agent accepts → **navigates to another page mid-call to prove the bar persists** → dispositions). Two real
bugs surfaced, both fixed:

1. **`Cannot read properties of undefined (reading 'enabled')`** — the campaign detail page crashed loading
   any campaign created before this session's `predictiveDialing` schema field existed. `CampaignsService.get()`/`.list()`
   use `.lean()`, which returns the raw stored document with **no schema defaults applied** — a pre-existing
   campaign genuinely has no `predictiveDialing` key in Mongo, so the lean read gives back `undefined`, not
   the schema default object. Fixed by exporting `DEFAULT_PREDICTIVE_DIALING` from the schema and backfilling
   it in `get()`, `list()`, and `update()` rather than trusting Mongoose hydration or the frontend to
   null-check. This is a schema-evolution class of bug — worth remembering for the next new Campaign field.

2. **The API process crashed outright** (`ValidationError: Lead validation failed: listId: Path 'listId' is
   required`) a few seconds into testing — an *existing*, unrelated data-integrity issue, not something this
   session's code introduced. 240 of the seeded `Lead` documents predate the `listId` field becoming
   `required: true` and had no value for it. `DialerService`'s per-tick `lead.save()` calls hit it constantly;
   most were caught by `tick()`'s `.catch()`, but at least one uncaught path (deeper in the transfer/orchestrator
   chain) let a `ValidationError` escape and kill the whole ts-node-dev process. Fixed by backfilling `listId`
   on all 240 leads from the matching `LeadList` (safe, additive, campaign-scoped match — 240/240 resolved,
   0 unmatched). **This was actively crashing the dev server during normal use, not just this test** — worth
   flagging as a pre-existing production-stability risk independent of anything built this session.

## Verification

- `tsc --noEmit` and full `tsc -p tsconfig.build.json` / `next build` clean across `packages/shared`,
  `apps/api`, `apps/web`. Existing 14-test suite still passes.
- **Actually drove the app** (not just typechecked) via headless Playwright against the running dev
  servers: logged in, went Available, triggered a simulated AI→transfer call from a second (admin) session,
  accepted it, confirmed the call bar renders with live briefing (summary/facts/rebuttals), **navigated to
  a different page via a real sidebar link click and confirmed the bar and its LiveKit room survived
  unchanged**, navigated back, and completed a disposition — bar cleared, presence flipped to Wrap-up
  server-side, no leftover state, no console errors.
- LiveKit audio itself failed to connect in this sandbox ("Could not connect the call") — expected, this
  environment has no route to LiveKit Cloud, and carrier/LiveKit wiring is explicitly out of scope for this
  session per prior instruction. Importantly, the bar **degraded gracefully**: phase flipped to "Call ended"
  with a visible error, but briefing and disposition remained fully usable — an agent isn't stuck if the
  audio leg fails.
- Note: a hard page reload (not a client-side nav) mid-call resets the in-memory call bar state, same as
  it always did pre-refactor (zustand isn't persisted to `localStorage`). Not a regression, but worth
  knowing — rehydrating an in-progress call after a refresh would need the browser to re-derive `activeCall`
  from a server-side "what am I on right now" endpoint, which doesn't exist yet.
