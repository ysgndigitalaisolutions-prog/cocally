# CoCally — Product-Market Fit Analysis

**Date:** 2026-07-23
**Also published as an interactive page:** https://claude.ai/code/artifact/f1e93b86-29cb-43a3-9fdd-7e6c96c6deab

> **Evidence tags:** `[V]` verified from a named primary/institutional source · `[S]` reputable
> secondary · `[E]` vendor-produced estimate — a working assumption, **not** evidence.

---

## 1. The problem, in numbers

| Figure | Metric | Source |
|---|---|---|
| **86%** | of unidentified calls go unanswered — **up from 80%** a year earlier | Hiya State of the Call 2026 `[V]` |
| **5.4%** | average B2B cold-call connect rate across 300M+ calls | Gong Labs `[S]` |
| **~27%** | of connections are the right party | industry mean `[E]` |
| **30–40%** | of an agent's shift lost to dial tones and voicemail without a dialer | vendor benchmark `[E]` |
| **13.7bn** | spam calls flagged in Q2 2025 alone (~150M/day) | Hiya `[V]` |

**What happens to 100 dials:**

```
Dials placed    ████████████████████████████████████████  100
Never answered  ██████████████████████████████████░░░░░░  ~86
Connected       █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ~14
Right party     █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   ~4
```

A human agent's genuinely productive time is a **single-digit percentage of dials**.

**The tailwind:** the unanswered rate rose 80% → 86% in a single year. The waste this product
removes is *growing* — the value proposition strengthens annually without shipping anything.

---

## 2. The solution — why the split is forced

In the verticals worth selling to (insurance, lending, solar) the **close** is regulated,
high-value or relationship-dependent — full automation is either illegal or loses money. Meanwhile
~90% of dialling reaches nobody and should never cost a human minute.

**The AI/human split is not a compromise. It is forced by the data.**

Three things make it one product rather than two:

1. **One lead database** — AI campaigns and human worklists draw from the same records, ownership
   partitioned per caller so 15 agents never collide.
2. **Two first-class dialing modes** — AI auto-dialer and human manual/preview, sharing one
   disposition taxonomy, recording store and compliance stack.
3. **One handoff that carries context** — at transfer the closer receives score, confirmed facts,
   live objection and suggested opener, **on screen**.

---

## 3. Competitive landscape — nobody in India sells this

| Vendor | Origin | Real dialer | AI outbound | Warm transfer w/ context | Humans dial same DB |
|---|---|---|---|---|---|
| **CoCally** | 🇮🇳 | ✅ | ✅ | ✅ | ✅ |
| Ozonetel | 🇮🇳 | ✅ | ✅ | ⚠️ claimed | ✅ * |
| SquadStack | 🇮🇳 | ⚠️ | ✅ | ✅ | ❌ *their* closers |
| Gnani.ai | 🇮🇳 | ⚠️ | ✅ | ⚠️ | ❌ |
| Convin.ai | 🇮🇳 | ❌ | ✅ | ⚠️ | ❌ |
| Exotel / Knowlarity | 🇮🇳 | ✅ | ❌ | ❌ | ✅ |
| Bolti / Tabbly / Caller Digital | 🇮🇳 | ❌ | ✅ | ❌ | ❌ |
| Yellow / Haptik / Uniphore | 🇮🇳 | ❌ | ✅ | ⚠️ | ❌ |
| **Convoso** | 🇺🇸 | ✅ | ✅ | ✅ | ✅ |
| **Regal.ai** | 🇺🇸 | ✅ | ✅ | ✅ documented | ✅ |
| Nooks / Orum / ReadyMode | 🇺🇸 | ✅ | ❌ no conversation | ❌ | ✅ |

\* Ozonetel owns both halves but ships them as **two separate products** — no unified campaign where
the AI dials, qualifies, and drops a scored live transfer into the same dialer's agent queue.

**The wedge:** even Regal.ai — the best-documented implementation globally — only *speaks* a
generated summary to the receiving agent. Nobody ships a screen-pop carrying transcript, intent
score, detected objection **and** recommended rebuttal at the transfer moment. That payload requires
owning both legs of the call, which is why it can't be bolted on.

