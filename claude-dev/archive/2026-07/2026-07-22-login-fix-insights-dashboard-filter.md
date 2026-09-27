# 2026-07-22 — Login fix, insights seeding, dashboard date filter

## 1. Demo login fix
Short logins `admin`/`1234` and `agent`/`1234` were rejected by the browser before
the request fired. Two client-side constraints in `apps/web/src/app/login/page.tsx`:
- identifier input was `type="email"` → browser demanded an `@`. Changed to
  `type="text"`, relabelled "Email or username".
- password `minLength={8}` rejected the 4-char `1234`. Lowered to `4`.

Backend already accepted both (`auth.controller.ts` LoginDto: `@MinLength(1)` email,
`@MinLength(4)` password). **Both the FE `minLength={4}` and BE `MinLength(4)` must go
back to 8 before any production deploy** — noted in code comments already.

## 2. Seeded agent "My Insights"
Repo already had `apps/api/src/seeds/demo-data.ts` (30 days of calls/transfers/
recordings/presence, tagged `demoSeed:true`, idempotent). It just hadn't been run.
Ran `pnpm --filter @cocally/api demo-data` → 719 calls, 113 transfers, 832
recordings, 3645 presence segments, distributed across all AGENT users incl. the
demo `agent` login and `agent1`. My Insights defaults to the **Today** preset (thin);
widen to 7d/30d for the full view.

## 3. Dashboard date filter (DASH-01)
Added a range selector (Today / 7d / 30d / All, default 30d) to the admin dashboard.
- FE `apps/web/src/app/(app)/dashboard/page.tsx`: `rangeQuery()` computes `from`/`to`
  ISO, appended to kpis/funnel/objections requests; recomputed each poll.
- BE `analytics.controller.ts` + `analytics.service.ts`: threaded `from`/`to` into
  `funnel` and `objections` (kpis already supported them). Funnel scopes on lead
  `updatedAt` (leads have no `startedAt`) — "leads whose state changed in the window".

Verified live: kpis dials today=6 vs 30d=706; objections today=0 vs 30d=2.
Note: seeded leads all have `updatedAt=now`, so funnel counts don't vary by window
in the demo data — expected artifact, real activity will differ.
