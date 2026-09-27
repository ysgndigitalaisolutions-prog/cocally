# India pricing — winning the first call-centre client

**Date:** 2026-07-25 · **Currency:** INR · **Buyer:** owner-operated Indian BPO, cost-sensitive
**Basis:** deep-research run (India-only), 14 verified competitor claims. FX ~₹83/USD.
**Supersedes** the global-benchmarked rate card in `2026-07-23-rate-card-inr.md` for the *first-client* offer.

> Key correction: the earlier ₹45 AI-connect (~₹30/AI-min) was **2× the top of the Indian AI-voice
> band and ~6× the cheap end**. Global platforms (Retell/Vapi) are the wrong comparison for an Indian
> buyer. This doc re-prices against what Indian vendors actually charge Indian call centres.

---

## 1. What Indian vendors actually charge (verified)

### AI voice, per minute

| Vendor | Rate (INR/min) | Notes |
|---|---|---|
| Smallest.ai (floor) | **₹4.2/min** | "as low as $0.05/min" |
| Smallest.ai (typical) | **₹7.5–17.5/min** | $0.09–0.21 depending on models |
| Bolna (market signal) | ~₹6/min | claim refuted in verify → treat as unconfirmed signal |
| Tabbly (market signal) | ~₹2.7–3.9/min | refuted → unconfirmed signal, but shows a sub-₹4 floor exists |
| **Accepted AI-voice band** | **~₹4–8/min wins, ₹15+ is premium** | |

### Per-outcome (exists in India)

- Caller Digital: **₹5–25 per connected call / outcome** (verified 2-1). So per-connect pricing is
  *real* in India — but at ₹5–25, **not** ₹45. My earlier number was off by the full band.

### Dialer / call-centre software, per seat/month

| Vendor | Price | Telephony bundled? |
|---|---|---|
| Trikon (hosted ViciDial) | **₹2.5/agent/hr ≈ ₹440/seat/mo** | No — software only |
| DialerIndia/Avyukta (rental) | ₹400–1,500/seat/mo | No |
| DialerIndia (DOT VoIP + dialer) | ₹2,200–4,100/seat/mo/shift | **Yes** |
| DialerIndia (combo) | ₹20,000/mo for 5 seats ≈ ₹4,000/seat | Yes |
| Knowlarity | ₹1,999–3,499/agent/mo | Partly; outbound ₹0.80–1.80/min extra |
| Exotel (Grow) | ~₹2,500/agent/mo + ₹0.60–1.50/min | No — minutes separate, DID ₹500 |
| Ozonetel | Asian pricing sales-only ($25–55 is NA/EU) | No |

### Telephony (India domestic outbound)

- Raw carrier: **₹0.30–0.80/min**. This stays on the BPO's own carrier / passes through at cost.

---

## 2. The value anchor — human tele-caller

- **Fully-loaded human agent: ₹8–20/min** (Tier-1/Tier-2, incl. salary, infra, mgmt, idle time).
- Salary: fresher ₹10–18k in-hand, 2–4 yr ₹20–35k; avg CTC ~₹36,655/mo + 13–15% employer.

**The pitch:** "Your human minute costs ₹8–20 fully loaded. Our AI minute costs ₹5, runs 24/7, and
your closers only touch the transfers." That single line is the whole sell — cheaper than the
cheapest human minute, no headcount.

---

## 3. Where we sit vs our COGS

- AI stack marginal cost: **₹2.87/AI-min**. Blended platform COGS: ₹1.29/dial.
- Fixed infra: ~₹34,100/mo (from rate-card doc) — must be covered by a base fee or minimum volume.
- Break-even on fixed at ₹5/min: 34,100 ÷ (5 − 2.87) ≈ **16,000 AI-min/mo** (~10,700 AI calls) —
  a real call centre clears this easily.

---

## 4. Recommended FIRST-CLIENT offer

Simple, per-minute, telephony left on their carrier. Priced to win the logo, still above COGS.

| Line | Price | Margin vs COGS |
|---|---|---|
| **AI talk time** | **₹5 / AI-minute** (billed per second) | ₹2.13/min ≈ 43% |
| Platform base fee | **₹20,000 / month** (covers fixed infra, waivable for pilot) | — |
| Human-agent dialer seat (if they use our CRM/dialer) | **₹800 / seat / month** | undercuts Knowlarity/Exotel 2–4× |
| Telephony | **their own carrier / pass-through at cost** (₹0.30–0.80/min) | not our line |
| Setup / onboarding | **₹0 for first client** | land-and-expand |

**Floor for negotiation:** ₹4/AI-min at committed volume (still ~28% margin). Don't go below ₹4.
**Premium anchor (don't lead with it):** we *could* justify ₹8–10/min on quality vs Smallest.ai's
typical ₹7.5–17.5 — but for the first client, ₹5 wins and proves the product.

### Why per-minute, not per-connect, for the first deal
- Indian buyers price AI in ₹/min and expect a low number. Per-minute is instantly comparable to
  Smallest.ai/Bolna and to their own human ₹8–20/min — we look cheap immediately.
- Per-connect (₹5–25 band exists) is a fine *expansion* model once trust is built, but for deal #1
  keep it to the unit they already benchmark.

### Simple monthly example to put in front of them
At 10,000 AI calls × 1.5 min = 15,000 AI-min:
- AI: 15,000 × ₹5 = **₹75,000** + base ₹20,000 = **₹95,000/mo** platform
- Their telephony (own carrier), their agents' salaries — separate, unchanged
- Replaces ~3–4 fronter seats (₹1.2–1.8 lakh of loaded labour) → **clear ROI on slide one**

---

## 5. Caveats

- Bolna ₹6/min and Tabbly ₹2.7–3.9/min were refuted in verification (secondary blog) — treat as
  directional signals, not quotes. Smallest.ai (₹4.2 floor) and the ₹5–25 per-connect band are the
  verified AI-voice anchors.
- Ozonetel India per-seat is sales-gated; the $25–55 figure is NA/EU, don't cite it to an Indian buyer.
- Telephony must stay a separate pass-through line — it is the BPO's carrier cost, and bundling it
  hides our clean ₹5/min story behind a scary all-in number.
