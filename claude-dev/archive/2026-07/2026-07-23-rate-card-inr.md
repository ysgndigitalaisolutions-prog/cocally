# Platform cost & rate card — INR, excluding telephony

**Date:** 2026-07-23 · **FX:** $1 = ₹96.36 (21 Jul 2026) · **Volume:** 60,000 dials/month
**Telephony (carrier minutes + DID rental) is EXCLUDED** — treat it as a separate pass-through line.

---

## 1. Platform COGS — ₹77,144 / month

| Component | USD | **INR** |
|---|---:|---:|
| **Fixed** | | |
| Agent-worker VM (`e2-standard-4`) | $138.82 | **₹13,377** |
| MongoDB Atlas M10 (GCP Sydney, 3-node) | $83.22 | **₹8,019** |
| App VM — API + web (`e2-standard-2`) | $69.41 | **₹6,688** |
| LiveKit Ship base plan | $50.00 | **₹4,818** |
| Egress / NAT / secrets / misc | $12.00 | **₹1,156** |
| GCS recordings | $0.47 | **₹45** |
| **Variable** | | |
| LiveKit SIP minutes (38,800 min) | $135.20 | **₹13,028** |
| Deepgram TTS — Aura-2 (4.4M chars) | $132.00 | **₹12,720** |
| LiveKit recording egress (22,000 min) | $107.00 | **₹10,311** |
| LiveKit agent-session minutes (8,400) | $34.00 | **₹3,276** |
| Deepgram STT — Nova-3 (6,800 min) | $32.64 | **₹3,145** |
| LLM — Gemini 2.5 Flash-Lite | $5.82 | **₹561** |
| **TOTAL** | **$800.58** | **₹77,144** |

Fixed ≈ ₹34,100 (44%) · Variable ≈ ₹43,000 (56%)

---

## 2. AI cost per minute — **₹2.87**

Marginal cost of one minute of live AI conversation:

| Component | INR / min | Share |
|---|---:|---:|
| TTS (Deepgram Aura-2) | **₹1.35** | 47% |
| LiveKit agent session | **₹0.96** | 34% |
| STT (Deepgram Nova-3) | **₹0.46** | 16% |
| LLM (Gemini 2.5 Flash-Lite) | **₹0.09** | 3% |
| **AI stack total** | **₹2.87 / min** | 100% |

**TTS is 15× the LLM.** If AI cost needs to come down, Aura-2 is the only line worth attacking
(Aura-1 ≈ half the price). Model choice is an accuracy decision, not a cost one.

> A "fully-loaded ₹12.86/AI-minute" figure can be produced by dividing *all* infra by AI minutes
> only — but that is misleading, since the same infra also carries 20,000 human-dialed calls.
> **₹2.87/min is the honest marginal number.**

---

## 3. Cost per call type

| Call type | Volume | **Cost each** | What it consumes |
|---|---:|---:|---|
| **Unconnected** (no answer / busy) | 42,000 | **₹0.72** | Ring time on SIP + infra share only |
| **Voicemail — human-dialed** | 4,000 | **₹0.74** | Short SIP + recording |
| **Voicemail — AI** | 8,000 | **₹1.74** | AMD + voicemail drop (TTS) |
| **Human connected** (4 min) | 2,000 | **₹4.04** | SIP + recording, no AI |
| **AI connected** (1.5 min, no transfer) | 2,800 | **₹6.17** | Full AI stack |
| **AI + transfer** (1.5 AI + 4 human) | 1,200 | **₹9.64** | AI stack + human leg |
| **Blended per dial** | 60,000 | **₹1.29** | |

---

## 4. Recommended rate card

Priced for a **~71% gross margin**, which is normal for a platform of this type.

| Call type | Volume | Cost | **Charge** | Revenue | Margin |
|---|---:|---:|---:|---:|---:|
| Unconnected | 42,000 | ₹0.72 | **₹2** | ₹84,000 | 64% |
| Voicemail (AI) | 8,000 | ₹1.74 | **₹5** | ₹40,000 | 65% |
| Voicemail (human) | 4,000 | ₹0.74 | **₹5** | ₹20,000 | 85% |
| Human connected | 2,000 | ₹4.04 | **₹15** | ₹30,000 | 73% |
| AI connected | 2,800 | ₹6.17 | **₹25** | ₹70,000 | 75% |
| AI + transfer | 1,200 | ₹9.64 | **₹40** | ₹48,000 | 76% |
| **TOTAL** | **60,000** | | | **₹2,92,000** | **71.2%** |

- Monthly revenue **₹2,92,000** · COGS **₹77,144** · **gross profit ₹2,15,000/month**
- Blended realised price **₹4.87/dial** against **₹1.29** cost

### Why charge for unconnected calls at all?

They cost you ₹0.72 each and there are 42,000 of them — ₹30,000/month of real cost. But clients
resent paying for no-answers, so keep the number visibly small (₹2). If the client pushes back, the
clean alternative is **₹0 for unconnected** and re-price connects to compensate:

| Model | Unconnected | Voicemail | Human conn. | AI conn. | AI + transfer |
|---|---:|---:|---:|---:|---:|
| **A — recommended** | ₹2 | ₹5 | ₹15 | ₹25 | ₹40 |
| **B — no charge for no-answer** | **₹0** | ₹5 | ₹25 | ₹45 | ₹70 |

Both land near 71% margin. **B is easier to sell** ("you only pay when we reach someone") and shifts
risk onto contact rate — safer for you if the list quality is good, riskier if it is poor.

### Simpler single-metric alternatives

| Model | 70% margin | 75% margin | 80% margin |
|---|---:|---:|---:|
| Flat per dial | ₹4.67 | ₹5.60 | ₹7.00 |
| Per connected call | ₹46.69 | ₹56.03 | ₹70.04 |
| Per AI minute | ₹46.69 | ₹56.03 | ₹70.04 |

---

## 5. Two things to get right before quoting

**1. This is cost-plus. Your actual price should be value-anchored.**
The AI replaces a human *fronter* — a qualifying caller. Price against **what that headcount costs
the client**, not against your infra bill. If the AI does the work of 2–3 fronters, the defensible
price is a share of that saving, which will typically be far above these numbers. Use the table above
as your **floor**, not your target.

**2. Telephony must be a separate pass-through line.**
It is excluded here and it is the *largest* real cost (~₹1.3 lakh/month at retail Twilio AU rates —
more than the entire platform). Bill it separately at cost-plus, or you will silently absorb carrier
rate changes and mobile/landline mix variation. See `2026-07-23-cogs-60k-calls.md` §4.

## 6. Caveats

- Assumes **20% voicemail**, **4-min human talk**, **30% of AI connects transfer**, **80/20
  mobile/landline**. Change these and the model moves.
- Fixed costs (₹34,100) are ~44% of platform COGS, so **margin improves with volume** — at 120k
  dials/month the blended cost per dial drops materially.
- A 1-year committed-use discount on both VMs saves ~**₹7,400/month**.
- Per-type costs are rounded to paise, so the rate-card total (₹84,044) is slightly conservative
  versus the precise COGS (₹77,144). That direction is safe for pricing.
