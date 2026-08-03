# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product Context

**Vision:** Best AI studio for ready-made photo and video. Users send a photo or idea → AI handles the creativity → they get broadcast-quality results in seconds.

**Core values:**
- **Instant gratification over control** — one-tap presets, no prompt engineering. Users get wow on first try.
- **Reliability first** — async rendering + automatic refunds on failure. Trust is non-negotiable.
- **Creator-first pricing** — affordable entry point, real returns for creators (referral program, partner tiers). Not a wealth extraction machine.
- **Delightful retention** — weekly featured models, gallery discovery, seasonal campaigns. Keep people coming back because they *want* to, not FOMO.

**How it works:**
1. **First 30 seconds** — photo in → immediate preview → credit cost shown → buy or use free tier. Respect their time.
2. **Studio experience** — curated presets (headshots, product shots, editorials, video animations). Each preset is tuned to a real use case.
3. **Creator economy** — referral bonus, partner codes, lifetime share. Word-of-mouth is the growth engine.
4. **Long-tail** — courses, partner tiers, seasonal promotions. Monetize without squeezing.

**NOT pursuing:** Generic model aggregator. Our strength is *curation and reliability*, not breadth.

---

## Competitive Positioning

**Where we differ from the market:**

| Competitor | Positioning | Why They Win | Why They Lose to neuroshot-bot |
|---|---|---|---|
| **Veoseebot** | Telegram bot + Mini App aggregator | Simple, fast API proxy | No curation; cold UX; relies on breadth, not reliability |
| **Neuroplace** | Web dashboard, 6+ models | Browser video editing, desktop UX | Telegram not primary; high friction; web adoption slower than mobile |
| **Syntx AI** | Extreme scale (338k+ users), 90+ models | Network effects; many options | Paradox of choice; no preset guidance; complex onboarding |
| **Higgsfield** | Open-source, sophisticated ($1.3B valuation) | Transparent, trust signal | Self-hosted complexity; not consumer-focused; niche enterprise market |
| **neuroshot-bot** | Telegram-first, one-tap presets, creator economy | Instant gratification + reliability | Growing; competing against entrenched players |

**Our defensive moat:**
- **Telegram integration** — Instant notifications, one-tap UX, chat history. Web competitors can't replicate this speed.
- **One-tap presets** — Anti-prompt-engineering. Users get broadcast-quality results without thinking. Competitors require prompt knowledge.
- **Creator economy** — Referral + partner tiers. Word-of-mouth scales faster than ads.
- **Reliability first** — Automatic refunds, async rendering. Competitors optimize for throughput; we optimize for trust.

**Strategic focus:**
- Stay Telegram-focused (not web-first). The audience is there; web is a secondary surface if needed.
- Expand preset library (not model count). Curation wins over choice paralysis.
- Double down on referral mechanics. Creators drive creators.
- Monitor tier pricing (Seedance). Real per-second pricing curve keeps unit economics tight as models get cheaper.

---

## Quick Start

```bash
npm install
cp .env.example .env          # Set BOT_TOKEN, FAL_KEY
npm run dev                   # Long-polling bot + Mini App server (if WEBAPP_URL set)

npm run typecheck             # Type check everything
npm run lint                  # Lint src, test, scripts, api
npm run test                  # npm run test:e2e && npm run test:webapp
npm run test:e2e              # Bot user journeys (signup, generate, purchase, referral refund)
npm run test:webapp           # Mini App API surface (100+ checks)
npm run cost-line             # Verify pricing against provider costs
```

## Architecture

The bot is one always-on process (bot + Mini App server) with three data layers:

