# Pricing & margin model

The whole economy is anchored to two real numbers: **what a generation costs on
fal.ai**, and **what a buyer pays in tenge via Kaspi**. Everything else is
derived so that every sale clears a healthy margin — even in the worst case.

## Payments: Kaspi (KZT)

Payments run through **Kaspi** in Kazakhstani tenge (₸) — Telegram Stars are
removed. The flow is: buy → a **pending order** is recorded → the user pays via
the Kaspi link (`KASPI_PAY_URL`) → an admin (or, later, a Kaspi payment webhook)
confirms → `grantPurchase` credits the patrons and fires the referral/partner
payouts. While `KASPI_PAY_URL` is blank the order machinery is ready but the buy
screen shows "оплата скоро". Margin math uses `KZT_PER_USD` (default 480) for the
digest only, never for pricing.

## The rule: 1 patron = $0.02 of AI cost

`CREDIT_COST_BASIS = 0.02` in `src/models.ts`. Every model charges:

```
credits = ceil(approxCostUsd / 0.02)
```

so **cost-per-patron is always ≤ $0.02**. Patrons are then sold at **47–62 ₸**
each (≈ $0.10–0.13) → comfortably **≥4× margin** on the ladder after the referral
share.

## The two purpose-built sets

One generic "combo" used to serve both intents at 36 🔫. That is enough for three
of the *cheapest* videos and not one of the good ones — so the same pack was
oversized for someone who wanted to play with photo styles and useless to someone
who wanted a real video. Split in two, each sized from the recipe it is named
after.

### 🎨 Фото-сет — 100 🔫 for 2 900 ₸ (the tripwire)

29 ₸/🔫, deliberately **below** the ladder, flagged `offer: true` and shown only
with a countdown so it reads as a sale rather than a permanent tier. It buys 50
preset looks (2 🔫), 25 fast frames (4 🔫) or 12 top-tier frames (8 🔫) — enough
to play through a gallery instead of peeking at it. Window: `COMBO_OFFER_DAYS`
from `COMBO_OFFER_START` (env names are historical; see `.env.example`).

### 🎬 Видео-сет — 650 🔫 for 31 000 ₸

Sized from what one **good** video actually costs. The recipe is two strong
frames — the still is what carries likeness and composition — and then ten
seconds of motion:

| tier | frames | 10s of motion | total |
|---|---|---|---|
| 2× Nano Banana 2 + Seedance 2.0 Fast | 8 | 121 | **129 🔫** |
| 2× Nano Banana Pro + Seedance 2.0 Fast | 16 | 121 | **137 🔫** |
| 2× Nano Banana Pro + Seedance 2.0 (audio) | 16 | 152 | **168 🔫** |
| 2× GPT Image 2 + Seedance 2.0 (audio) | 22 | 152 | **174 🔫** |

650 🔫 covers **5 / 4 / 3 / 3** of those — three to five finished videos whichever
tier the buyer works at, which is exactly what the title promises. It is **not**
an `offer`: at this ticket a countdown is pressure, not a launch hook. Priced at
47.7 ₸/🔫, between Про (50) and Студия (46.7), so "bigger pack, better rate"
still holds end to end. An e2e step asserts both the 3–5 promise and the ladder
monotonicity.

The old `combo` pack stays in `PACKS` flagged `retired` — orders already placed
against it must still resolve — and is filtered out of every listing, keyboard
and paywall anchor.

### Per-model patron prices

| Model | Role | AI cost | Patrons |
|---|---|---|---|
| **Seedream 4 edit** | **scenario image (default)** | **$0.03** | **2** |
| Seedream 4.5 (text→image) | cheap image + free-trial anchor | $0.04 | 2 |
| Photo edit (Nano Banana) | «свой промпт» edit | $0.06 | 3 |
| Nano Banana 2 | image picker | $0.08 | 4 |
| Nano Banana Pro (2K) | image picker | $0.15 | 8 |
| Premium (GPT-Image, hi-q) | typography/detail | $0.21–0.22 | 11 |
| **Hailuo 2.3 Fast (6s)** | **scenario video (default)** | **$0.19** | **10** |
| Hailuo 2.3 Fast (10s) | — | $0.32 | 16 |
| Animate (Kling 2.5, 5s) | budget video | $0.50 | 25 |
| Kling 3.0 (5s) | cinematic swap-up | $0.84 | 42 |
| Seedance Fast (5s) | **epic scenes** (physics/audio) | $1.21 | 61 |
| Seedance flagship (5s) | max quality swap-up | $1.51 | 76 |

