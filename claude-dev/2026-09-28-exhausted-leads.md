# Leads exhausted after one call — 28 Sep 2026

Trigger: campaign page showed `Test3 · +918186045160 · EXHAUSTED` with no explanation.

## What was wrong

A lead could be exhausted by a single call, and the UI never said why.

1. **Declined calls burned the lead.** SIP 603 (callee taps "decline") maps to
   `CARRIER_BLOCKED` → outcome `DISCONNECTED`, whose default rule allows **1** attempt.
2. **Ring-out cancel counted as a rejection.** SIP 487 fell into the generic 4xx
   bucket → `REJECTED` → `DISCONNECTED` → exhausted.
3. **Campaign rules replaced the defaults wholesale.** Seeded campaigns only list
   BUSY / NO_ANSWER / ANSWERED_VOICEMAIL, so `FAILED` (our trunk error),
   `DISCONNECTED` and `ANSWERED_IVR` had *no* rule → "No retry rule" → exhausted.
4. `ANSWERED_IVR` had no default rule at all.
5. `FAILED` doesn't increment attempts but was still checked against `maxAttempts`
   using the total, so it could exhaust a lead with a misleading count.

## Changes

- `packages/shared/src/enums.ts`: 487 → `NO_ANSWER` (+ test).
- `call-progress.service.ts`: `CARRIER_BLOCKED` → outcome `BUSY` (30 min, 5 tries).
  The end reason is unchanged, so CLI burst detection still sees it.
- `leads.service.ts`:
  - default `ANSWERED_IVR` rule (4 h + time-band shift, 3 tries);
  - campaign rules override defaults **per outcome**, missing ones fall back;
  - `FAILED` never exhausts;
  - human-readable reasons, e.g. `Busy or declined the call — 5 of 5 attempts used`.
- `lead.schema.ts`: new `stateReason`, set by every `transition()`.
- Web: `lib/lead-state.ts#leadStateReason` (falls back to the latest STATE_CHANGE
  timeline entry for older leads). Shown under EXHAUSTED/DNC/NURTURE on the campaign
  page and leads table, and always in the lead drawer header.

## Verified

- `@cocally/shared` tests 20/20, `@cocally/api` tests 19/19.
- `tsc --noEmit` clean for api and web.

## Open

- Leads already exhausted by the old rules stay EXHAUSTED — reopen from the lead
  drawer (state → ATTEMPTED) if they should be dialled again.

## Attempt limits switched off for testing

`ENFORCE_ATTEMPT_LIMITS = false` at the top of `leads.service.ts`: leads keep
retrying on their rule's delay instead of being exhausted. **Set it back to `true`
before dialling real lists.** Wrong-number dispositions still exhaust (agent's call).