| System | Files | What it does | When to touch it |
|--------|-------|--------------|------------------|
| **Model Registry** | `src/models.ts` | Declare generation endpoints, price in credits, provider cost. **This is the primary tuning surface.** | Adding/updating AI models, presets, credit packs, referral rates |
| **Database** | `src/db.ts` | Postgres schema + atomic credit ledger. Neon in production; embedded pglite in tests/local dev. | Schema changes (ALWAYS run migrations). Adding analytics tables. |
| **Config** | `src/config.ts` | Typed env vars with safe defaults. Feature gates: `reengageEnabled`, `freeGateEnabled`, `flagshipCapFrom`, pricing knobs, etc. | Gating features before merge. Tuning economic params at deploy time. |
| **Bot Logic** | `src/bot.ts` | Telegram command handlers + photo/text flows + pending-action state. Built by `createBot()`, used by e2e harness. | Adding commands, changing user flows, handling errors |
| **Generation** | `src/generate.ts` | Charge → call fal → deliver → refund-on-error pipeline. Moderation runs here (before spend). | Changing generation flow, provider error handling |
| **Payments** | `src/payments.ts` | Kaspi buy flow (order → pay link → webhook/self-check), `grantPurchase` crediting, referral payout, course cohort invite delivery. | Changing purchase logic or referral/partner tiers |
| **Mini App** | `src/webapp.ts` + `public/app.html` | Telegram Mini App: shared-state API + personal cabinet, same Postgres. Auth: HMAC (`initData`) or JWT Bearer token. | Adding routes, changing UI, gating Mini App features |
| **Monitoring** | `src/monitor.ts` | Daily digest + exception alerts, stuck-render reaper, re-engagement sweep. Configurable per `config.ts`. | Adding metrics, changing alert thresholds, debugging re-engagement |
| **Auth** | `src/auth.ts` | Session tokens (JWT, HS256). Lets a PWA/iOS app hit the API outside Telegram. | Adding auth methods or session management |
| **Other** | `src/offer.ts`, `src/ratelimit.ts`, `src/watermark.ts`, `src/promptcraft.ts`, `src/dubbing.ts`, etc. | Launch combo offer countdown (shared by bot + Mini App), rate-limiting, watermark compositing, prompt sanitization, **Dubbing (not wired)** | Rarely needed; see docs for each |

## Feature Gating: How Scope Doesn't Spiral

**Problem:** The bot has grown to include payments, courses, referrals, partner programs, and multiple AI models. New PRs easily pile features on without clear coordination.

**Solution:** Use `config.ts` to gate changes:

```typescript
// In config.ts, add a typed boolean:
export const config = {
  // ... existing
  myNewFeatureEnabled: (process.env.MY_NEW_FEATURE_ENABLED ?? "false") === "true",
};

// In your handler:
if (config.myNewFeatureEnabled) {
  // new behavior
} else {
  // existing behavior (no regression)
}
```

**Before merging any multi-system PR** (e.g., "add referral badges to Mini App + update pricing model + add course tier"):
1. Use a config flag: `FEATURE_X_ENABLED=false` by default
2. Test thoroughly with flag on + off
3. Document the flag in this file (see section below)
4. Deploy with flag off, then flip in production once validated
5. This prevents "half-deployed features" from breaking main

## Feature Gates Currently In Use

| Flag | Default | Purpose | Docs |
|------|---------|---------|------|
| `WEBAPP_URL` | unset | Enable Mini App server. If unset, bot runs without web endpoints. | `docs/web-app.md` |
| `REENGAGE_ENABLED` | true | Daily re-engagement sweep (nudges, pushes). | `docs/monitoring.md` |
| `FREE_GATE_ENABLED` | false | Require phone verification before free-result claim. | `docs/growth-product.md` |
| `DUB_KAZAKH_ENABLED` | false | Enable AI video translator (Phase 0, not public). | `docs/video-translator-spec.md` |
| `COURSE_FLAGSHIP_CHANNEL_ID` | "" | If set, deliver course packs to this Telegram channel. | `docs/course-funnel.md` |
| Pricing knobs | per config | `SEEDANCE_SALE_ACTIVE`, `FLAGSHIP_CAP_FROM`, `REFERRAL_FIRST_PURCHASE_BONUS`, etc. | `docs/pricing.md` |

## Testing Strategy

**E2E tests** (`npm run test:e2e`):
- Drive the actual handlers through grammY's update pipeline
- Stub only network edges: Telegram API, fal.ai
- Cover: signup → text-to-image → photo-edit → animate paywall → Kaspi purchase → referral payout → refund-on-error
- Uses embedded pglite (hermetic, no external DB needed)

