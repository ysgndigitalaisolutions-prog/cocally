# Call script as the golden set; usage on the tenant's Calls page (12 Oct 2026)

## Call script

Nithin's "AI Energy Campaign – Outbound Call Script" and its "Customer
Questions & Answers" are the golden set. Client: **Australian Deal** (persona
Daniel). Compliance wording is parked by his decision.

- Brief (`engine.controller.ts`): the flow's mandatory SPEAK node is the
  spoken opening line; the TRANSFER node's `announceText` is the hand-off
  line, spoken once by the worker; the model is told what it already said and
  to say scripted lines word for word.
- Worker: hand-off line from the brief; `end_call` tool (after a goodbye);
  `schedule_callback` tool -> `POST /engine/calls/:id/callback` (handler AI).
- Opt-out closing line = the script's DNC answer (`modules/engine/lines.ts`).
- Scoring: decisionMaker 30, billProvided 20, retailerProvided 50, transfer
  at 100, so it can only fire after the retailer answer.
- Seed run against Atlas on 12 Oct: client "Australian Deal", flow "AI Energy
  Campaign – Outbound Call Script" v1, campaign renamed "Wendy test (India)"
  -> "AI Energy Campaign (India test)" (status PAUSED, unchanged), Nithin and
  Surya leads FRESH with facts cleared. Only campaign in the database.
- Opener, hand-off, end_call and callback need the deploy of `702e35d`+.

## Usage for the tenant

The tenant (the business CoCally bills) already had Usage & billing (monthly
AI talk time, dials, answered, transfers, agent time, per-campaign AI minutes,
invoices, advance ledger; OWNER/ADMIN). Added on the Calls page:
- per call: ring time, AI minutes, agent minutes (all roles that see Calls),
  and the charge at the base rate (OWNER/ADMIN only; same formula as the ops
  console's "Billed"); internal cost is never sent to tenants;
- a totals strip for the calls listed: calls, answered, transferred, AI
  minutes, agent minutes, charge.
