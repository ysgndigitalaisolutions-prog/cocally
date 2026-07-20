# CoCally — COGS & AI Cost Model (Phase-1 Pilot)

> Written 19 July 2026. Rates verified against vendor pricing pages as of today. FX: **$1 = ₹98**. All buffers stated explicitly. Companion to [`2026-07-19-deployment-strategy.md`](./2026-07-19-deployment-strategy.md).
>
> **Scope: telephony (telco termination) charges are EXCLUDED — billed separately.** Twilio/Telnyx rates are listed in §0 for reference only (for reconciling the separate telco bill); they appear in no COGS line below.

## 0. Verified vendor rates (the inputs)

| Vendor | Item | Rate (USD) | Notes |
|---|---|---|---|
| Twilio | Outbound AU **mobile** | $0.0750/min | Pay-as-you-go; volume discounts kick in automatically |
| Twilio | Outbound AU **landline** | $0.0252/min | |
| Twilio | AU local number | $3.00/mo + $0.01/min inbound | CLI pool numbers |
| Telnyx | Outbound (general) | from ~$0.009/min | AU-specific rates need their price sheet; typically 30–50% below Twilio |
| LiveKit Cloud | SIP participant minute | $0.003–0.004/min | |
| LiveKit Cloud | WebRTC participant minute | $0.0004–0.0005/min | Agent worker + human agent legs |
| Deepgram | Nova-3 **streaming STT** | $0.0077/min | Billed per second; $200 free credit |
| Deepgram | Aura-2 **TTS** | $0.030/1k chars | $0.027/1k on Growth |
| ElevenLabs | Flash TTS (API) | ~$0.05/1k chars | Premium voice option |
| ElevenLabs | Agents (bundled per-min) | $0.08–0.10/min | Not used — we run our own pipeline |
| Google | **Gemini 2.5 Flash-Lite** | $0.10 in / $0.40 out per MTok | **Default conversation LLM** |
| Google | **Gemini 2.5 Flash** | $0.30 in / $2.50 out per MTok | Premium conversation option (deprecates 2026-10-16 — plan the successor) |
| Anthropic | Claude Haiku 4.5 | $1 in / $5 out per MTok | Reference only; ~10× Flash-Lite input |
| Firebase Auth | **Phone OTP SMS — AU** | ~$0.06/verification | Chosen channel (agents + admins) |
| Firebase Auth | **Phone OTP SMS — India** | ~$0.01/verification | India-based floor staff / admins |

## 1. Usage assumptions per AI-call minute

- ~2.5 conversation turns per elapsed minute.
- AI speaks ~40% of the time → **~400 TTS characters per elapsed minute**.
- STT streams continuously on the customer leg → billed for full elapsed duration.
- LLM per turn: ~2.5k input tokens (system prompt rebuilt each turn + rolling history + utterance), ~120 output tokens (`maxTokens 400` cap, typical replies shorter). Priced **uncached** as the conservative base; prompt caching on the stable prompt prefix realistically cuts LLM cost 30–40%.
- Summary + scoring LLM roles add ~25% on top of conversation LLM.
- Telco reference (for the separate bill): 80/20 mobile/landline mix on Twilio AU blends to ~$0.065/min — **not included in any line below**.

## 2. Per-minute COGS — AI leg (default stack, ex-telco)

Default stack: **LiveKit Cloud + Deepgram Nova-3 (STT) + Deepgram Aura-2 (TTS) + Gemini 2.5 Flash-Lite**.