**Webapp tests** (`npm run test:webapp`):
- Same approach: real Mini App routes, stubbed network edges
- 100+ checks on the API surface

**When adding a feature:** Add a case to either test harness. If it crosses the bot↔webapp boundary, add to both.

## Known Limitations & Blockers

| Feature | Status | Blocker | Docs |
|---------|--------|---------|------|
| AI Video Translator | Not wired | Phase 0 gate not run; no command, no route, no registry entry | `docs/video-translator-spec.md` |
| GenAI Courses | Partial | Course delivery works; blockers on instructor workflow + cohort scaling | `docs/course/BLOCKERS.md` |
| Seedance Tiers | Live | Monitor tier-resolution gaps in `clampStudioOpts`. Has real per-second pricing curve. | `docs/seedance-tiers.md` |

## Deployment

**Environment:**
- One always-on process (Fly.io, Railway, Render, or VPS with Docker)
- Long polling (no webhook, no public URL)
- State in Postgres (Neon, or managed database)

**Checklist before going live:**
1. Verify fal endpoint IDs in `src/models.ts` against https://fal.ai/explore/models (they drift monthly)
2. Set 2–3 `ADMIN_IDS` and test `/stats`
3. Recalculate credit prices against `approxCostUsd` in `src/models.ts` when models change — see `docs/pricing.md`

Full walkthroughs: `docs/deploy.md`

## Common Tasks

### Add a new AI model or preset
**File:** `src/models.ts`  
**Steps:**
1. Get fal endpoint ID from https://fal.ai/explore/models
2. Add to `MODELS.image` (or `.video`, `.edit`)
3. Set `creditPrice` (see `docs/pricing.md` for calculation)
4. Add to `PRESETS` for one-tap access (optional)
5. Run `npm run cost-line` to verify margin
6. Test with `npm run test:e2e`

### Change pricing
**File:** `docs/pricing.md` (rationale) + `src/models.ts` (prices) + `src/config.ts` (seasonal knobs)  
**Also update:**
- `creditPrice` per model in `src/models.ts`
- Seasonal overrides: `SEEDANCE_SALE_ACTIVE`, `FLAGSHIP_CAP_FROM`, etc.
- Referral tier: `REFERRAL_FIRST_PURCHASE_BONUS`
- Credit packs in `creditPacks` array

### Add a Telegram command
**File:** `src/bot.ts` (handler) + test case in `test/e2e.ts`  
**Pattern:** Register in `createBot()`, call `db.logEvent()` for analytics

### Add a Mini App route
**File:** `src/webapp.ts` (handler) + test in `test/webapp.ts`  
**Auth:** HMAC validate via `ctx.req.headers["x-telegram-init-data"]`, or JWT Bearer token  
**Data:** Use the same database functions as the bot (all in `db.ts`)

### Catch scope creep before PRs ship
**Recommendation:**
1. Use `/update-config` skill to set a **hook** that reminds you: "Before pushing, update CLAUDE.md with your change (system added/changed, why it matters, any config flags needed)."
2. When a PR touches >3 systems (e.g., bot logic + Mini App + payments + config all in one), split it and use config flags to coordinate merges.
3. Before merging multi-system PRs, run `/code-review ultra` for an independent multi-agent review.

## Docs You'll Reference Often

| Doc | When |
|-----|------|
| `docs/pricing.md` | Changing credit prices, understanding margin |
| `docs/web-app.md` | Mini App routes, auth, state sharing |
| `docs/kaspi.md` | Payment flow, webhook handling, reconciliation |
| `docs/monitoring.md` | Alert thresholds, daily digest, re-engagement sweep |
| `docs/deployment.md` | Deploy procedure for Fly/Railway/Render/VPS |
| `docs/seedance-tiers.md` | Video pricing curve, tier resolution |
| `docs/compliance.md` | Watermark requirements, legal disclosures |
| `docs/model-inputs.md` | How to pass URLs/photos/videos to fal endpoints |

## Debugging

