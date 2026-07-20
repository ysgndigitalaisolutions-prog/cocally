# CoCally marketing website — co-cally.com

Static, dependency-free marketing site. No build step, no framework — deploy the folder anywhere that serves static files.

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-page site: hero (animated live-call demo), how-it-works, capabilities, comparison, 2–3-day onboarding timeline, pricing, FAQ |
| `styles.css` | All styling — dark theme, gradients, glassmorphism, scroll animations, fully responsive, `prefers-reduced-motion` respected |
| `main.js` | Live-call simulation loop, scroll reveals, animated counters, nav |
| `robots.txt` | Allows all crawlers incl. AI bots (GPTBot, ClaudeBot, PerplexityBot…), points to sitemap |
| `sitemap.xml` | Single-URL sitemap — update `lastmod` when you edit content |
| `llms.txt` | AI-SEO: machine-readable product summary for LLM crawlers/answer engines |
| `site.webmanifest` | PWA manifest (name, theme colour, icon) |
| `assets/favicon.svg` | Brand mark |
| `assets/og-image.png` | 1200×630 social share card (regenerate: see git history for the Pillow script) |

## Preview locally

```bash
cd website
python3 -m http.server 8080
# open http://localhost:8080
```

## Deploying (pick one)

The site is plain static files, so any of these work. Recommended: **Cloudflare Pages** or **Vercel** (free tier, global CDN, automatic HTTPS) rather than GoDaddy's own hosting.

### Option A — Cloudflare Pages (recommended)
1. Push this repo to GitHub, create a Pages project, set the build output directory to `website/` (no build command).
2. Add custom domain `co-cally.com` (+ `www.co-cally.com`) in the Pages project.
3. In GoDaddy DNS, either move nameservers to Cloudflare (best — free CDN/WAF) or add the CNAME records Pages shows you.

### Option B — Vercel
1. `npx vercel --prod` from `website/`, or import the repo and set the root directory to `website`.
2. Add `co-cally.com` in Vercel → Domains. It will give you two records to add in GoDaddy:
   - `A` record `@` → `76.76.21.21`
   - `CNAME` record `www` → `cname.vercel-dns.com`

### Option C — GoDaddy hosting
Upload the contents of `website/` to the web root (`public_html/`) via cPanel/FTP. Make sure HTTPS is enabled (free SSL in GoDaddy hosting settings) — search engines require it.

## After DNS is live — SEO launch checklist

- [ ] Verify the domain in [Google Search Console](https://search.google.com/search-console) and submit `https://co-cally.com/sitemap.xml`
- [ ] Verify in [Bing Webmaster Tools](https://www.bing.com/webmasters) (also feeds ChatGPT/Copilot answers)
- [ ] Test social cards: [opengraph.xyz](https://www.opengraph.xyz) / LinkedIn Post Inspector
- [ ] Test structured data: [Google Rich Results Test](https://search.google.com/test/rich-results) (Organization, SoftwareApplication, FAQPage are embedded)
- [ ] Run Lighthouse (Chrome DevTools) — target 95+ on Performance/SEO/Accessibility
- [ ] Set up a `hello@co-cally.com` mailbox (all CTAs point there) — GoDaddy → Email & Office, or Google Workspace MX records

## Content notes

- **Pricing figures are indicative placeholders** ($499 / $999 / custom, $0.10–0.12 per AI-minute) — confirm against the real rate card before launch. The COGS model in `claude-dev/2026-07-19-cogs-model.md` supports these margins but the public numbers were chosen for the page, not quoted from a signed price list.
- Stats used: ~230ms transfer bridge (pilot-verified), 100% auto-QA, 1,200 dials/day (Scenario B ramp), 2–3 day onboarding.
- Keep `llms.txt`, the FAQ JSON-LD and the visible FAQ answers in sync when editing claims.
