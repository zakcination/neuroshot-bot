# NeuroShot Bot

Telegram GenAI photo/video bot — the MVP from `research/saas-ideas/veosee-clone-plan.md`
(VeoSee/Neuroplace-style machinery, launched with a single-use-case wedge:
**AI photoshoots & product videos**).

## What it does

- Send a **photo** → 🖼 edit it with a prompt (Nano Banana), 💎 premium-edit it (GPT Image 2),
  restyle it with 🎭 one-tap presets (business headshot, fashion editorial, product hero…), or
  🎬 animate it into a 5s video (Kling)
- Send a **text prompt** → ✨ generate an image (Seedream), or `/premium <prompt>` for GPT Image 2 high quality
- **Credits ledger** in SQLite: 3 free credits on signup, image = 1 credit, 💎 premium = 4, video = 8
- **Payments via Telegram Stars** (XTR) — works worldwide, no legal entity or payment provider needed
- **Referral program**: 10% of every purchased pack credited to the referrer
- Automatic **refund on provider failure**; `/stats` for admins

## Run it

```bash
npm install
cp .env.example .env   # fill in BOT_TOKEN (from @BotFather) and FAL_KEY (fal.ai)
npm run dev
```

Long polling — no webhook or public URL needed; runs on any $5 VPS.

## Test it

```bash
npm run lint        # eslint over src + test
npm run typecheck   # tsc --noEmit
npm run test:e2e    # full user journey against a throwaway SQLite db
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
| `src/db.ts` | SQLite schema + atomic credit ledger (spend is check-and-decrement, every movement journaled) |
| `src/generate.ts` | Charge → call fal → deliver → refund-on-error pipeline |
| `src/payments.ts` | Stars invoices, pre-checkout, crediting, referral payout |
| `src/bot.ts` | Bot wiring: commands, photo/text flows, pending-action state (`createBot()`, also used by the e2e harness) |
| `src/webapp.ts` + `src/webapp.html` | Telegram Mini App: shared-state API (`initData` HMAC auth) + personal cabinet, over the same SQLite. See `docs/web-app.md` |
| `src/index.ts` | Entrypoint: builds the bot, starts long polling + the Mini App server (if `WEBAPP_URL` set) |

## Before going live

1. **Verify fal endpoint IDs** in `src/models.ts` against https://fal.ai/explore/models — model versions drift monthly.
2. Set 2–3 `ADMIN_IDS` and check `/stats`.
3. Price check: packs are set at ~3–4x provider cost *before* the Telegram Stars cash-out discount — recalculate against `approxCostUsd` when you change models.
4. Content safety: fal models ship with provider-side safety filters enabled; do not disable them.

## Economics (targets from the channel research)

- 3–7% of MAU convert to buyers; ~$6–11 acquisition cost per paying user via Telegram seeding
- Target 50–70% gross margin per generation; watch the `generations` table vs `approxCostUsd`
- First milestone: $1K MRR in 2–3 months (see `research/saas-ideas/REPORT.md`, ideas #2)

## Roadmap (from the clone plan)

1. ~~Bot MVP: 3 models, credits, Stars, referrals~~ ← you are here
2. Push notifications on new models/trends (+20–50% payback)
3. Telegram Mini App (galleries, model picker)
4. Web app + SEO landings per use case; YooKassa/Paddle for card payments
5. Premium video tier (Veo 3.1 / Sora 2 via reseller route with fal fallback)