| Component | Math | USD/min | ₹/min |
|---|---|---|---|
| LiveKit (SIP + agent leg + recording egress) | ~$0.004 + ~$0.0005 + egress | $0.0080 | ₹0.78 |
| STT — Deepgram Nova-3 streaming | flat | $0.0077 | ₹0.75 |
| TTS — Deepgram Aura-2 | 400 chars × $0.030/1k | $0.0120 | ₹1.18 |
| LLM — Gemini 2.5 Flash-Lite (conversation) | 2.5 turns × (2.5k in × $0.10/M + 120 out × $0.40/M) | $0.0007 | ₹0.07 |
| LLM — summary + scoring roles | +25% of conversation LLM | $0.0002 | ₹0.02 |
| GCS recording storage + ops | ~1 MB/min + writes | $0.0010 | ₹0.10 |
| **Subtotal** | | **$0.0296** | **₹2.90** |
| **Buffer +25%** (retries, price drift, longer AI turns, egress uncertainty) | | **$0.0370** | |
| **Planning number — AI leg** | | **≈ $0.037/min** | **≈ ₹3.63/min** |

Cost order is now **TTS (41%) → LiveKit (27%) → STT (26%) → LLM (3%)**. Moving Haiku 4.5 → Flash-Lite cut the LLM lines by ~90% (₹0.96 → ₹0.09/min) and took ~₹1.07/min off the AI leg. **The LLM is no longer worth optimizing** — prompt caching would now save under ₹0.03/min. TTS and STT are the only AI lines that matter.

### Variants

| Stack variant | Change | USD/min (buffered) | ₹/min |
|---|---|---|---|
| **Default / Basic** (above) | — | $0.037 | ₹3.63 |
| **Premium** | ElevenLabs Flash TTS ($0.020/min) + Gemini 2.5 Flash conversation (~$0.003/min LLM incl. roles) | $0.051 | ₹5.00 |
| **Reference — Claude Haiku 4.5 instead** | +$0.0089/min LLM | $0.048 | ₹4.70 |

## 3. Per-minute COGS — human-agent leg (post-transfer, ex-telco)

After warm transfer the AI pipeline (TTS/LLM) stops; LiveKit + recording continue. STT stays on for the QA transcript (on by default).

| Component | USD/min |
|---|---|
| LiveKit (SIP + human agent WebRTC + egress) | $0.0080 |
| STT for QA transcript (optional, on by default) | $0.0077 |
| GCS | $0.0010 |
| Subtotal | $0.0167 |
| **Buffered +15%** | **≈ $0.019/min ≈ ₹1.90/min** |

## 4. Fixed monthly costs (prod)

| Item | USD/mo | ₹/mo |
|---|---|---|
| App VM `e2-standard-2` + disk (24/7) | $55 | ₹5,390 |
| Agent-worker VM `e2-standard-4` | $110 | ₹10,780 |
| MongoDB Atlas M10 (Sydney) | $60 | ₹5,880 |
| LiveKit Cloud base plan (Ship tier) | $50 | ₹4,900 |
| GCS, egress, snapshots, static IP | $15 | ₹1,470 |
| Secret Manager, Artifact Registry, Logging | $10 | ₹980 |
| Firebase phone OTP SMS (agents + admins — see note) | $15 | ₹1,470 |
| DNS/domain/misc | $5 | ₹490 |
| **Subtotal** | **$320** | **₹31,360** |
| **Buffer +20%** | | |
| **Fixed total** | **≈ $385/mo** | **≈ ₹37,700/mo** |
| Staging environment (optional, small sizing) | +$35 | +₹3,430 |

**SMS OTP sizing — the one line that scales with headcount, so set the re-auth policy deliberately.** AU SMS is **$0.06/verification**; India is **$0.01**.

| Re-auth policy | 30 agents (AU numbers) | Monthly SMS cost |
|---|---|---|
| Every login (daily × 22 days) | 660 SMS | ~$40 (₹3,900) |
| **Weekly / on new device** (recommended) | ~130 SMS | **~$8 (₹780)** |
| Weekly, India numbers | ~130 SMS | ~$1.30 (₹130) |

The $15/mo line above budgets weekly re-auth on AU numbers plus admin logins and headroom. Achieve it with **long-lived refresh tokens** — the session persists so the agent isn't re-OTP'd each shift; a fresh SMS is triggered only weekly, on a new device, or after an explicit logout. If agents log in on shared floor machines (forcing per-shift auth), budget the ~$40/mo row instead. India-based staff are effectively free at $0.01/SMS.

