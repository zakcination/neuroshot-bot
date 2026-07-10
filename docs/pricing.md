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

## The combo offer (acquisition tripwire)

The launch hook is a **limited-time** offer: **3 scenario-videos (Seedream +
Hailuo, 12 🔫 each) for 1 000 ₸ = 36 🔫** — deliberately **below** the ladder
(28 ₸/🔫, ~3.1× margin). It's flagged `offer: true` and shown with a "🔥 Акция ·
1 мес" badge so it reads as a sale, not a permanent tier (which would break the
ladder). It's ~2.2× cheaper per video than buying patrons — a genuine first-hit
discount to pull an audience in. Window: `COMBO_OFFER_DAYS` from
`COMBO_OFFER_START` (defaults to ~1 month from deploy).

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
- **The free onboarding gift:** every newcomer keeps the 4 free 🔫 **and** gets
  ONE whole scenario (princess **or** football) rendered free — Seedream scene →
  Hailuo video — **watermarked** with the NeuroShot logo (`src/watermark.ts`).
  Marketing cost ≈ **$0.22/new user**, and each shared clip is a branded ad, so
  the loop is CAC-negative at any reasonable share rate. Claimed once
  (`users.free_scenario_used`); a failed render keeps the freebie.
- **Complexity ↔ engine matching:** simple one-action scenes run on the cheap
  Hailuo default; "epic" scenes (multi-actor goals, trophy lifts, flight,
  multi-shot) are gated to **Seedance** and priced accordingly — a simple model
  is never asked to carry a hard action. The composer swaps + reprices on select.

## Packs (KZT / Kaspi)

Ladder in ₸/patron (bigger pack = better rate). Prices are data in
`PACKS` (`src/models.ts`) — tweak freely.

| Pack | Patrons | Price | ₸/patron | ≈ USD | Margin* |
|---|---|---|---|---|---|
| 🔥 Комбо-сет (offer) | 36 | 1 000 ₸ | 28 | $2.08 | ~3.1× |
| Старт | 60 | 3 700 ₸ | 62 | $7.7 | ~6× |
| Популярный | 200 | 11 000 ₸ | 55 | $23 | ~5.5× |
| Про | 500 | 25 000 ₸ | 50 | $52 | ~5× |
| Студия | 900 | 42 000 ₸ | 47 | $87 | ~4.7× |

\* vs the ≤$0.02/patron provider cost, at `KZT_PER_USD=480`, before Kaspi fees.
The combo is intentionally below the ladder — a limited-time tripwire, not a tier.

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
5. **Loops — referral + partner.** 10% lifetime referral share and the 15%
   partner cashback (docs/partner-program.md) turn payers into distributors.

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
| Lifetime share | inviter | **every** purchase | 10% of the pack |
| Milestones | inviter | 3 / 10 / 25 **paying** friends | +20 / +75 / +250 🔫 |

- The **join bonus** is the only farmable surface, and it lands on a throwaway
  account, not the farmer — kept small on purpose.
- **First-purchase** and **milestones** fire once, guarded by an atomic set-once
  flag (`users.ref_first_purchase_at`) and a paid-tier counter
  (`users.ref_milestones`). Milestones count **distinct paying** friends.
- The 10% lifetime share is baked into the margin: base ~4.5× → **≥3.5× after
  the payout**.

All amounts are env-tunable — see `.env.example` (`REFERRAL_*`) and
`REFERRAL_MILESTONES` in `src/models.ts`.

## Before changing prices

- Keep `approxCostUsd` current with fal.ai's model pages — it's the anchor.
- Re-run `npm test` (the e2e suite asserts exact patron math end-to-end).
- Remember free/referral patrons are **marketing cost**, separate from the 3.5×
  (which applies to *purchased* patrons).
