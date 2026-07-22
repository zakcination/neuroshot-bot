# Growth campaign plan — July 2026 (growth-expert synthesis)

**Source:** growth-expert analysis (anchored on the Shipper case — $25.6K MRR / 690 paying / 0 free plan / $0 ads — plus founder-posts #680/683/684/685/686), delivered 2026-07-22. This doc records the plan and, critically, **where it intersects the product build** so engineering priorities follow it.

## Core sequencing decision
**Do NOT open with paid Meta.** Meta is ROAS-only and at peak cost (#686); ROAS needs conversion data we don't have. Earn the first ~50 payments on near-free channels, harden the first session, THEN scale on Meta with known LTV.

- **Phase 0 — differentiate:** killer-feature candidate (grounded): **"Kaspi/WB-ready product card in 40 seconds"** — correct marketplace spec (3:4, 900×1200, white bg / #f2f3f5 for apparel). Competitors (VeoSee etc.) treat this as generic image-gen; sellers-in-pain (type-4) treat it as a deadline problem.
- **Phase 1 (wk 1–4, ~zero budget):** TG посевы in KZ seller channels · evidence-first DMs to 30 Kaspi/WB sellers with before/after of *their own* listing · daily TikTok/Reels before/after with watermark CTA · Reddit/threads. **Gate:** ≥10 payments with known source, else fix the funnel, don't spend.
- **Phase 2 (wk 5+):** Meta ROAS probe $300–500/mo → scale $1.5–3K/mo on winners; per-creative deep-links into `/dash` (ENTRY_LINKS already support this).
- **Phase 3 (parallel):** SEO on competitor names · build-in-public · prompt-library-as-content (the scraped 398-recipe library).

## Four user types (#684) → channel logic
Free channels deliver types 1–3 (random / freeloader / doubter); **only paid algos reliably fetch type-4 (in pain, card in pocket)**. Free channels = learning + cheap first payments; paid = scaling a proven funnel.

## First-session doctrine (#683 — "money is made in the first session")
1. Zero friction: ad → bot → result in <60s, no registration.
2. Wow before ask: first result free, watermarked, low-res.
3. **Paywall = a sales page**: outcome headline, before/after proof, testimonials, ONE choice — and a **50%-off offer fired the instant the paywall is closed** (abandoned-cart push 24h later).
4. Second result paid.

## Grounded vs speculation (analyst discipline)
| Claim | Status |
|---|---|
| ~40,500 KZ Wildberries sellers (H1 2023, understated now) | Grounded (Statista) |
| Marketplace photo spec 3:4 / 900×1200 / white or #f2f3f5 bg | Grounded (PressFoto) |
| Shipper $25.6K MRR, 0 free plan, $0 ads | Grounded (screenshots + #685) |
| Meta most-expensive since Nov 2025, ROAS-only | Grounded (#686) |
| KZ seller CAC, our conversion %, LTV | **Speculation — hypotheses to test** |

---

## Build intersections (what engineering must ship for this plan)

| Growth ask | Product state today | Gap / build item |
|---|---|---|
| **Marketplace-spec presets** (3:4, 900×1200, white / #f2f3f5 bg) | 8 product presets exist; models support 3:4 via `image_size`/`aspect_ratio`; **no exact-pixel (900×1200) output, no bg-compliance guarantee** | New "Карточка Kaspi/WB" preset(s) pinned to the spec; decide whether 3:4 is enough or exact-px resize post-process is needed (open question) |
| **Paywall-close 50% offer** (#683) | Paywall (402 → packs) exists; combo offer exists; **no on-close discount mechanic**; Kaspi *fixed-amount* links complicate arbitrary discounts | Decide mechanic (open question): time-limited special pack vs existing combo as the "offer" |
| **First result free, cap free tightly; Shipper has 0 free plan** | FREE_CREDITS=4 + one-time free scenario + welcome/roadmap bonuses | Decide free-plan sizing (open question — economics change) |
| Abandoned-cart push 24h with discount | Re-engage sweep exists (48h dormant) | Add a paywall-abandon trigger variant |
| Per-creative attribution | `ENTRY_LINKS` + `/dash` already live | None — reuse |
| Watermark CTA on free results | Watermark module + per-user toggle live | Confirm free-tier watermark copy carries the bot handle |
| Prompt-library-as-content | 398-recipe scrape + 28 presets live | Marketing usage, no build |

**Priority tension to resolve:** the growth plan's "this week" ask (marketplace presets + paywall mechanics + DM test) competes with the Cinema Studio build queue (composer Phase 1, in-progress/ripple UI, multi-output count). Resolution recorded in the decisions below when answered.
