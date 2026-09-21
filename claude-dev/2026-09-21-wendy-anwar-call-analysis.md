# Real fronter call analysis — "Wendy Anwar" recording (energy + NBN)

**Date:** 2026-09-21
**Input:** `~/Downloads/Wendy Anwar_1990118554.mp3.mpeg` (8 kHz mono MP3, 8m13s). Transcribed locally with faster-whisper `small` (no audio left the machine). Timestamps approximate; 8 kHz phone audio produced some garbled tokens (spelled-out names/addresses, "dow-dow" = Dodo, "with soup" = Superloop).
**PII:** the customer's email, unit/street address and phone are in the recording. They are redacted here and must not be committed anywhere in plain text.

## What the call is

An Australian **human fronter call** (agent "Sam", claims to be from a comparison/survey outfit) to a residential customer, doing an **energy bill review + NBN cross-sell**, ending in a **consent capture and hand-off to a "product specialist"** (the closer) who calls back in 5–10 minutes. This is the exact fronter→closer model CoCally automates.

## Call structure (turn by turn, ~8 min)

| t | Stage | What happened |
|---|---|---|
| 0:10 | Opener | Greeting, company name, "how are you". No AI/recording disclosure. |
| 0:19 | Decision-maker check | "Are you the one who looks after the bill?" → yes |
| 0:32 | Pretext | "Quick survey to see if we can offer a better plan" |
| 0:43 | Scope | Electricity or gas? → **gas only** |
| 1:03 | Retailer | → **AGL** |
| 1:13 | Bill delivery | Paper or email? → email; **email address captured + spelled back** |
| 1:45 | Bill size | "Roughly 200/300/400 a quarter?" → **$300–400 / quarter** |
| 2:04 | Address | Residential address captured (NSW) |
| 2:28 | Switching history | Compared/changed in last 6–12 months? → yes (had to re-ask once) |
| 3:07 | Motivation | Price or service? → both |
| 3:14 | Pain check | Paying too much? → yes |
| 3:29 | **Cross-sell pivot to NBN** | Current ISP Superloop, $72→$94 after 6 mo, 500/42 Mbps |
| 4:13 | NBN offer | Dodo: $63→$93, 500/48, unlimited. Handles the "500+50" plan-name objection by pointing at the invoice's real upload speed. |
| 5:24 | **Gas offer** | Alinta Energy, "cheapest on gas", no lock-in / joining / exit fees |
| 5:49 | Rate read-out | Supply 57.99 c/day; 5 usage steps read verbatim (4.620 → 2.244 c/MJ) — a compliance-style "we're on the same page" script |
| 6:25 | **Consent** | SMS sent with a link ("energy bill finder"); customer taps **"Call me"** = express consent to be called back for the sale. Agent waits ~25 s for the tap. |
| 7:46 | **Hand-off** | "Forwarding to the product specialist in your area, they'll call in 5–10 min and sign you off for gas with Alinta and internet with Dodo." |
| 8:10 | Close | Thank you. |

## What this tells us about the operation

- **Two-tier floor**: fronter (qualify + consent) → closer (sign-up). The fronter never sells; they gather facts, pitch the headline offer, get consent, and pass the lead. CoCally's AI-leg → warm-transfer/callback design is this model, one for one.
- **Consent is captured out-of-band by SMS + "Call me" tap**, not verbally. That is what lets the closer legally call back. This is a **required product feature we do not have**: send SMS with a tracked link during the call, detect the click, attach it to the lead as a consent event, and only then allow the transfer/callback.
- **Hand-off is a scheduled callback, not a live bridge.** "5–10 minutes", not "hold the line". The closer works from a queue of consented leads. Our callback tasks + lead ownership cover the data side; a "consented, awaiting closer" state and closer worklist would match it directly.
- **Multi-product upsell in one call**: gas → NBN. Capture keys and scoring must handle more than one product per lead (current energy flow captures retailer/billAmount/hasSolar/lifeSupport/…; this call also needs `currentIsp, ispPrice, ispSpeed, ispPromoEndsMonths`, and for gas `fuelType, billDelivery, email, address, switchedRecently, motivation`).
- **Bill-band framing** ("200, 300, 400?") is the same technique as the Mitchell energy flow — worth keeping as the standard question phrasing.
- **Rate read-out** is a real-world "verbatim block" — a SPEAK node with fixed text, not an AI turn. Same category as the mandatory disclosure.
- **Compliance gaps in the human call** that the AI version would be *better* on: no disclosure at all, no recording notice, and the "survey" pretext. Our AU pack forces the disclosure node; the flow cannot publish without it.

## Mapping to the CoCally flow graph

```
AMD → disclosure (mandatory) → AI_CONVERSATION "energy_qualify"
   (decisionMaker, fuelScope, retailer, billDelivery, email, billBand, address, switchedRecently, motivation, payingTooMuch)
→ AI_CONVERSATION "nbn_crosssell" (optional, gated on fuelScope/time)
→ SPEAK "offer_rates" (verbatim Alinta rate card, per campaign)
→ CONSENT_SMS  ← new node type: send link, wait for click (timeout → callback intent)
→ TRANSFER (warm) | END QUALIFIED_CALLBACK (closer worklist, 5–10 min SLA)
```

## Follow-ups

1. Add an SMS-consent step (Twilio SMS + tracked link + webhook → `ComplianceEvent: CONSENT_SMS_CLICKED`) and gate transfer/callback on it.
2. Add a "CONSENTED → closer" lead state and a closer worklist with a 10-minute SLA timer.
3. Extend the energy flow capture set and scoring for the fields above; add the NBN cross-sell node.
4. Treat rate read-outs as campaign-level verbatim SPEAK content, editable without touching the prompt.
5. Redact email/address in stored transcripts (current redactor masks phone numbers; extend to email and street address).
