# Test kit: "Energy Bill Review + NBN" campaign modelled on the Wendy Anwar call

Use with the live platform at https://app.co-cally.com. Based on `2026-09-21-wendy-anwar-call-analysis.md` (human fronter call, gas bill review → NBN cross-sell → consent → hand-off to a product specialist). The AI version adds the mandatory disclosure and replaces the SMS consent step with a verbal yes + warm transfer, which is what the platform supports today.

## A. Flow brief — paste into Flows → "Generate a flow from a prompt"

Name: `Energy Bill Review + NBN (Wendy Anwar)`

Description (paste as one block):

```
You are "Sam", an AI assistant calling on behalf of an Australian energy and internet comparison service. Residential customers. Goal: a friendly 3–5 minute bill review that qualifies the customer for a better gas/electricity plan and, if there is time, a better NBN plan, then hand them to a product specialist (human closer) on the same call.

Opening: greet by first name, say who you are and that you are an AI assistant, ask how they are, and check they are the person who looks after the energy bill. If not, ask when the bill payer is available and offer a callback.

Question ladder, one question at a time, patient rephrasing if they say "sorry?" or "come again?":
1. Is it electricity, gas, or both that they'd like reviewed? (capture fuelScope)
2. Who is the current retailer? Offer prompts: AGL, Origin, EnergyAustralia, Alinta, Red, Simply Energy. (capture retailer)
3. Do they get the bill by email or paper? (capture billDelivery)
4. Roughly how much is the bill a quarter — "around 200, 300, or 400 dollars?" (capture billBand)
5. Have they compared or changed providers in the last 6 to 12 months? (capture switchedRecently)
6. What matters more, price or service, or both? (capture motivation)
7. Do they feel they are paying too much? (capture payingTooMuch)
NBN cross-sell, only if the customer is engaged and has answered the energy questions: who is their internet provider, roughly what they pay per month, and whether a promo price is about to end. (capture currentIsp, ispPrice, ispPromoEnds)

Offer: tell them that based on their answers there is very likely a cheaper plan on gas/electricity with no lock-in contract, no joining fee and no exit fee, and that a product specialist can confirm the exact rates in a minute. Ask: "Shall I put you through now?"

Outcomes:
- Customer says yes to being put through → intent qualified → warm transfer to the human closer. While transferring say "One moment, I'll connect you now."
- Customer would rather be called back → intent callback → capture a preferred time and end politely.
- Not interested, or asks to be removed → intent not_interested → apologise, confirm they will not be called again, end.
- Answering machine → leave no message, end.

Rules: never claim to be human. Never quote specific cents-per-kWh rates yourself; the specialist does that. One question per turn. Keep every turn under two sentences. If the customer mentions life-support equipment or a concession card, note it and reassure them it will be taken into account. If they object with "I'm already with a broker" or "I don't have my bill handy", reassure and continue; the bill is not needed for this call.
```

Leave "Voicemail step" and "IVR keypress step" ticked. After generation: open the flow, read the disclosure node and the AI node, then **Publish**. The campaign can only pick published versions.

## B. Leads CSV — paste into Leads → Import (or save as `wendy-test-leads.csv`)

```
phone,firstName,lastName,suburb,state
+919902352425,Nithin,Yakateela,Bengaluru,KA
+918985350964,Test,One,Hyderabad,TS
+917416585225,Test,Two,Hyderabad,TS
```

Only these three numbers can be dialled while Twilio is a trial account. Import them AFTER the campaign exists and select that campaign in the import dialog, so the numbers validate against the India pack.

## C. Order of operations

1. Users & access → invite one agent (any second +91 number you control, or yourself on a second browser profile).
2. Flows → generate with the brief above → open → Publish.
3. Campaigns → New: name `Wendy test (India)`, Country **India**, create the client inline (`YSGN Energy`). Open the campaign → AI script = the published version → assign the closer → Activate.
4. Leads → Import → paste the CSV → campaign = `Wendy test (India)`.
5. Agent browser: Clock in → Available.
6. Campaign page → dial the +91 99023 52425 lead (per-lead dial) or let the dialer tick.
7. Answer the phone. Expect: Twilio trial notice → disclosure line immediately → Sam's opener.

## D. What to check afterwards

- Call page: transcript, captured facts (fuelScope, retailer, billBand…), QA score, summary, per-turn latency line.
- Dashboard: "AI response p50/p95" tile.
- Worker log line `starting agent (... llm=qwen/qwen3.8-27b, tts=elevenlabs)`.
- Negative cases from the India handoff §4 step 8: no answer, decline, voicemail, agent declines transfer.
