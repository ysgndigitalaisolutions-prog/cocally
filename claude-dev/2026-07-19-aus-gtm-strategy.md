# CoCally — Australia GTM Strategy

> Written 19 July 2026. Companion to [`2026-07-19-market-research-and-positioning.md`](./2026-07-19-market-research-and-positioning.md). Two motions: **direct** (AU businesses drowning in paid leads) and **channel** (the offshore BPOs already dialing for Australia). The channel motion is the faster path to volume.

---

## 1. Market shape

Australian outbound today is largely dialed offshore: India/Philippines seats at US$6–12/hr billable (≈A$1.5–2.5K/mo/seat), reselling output to AU clients at hundreds of dollars per appointment. Meanwhile:

- AU consumers punish unknown/offshore calls; carrier spam-flagging hits high-volume BPO dialing hardest.
- Compliance liability sits with the **AU client**, not the BPO — DNCR breaches, 9am–8pm windows, 3-month consent staleness. ACMA fined V Marketing A$1.5M + A$60K personally against the director (2025), and has flagged AI voice in its 2025–26 priorities.
- Our unit economics undercut even Indian seats: single-digit dollars per qualified conversation vs $60–150 offshore.

**Conclusion:** we don't fight the BPOs for seats — we either replace their function for direct clients, or become their engine.

## 2. Motion A — the BPO channel (priority)

### Who to target
BPOs and lead-gen shops (India, Philippines, and AU-onshore boutiques) running **AU campaigns**: solar/battery appointment setting, energy & telco switching, insurance/mortgage lead qualification, real-estate follow-up, education enquiry handling. Typically 10–200 seats, GoHighLevel/VICIdial/Convoso stacks, selling per-appointment or per-seat-hour.

### The offer
**"Keep your clients. Cut your seats. Fix your compliance."**
- CoCally becomes their AI front line: AI dials from AU numbers with geo-matched CLI, qualifies, and warm-transfers to *their* existing agents (browser workspace, works from Gurgaon or Manila as well as Melbourne).
- Their cost per appointment collapses; their capacity stops being headcount-bound; campaign bursts don't require hiring.
- Compliance becomes their sales asset instead of their client's risk: DNCR wash, calling windows, AI disclosure, zero structural abandonment, per-call evidence packs to show AU clients.
- Multi-tenant floors (already built) = one BPO, many end-clients, separated data.

### Why they'd say yes
1. Their #1 costs (seats, attrition, training) become software margin.
2. Their #1 client objection (offshore quality/compliance) disappears — the accent on the phone is whatever voice they pick; the compliance log is printable.
3. Their #1 growth constraint (hiring/ramping for bursts) disappears.

### Why they'd say no — and the answers
- *"You'll disintermediate us."* → We're a platform, not an agency; we don't hold client relationships. White-label/partner tier can hide our brand.
- *"Our margin is the seat markup."* → Reprice on outcomes: same A$X/appointment to the client, 3–5× the margin behind it.
- *"Our floor won't adopt it."* → The closer seat is one screen: accept, talk, dispose. Pilot on one campaign, 2 weeks, alongside the existing dialer.

### Commercial structure
- Enterprise tier: custom minute bundles + per-qualified-transfer pricing; volume discounts; optional white-label.
- Land: 1-campaign paid pilot (2 weeks, fixed fee, success criteria = cost/appointment + QA vs their human baseline).
- Expand: per-campaign rollout; their sales team resells "AI-assisted appointments" to new AU clients.

### How to reach them
- Direct founder outreach to BPO owners/ops directors (LinkedIn + intros) — Nithin's India network is an unfair advantage here; the buyers are reachable in one hop.
- BPO industry groups (NASSCOM BPM council, CCAP in PH, AU's ACXPA) and outsourcing marketplaces where AU clients find BPOs.
- The pitch asset: a side-by-side recording — their fronter call vs our AI call on the same script — plus the receipt (QA + compliance log).

## 3. Motion B — direct to AU businesses

### Beachhead ICPs (in order)
1. **Lead-gen agencies & aggregators** (solar, insurance, home improvement) — aggregate many end-clients, feel speed-to-lead daily, buy on cost-per-appointment. One agency = dozens of campaigns.
2. **Solar/battery installers** buying aggregator leads (rebate-driven volume; leads decay in minutes).
3. **Mortgage/insurance brokers** — callback SLAs, compliance-sensitive, high lead values.
4. **Real estate** (appraisal follow-up, open-home nurture) and **private education/RTOs** (enquiry response; exempt from DNCR).

### Plays
- **Dogfood the demo:** the website form triggers CoCally calling the prospect back within 60 seconds — "you just experienced the product." Highest-leverage single build item for GTM (needs telephony live + inbound-lead webhook, roadmap items #1).
- **Proof-led sales:** one pilot per vertical, real recorded calls as the sales asset. "Press play" beats any deck; AU mid-market is small and referral-driven.
- **Compliance-first content:** own "ACMA-compliant AI calling" — guides on DNCR washing, 3-month consent staleness, AI disclosure, zero-abandonment. Webinars via ADMA / Smart Energy Council / vertical associations. Positions us as the safe choice before competitors arrive from the US.
- **Ecosystem:** GoHighLevel/HubSpot agencies serving AU trades; lead marketplaces (integrate as the "instant call" layer on leads they sell).
- **Local trust signals** (already built, must be said everywhere): AUD pricing, AU numbers with geo-matched CLI, Sydney data residency, AU country pack.

## 4. 90-day plan

| Weeks | Focus |
|---|---|
| 1–2 | Finalize pricing; activate form→Gmail; build the side-by-side pitch recording from the simulator; list 50 target BPOs + 50 direct prospects |
| 3–6 | 2 paid pilots: one BPO campaign, one direct (solar agency). Ship speed-to-lead webhook (roadmap #1) for the direct pilot |
| 7–10 | Convert pilots to case studies (with recordings); compliance guide + ADMA/industry outreach; BPO white-label packaging |
| 11–13 | Referral loop: pilot clients intro 2 peers each; first association webinar; evaluate per-appointment outcome pricing from pilot data |

**Metrics that matter:** pilot cost-per-qualified-transfer vs baseline · transfer accept rate · client's show/close rate on AI-sourced appointments · number reputation health · pilot→paid conversion.

## 5. Risks

- **Telephony not yet live** (LiveKit runtime is the one unbuilt production component) — GTM sequencing must not promise real dials before it ships; simulator demos carry the early conversations.
- **BPO channel conflict** — a BPO pilot leaking our direct pricing to their client; mitigate with white-label tier and clean rate cards.
- **Voice quality bar** — AU accents on TTS must be rehearsed per campaign; budget premium voices (PAL per-node override) for pilots.
- **Regulatory drift** — ACMA AI guidance could land mid-year; our positioning benefits, but keep the AU country pack ahead of it.