## 5. Support

Flat **₹25,000/mo** (≈ $255/mo) as specified.

## 6. Monthly total — volume scenarios

Volume model: connects/day × avg AI-conversation length + transfers × avg human-talk length, 22 working days.

| | Scenario A — pilot | Scenario B — ramped |
|---|---|---|
| Dials/day | 500 | 1,200 |
| Connects (40%) | 200/day | 480/day |
| AI minutes (avg 3 min/connect) | **13,200/mo** | **31,700/mo** |
| Transfers (15% of connects) × 6 min human | **4,000/mo** | **9,500/mo** |
| AI-leg variable (× $0.037) | $488 | $1,173 |
| Human-leg variable (× $0.019) | $76 | $181 |
| **Variable subtotal (ex-telco)** | **$564** | **$1,354** |
| Fixed (buffered, incl. SMS OTP) | $385 | $385 |
| Support | $255 (₹25k) | $255 (₹25k) |
| **Monthly total (USD, ex-telco)** | **≈ $1,204** | **≈ $1,994** |
| **Monthly total (INR @ ₹98)** | **≈ ₹1.18 lakh** | **≈ ₹1.95 lakh** |
| Effective cost per AI-minute (all-in, ex-telco) | ₹8.9/min | ₹6.2/min |
| Cost per connect (all-in, ex-telco) | ₹26.8 | ₹18.5 |

The all-in per-minute number falls as volume grows because fixed + support amortize; the pure marginal COGS stays ≈ ₹3.63/min (AI leg).

*Telco reference (billed separately, not in the totals): at Twilio's blended ~$0.065/min the same volumes would add ≈ $1,120/mo (₹1.10L) in Scenario A and ≈ $2,680/mo (₹2.63L) in Scenario B — larger than the entire platform COGS, so whoever holds the telco bill should negotiate it.*

## 6b. Pricing tiers — Basic vs Premium, 5k → 20k AI minutes/month (ex-telco)

Stack definitions:
- **Basic** = Deepgram Nova-3 STT + Deepgram Aura-2 TTS + **Gemini 2.5 Flash-Lite** → **$0.037/min** AI leg.
- **Premium** = Deepgram Nova-3 STT + ElevenLabs Flash TTS + **Gemini 2.5 Flash** → **$0.051/min** AI leg.
- Human-agent leg (same for both): **$0.019/min**, volume assumed at **30% of AI minutes** (pilot-observed transfer ratio; linear if it shifts).
- Every tier includes fixed infra **$385/mo** (buffered, incl. SMS OTP) + support **₹25,000 ($255)/mo** = **$640/mo**. Telco excluded throughout.

### Basic stack

| AI min/mo | Human min | Variable | Fixed+Support | **Total USD** | **Total INR** | All-in ₹/AI-min |
|---|---|---|---|---|---|---|
| 5,000 | 1,500 | $214 | $640 | **$854** | **₹83,700** | ₹16.7 |
| 10,000 | 3,000 | $427 | $640 | **$1,067** | **₹1.05 L** | ₹10.5 |
| 15,000 | 4,500 | $641 | $640 | **$1,281** | **₹1.26 L** | ₹8.4 |
| 20,000 | 6,000 | $854 | $640 | **$1,494** | **₹1.46 L** | ₹7.3 |

### Premium stack

| AI min/mo | Human min | Variable | Fixed+Support | **Total USD** | **Total INR** | All-in ₹/AI-min |
|---|---|---|---|---|---|---|
| 5,000 | 1,500 | $284 | $640 | **$924** | **₹90,600** | ₹18.1 |
| 10,000 | 3,000 | $567 | $640 | **$1,207** | **₹1.18 L** | ₹11.8 |
| 15,000 | 4,500 | $851 | $640 | **$1,491** | **₹1.46 L** | ₹9.6 |
| 20,000 | 6,000 | $1,134 | $640 | **$1,774** | **₹1.74 L** | ₹8.5 |

