# NeuroShot Bot

**AI photoshoots and product videos, one tap away — inside Telegram.**

Send a photo or a text prompt, get a studio-quality result back in your chat.
No prompt-writing, no picking a model, no separate app to install — the bot
routes each request to the right generation model, prices it transparently in
credits, and delivers the result (with the mandatory AI-disclosure watermark
baked in) straight back to the conversation. A companion Telegram Mini App
gives the same account a wallet, a gallery, and a personal cabinet over the
same data.

Built as a single-use-case wedge rather than a general-purpose model
aggregator: a curated set of one-tap presets (headshots, product hero shots,
fashion editorials, short animated clips…) stands in for prompt-engineering
skill, so newcomers get a good result on the first try.

## What it does

- Send a **photo** → 🖼 edit it with a prompt (Nano Banana), 💎 premium-edit it (GPT Image 2),
  restyle it with 🎭 one-tap presets (business headshot, fashion editorial, product hero…), or
  🎬 animate it into a short video (Kling)
- Send a **text prompt** → ✨ generate an image (Seedream), or `/premium <prompt>` for GPT Image 2 high quality
- **🔫 credit ledger** in Postgres — free credits on signup, every model priced transparently up front; see [`docs/pricing.md`](docs/pricing.md)
- **In-app payments via Kaspi** (KZT) — buy → pending order → pay by link → admin/webhook/self-check confirms → credits granted; see [`docs/kaspi.md`](docs/kaspi.md) and [`docs/pricing.md`](docs/pricing.md)
- **Telegram Mini App** — wallet, gallery, referral/partner dashboard, achievements wall, all served from the same account; see [`docs/web-app.md`](docs/web-app.md)
- **GenAI course products** (`/course`) — free guide + paid tiers, delivered as a private-channel cohort invite on purchase; see [`docs/course/`](docs/course/)
- **Referral program** (abuse-safe, purchase-gated): a friend joins with bonus credits; the inviter earns on the friend's first purchase, plus a lifetime share and milestone bonuses
- Automatic **refund on provider failure**; `/stats` for admins

## Quick start

```bash
npm install
cp .env.example .env   # fill in BOT_TOKEN (from @BotFather) and FAL_KEY (fal.ai)
npm run dev
```

Long polling — no webhook or public URL needed; runs on any $5 VPS. State lives in
Postgres: set `DATABASE_URL` to your Neon (or any Postgres) connection string for
production; leave it empty for local/dev and an embedded (ephemeral, in-memory)
Postgres is used automatically.

## Test it

```bash
npm run lint          # eslint over src + test + scripts + api
npm run typecheck     # tsc --noEmit
npm run test:e2e      # full bot user journey against embedded Postgres (pglite)
npm run test:webapp   # Mini App API surface — 100+ checks
```

`test/e2e.ts` drives the real handlers through grammY's update pipeline — signup,
text→image, photo→edit, the animate paywall, the Kaspi purchase flow, referral payout, and
refund-on-provider-failure — stubbing only the Telegram API and fal.ai network edges.
`test/webapp.ts` does the same for the Mini App's API routes. CI
(`.github/workflows/ci.yml`) runs everything on every push and PR, and auto-deploys
`main` on green.

## Architecture