**The window:** Ozonetel is the fast-follower risk — merging its two product lines is packaging
work, not engineering. Realistically **12–18 months**. Durable differentiation must live in the
handoff payload and blended unit-economics reporting, not in merely having both halves.

---

## 4. Who to pitch

| Buyer | Verdict | Why |
|---|---|---|
| **Lead-gen agencies** | ⭐ **Best first buyer** | Paid per lead/appointment, not per hour — AI savings become their margin. **No cannibalisation conflict.** They already measure cost-per-qualified-lead, the exact number this product moves. |
| **Outbound BPOs** | ⚠️ Structural conflict | They bill per seat/hour; a product that reduces seats attacks their own revenue. Sellable only as **capacity expansion for existing headcount** or margin defence on fixed-price contracts — never as headcount reduction. |
| **In-house sales teams** | Slower, stickier | Insurance renewals, lending, edtech. Highest retention, cleanest data access, but longer cycles. Approach after 2–3 reference accounts. |

---

## 5. Verticals ranked by fit

| Vertical | Fit | Lead / appointment value | Why |
|---|---|---|---|
| **Edtech admissions** 🇮🇳 | ★★★★★ | $25–70 CPL | 20–50k enquiry pools, 5–10× seasonal spikes, qualifying odds drop **21×** when response slips 5→30 min. Can't hire for a 7-week spike; can scale AI concurrency. |
| **Insurance renewals** 🇮🇳🇦🇺 | ★★★★★ | ₹110–125 (IN) · $50–150 transfer (US) | Existing customers = consented contact. Close is regulated and **must** be human — warm transfer *is* the product. |
| **Debt collection** 🇮🇳 | ★★★★☆ | 18–35% contingency | Highest dial:contact ratio of any vertical. India's NPAs shifting from few large accounts to mass retail/MSME — exactly where human collector economics break. |
| **Solar / home improvement** 🇦🇺 | ★★★★☆ | A$50–100 lead · A$400–800 appt | Highest lead value; quantified failure mode (**30–40% no-show**). But consent-only — see §6. |
| **Lending / cards** | ★★★★☆ | high LTV | Bajaj Finance already proved voice AI at scale in this vertical. |
| **Healthcare recall** | ★★★☆☆ | — | Fully consented, low compliance risk, clean ROI on no-show backfill. Smaller volumes. |
| **B2B SDR** | ★★☆☆☆ | $250–600/meeting | Crowded, lowest connect rates (3–10%), buyers AI-fatigued. **Avoid initially.** |

---

## 6. ⚠️ Regulatory constraints that change the plan

### Victoria has banned telemarketing for energy upgrades — this affects Aurora Solar VIC

Under the Victorian Energy Upgrades program: **telemarketing banned 1 May 2024**, **door-knocking
banned 1 Aug 2024**, later **extended to solar and energy-upgrade cold calls**. Consumer consent is
required *before* calling. `[V]` — Essential Services Commission Victoria.

**This doesn't kill the AU solar play, it redefines it:** the AI's job becomes **speed-to-lead on
consented enquiries, requalification of consented databases, and appointment confirmation** — not
cold outreach. Narrower, but far more defensible. **Confirm with counsel.**

### Australia — Do Not Call Register `[V]`

- Unsolicited marketing calls to registered numbers illegal without consent
- Lists must be scrubbed **at least every 30 days**
- Penalties to **A$250,000**
- **Exempt:** charities, educational institutions, government
- **Business numbers are not protected** → B2B remains open

**Implication:** DNCR scrubbing on a 30-day cycle and mandatory caller identification should be
**native platform features**. This is a moat against every US competitor.

### India — the addressable long tail `[V]`

TRAI lists ~**16,000 registered telemarketers**, but issued **731,000+ notices to unregistered ones
in 2025** — implying an enormous informal long tail. That gap is the SMB segment. DLT registration
and TRAI scrubbing are table stakes locally and absent from Convoso, Regal and Five9.

---

## 7. Revenue model

**Two billable units + telephony as visible pass-through:**

| Unit | Rate |
|---|---|
| Per dial (any outcome) | **₹1** — covers fixed infrastructure 1.8× |
| Per connected minute (AI or human) | **₹8–11** — India market band is ₹4–9/min |
| Telephony | **cost + 15%**, never marked up as platform revenue |

