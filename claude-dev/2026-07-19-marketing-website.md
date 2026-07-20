# Session log — 19 July 2026: Marketing website (co-cally.com)

## What was built

New top-level `website/` folder: a static, dependency-free marketing site for **co-cally.com** (domain held at GoDaddy). No framework, no build step — `index.html` + `styles.css` + `main.js` + SEO assets, deployable to any static host.

## Page structure (single page)

1. **Hero** — "AI dials. AI qualifies. Your closers close." with an animated live-call simulation: typing bubbles, live intent-score bar climbing, captured-fact chips, then a warm-transfer card popping in with the 230ms bridge line. Loops continuously; static final-state fallback under `prefers-reduced-motion`.
2. **Stats band** — animated counters: 230ms handoff, 100% auto-QA, 1,200+ dials/day, ≤3 days to first dial.
3. **How it works** — 5 steps (dial → AMD → qualify → live score → warm transfer).
4. **Capabilities** — 8 cards with cursor-tracking glow (voice agents, flow builder, transfer, compliance, QA/recording, analytics, PAL/bring-any-vendor, enterprise core).
5. **Comparison** — CoCally vs DIY stack vs traditional call centre table (the "one-stop vs duct-taped stack" argument) + three callouts.
6. **Onboarding** — Day 1 / Day 2 / Day 3 timeline with animated progress line ("2–3 days, really").
7. **Pricing** — Launch $499/mo + $0.12/AI-min · Scale $999/mo + $0.10/AI-min (featured) · Enterprise custom. **These are placeholder market-facing numbers, NOT from a rate card** — internal COGS (₹3.63/AI-min marginal) supports the margin, but confirm before launch. No per-seat fees is the stated model.
8. **FAQ** (accordion, mirrors FAQPage JSON-LD) → final CTA → footer.

## SEO / AI-SEO

- JSON-LD: Organization, WebSite, SoftwareApplication (AggregateOffer), FAQPage.
- Full meta set: canonical `https://co-cally.com/`, OG + Twitter cards with generated 1200×630 `assets/og-image.png` (Pillow script, session scratchpad).
- `robots.txt` explicitly allows AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot); `sitemap.xml`; **`llms.txt`** machine-readable product summary for answer engines.
- Semantic HTML (single h1, ordered sections, aria labels), Google Fonts (Sora/Inter/JetBrains Mono).

## Decisions

- **Static over Next.js**: fastest possible loads, trivially hostable (Cloudflare Pages/Vercel/GoDaddy), SEO needs met with hand-written meta/JSON-LD; the product app is separate (`apps/web`), so the marketing site stays independent.
- **Did not publish internal COGS** — pricing page uses indicative tiers with "finalised on a discovery call" note.
- All CTAs are `mailto:hello@co-cally.com` — mailbox does not exist yet; needs GoDaddy/Workspace setup (in README checklist).

## Deployment

`website/README.md` has: local preview command, three deploy options (Cloudflare Pages recommended, Vercel, GoDaddy cPanel) with exact GoDaddy DNS records, and a post-launch SEO checklist (Search Console, Bing, rich-results test, Lighthouse).

## Revision (same day) — clarity + brand consistency

User feedback: offer wasn't instantly understandable, and colors should match the platform. Changes:

- **Rethemed to the product palette** from `apps/web/src/app/globals.css`: navy bg `#0b1220`, surfaces `#111a2e`/`#182238`, **amber accent `#f5a623`**, green `#34d399` (good), orange `#fb923c` for "hot". Old violet/teal palette removed everywhere (index, styles, favicon, manifest, OG image).
- **Plain-language hero**: "AI agents call & qualify your leads. Your team just closes." + a literal explainer sub ("Upload a lead list… live call transfers to your salesperson…"). Eyebrow now names the category: "AI outbound call-centre platform".
- **New "what CoCally does" pipeline strip** directly under the hero: Upload leads → AI calls them → Hot leads transfer live → You close & measure. Four tiles with arrows — the offer is scannable without reading anything else.
- Comparison heading simplified to "One platform instead of five separate tools". OG/Twitter titles + OG image regenerated to match.

## Revision 2 (same day) — research-driven positioning revamp

Full market research (four parallel web-research agents; synthesis in [`2026-07-19-market-research-and-positioning.md`](./2026-07-19-market-research-and-positioning.md)) drove a repositioning of the whole site:

- **New lead message: speed-to-lead.** Hero is now "AI calls every lead in seconds. Your team only talks to buyers." — the 21×-qualification-within-5-minutes stat is the sharpest pain in the market. Hero sim reframed from cold outbound to a web-lead callback ("called 38s after form fill"); first AI line references the form fill.
- **New "Why now" section** (#why): four researched pain stats (42-hr avg lead response, $110K+ SDR cost, >95% Spam-Likely unanswered, 1–2% QA sampling) with source attributions, plus "hiring/dialing harder doesn't fix this" callouts.
- **New "Proof / receipts" section** (#proof): post-11x/Air.ai trust positioning — recording, transcript, score history, auto-QA, compliance log, per-call cost; includes a mock "call receipt" panel (new CSS).
- **Compliance elevated to its own section** (#compliance): "can't publish / can't dial / can't call illegal" framing, AI self-disclosure, zero-abandoned-calls-structurally, consented-calling stance, caller-ID reputation ops.
- **New use-cases section**: speed-to-lead, database reactivation, appointment confirmation (no-show stat), B2B front line.
- **Comparison rebuilt** as CoCally vs Voice-AI API (Vapi/Retell/Bland) vs dialer+SDR floor vs BPO, incl. cost-per-qualified-conversation row and $150–600/appointment BPO anchor.
- **Honesty fixes:** all "230ms" claims replaced with "sub-second"/"under a second" (the figure was a simulation wall-clock measurement, per the ops-map validation); stats band now leads with "<60s to first dial" and "0 abandoned calls"; no fabricated customers/testimonials anywhere.
- **Pricing:** unchanged tiers, added "no seat minimums" and Enterprise outcome-aligned (per-qualified-transfer) pricing line, plus BPO/SDR cost anchors in the note.
- `llms.txt`, meta/OG/Twitter/JSON-LD (incl. FAQ schema) all rewritten to match.
- **Copy pass (user feedback: "too verbose"):** every section cut to scannable length — card blurbs to one line, FAQ answers to 1–2 sentences, comparison trimmed to 6 rows, duplicate callout strips removed (replaced with single `.pain-verdict` punch lines). Visible body text ~1,550 words, down from ~2,600.

## Revision 3 (same day) — demo form + AUD pricing

- **Demo-request form** (`#demo`, replaces the final CTA buttons): name, work email, phone/company (optional), free-text. Posts to **FormSubmit.co → nithinyakateela@gmail.com** (no backend needed). Includes honeypot (`_honey`), `_captcha=false`, table email template, redirect to new `thanks.html` (noindex). **Activation required:** FormSubmit sends a one-time activation email to the Gmail on the first submission — click it or nothing delivers. After activation, FormSubmit provides a random alias string that can replace the raw address in the form action (the Gmail is currently visible in page source). All CTAs across the site (nav, hero, pricing cards, footer) now point to `#demo`; every `mailto:` removed (hello@ mailbox still doesn't exist).
- **Pricing switched to AUD and lowered** (user feedback "too much and in dollars"): Launch **A$249/mo + from A$0.15/AI-min**, Scale **A$599/mo + from A$0.12/AI-min**, Enterprise custom/outcome-aligned. Margin check vs COGS: AI-leg ≈ US$0.037/min ≈ A$0.056 → A$0.12–0.15 keeps ~60%+ gross margin on minutes; platform fees cover fixed-cost share. Still placeholder numbers — confirm before launch. Receipt mock now shows A$1.20 all-in call cost; SDR pain stat localized to A$150K+.
- JSON-LD (offers → AUD 249), FAQ schema, llms.txt updated to match.
- **Included minutes added** (user request): Launch bundles **500 AI min/mo free** (COGS ≈ A$28), Scale **2,000 AI min/mo free** (≈ A$112) — then the per-minute rate. Enterprise = custom bundles. Compliance section also compressed from 6 cards to 3 in this pass.

## Revision 4 (same day) — BPO strip

Added a compact "For BPOs calling into Australia" banner (`#bpo`, after use-cases): "Keep your clients. Cut your seats. Fix your compliance." — white-label AI front line, multi-client floors, DNCR/ACMA enforcement, per-call evidence packs; CTA to the demo form. Footer link added; llms.txt updated. GTM strategy behind it: [`2026-07-19-aus-gtm-strategy.md`](./2026-07-19-aus-gtm-strategy.md) (BPO channel = priority motion).

## Follow-ups

- Confirm real pricing numbers before launch.
- Create `hello@co-cally.com` mailbox.
- Swap mailto CTAs for a form / Calendly once one exists.
- Add real logos/testimonials band when pilot customers can be named.