### Scenario economics — the free-hook lever

The whole scenario stack was re-based onto the two cheapest capable engines so a
*whole* scenario can be given away as the acquisition hook:

- **Default scenario = Seedream edit (2 🔫) + Hailuo 6s (10 🔫) = 12 🔫 ≈ $0.24**
  of provider cost — down from 46 🔫 (Nano Banana 2 + Kling 3.0). That 4× drop is
  what makes the free offer sustainable.
- **The free onboarding gift:** every newcomer is offered the 4 free 🔫 **and**
  gets ONE whole scenario (princess **or** football) rendered free — Seedream
  scene → Hailuo video — **watermarked** with the NeuroShot logo
  (`src/watermark.ts`). The signup 🔫 are **claim-gated**, not silently
  credited: they park in `pending_signup_credits` until the user taps "🎁
  Получить" (bot inline button, or the Mini App's welcome flow →
  `POST /api/claim-welcome`) — a deliberate claim reads as a real gift and
  onboards better than a number that was just already there. `claimWelcomeBonus`
  (`src/db.ts`) moves it into `credits` exactly once; persona-routed ad deep
  links (`src_football` etc.) auto-claim silently first to keep their ≤2-tap
  promise. Marketing cost ≈ **$0.22/new user**, and each shared clip is a
  branded ad, so the loop is CAC-negative at any reasonable share rate. The
  scenario gift itself is unrelated and claimed once (`users.free_scenario_used`);
  a failed render keeps the freebie.
- **Complexity ↔ engine matching:** simple one-action scenes run on the cheap
  Hailuo default; "epic" scenes (multi-actor goals, trophy lifts, flight,
  multi-shot) are gated to **Seedance** and priced accordingly — a simple model
  is never asked to carry a hard action. The composer swaps + reprices on select.

## Packs (KZT / Kaspi)

Ladder in ₸/patron (bigger pack = better rate). Prices are data in
`PACKS` (`src/models.ts`) — tweak freely.

| Pack | Patrons | Price | ₸/patron | ≈ USD | Margin* |
|---|---|---|---|---|---|
| 🎨 Фото-сет (offer) | 100 | 2 900 ₸ | 29 | $5.8 | ~3× |
| Старт | 60 | 3 700 ₸ | 62 | $7.7 | ~6× |
| Популярный | 200 | 11 000 ₸ | 55 | $23 | ~5.5× |
| Про | 500 | 25 000 ₸ | 50 | $52 | ~5× |
| 🎬 Видео-сет | 650 | 31 000 ₸ | 47.7 | $67 | ~4.8× |
| Студия | 900 | 42 000 ₸ | 47 | $87 | ~4.7× |

\* vs the ≤$0.02/patron provider cost, at `KZT_PER_USD=480`, before Kaspi fees.
The photo set is intentionally below the ladder — a limited-time tripwire, not a tier.

The cheaper scenario stack also *reprices the value story*: a «Старт — 60 🔫»
pack now buys **~5 whole Hailuo scenarios** (12 🔫 each) instead of ~1 Kling
scenario. Same margin per patron, far better perceived value — the anchor a paid
social campaign needs.

## Marketing progression (the campaign funnel)

Built to be poured into a social-media push, each stage feeding the next:

1. **Hook — free watermarked scenario.** New user picks princess/football, gets
   a branded video for ~$0.22. They share it → the watermark drives the next
   install. This is the top of the funnel and the CAC engine.
2. **Activate — 4 free 🔫.** Enough for a Seedream image or a second cheap render,
   so they feel the studio before paying.
3. **First purchase — «Старт» anchor.** Framed as "~5 full scenarios", the
   cheapest pack clears 6× margin; the free scenario already proved the value.
