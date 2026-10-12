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

## First call on the script, 12 Oct 15:26 UTC (`6accfc16`, prod `c2ec237`)

Felt slow because Flux missed three clear answers, each the first answer after
a long scripted line (10-13 s): "I have electricity only now", "monthly around
five hundred dollars", "monthly eight hundred dollars" (nova-3 on the
recording). VAD fired each time, room audio and the Flux stream both carried
loud audio (peak ~19-23k), the STT gate was open, and Flux emitted no event at
all; the stall guard asked to repeat 4.5 s later (2.5 s + 2 s) and the repeat
was heard. Same signature as the 6 Oct 05:23 / 15:27 deaf calls.

Model: first token 0.56 / 0.90 / 0.56 s vs ~0.36 s last week. Prompt grew
~1200 -> ~1620 tokens with the script and playbook, but last week's turns at
1500-1580 tokens still ran at ~0.35 s; a probe right after gave 0.33-1.36 s,
so it is Cerebras variance on this call. Cartesia's first open took 3.2 s (all
far back-ends), hidden by the ring.

Next: (1) NOISE_CANCELLATION=0 for one call (Flux may be getting voice that
BVC has mangled: VAD fires, Flux hears no words); (2) a fallback that sends a
VAD-detected segment Flux ignored to nova-3 and commits that transcript, so a
missed answer costs ~1.5 s instead of a 4.5 s "sorry?".
