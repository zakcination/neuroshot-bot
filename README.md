# NeuroShot Bot

Telegram GenAI photo/video bot — the MVP from `research/saas-ideas/veosee-clone-plan.md`
(VeoSee/Neuroplace-style machinery, launched with a single-use-case wedge:
**AI photoshoots & product videos**).

## What it does

- Send a **photo** → 🖼 edit it with a prompt (Nano Banana), 💎 premium-edit it (GPT Image 2),
  restyle it with 🎭 one-tap presets (business headshot, fashion editorial, product hero…), or
  🎬 animate it into a 5s video (Kling)
- Send a **text prompt** → ✨ generate an image (Seedream), or `/premium <prompt>` for GPT Image 2 high quality
- **🔫 patrons ledger** in Postgres (Neon): 3 free patrons on signup; image = 2, 💎 premium = 11, video = 25–76. Every model is priced at `ceil(cost/$0.02)` patrons for a ≥3.5× margin — see [`docs/pricing.md`](docs/pricing.md)
- **Payments via Kaspi** (KZT) — buy → pending order → pay by Kaspi link → admin/webhook/self-check confirms → patrons credited; see [`docs/kaspi.md`](docs/kaspi.md) and [`docs/pricing.md`](docs/pricing.md)
- **GenAI course products** (`/course`) — free guide + paid tiers, delivered as a private-channel cohort invite on purchase; see [`docs/course/`](docs/course/)
- **Referral program** (abuse-safe, purchase-gated): friend joins with bonus patrons; inviter earns on the friend's first purchase + 10% lifetime + milestone bonuses
- Automatic **refund on provider failure**; `/stats` for admins

## Run it

```bash
npm install
cp .env.example .env   # fill in BOT_TOKEN (from @BotFather) and FAL_KEY (fal.ai)
npm run dev
```

Long polling — no webhook or public URL needed; runs on any $5 VPS. State lives in
Postgres: set `DATABASE_URL` to your Neon connection string for production; leave it
empty for local/dev and an embedded (ephemeral, in-memory) Postgres is used.

## Test it

```bash
npm run lint        # eslint over src + test
npm run typecheck   # tsc --noEmit
npm run test:e2e    # full user journey against embedded Postgres (pglite)
```

`test/e2e.ts` drives the real handlers through grammY's update pipeline — signup,
text→image, photo→edit, the animate paywall, Stars purchase, referral payout, and
refund-on-provider-failure — stubbing only the Telegram API and fal.ai network edges.
CI (`.github/workflows/ci.yml`) runs all three on every push and PR.

## Architecture

| File | Responsibility |
|---|---|
| `src/models.ts` | Model registry (fal endpoint, credit price, provider cost) + top-model pickers (Nano Banana Pro/2, Kling 3.0, Seedance 2.0) + style presets + credit packs + referral rate. **This is the tuning surface** — add models/packs/presets here only. |
| `scripts/brand-assets.mts` | Content population: generates avatar candidates, seed-post creatives and onboarding examples with GPT Image 2 into `brand-assets/` (gitignored) |
| `assets/previews/` | Per-preset example-result images shown as an album when a category menu opens (see its README) |
| `assets/menu/` | Top-level menu media: `/start` hero, animate video preview, text-flow examples (see its README) |
| `src/db.ts` | Async Postgres data layer (Neon in prod, embedded pglite in tests) + atomic credit ledger (check-and-decrement, journaled) |
| `src/generate.ts` | Charge → call fal → deliver → refund-on-error pipeline |
| `src/payments.ts` | Kaspi buy flow (pending order → Kaspi pay link → admin/webhook/self-check confirm), `grantPurchase` crediting + referral/partner payout + course-pack cohort invite delivery. See `docs/kaspi.md` |
| `src/kaspi.ts` | Server-side Kaspi merchant-API status check (the "pull" half of auto-approval; the webhook "push" half lives in `webapp.ts`). See `docs/kaspi.md` |
| `src/config.ts` | Typed env config — Kaspi, referral/partner, course-cohort, monitoring and combo-offer knobs, all env-tunable with safe defaults |
| `src/monitor.ts` | Solo-CEO monitoring: daily digest + exception alerts, the reaper (stuck-render refunds) and the 48h re-engagement sweep. See `docs/monitoring.md` |
| `src/offer.ts` | Single source of truth for the launch combo offer's countdown, shared by the bot's static snapshot and the Mini App's live ticker |
| `src/promptcraft.ts` | Prompt sanitation + mapping applied to every generation (curated preset/campaign prompts skip the mapping but still pass sanitation) |
| `src/text.ts` | Russian-language UI copy helpers — the patron unit emoji/name, the photo-quality tip |
| `src/watermark.ts` | Deliverable branding: the mandatory AI-generated-content disclosure (KZ Law 230-VIII, always on) + the optional promo CTA badge, composited via ffmpeg. See `docs/watermark.md`, `docs/compliance.md` |
| `src/bot.ts` | Bot wiring: commands, photo/text flows, pending-action state (`createBot()`, also used by the e2e harness) |
| `src/webapp.ts` + `public/app.html` | Telegram Mini App: shared-state API + personal cabinet, over the same Postgres. Auth by `initData` HMAC **or** a Bearer session token. See `docs/web-app.md` |
| `src/auth.ts` | Client-agnostic session tokens (JWT, HS256) — lets an installed PWA / future iOS app hit the same API outside Telegram |
| `public/` | PWA shell: `app.html`, `manifest.webmanifest`, `sw.js`, `icon.svg` (installable / offline app shell; also served statically by Vercel) |
| `api/auth.ts` + `api/me.ts` | Vercel serverless entry points wrapping the shared web handlers — only these two routes run on Vercel today. See `docs/vercel.md` |
| `src/index.ts` | Entrypoint: builds the bot, starts long polling + the Mini App server (if `WEBAPP_URL` set) |

## Before going live

1. **Verify fal endpoint IDs** in `src/models.ts` against https://fal.ai/explore/models — model versions drift monthly.
2. Set 2–3 `ADMIN_IDS` and check `/stats`.
3. Price check: patrons are priced at ≤$0.02 AI cost each (`CREDIT_COST_BASIS`), packs sell at ~4–6x that over the ladder (before referral/partner payout share and Kaspi processing fees) — recalculate against `approxCostUsd` when you change models; see [`docs/pricing.md`](docs/pricing.md).
4. Content safety: fal models ship with provider-side safety filters enabled; do not disable them.

## Economics (targets from the channel research)

- 3–7% of MAU convert to buyers; ~$6–11 acquisition cost per paying user via Telegram seeding
- Target 50–70% gross margin per generation; watch the `generations` table vs `approxCostUsd`
- First milestone: $1K MRR in 2–3 months (see `research/saas-ideas/REPORT.md`, ideas #2)

## Roadmap (from the clone plan)

1. ~~Bot MVP: 3 models, credits, Stars, referrals~~ ← you are here
2. Push notifications on new models/trends (+20–50% payback)
3. Telegram Mini App (galleries, model picker)
4. Web app + SEO landings per use case. Kaspi (KZT) is the live payment rail (see [`docs/kaspi.md`](docs/kaspi.md)); multi-provider expansion (YooKassa, Crypto/TON, etc.) is backlog — see `docs/product-roadmap.md` Tier F
5. Premium video tier (Veo 3.1 / Sora 2 via reseller route with fal fallback)
