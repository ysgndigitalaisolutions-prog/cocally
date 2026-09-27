# CoCally — Where calling actually starts (and what gates it)

> Session log: 19 July 2026. Nithin asked where dialing gets kicked off. Traced the chain in code and verified each gate live against the running stack.

## The chain

1. **Human action**: Campaigns page → **Start** on a campaign → `POST /campaigns/:id/status {status:'ACTIVE'}`. That flips `campaign.status` to `ACTIVE` — the only manual trigger in the whole system.
2. **`DialerService.tick()`** ([dialer.service.ts:44](../apps/api/src/modules/telephony/dialer.service.ts#L44)) — `@Interval(5000)`, running since API boot. Each tick queries `{status:'ACTIVE'}` and calls `dialCampaign` per campaign. Re-entrancy guarded by a `ticking` flag.
3. **Gates, in order** (`dialCampaign`): tenant kill switch / `active` → campaign daily dial budget → tenant daily quota → concurrency `maxConcurrentCalls` → **availability pacing** `freeAgents * dialsPerAvailableAgent` → atomic lead lock (`findOneAndUpdate` on dialable state + due + unlocked, 10-min lock TTL) → **legal calling window** in the lead's own timezone → suppression stack (DNC/opt-out/frequency cap/client list) → CLI selection → `orchestrator.placeCall()` fired without blocking the loop.

**Humans never dial.** The AI places every call; human agents only *receive* warm transfers into the Workspace. So "agents start calling" = agent goes AVAILABLE, which unlocks pacing capacity so the AI dials.

## Live verification (why the pilot stack was idle)

Checked against the running instance:

- Campaign "Aurora Solar — VIC Pilot" is `ACTIVE`; 100 leads with 1 FRESH + 35 ATTEMPTED + 12 CONTACTED + 8 CALLBACK still dialable. Last call placed 10:30 PM IST.
- **All four users were `presence=OFFLINE`** → `availableAgentCount()` = 0 → `pacingCap` = 0 → `capacity <= 0` → early return. Set agent1 AVAILABLE via `POST /workspace/presence {state:'AVAILABLE'}` (note: field is `state`, not `presence`) and waited 15 s — still no dials, so a second gate was also closed.
- **Calling window was the second gate**: machine time Sun 23:28 IST = **Mon 03:58 AEST**; leads are `Australia/Melbourne`; AU pack allows Mon 09:00–20:00. `isWithinCallingWindow` false → each locked lead gets `nextAttemptAt = nextWindowOpen(...)` and is released, not dialed.

Conclusion: both gates behaving exactly as designed — nothing broken. Dialing resumes on its own at 09:00 Melbourne (≈04:30 IST) provided an agent is AVAILABLE.

State restored: agent1 set back to OFFLINE after the test.

## Demo implication

To see dialing on demand outside AU hours, either: temporarily widen the AU pack's `callingWindows`, seed leads with a timezone whose local time is inside the window, or use the flow test-drive / simulation driver (which bypasses the dialer entirely). Worth adding to [`2026-07-19-demo-guide.md`](./2026-07-19-demo-guide.md) — it currently documents pacing but not the calling-window gate as a demo blocker.
