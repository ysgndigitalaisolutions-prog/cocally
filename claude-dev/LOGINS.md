# CoCally — local logins

> Seeded by `pnpm --filter @cocally/api seed` (run automatically by `./start.sh` on first start; `./start.sh --reseed` forces it again).
> Web: http://localhost:3000 · API: http://localhost:4000

**These are local development credentials only.** The short `1234` logins are skipped entirely when `NODE_ENV=production`. Never reuse any of these in a real environment.

## Short demo logins

Fastest for walkthroughs — no typing full email addresses.

| Username | Password | Role |
|---|---|---|
| `admin` | `1234` | Admin |
| `agent` | `1234` | Agent |

## Full pilot accounts

All six share the password **`CoCally!Pilot2026`**.

| Email | Name | Role | Can see |
|---|---|---|---|
| `owner@cocally.dev` | Olivia Owner | Owner | Everything, incl. team insights + kill switch |
| `admin@cocally.dev` | Andre Admin | Admin | Campaigns, flows, providers, team insights, audit log |
| `supervisor@cocally.dev` | Sana Supervisor | Supervisor | Floor feed, team insights, can pause campaigns |
| `agent1@cocally.dev` | Alex Agent | Agent | Workspace + own insights only (403 on team endpoints) |
| `agent2@cocally.dev` | Amelia Agent | Agent | Same as agent1 |
| `qa@cocally.dev` | Quinn QA | QA | Calls, recordings, QA scores, team insights |

## Quick pilot loop

1. Sign in as **agent1** → Workspace → set presence **AVAILABLE**.
2. Separate window, sign in as **admin** → Campaigns → *Aurora Solar — VIC Pilot* → **Dial (sim)** on a lead.
3. AI leg runs (AMD → disclosure → qualification → live scoring); at the transfer threshold agent1 gets the transfer card → accept → bridge → disposition.

Note: automatic dialing additionally requires an AVAILABLE agent *and* the lead's local calling window to be open (AU: Mon–Fri 09:00–20:00, Sat 09:00–17:00, no Sundays). The Campaigns page **Dialer** column shows which gate is currently closed and when it reopens. **Dial (sim)** bypasses these, which is why it always works for a demo.
