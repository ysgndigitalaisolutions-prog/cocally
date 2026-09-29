# Handoff: ops console latency UI

**Date:** 2026-09-29. **For:** the agent taking over the ops console UI. **Branch:** `reconcile/voice-on-prod` (commit `d115b20`); `prod` deploys from it on push.

The backend and data for voice latency are done and should not need changes. The UI works but was built quickly: treat the two screens below as a functional first pass to redesign, not a finished design. Nithin's goal: "per tenant I should see very clear logs of the timings, latencies etc. to make a clear decision" (which provider stack to keep, whether the network or a model is the bottleneck).

## Where the UI is

| Screen | File | What it shows now |
|---|---|---|
| Tenant → **Latency** tab | `apps/web/src/components/ops/TenantLatency.tsx`, tab wired in `apps/web/src/app/ops/(console)/tenants/[id]/page.tsx` | Range buttons (today / 7 / 30 days), 4 headline stats, "Where the time goes" table, Network table, by stack, by LLM actually served, by voice actually served, by day, per-call list with a stage bar and network column |
| Call page → **Voice timings** section | `TurnTimings` at the bottom of `apps/web/src/app/ops/(console)/calls/[id]/page.tsx` | Network line, timeline events, one row per turn: stage bar, end of turn, of which STT, LLM, voice, gap, models, prompt tokens |
| Shared bits | `apps/web/src/components/ops/latency.tsx` | `ms()` formatter, `Gap` (coloured by target), `StageBar` (stacked eou/llm/tts, fixed 3 s scale, red when over), `Legend`, stage colours |

Other ops UI conventions: `apps/web/src/components/ops/ui.tsx` (`Stat`, `Pill`, `secs`, `fmtDateTime`), CSS variables `--text-dim`, `--surface-2`, `--border`, `--good`, `--bad`, `--accent`; `card`, `btn`, `input` classes. API client `opsApi` in `apps/web/src/lib/ops-api.ts` (base `/api/v1/operator`, operator token).

## API contracts (read-only for the UI)

### `GET /operator/tenants/:id/latency?from=ISO&to=ISO&campaignId=`
Default range: last 7 days. Newest 1,000 AI calls (manual/predictive excluded); `truncated: true` if capped. `calls` list is the newest 200. Source: `OpsCallsService.latency()` in `apps/api/src/modules/operator/ops-calls.service.ts`.

`Dist` = `{ n, p50, p90, p95, max, avg }` in ms (nulls when n = 0).

```ts
{
  range: { from, to },
  targets: { goodMs: 1000, slowMs: 1500, stallMs: 5000 },
  truncated: boolean,
  summary: {
    turns, timedTurns, untimedTurns,
    total: Dist, eou: Dist, stt: Dist, llm: Dist, tts: Dist,   // total/eou/stt over timed turns only; llm/tts over all
    slow, stalls, underTarget,                                  // counts over timed turns
    calls, stallGuardFires,
    greeting: Dist,        // pickup → first AI audio
    answerDetect: Dist,    // worker join → SIP answer (mostly ring time; low value)
    amd: Dist,             // answering-machine decision latency
    transfers: { n, bridged, wait: Dist },
  },
  network: {
    providers: [{ host, stage: 'stt'|'llm'|'tts', rtt: Dist }],   // TCP round trip worker → provider, once per call
    media: { rtt: Dist, jitter: Dist, lossPct: Dist },            // worker ↔ LiveKit media; jitter/loss on customer audio
  },
  byStack: [{ stack: { stt, llm, tts }, calls, ...turn stats }],
  byModel: [{ model, turns, llm: Dist, total: Dist }],   // LLM that actually answered; "(configured)" suffix = old calls without served data
  byVoice: [{ model, turns, tts: Dist }],
  byDay:   [{ day: 'YYYY-MM-DD' (IST), calls, ...turn stats }],
  calls: [{
    id, startedAt, leadName, campaignName, outcome, stack, turns, untimedTurns,
    p50, p95, max, eouP50, llmP50, ttsP50, slow, stalls, stallGuardFires,
    greetingMs, amdLatencyMs, llmServed: string[],
    net: { providers: { stt?: ms, llm?: ms, tts?: ms }, mediaRttMs, jitterMaxMs, lossPct },
  }],
}
```

### `GET /operator/calls/:id` (added fields)
```ts
turnMetrics: [{ at, eou, stt, llm, tts, total, llmServed?, ttsServed?, promptTokens?, reply: boolean }],
events: [{ at, kind, ms?, detail?, host?, stage?, jitterMs?, lossPct? }],
providersUsed: { stt?, llm?, tts? },
latencyTargets: { goodMs, slowMs, stallMs },
```
Event kinds: `answered`, `greeting`, `stall_guard`, `transfer` (detail = result), `net_provider`, `net_media`, `llm_fallback` (reserved, not emitted yet).

## Meaning of the numbers (get the labels right)
- **Turn gap** = customer stops speaking → AI's first audio, measured on the server. The caller also hears the phone network delay on top (not measurable here).
- **End of turn (eou)** = customer stops → turn decided. **stt** is the part spent waiting for the final transcript; it is inside eou, not added to it.
- **total = eou + llm + tts**. Stages overlap slightly in reality; never add percentiles across stages.
- **reply = false / "not timed"**: a real reply to the customer where the voice detector did not time the end of speech (turn committed from the transcript). LLM and voice times are valid; the gap is a lower bound. They are NOT "AI-initiated" turns.
- **Stall** = timed gap > 5 s (speech-to-text never finalised). The stall guard (worker) forces the turn after 2.5 s and asks the customer to repeat after 4.5 s; each firing is an event.
- **Network provider rtt** is one TCP round trip; each stage's time already includes at least one of these, so it shows how much of a stage is distance.
- The phone ↔ carrier ↔ LiveKit SIP leg is not measured. Say so on screen rather than implying the network table is the whole path.

## Known gaps / ideas for the redesign
1. The Latency tab is long and table-heavy. A decision-first layout would lead with: typical gap vs target, stalls, and "what dominates" (largest stage p50, largest network leg), then the comparison tables.
2. No charts yet. Useful: gap p50/p95 per day (line), stage split per stack (stacked bar), a per-call scatter (gap vs time of day).
3. Campaign filter is supported by the API (`campaignId`) but has no control in the UI.
4. Custom date range is not exposed (only 1/7/30 days).
5. Per-call network column is dense text; consider icons or a tooltip.
6. Call page: the turn table does not line up turns with the transcript lines; interleaving them would make stalls obvious.
7. Old calls (before 29 Sep) have no events, served models or network data; the UI shows "—" / "(configured)". Keep that graceful.
8. `pnpm --filter @cocally/web lint` fails repo-wide (no `eslint.config.js`); typecheck and tests are the checks that work: `pnpm -r typecheck`, `pnpm -r test`.

## Don't change without talking to Nithin / the voice work
- The API endpoints above, `LATENCY_TARGETS`, the call schema `timings.turns` / `timings.events`, and the worker (`agent-worker/agent.py`). Those are owned by the voice-latency work.
- Deploy: never commit `deploy/gcp/.env` or `.state`. Pushing to `prod` deploys to production; Nithin runs that push.
