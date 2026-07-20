# CoCally — Energy Bill Review flow (from a real sample call)

> Session log: 19 July 2026 (same session as the flow canvas). Nithin supplied a transcript of a real human BPO call — "Mitchell from Energy Market" doing an energy bill better-deal qualification — and asked for it as a prompt in a flow.

## What was created

**Flow: "Energy Bill Review — Better Deal Qualification"** (draft v1, created live via API — id `6a5d05e00ef7c7980ab7c8f4`). Not committed to the repo; it lives in Mongo like any user-authored flow.

- Graph: `AMD → disclosure (mandatory) → AI_CONVERSATION → { qualified→TRANSFER→fallback→END QUALIFIED, callback→END NURTURE, not_interested→END NURTURE, else→END }`.
- The `AI_CONVERSATION` prompt is modelled turn-for-turn on the transcript: Mitchell persona, "prices revised in the market, better deal on your same supplier" opener, then the exact question ladder — retailer (AGL/Origin/EnergyAustralia/Simply Energy) → bill amount (rough estimate framing "around $200 or $300?") → solar panels → life-support equipment (CPAP/oxygen/nebuliser, reassure it's noted) → concession card → bill in hand (offer to hold) → NMI on page 2 (with the explanation of what an NMI is). Rules encode the transcript's behaviours: patient rephrasing on "can you come again?", the callback offer ("one to two hours") mapping to `intent: callback`, qualified on NMI capture.
- Capture variables: `retailer, billAmount, hasSolar, lifeSupport, concessionCard, billInHand, nmi`.
- **Compliance adaptation**: the sample call passes as human; our flow keeps the persona/name but the mandatory disclosure identifies it as an AI assistant (country-pack requirement — flow can't publish without it).

## Verification

- `POST /flows/validate` → valid, no issues.
- Test-drive through the real engine: AMD → disclosure spoken → AI turns ran, facts captured, score updated. **Caveat noted**: with no real LLM key configured the simulation adapter answers (canned solar persona, ignores the node prompt) — prompt fidelity needs an Anthropic/OpenAI key on the Providers page.
- `POST /flows/prompt-preview` with sample facts: variables interpolate ({{firstName}}→Sam), `ALREADY ANSWERED: retailer=Simply Energy, billAmount=500, lifeSupport=true` appears, envelope contract appended — the no-re-ask mechanism that the human agent in the transcript lacked.
- Canvas screenshot: full graph with all four intent-labelled exits renders; AI node click-through to editor works.

## Follow-ups suggested

- Campaign to pair with it: scoring weights for the new capture variables (e.g. `billAmount` high → points), rebuttal library for common energy objections ("I'm with a broker already", "I don't have my bill").
- The envelope's `captured` key list in the composed prompt still names the solar campaign facts (`owner, noPanels, billHigh…`) — campaign-specific capture keys come from scoring config; worth aligning when the campaign is created.
