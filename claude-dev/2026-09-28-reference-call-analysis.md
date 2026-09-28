# 2026-09-28 — Reference call analysis vs. the energy bill-review flow

Two recordings of the client's human floor were transcribed (Deepgram nova-3,
diarised) and compared against the seeded flow in
`apps/api/src/seeds/seed-test-campaign.ts` (`Energy Bill Review + NBN`) and the
worker brief in `engine.controller.ts`. Transcripts hold customer PII (address,
DOB, NMI, email) and are deliberately not committed; only the structure is here.

## What the human agents actually do

| Step | Call 1 (agent "Sam", 6m13s) | Call 2 (agent "Alex", 8m17s) | Our flow |
|---|---|---|---|
| Recording disclosure | **none** | yes | `disclosure` SPEAK node, uninterruptible |
| Bill-payer check | yes | implicit ("bill under your name?") | yes (`decisionMaker`) |
| Solar panels on roof | yes | yes | **missing** |
| Life support / medical equipment | yes | yes | noted only if customer raises it |
| Concession / pension card | yes | yes | noted only if customer raises it |
| Confirm supply address (read back) | yes | yes + NMI | **missing** |
| Current retailer | yes | yes | yes |
| Gas as well? | yes | yes | yes (`fuelScope`) |
| Bill amount per quarter | no | yes | yes (`billBand`) |
| Paying too much? / price vs service | yes | no | yes |
| Switched recently? | no | no | yes (`switchedRecently`, weight 10) |
| Bill by email or paper | mentioned as a feature | no | yes (`billDelivery`) |
| Confirm email | yes | yes | no |
| DOB | no | yes, twice | no — keep it that way |
| Quote cents/kWh rates | yes, in full | yes, in full | never (specialist does) |
| SMS consent link ("Call me" button) | yes, ~1 min | yes, ~2.5 min of struggle | **no SMS capability** |
| NBN upsell | yes | no | yes, if engaged |
| Handoff | "specialist calls back in 5–10 min" | "verification team rings in 10 min" | live transfer, book-fallback if no agent |

## Where our flow is already stronger

- Disclosure is scripted and mandatory; call 1 had none.
- No rates are quoted, no DOB/NMI collected — the specialist owns that.
- Call 2 opened with claims we must not copy: that the regulator "reduced the
  price", that the customer is a "pay on time customer", and that the switch
  was already decided ("instead of Origin it will come from FirstEnergy").
  Our prompt makes no such claims. Flag to the client: an AI recording of
  that pitch would be a compliance liability.

## Gaps to fix in the prompt/flow

1. **Ask about solar panels** — both agents do, it drives plan selection.
   Add `hasSolar` to the question list and `captureVariables`.
2. **Ask life support and concession card explicitly** rather than only
   noting them if raised. Both are asked on every real call and life support
   is a hard retail-transfer requirement. Add `lifeSupport`, `concessionCard`
   as questions (they are already capture variables).
3. **Confirm the supply address** by reading back the lead record and asking
   yes/no. Do not collect NMI.
4. **Confirm email** if on the lead record (read back, yes/no). Optional.
5. **Pace for older customers.** Both customers were elderly; one asked
   "say that again?" twice, one struggled with the SMS for minutes. Add:
   speak slowly, one idea per sentence, repeat on request without irritation.
6. **Brand consistency.** Agents said "Bay/BEAT Energy" while the SMS said
   "Energy Bill Finder". `{{clientName}}` must match whatever the specialist
   and any SMS say, or the customer distrusts the callback.
7. **Consider dropping `switchedRecently` and `billDelivery`** — neither
   agent asks them; they add turns without adding qualification. If dropped,
   move the 10 points from `notSwitchedRecently` to `payingTooMuch`.

## Open decision: SMS consent link

The real process records consent by the customer tapping "Call me" on an SMS
link before the specialist rings. We have no SMS sending. Our model is a live
warm transfer where consent is verbal and recorded, so the link may not be
needed — but if the client's specialist team requires the web consent record
for their retailer's explicit-informed-consent process, we need to add SMS
(and it is the slowest, most error-prone part of both calls). Ask the client.

## Scoring check

`ENERGY_SCORING` transfer threshold 70 = `wantsSpecialist` (35) +
`decisionMaker` (25) + `payingTooMuch` (20) → 80. Both reference calls would
have scored: call 1 = 80 (transfer), call 2 = 60 (bill payer + wantsSpecialist,
paying-too-much never asked) → book-only. That is the intended behaviour.

## Done in this session (2026-09-28)

- `seed-test-campaign.ts` PROMPT: added solar, life-support, concession and
  address read-back questions; dropped `switchedRecently`/`billDelivery`;
  added deviation handling (off-topic remarks, "hold on a sec", phone handed
  to someone else, "are you a real person?", questions it can't answer);
  added pacing rules for older customers; banned the misleading claims heard
  in call 2. Scoring: `notSwitchedRecently` removed, `payingTooMuch` 20 → 30.
- Seed now publishes a new flow version (archiving the old one) when the
  prompt differs from what is published, so re-running
  `deploy/gcp/seed-test-campaign.sh` updates the live pilot flow.
- **Bug fixed** in `engine.controller.ts` brief: `clientName` was
  `campaign.name`, so the AI said "on behalf of Wendy test (India)". It now
  resolves the campaign's Client record. Also exposes `{{address}}`
  (suburb, state, postcode) and `{{postcode}}` to prompts.
- Still open: SMS consent link (client decision) and which brand name the
  Client record should carry.