Notes:
- The fixed infra footprint (one app VM + one `e2-standard-4` worker VM) **holds through 20k min/mo** — 20k min ≈ 900 min/day ≈ peak concurrency well under the worker's ~40-session ceiling. No step-up in fixed cost across these tiers.
- The Basic↔Premium gap is now only **~₹1.40/min** (it was ₹3.35/min on Claude models) — because with Flash-Lite vs Flash the LLM difference is negligible and TTS carries nearly the whole delta. Premium is effectively "ElevenLabs voice", not "smarter model".
- A mixed mode (premium TTS only on conversion-critical flow nodes via the PAL per-node override) lands between the two tables.
- Beyond 20k min/mo: fixed adds a second worker VM (~$110) around 40–50k min/mo; everything else stays linear.

## 7. Where the money goes & levers, in order of impact

1. **TTS (~41% of AI-leg COGS)** — now the dominant line. The PAL's per-node override lets you run Aura-2 on qualification nodes and reserve ElevenLabs for conversion-critical moments; that choice alone is the whole Basic↔Premium delta.
2. **STT (~26%)** — Deepgram Growth tier ($0.0065/min vs $0.0077) once volume justifies the annual commit; ~₹0.12/min.
3. **QA STT on the human leg** — it's ~45% of the human-leg cost; sample-based QA (transcribe 50% of human legs) halves that line if 100% auto-QA isn't contractually required.
4. **SMS OTP re-auth policy** — the only fixed line that scales with headcount. Long-lived refresh tokens (weekly re-OTP) hold it near ₹780/mo; per-login auth on AU numbers pushes it to ~₹3,900/mo. Set this deliberately, especially if agents share floor machines.
5. **LLM — no longer a lever.** At Flash-Lite rates the entire LLM spend is ₹0.09/min. Prompt caching, model-swapping, and token trimming would each save single paise. Spend the effort on conversation quality instead; if quality demands Gemini 2.5 Flash or Claude on some nodes, the cost is affordable (see variants).
6. **Telco (separate bill)** — still the biggest number overall; Telnyx or Twilio committed-use for AU mobile is worth more than every platform lever combined.

**Deprecation watch:** Gemini 2.5 Flash retires **2026-10-16**. Flash-Lite has no announced retirement, but the PAL's adapter registry + fallback chain means a model swap is a config change, not a code change — keep a second adapter (Claude Haiku 4.5 or the next Flash generation) configured in the chain as the failover hop.

## 8. Per-call billing anatomy — who meters what

> Added while validating the transfer model. §2/§3 give per-minute rates by *leg*; this section explains what is actually metering during a call, because several meters run **concurrently on the same call** and that is easy to miss when reading the leg tables.

### The room, concretely

One call = one LiveKit room with up to three participants:

| Participant | How it joins | Present for | LiveKit meter |
|---|---|---|---|
| **Customer** | SIP participant — LiveKit dials out through the Twilio/Telnyx trunk, presenting the selected CLI | **The whole call** | SIP participant-minute (~$0.003–0.004/min) |
| **AI agent** | Worker VM process, joins **outbound** over WebRTC, dispatched by LiveKit agent dispatch | AI leg only | WebRTC participant-minute (~$0.0004–0.0005/min) |
| **Human agent** | Browser, joins the **same room** over WebRTC on transfer accept | Human leg only | WebRTC participant-minute (~$0.0004–0.0005/min) |

Plus **egress**: recording tracks written directly to GCS, metered for the duration they run.

The transfer is a participant joining a room that already exists — not a new call. Nothing is re-dialled, no second PSTN leg is created, no DID is involved. This is why bridge dead-air can be low: it's a WebRTC join and track subscription, not call setup.

