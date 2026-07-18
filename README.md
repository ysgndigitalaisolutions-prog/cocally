# CoCally

AI-first outbound contact-centre platform. Autonomous voice agents dial leads, classify who answered, qualify in natural conversation, and warm-transfer high-intent leads to human agents in CoCally's own browser workspace — with an AI-generated summary at the moment of transfer. Dual-leg recording, 100% auto-QA, and country-pack compliance are built in.

## Stack

- **API** — NestJS + Mongoose (MongoDB), Socket.IO, JWT + TOTP 2FA
- **Web** — Next.js + Tailwind + zustand
- **Shared** — `@cocally/shared`: domain enums, flow-graph schema (zod), contracts, scoring, PII redaction

## Monorepo layout

```
apps/api        NestJS platform API (all 12 PRD modules)
apps/web        Next.js admin console + agent workspace + dashboards
packages/shared Shared types and pure domain logic
```

## Quick start

```bash
pnpm install
docker compose up -d          # MongoDB
cp apps/api/.env.example apps/api/.env

pnpm --filter @cocally/shared build
pnpm --filter @cocally/api seed   # tenant, users, AU pack, campaign, flow, leads

pnpm --filter @cocally/api dev    # API on :4000
pnpm --filter @cocally/web dev    # Web on :3000
```

Login at http://localhost:3000 — seeded users (password `CoCally!Pilot2026`):

| Email | Role |
|---|---|
| owner@cocally.dev | Owner |
| admin@cocally.dev | Admin |
| supervisor@cocally.dev | Supervisor |
| agent1@cocally.dev, agent2@cocally.dev | Agent |
| qa@cocally.dev | QA |

## Try the pilot loop (simulation driver)

No carrier or AI keys needed — simulation adapters run the whole loop in-process:

1. Sign in as **agent1** → Workspace → set presence **AVAILABLE**.
2. In another window sign in as **admin** → Campaigns → *Aurora Solar — VIC Pilot* → **Dial (sim)** on a lead.
3. The AI leg runs (AMD → mandatory disclosure → qualification → live scoring). When the score crosses the transfer threshold the agent gets the **transfer card** with countdown — accept to bridge, then disposition (**Booked** etc.).
4. Dashboard shows KPIs, funnel, objection intelligence; Calls shows the deep-dive (transcript is PII-redacted by default); the lead's recording timeline holds both legs stitched.

Activating the campaign switches on the pacing-aware dialer (5s ticks): availability-aware pacing, daily budgets, channel caps, timezone-legal calling windows, and the dial-time suppression stack (DNC wash → opt-out → frequency cap → client suppression).

## Provider abstraction (PAL)

TTS / STT / LLM are registries of interchangeable adapters (ElevenLabs, Deepgram, Whisper, Anthropic, OpenAI, Gemini + always-on simulation). Chains resolve through the override hierarchy *flow node → campaign → country pack → tenant → platform* with automatic failover. Keys live in a per-tenant AES-256-GCM vault (`VAULT_KEY`); env keys are the dev fallback.

## Telephony

`TELEPHONY_DRIVER=SIMULATION` (default) runs calls in-process behind the same `CallRuntime` interface the SIP driver implements. Carrier integration (IP-auth trunk pairing, codecs, DTMF, AMD against real voicemail greetings) is the external dependency tracked in PRD §7.

## Tests

```bash
pnpm --filter @cocally/shared test   # redaction, flow-graph validation
pnpm --filter @cocally/api test      # calling windows (incl. DST divergence), E.164 normalisation
pnpm typecheck
```

## PRD coverage

Phase-1 (pilot) requirements are implemented end-to-end in simulation: TEL (dialer, AMD policy, CLI pools, concurrency), PAL (registries, hierarchy, fallback, vault), FLOW (graph, validation, versioning, simulator), LEAD (import, E.164, dedup, retry matrix, suppression stack, calling windows), AI (conversation loop, scoring, structured capture, objection memory, safety rails), XFER (eligibility, pre-reservation, accept-window cascade, summary card), WS (presence, floor feed, transfer card, dispositions), REC (dual-leg stitched timeline, redaction, retention, legal hold), DASH (KPIs, funnel, objections, heatmap, deep-dive), ADM (RBAC, immutable audit, campaign controls, pause-everything), CP (AU pack: ACMA wash expiry, calling hours, disclosures), PLAT (multi-tenancy, webhooks with HMAC + retry, quotas/kill switch, health).
