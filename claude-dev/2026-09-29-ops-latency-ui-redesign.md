# Ops console: latency UI redesign

**Date:** 2026-09-29. **Branch:** `reconcile/voice-on-prod`. **Status:** code written and typechecked; **not yet seen in a browser** and not committed. Follows `2026-09-29-ops-latency-ui-handoff.md`.

Only the web UI changed. The API, `LATENCY_TARGETS`, the call schema and the worker are untouched.

## What changed

| File | Change |
|---|---|
| `apps/web/src/components/ops/TenantLatency.tsx` | Rewritten. Decision-first layout (below). |
| `apps/web/src/components/ops/latency-charts.tsx` | New. `TrendChart` (gap per day) and `CallScatter` (gap by time of day), plain SVG, no chart library. |
| `apps/web/src/components/ops/CallConversation.tsx` | New. Transcript and turn timings in one view. |
| `apps/web/src/components/ops/latency.tsx` | New stage colours, `gapTone`, `TonePill`, `RangeBar`; `Gap` shows a status dot instead of colouring the number; `StageBar` takes `total`. |
| `apps/web/src/components/ops/ui.tsx` | Added `Segmented` (range, view and filter switches). |
| `apps/web/src/app/ops/(console)/calls/[id]/page.tsx` | "Voice timings" and "Transcript" sections replaced by `CallConversation`; recording moved above it. |

## Tenant → Latency tab, top to bottom

1. **Filter row:** Today / 7 days / 30 days / Custom (two date fields), campaign, refresh. The page dims while reloading instead of blanking.
2. **Verdict card:** typical gap as the one large number with its status, a ruler showing typical and worst 5% against the targets, four supporting figures, and three findings: largest stage, furthest provider and what share of its stage that round trip is, stalls.
3. **Where the time goes:** one bar per stage on a shared scale (bar = p50, thin line = p95, darker start = one network round trip). Full percentile table behind "All percentiles".
4. **Network path:** the route drawn top to bottom. The phone ↔ carrier ↔ LiveKit leg is shown as "not measured".
5. **Compare:** one card, switch between provider stack, LLM served and voice served. "Fastest" is only awarded among rows with 20 or more replies; thinner rows say "too few to judge".
6. **Day by day** (line chart, hidden when the range has one day) and **By time of day** (one dot per call, click opens the call).
7. **Calls:** six columns instead of ten. Filters (all / slow or stalled / used a fallback), order (newest / slowest), 25 rows at a time. A row opens to show stack, models and network.

## Call page → Conversation

- Each AI line carries the wait before it: gap, stage bar, stage times. Slow and stalled replies are shaded.
- Worker events (pickup, greeting, stall guard, transfer) sit in place on the timeline.
- "Timing table" switch keeps the old per-turn table.
- A turn is attached to the nearest AI transcript line within 6 s (`MATCH_WINDOW_MS`); a turn with no line near it is shown on its own at its time.

## Decisions worth knowing

- **Stage colours are blue / magenta / violet** (`#3987e5`, `#d55181`, `#9085e9`). The old green and amber clashed with the good / warning status colours. The new set passed the colour-blind separation check on the card surface.
- **Percentiles are never added.** The per-call bar in the calls list is as long as the call's real p50 gap; the stage medians only set the proportions.
- Old calls without events or served models still render: "—", "(configured)", and a plain transcript.

## Still to do

1. **Look at both screens in a browser with real data.** The shell stopped responding during this session before a screenshot could be taken, so layout (label overlap on the ruler, narrow widths) is unchecked.
2. **Delete `apps/web/src/app/zz-preview/`.** It was a temporary preview route; it now only returns "not found", but it should not ship.
3. Run `pnpm -r typecheck` and `pnpm -r test` again. Typecheck passed after the rewrite, but one small edit (ruler height) came after that run.
4. A dev server on port 3917 or a headless Chrome may still be running from the preview attempt.

## Verification (29 Sep, after the redesign)
- `pnpm -r typecheck`, `pnpm -r test` (20 / 17 / 19) and `pnpm --filter @cocally/web build` pass.
- Both screens rendered at 1440 px against real Atlas data for tenant YSGN (14 calls, 30 days) and call 6abb4308; network figures were sample values because no call has network data yet. Layout holds; headline, compare, charts, calls list and the conversation view read correctly.
- Fixed: target/slow labels overlapped on the day-by-day chart when a stall stretches the scale (`TargetLines` now spreads the labels); media round-trip median counted samples without a value as 0 (`CallConversation`).
- Removed `apps/web/src/app/zz-preview/`.
- Not checked: widths under ~500 px, and the label fix on screen.
- Warning for whoever previews next: headless Chrome with `--headless=new --screenshot` does not exit on this machine; repeated runs exhaust the process limit and the shell stops responding. Kill it after the file appears.
- Idea, not built: the conversation view shows no marker for dead air when the customer's words were never transcribed (call 6abb4308, 1:30 → 1:48). A "N s of silence, nothing transcribed" row between lines would make that visible.