| File | Responsibility |
|---|---|
| `src/models.ts` | Model registry (fal endpoint, credit price, provider cost) + top-model pickers + style presets + credit packs + referral rate. **This is the tuning surface** — add models/packs/presets here only. |
| `scripts/brand-assets.mts` | Content population: generates avatar candidates, seed-post creatives and onboarding examples with GPT Image 2 into `brand-assets/` (gitignored) |
| `assets/previews/` | Per-preset example-result images shown as an album when a category menu opens (see its README) |
| `assets/menu/` | Top-level menu media: `/start` hero, animate video preview, text-flow examples (see its README) |
| `src/db.ts` | Async Postgres data layer (Neon in prod, embedded pglite in tests) + atomic credit ledger (check-and-decrement, journaled) |
| `src/generate.ts` | Charge → call fal → deliver → refund-on-error pipeline |
| `src/payments.ts` | Kaspi buy flow (pending order → Kaspi pay link → admin/webhook/self-check confirm), `grantPurchase` crediting + referral/partner payout + course-pack cohort invite delivery. See `docs/kaspi.md` |
| `src/kaspi.ts` | Server-side Kaspi merchant-API status check (the "pull" half of auto-approval; the webhook "push" half lives in `webapp.ts`). See `docs/kaspi.md` |
| `src/config.ts` | Typed env config — Kaspi, referral/partner, course-cohort, monitoring and combo-offer knobs, all env-tunable with safe defaults |
| `src/monitor.ts` | Operational monitoring: daily digest + exception alerts, the reaper (stuck-render refunds) and a re-engagement sweep. See `docs/monitoring.md` |
| `src/offer.ts` | Single source of truth for the launch combo offer's countdown, shared by the bot's static snapshot and the Mini App's live ticker |
| `src/promptcraft.ts` | Prompt sanitation + mapping applied to every generation (curated preset/campaign prompts skip the mapping but still pass sanitation) |
| `src/text.ts` | Russian-language UI copy helpers |
| `src/watermark.ts` | Deliverable branding: the mandatory AI-generated-content disclosure watermark (always on) + an optional promo CTA badge, composited via ffmpeg. See `docs/watermark.md`, `docs/compliance.md` |
| `src/bot.ts` | Bot wiring: commands, photo/text flows, pending-action state (`createBot()`, also used by the e2e harness) |
| `src/webapp.ts` + `public/app.html` | Telegram Mini App: shared-state API + personal cabinet, over the same Postgres. Auth by `initData` HMAC **or** a Bearer session token. See `docs/web-app.md` |
| `src/auth.ts` | Client-agnostic session tokens (JWT, HS256) — lets an installed PWA / future iOS app hit the same API outside Telegram |
| `src/moderation.ts` | Content gate run on every upload BEFORE any spend, so a blocked photo costs nothing |
| `src/ratelimit.ts` | Per-user limits on the cost-sensitive routes (generate / upload / enhance); polling is never limited |
| `src/enhance.ts` | Prompt Enhancer — a stack of free rewrites per render, then 1 patron refills it. See `docs/cinema-studio-spec.md` |
| `src/dubbing.ts` | AI video translator. **Not wired to anything** — no registry entry, no command, no route; its own spec gates it behind a Phase 0 validation that has not run. See `docs/video-translator-spec.md` and `docs/course/BLOCKERS.md` |
| `public/` | PWA shell: `app.html`, `manifest.webmanifest`, `sw.js`, `icon.svg` (installable / offline app shell; also served statically by Vercel) |
| `api/auth.ts` + `api/me.ts` | Vercel serverless entry points wrapping the shared web handlers — only these two routes run on Vercel today. See `docs/vercel.md` |
| `src/index.ts` | Entrypoint: builds the bot, starts long polling + the Mini App server (if `WEBAPP_URL` set) |

## Deploy

Runs as one always-on process (bot + Mini App server together) behind any host
that supports Docker or a persistent Node process — Fly.io, Railway, Render, or
a plain VPS with Docker Compose. Full walkthroughs for each option, plus the
production checklist, live in [`docs/deploy.md`](docs/deploy.md).

## Before going live

1. **Verify fal endpoint IDs** in `src/models.ts` against https://fal.ai/explore/models — model versions drift monthly.
2. Set 2–3 `ADMIN_IDS` and check `/stats`.
3. Price check: recalculate credit prices against `approxCostUsd` whenever you change models — see [`docs/pricing.md`](docs/pricing.md).
4. Content safety: fal models ship with provider-side safety filters enabled; do not disable them.

## Documentation

The `docs/` folder is the deeper reference — pricing model, payments integration,
the Mini App, deployment options, compliance requirements, and more. Start at
[`docs/product-roadmap.md`](docs/product-roadmap.md) for the current backlog and
what's shipped.

## Contributing

Issues and pull requests are welcome. Before opening one:

```bash
npm run lint && npm run typecheck && npm run test:e2e && npm run test:webapp
```

should all pass — CI runs the same four checks on every PR.

## License

No license has been declared yet for this repository. Until one is added, all
rights are reserved by the copyright holder — open an issue if you'd like to
discuss licensing terms.