4. **Upsell ladder in the composer.** Hailuo Fast (10 🔫) → Kling 3.0 cinematic
   (42 🔫) → Seedance epic scenes with audio/physics (61–76 🔫). Every swap shows
   its price; epic scenes force the Seedance rung.
5. **Loops — referral + partner.** A 5% lifetime referral share and partner
   cashback that starts at 10% and climbs to 20% with volume
   (docs/partner-program.md) turn payers into distributors. Both bases were cut
   in 2026-07 so the budget sits where it compounds: catalogue breadth and the
   Level ladder, which is what makes a second purchase worth making.

Track it with `/dash` (docs/monitoring.md): new-by-source, activation, and the
per-source payer split tell you which creative to pour tomorrow's budget into.

## Referral economics (abuse-safe)

The structure is designed so a multi-account farm **cannot** profit: the
inviter's rewards are all **purchase-gated** — they only pay out when a referred
friend spends real Stars.

| Reward | Who | When | Default |
|---|---|---|---|
| Join bonus | invited friend | joins via link | +3 🔫 |
| First-purchase bonus | inviter | friend's **1st** purchase | +10 🔫 |
| Lifetime share | inviter | **every** purchase | 5% of the pack |
| Milestones | inviter | 3 / 10 / 25 **paying** friends | +20 / +75 / +250 🔫 |

- The **join bonus** is the only farmable surface, and it lands on a throwaway
  account, not the farmer — kept small on purpose.
- **First-purchase** and **milestones** fire once, guarded by an atomic set-once
  flag (`users.ref_first_purchase_at`) and a paid-tier counter
  (`users.ref_milestones`). Milestones count **distinct paying** friends.
- The lifetime share is baked into the margin, and it is paid in 🔫 rather than
  ₸ — on the friend track those patrons are spend-only, so what it actually
  costs is provider COGS, not revenue. Halving it in 2026-07 mattered less for
  the margin than for what a standing claim on all future revenue crowds out.

All amounts are env-tunable — see `.env.example` (`REFERRAL_*`) and
`REFERRAL_MILESTONES` in `src/models.ts`.

## Cost tracking (`generations.cost_usd`)

The patron `credits` charge and the actual provider `cost_usd` are tracked
separately per generation — they diverge on purpose (free/gifted renders
charge 0 credits but still cost real money) and by rounding (patrons are
whole numbers rounded up for margin; cost_usd is the real, un-rounded spend).

- **`costUsdFor(model, opts)`** (`src/models.ts`) — the single source of truth,
  mirroring `priceFor`'s duration/resolution scaling exactly but returning
  USD. Every completed generation logs this + fal's `provider_request_id`
  (`completeGeneration`/`markOk` in `src/generate.ts`) — an audit trail from a
  delivered result back to the exact provider request, for support/dispute
  and margin-accuracy purposes.
- **`buildDigest`** (`src/monitor.ts`) sums real `cost_usd` where it's been
  logged (every generation going forward) and only falls back to the old
  flat per-model estimate for pre-migration rows (`cost_usd IS NULL`) — the
  `/dash` margin number gets more accurate over time with no backfill needed.
- **Deliberately NOT wired up yet:** `userCogsUsd` / `usersOverCogsThreshold`
  (per-user spend + an alert threshold) and `rerollRateApprox` (a same-user/
  same-model-within-N-minutes heuristic) exist in `src/db.ts` but aren't
  called anywhere. They matter once a revenue-tied reward multiplier (referral
  or top-up bonus %) is close to shipping — building the alerting/measurement
  layer before that exists would be instrumenting a problem that isn't live
  yet, which this project's own monitoring philosophy explicitly avoids (see
  `monitor.ts`'s header comment). Wire them up when that day comes.

## Before changing prices

- Keep `approxCostUsd` current with fal.ai's model pages — it's the anchor.
- Re-run `npm test` (the e2e suite asserts exact patron math end-to-end).
- Remember free/referral patrons are **marketing cost**, separate from the 3.5×
  (which applies to *purchased* patrons).
