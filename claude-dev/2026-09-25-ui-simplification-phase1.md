# UI simplification, phase 1: role-based navigation and a quieter workspace

**Date:** 2026-09-25
**Ask:** "Plan for a fresh UI, simple to understand, clean UX, not overloaded with features. An agent will only see what he needs; the owner might see everything, and clean. This looks overwhelming." (Screenshot: the owner's view of `/workspace` with 17 flat sidebar links plus Team and Live floor under the agent controls.)

Decisions taken with Nithin before building:
- Two phases. Phase 1 (this log) is a low-risk restructure that ships before the pilot goes live on Monday 2026-09-28. Phase 2, after the pilot, is the visual refresh: light theme with dark toggle, a `components/ui` primitives folder, page-by-page redesign, and floor events scoped server-side. The full plan is in `~/.claude/plans/plan-for-a-fresh-sparkling-treehouse.md`; the Phase 2 section is reproduced under "Not done" below.
- One grouped sidebar (My desk / Operate / Setup / Account), no agent-vs-manager mode switch.

## What was done

### Role helpers: `apps/web/src/lib/roles.ts` (new)
`hasRole`, `isManager`, `homeFor`, `roleLabel`, plus `DESK_ROLES`, `MANAGEMENT_ROLES`, `SUPERVISOR_ROLES`. The frontend had no role helper; every page did its own `roles.includes(...)`.

**Landing rule (`homeFor`):** 2FA still required → `/security`; holds AGENT → `/workspace`; holds a management role → `/dashboard`; anything else → `/security` (open to every role, so the guard can never loop). Before this, every role was pushed to `/dashboard`, whose `/analytics/*` calls return 403 for agents.

**Who gets the agent desk:** `DESK_ROLES = AGENT | SUPERVISOR | ADMIN`, matching the `@Roles` on `POST /workspace/presence`, `/clock-in` and the manual-dial routes. OWNER is not in the list on purpose. The roles guard lets an owner through every route, but `PresenceService.availableAgentCount` only counts users holding AGENT, so an owner who clocks in and goes Available never receives a transfer. The "Takes calls" toggle on Users & access adds AGENT, and with it the desk appears. Reversible by adding `'OWNER'` to the three My desk rows in `nav.ts`.

### Navigation: `apps/web/src/lib/nav.ts` (new), `apps/web/src/components/Sidebar.tsx` (new)
The inline `NAV` list in `(app)/layout.tsx` became `NAV_SECTIONS`:

| Section | Items | Roles |
|---|---|---|
| My desk | Workspace, Manual dial, My insights | AGENT, SUPERVISOR, ADMIN |
| Operate | Dashboard, Supervisor desk, Team insights, Campaigns, Leads, Calls, Reports | unchanged per item |
| Setup (collapsible, closed by default, forced open on its own pages, remembered in `localStorage['cocally.nav.setupOpen']`) | Flows, CLI numbers, Providers, Users & access, Audit log, Live demo (dev only) | unchanged per item |
| Account (sidebar footer) | My security, then name, role label, Sign out | every role incl. API_CLIENT |

Helpers: `visibleSections(user)` drops items and empty sections by role; `navItemFor(pathname)` maps nested routes (`/team/abc`) to their item; `canVisit(user, pathname)`. Each item has a `react-icons/lu` icon (the package was installed but unused). The user card shows `roleLabel` ("Owner", "Owner · takes calls", "Agent") instead of `OWNER, ADMIN, AGENT`.

Counts: agent 3 + 1 links in two groups; owner without AGENT 13 in three groups; owner with "Takes calls" 16 in four; QA 7.

### Shell: `apps/web/src/app/(app)/layout.tsx`
- Sidebar renders only once the user is loaded; before that an empty same-width aside holds the layout. The old `!user ||` filter flashed all 17 links on every hard refresh.
- Route guard: a page outside the user's nav redirects to `homeFor(user)`. The API still enforces every role; this only stops the UI from rendering a wall of 403s.
- Page content renders only once the user is loaded, except `/security` (the 2FA-required flow must always reach it). A token without a stored user now goes to `/login` rather than hanging.
- Heartbeat, `logout()`, main padding and `GlobalCallBar` untouched.

### Landing redirects
- `login/page.tsx`: `router.push(homeFor(data.user))`.
- `security/page.tsx`: after first 2FA enrolment, routes on the freshly loaded profile via `homeFor` (the stale one still said setup was required).
- `app/page.tsx`: now a client component that reads the session and routes via `homeFor`; the server `redirect('/dashboard')` could not see localStorage.

### Workspace: `apps/web/src/app/(app)/workspace/page.tsx`
- Team roster and Live floor render only for `SUPERVISOR_ROLES` (SUPERVISOR, ADMIN, OWNER). An agent sees presence buttons, the clock card, the status banner and the wrap-up countdown, nothing else. The 15 s `/workspace/team` poll is skipped for agents. The socket effect is unchanged: `presence.updated` still drives the agent's own `loadShift`, and the floor listeners are harmless with nothing rendered.
- Copy: "Agent workspace" → "Workspace"; team rows show `roleLabel`; empty state "No one else is on the floor yet."
- Presence buttons, `PRESENCE_META`, clock logic and colour literals untouched.

### Theme groundwork: `apps/web/src/app/globals.css`
Additive only, no visual change: `--on-accent` token, and a Tailwind v4 `@theme inline` block mapping the palette so `bg-surface`, `text-dim`, `border-border`, `text-accent`, `text-on-accent` are real utilities. The Sidebar uses them. `.btn-primary` / `.btn-danger` text colour now reads `var(--on-accent)` (same computed value).

### Tests: first web unit tests
`vitest ^2.1.8` (the API's version) added to `apps/web`; `vitest.config.ts` (with an empty PostCSS pipeline, because Vite cannot load Next's `postcss.config.mjs`); `src/lib/__tests__/roles.test.ts` with 14 cases over `homeFor`, `visibleSections`, `canVisit`, `navItemFor`, `roleLabel`. CI now runs `pnpm --filter @cocally/web test`. The loop-invariant test ("homeFor never returns a page canVisit rejects") caught a real gap on first run: an API_CLIENT-only session would have looped between `/security` and itself; My security now lists every role.

## Verification
- `pnpm --filter @cocally/shared build`, `pnpm --filter @cocally/web typecheck`, `pnpm --filter @cocally/web test` (14/14), `pnpm --filter @cocally/web build` (all 25 routes). `pnpm-lock.yaml` changed by 11 lines for the vitest link.
- Browser checks (headless Chrome over the DevTools protocol against the production build and the local API; script in the session scratchpad, not committed). The agent and the un-enrolled owner used real logins; supervisor, admin, QA and owner-with-AGENT reused the agent's token with the role list set in localStorage, because those roles need a TOTP enrolment the local seed does not have and the nav, guard and floor gating are client-side.

| Session | Result |
|---|---|
| Agent (real login) | `/` → `/workspace`. Sidebar: My desk (Workspace, Manual dial, My insights) + My security, card "Demo Agent / Agent". Workspace has no Team and no Live floor. `/dashboard`, `/users`, `/campaigns/abc` all bounce to `/workspace`. |
| Owner, 2FA not enrolled (real login) | `/` → `/security`. Sidebar: Operate (7) + Setup (collapsed) + My security, card "Owner", no My desk. |
| Supervisor | `/` → `/dashboard`. My desk + Operate + Setup + Account. `/workspace` shows Team and Live floor. `/users` bounces to `/dashboard`. `/flows` opens and expands Setup to Flows + CLI numbers. |
| Owner with "Takes calls" | `/` → `/workspace`, card "Owner · takes calls", Team + Live floor shown, all four groups present. |
| QA | `/` → `/dashboard`. No My desk; Operate = Dashboard, Team insights, Campaigns, Calls, Reports. `/workspace` bounces to `/dashboard`; `/team/abc` opens. |
| Admin | `/` → `/dashboard`; My desk present; `/workspace` shows Team + Live floor. |

Still to do by hand before Monday: the LOGINS.md "Quick pilot loop" (admin sim dial → transfer card → accept → bridge → disposition) as agent1 on the new shell, and a first-2FA-enrolment run for a privileged user to confirm the post-enrolment redirect.

## Not touched (deliberately, pilot in three days)
`GlobalCallBar.tsx`, `TransferDialog.tsx`, `PauseCodeMenu.tsx`, `lib/api.ts`, `lib/socket.ts`, `lib/store.ts`, everything in `apps/api`, every page except workspace, the `.btn/.card/.input` visuals.

## Not done: Phase 2 (after the pilot)
1. **Light/dark token layer.** `:root` becomes a light palette (with a separate `--accent-text` because the amber fails AA as text on white), `[data-theme='dark']` keeps today's values, `prefers-color-scheme` honoured when nothing is stored, `@custom-variant dark`. Replace the 14 `#0b1220` literals with `var(--on-accent)` / `var(--on-good)`; the call bar, transfer dialog and pause menu edits are colour-only, in their own commit, with the call loop re-run. `lib/theme.ts` + a head script in the root layout to avoid a flash; toggle in the sidebar footer and an Appearance row on My security.
2. **`components/ui` primitives:** Button, Card, Stat, Badge, PresenceDot, PresenceBadge, PageHeader, EmptyState, Section, Field/Input/Select. `PRESENCE_META` moves to `lib/presence.ts`. Migrate the duplicated `Stat` (dashboard, AgentInsightsView), `Tile` (CampaignInsights), `ReportCard`, `Field/SelectField` (campaign detail).
3. **Pages, by pilot impact:** Workspace (one Shift card; "Next up" from the manual-dial worklist reusing that page's `dial()`; "Today" stats from `/analytics/agents/me`; Team and Live floor leave the page), Manual dial, Dashboard (four default tiles: Dials, Connect rate, Bookings, Abandon rate; overdue callbacks and "no closer available" as conditional banners; the rest under a collapsed "More metrics"), Supervisor desk (two columns; absorbs Team + Live floor), Campaigns (tabbed detail), Leads, Calls, then the setup pages.
4. **Floor events scoped server-side:** `realtime.gateway.ts` joins a `floor:<tenantId>` room only for SUPERVISOR/ADMIN/OWNER/QA and emits `floor.call.*` there. About ten lines plus a spec. Per-campaign scoping for agents stays deferred (no consumer); `claude-dev/product-features.md` §floor feed should be updated to "supervisors see the live floor; agents see their own calls and worklist".