### Two meters run on the customer leg, not one

This is the single most missed point:

- **The carrier (Twilio/Telnyx)** bills the PSTN minutes — the actual phone call.
- **LiveKit** separately bills the SIP participant-minute — the bridge between PSTN and the room.

Both run for the **entire call duration, including the human-talk portion.** The carrier bill does not stop at transfer. §3's human-leg table ($0.019/min) is ex-telco like the rest of the doc, so the true marginal cost of a human-talk minute is **$0.019 + ~$0.065 = ~$0.084/min** — roughly 4.4× what the table alone implies.

### Worked example — one transferred call (3 min AI + 6 min human)

| Line | Math | USD | INR |
|---|---|---|---|
| AI leg (ex-telco, buffered §2) | 3 × $0.037 | $0.111 | ₹10.9 |
| Human leg (ex-telco, buffered §3) | 6 × $0.019 | $0.114 | ₹11.2 |
| **Platform subtotal (ex-telco)** | | **$0.225** | **₹22.1** |
| Telco PSTN (separate bill) | 9 × $0.065 | $0.585 | ₹57.3 |
| **True all-in per transferred call** | | **≈ $0.81** | **≈ ₹79** |

**Telco is ~72% of the true cost of a transferred call.** Every platform-side lever in §7 operates on the remaining 28%. This reinforces §7 item 6 — carrier rate negotiation outweighs every other optimization combined, and the ex-telco framing used throughout this doc systematically understates true cost by ~3.6× on transferred calls. Anyone reading the totals needs that stated.

### Does the AI keep listening after transfer?

**Default: no, and the AI should fully *leave* the room rather than mute.** The reason is capacity, not billing. A muted AI participant costs ~$0.0005/min — negligible. But if the worker *process* stays attached, it holds a **job slot on the worker VM**, and that is the scarce resource: ~10–20 concurrent sessions per 4 vCPU (architecture §3). Holding slots through 6-minute human legs would cut effective dialling concurrency by more than half and force a second worker VM far earlier than the ~40–50k min/mo threshold in §6b.

**So: on transfer accept, the AI publishes its final state and disconnects.** "Mutes/exits" in architecture §8 should be read as *exits* — worth making explicit when the LiveKit runtime is built, because muting is the easier implementation and the expensive mistake.

### The human-leg QA transcript should be batch, not streaming

§3 carries streaming STT ($0.0077/min) on the human leg for the QA transcript, and §7 item 3 notes it's ~45% of human-leg cost. But QA has **no real-time requirement** — the transcript is read after the call. Two changes follow:

1. **Transcribe the human leg from the recording, post-call, in batch.** Deepgram pre-recorded is materially cheaper than streaming (roughly 40–45% less — *verify against the current price sheet before relying on this*).
2. **Batch transcription needs no participant in the room**, so it doesn't hold a worker slot either.

Combined with sampling (§7 item 3), the human-leg STT line is the easiest remaining saving in the model — and unlike the LLM lines, it's still worth chasing because the human leg is twice the duration of the AI leg in the §6 volume assumptions.

### The one case for keeping the AI listening — a premium feature, not a default

Keeping the full AI pipeline running through the human leg would enable **real-time agent assist**: live compliance flagging, next-best-action, automatic objection surfacing in the agent script panel. That is a genuinely differentiated product capability and directly complements the agent-script work (ops map C12).

Cost it honestly before promising it: it puts STT + LLM back on the human leg (~$0.008–0.010/min on top) **and** holds a worker slot for the call's full duration, which is the larger constraint. Price it as a premium tier, and default it off.

## Assumptions to revisit after 2 weeks of pilot data

- Turns/min (2.5) and chars/min (400) — measure from `providersUsed` per-call cost records already captured by the engine.
- 80/20 mobile/landline mix — measure from lead-list line-type inference.
- 3-min average AI conversation and 15% transfer rate — these drive everything; the model is linear in both.
