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

All six share the password **`CoCally!Pilot2026`**. Sign in with the **phone number** (any spelling: `0400 000 001` or `+61400000001`); the email still works as a legacy identifier.

| Phone | Email | Name | Role | Can see |
|---|---|---|---|---|
| `0400 000 001` | `owner@cocally.dev` | Olivia Owner | Owner | Everything except the agent desk (Workspace, Manual dial, My insights) unless "Takes calls" is on for her in Users & access |
| `0400 000 002` | `admin@cocally.dev` | Andre Admin | Admin | Campaigns, flows, providers, users, audit log |
| `0400 000 003` | `supervisor@cocally.dev` | Sana Supervisor | Supervisor | Floor feed, team insights, can pause campaigns |
| `0400 000 004` | `agent1@cocally.dev` | Alex Agent | Agent | My desk (Workspace, Manual dial, My insights) + My security only; lands on Workspace; management URLs bounce home |
| `0400 000 005` | `agent2@cocally.dev` | Amelia Agent | Agent | Same as agent1 |
| `0400 000 006` | `qa@cocally.dev` | Quinn QA | QA | Calls, recordings, QA scores, team insights |

**Owner, Admin, Supervisor and QA must enrol an authenticator app at first sign-in** (My security page). Until then every other route returns `403 TWO_FACTOR_REQUIRED`. Agents may enrol but are not forced to. If you lose a dev authenticator, clear it in Mongo: `db.users.updateOne({email:"owner@cocally.dev"},{$set:{totpEnabled:false},$unset:{totpSecret:1}})`.

## Quick pilot loop

1. Sign in as **agent1** → Workspace → set presence **AVAILABLE**.
2. Separate window, sign in as **admin** → Campaigns → *Aurora Solar — VIC Pilot* → **Dial (sim)** on a lead.
3. AI leg runs (AMD → disclosure → qualification → live scoring); at the transfer threshold agent1 gets the transfer card → accept → bridge → disposition.

Note: automatic dialing additionally requires an AVAILABLE agent *and* the lead's local calling window to be open (AU: Mon–Fri 09:00–20:00, Sat 09:00–17:00, no Sundays). The Campaigns page **Dialer** column shows which gate is currently closed and when it reopens. **Dial (sim)** bypasses these, which is why it always works for a demo.