### Revenue per account

| Account | Dials/mo | Monthly revenue | Platform COGS | Margin | Annual |
|---|---|---|---|---|---|
| Small — 5 seats | 20,000 | ₹86,000 | ₹52,000 | 40% | ₹10.3L |
| **Mid — 15 seats** *(current deal)* | 60,000 | **₹2,06,800** | ₹77,144 | **63%** | **₹24.8L** |
| Large — 40 seats | 160,000 | ₹5,20,000 | ₹1,55,000 | 70% | ₹62.4L |

~44% of platform COGS is fixed, so **margin improves materially with account size**.

### Portfolio outlook

| Accounts | ARR |
|---|---|
| 1 mid (today) | ₹25L |
| 10 mid (year 1) | ₹2.5Cr |
| 30 mixed (year 2) | ₹7.4Cr |
| 100 mixed (year 3–4) | ₹25Cr |

**Market ceiling:** contact-centre AI is **$3.5–4.2B growing ~22% CAGR to $10–12B by 2030** — the
most reliable figure in this analysis (three independent research firms cluster tightly). India's
BPO services market: **$18–22B**.

### Alternative models worth testing

- **Per qualified lead** — ₹150–400 per qualified transfer. Aligns with agency economics; how
  SquadStack already sells. Higher risk, materially higher ceiling.
- **Outcome / contingency** — share of recovered value in collections (norm 18–35%). Hardest to
  sell, highest margin, near-impossible for a per-minute competitor to match.
- **White-label to agencies** — agencies resell AI voice at $0.20–0.35/min against ~$0.09 wholesale.
  Turns each agency into a distribution channel rather than a single account.

---

## 8. Honest gaps

1. **Product readiness.** Human manual dialing **does not yet place real calls** — it creates the
   record and stops. CLI pool isn't wired to the wire. Recording writes a transcript, not audio.
   Until these land, no BPO can retire its existing dialer. See
   `2026-07-23-human-dialing-requirements.md`.
2. **Evidence quality.** Every published ROI figure for AI voice in *outbound* is vendor-produced.
   The credible exception is **Bajaj Finance** — ₹1,600 crore in disbursals from AI-analysed calls,
   third-party reported. Use that; discard the "90% cost reduction" claims.
3. **No reliable seat-count TAM.** No authoritative count of outbound BPOs by seat size exists for
   India or Australia. TRAI's ~16,000 registered telemarketers is the closest hard number.
4. **Australia is smaller than it looks.** Third-party call centres: **A$1.9B, 11,040 employees,
   0.1% CAGR** — flat. The real AU pool is in-house teams (102,373 contact-centre roles) and
   lead-gen agencies. **India is where seat-based buyers concentrate.**

---

## 9. Recommended sequence

1. **Now — ship human dialing.** Real PSTN calls from the agent workspace, CLI on the wire,
   recording to storage. This gates the current deal and every BPO conversation after it.
2. **Next — prove one vertical end to end.** Take the solar account to a measured result: cost per
   booked appointment, and no-show rate before/after AI confirmation. One defensible case study is
   worth more than any deck — and would be the only non-vendor evidence in this category.
3. **Then — sell agencies, not BPOs.** No cannibalisation conflict, and they already measure
   cost-per-qualified-lead. Land three, then use them as distribution via a white-label tier.
4. **Build the moat.** DLT/TRAI + DNCR compliance native, Indian-language handling with mid-call
   code-switching, and blended AI+human cost-per-qualified-lead reporting. Convoso and Regal have
   none of these. Ozonetel could — which is why the reporting layer and handoff payload must be the
   differentiation, not merely having both halves.

---

**Sources:** vendor pricing pages; regulatory — ACMA/Do Not Call Register, Essential Services
Commission Victoria, TRAI; market research — Gartner, IBISWorld, ACXPA, Hiya, NASSCOM/IBEF, Grand
View Research, Fortune Business Insights. Revenue projections are illustrative models built on the
pricing analysis in `2026-07-23-cogs-60k-calls.md`, not forecasts.