**"My changes work locally but not in prod"**
- Check `.env` vs `.env.example`: Are all required vars set?
- Verify fal model IDs match https://fal.ai/explore/models (they drift)
- Check database schema: Did you run migrations? (pglite auto-applies; Neon may need manual schema setup)

**"Tests pass but the bot crashes on startup"**
- Run `npm run typecheck` first — TypeScript errors don't always surface in test
- Check config loading: is a `required()` var missing?

**"Pricing is wrong in production"**
- Check `config.ts` for active seasonal knobs (e.g., `SEEDANCE_SALE_ACTIVE`, `FLAGSHIP_CAP_FROM`)
- Recalculate `creditPrice` against provider cost in `src/models.ts`

## Dev Discipline (Long-term)

**From historical audit (86 PRs, 27 days):** One branch merged 17 times over 8 days instead of once—scope creep through incremental refinement. Keep PRs focused:

- **Max 12 files per PR** — if >15, you're likely touching 3+ systems. Split or use feature flags.
- **Max 8 commits per PR** — squash locally before opening. Rework post-PR-creation signals scope drift.
- **Avoid same-day merge on large PRs** — no friction = no validation. Add asynchronous review window if possible.
- **Lock scope at PR inception** — don't refine it across 17 merges. If scope shifts mid-PR, close it and open a new one.

**When to break these:** Sweeping refactors, multi-system features (split via config flags in `config.ts`).

### "Rebuild" means delete the old one. In the same commit.

**Not negotiable, and never needs restating.** When the ask is *rebuild*,
*remake*, *redesign*, *переделать* — the old implementation is deleted as part
of the change. Not deprecated, not left behind a flag, not kept "just in case".
Nobody should ever have to add "…and remove the old one": that is already what
the word means.

This is written down because it was violated repeatedly. "Rebuild the Home promo
banner" and "Rebuild the Studio reference grid" both shipped the new block
*next to* the old one, and the Home and Studio screens ended up carrying two
designs at once — a hero, a promo banner and a TV banner all competing above the
fold, four unrelated ways to attach an input scattered down the composer.

A rebuild is complete when **all** of these are true:

1. The replaced block's **markup, CSS, helper functions, state fields and event
   handlers are gone.** A stylesheet rule with no markup is the signature of a
   half-finished rebuild — run `npm run check:dead-css`, which exists for
   exactly this and reports every class defined in `<style>` that nothing uses.
2. The screen's wireframe is bumped to the next version **in the same PR**
   (`docs/wireframes/<screen>.v<N>.html`). A screen change that isn't in a
   wireframe isn't approved.
3. Anything on the screen that is **not** in the current wireframe is cut. If
   it's worth keeping, it goes into the wireframe first. The wireframe is the
   scope boundary, not a mood board.
4. Anything cut on purpose gets a paragraph in `docs/graveyard.md` — what it
   was, why it went, what replaced it. The idea stays recoverable; the dead code
   does not stay alive.

**Feature flags are for coordinating a merge, not for keeping dead UI on life
support.** A flag nobody reads is worse than no flag:
`HOMEPAGE_REDESIGN_ENABLED` sat plumbed through `config.ts` and `/api/me` for
days while `public/app.html` never once read `uiFeatures` — a switch that
silently did nothing. Delete a flag once its rollout is done.

---

## Before You Push

**Worktree sync check (prevents silent production crashes):**
1. Run `git diff origin/main -- $(git diff --cached --name-only)` — look for unexpected large `-` (deletion) blocks
2. If you see >10 lines deleted in a file you edited, investigate: did you accidentally revert a merge?
   - Fix: `git checkout origin/main -- <file>` then re-commit
3. Reason: Worktrees can silently lose recent commits (esp. after merges). CI passes (tests run in isolation) but production crashes when files are missing. This has caused 20+ min outages.

**Then proceed to merge:**
- Ensure CI passes
- Rebase onto main if needed
- Open PR, mark ready, merge when approved

---

## Before You Hand Off

Update this file if you:
- Add a new subsystem
- Add a new feature gate
- Hit a blocker or known issue
- Change long-term dev discipline principles
