# Pricing & margin model

The whole economy is anchored to two real numbers: **what a generation costs on
fal.ai**, and **what a Telegram Star actually pays out**. Everything else is
derived so that every sale clears a **≥3.5× margin** — even in the worst case.

## What a Telegram Star is worth to us

Stars are **not** worth what the buyer pays. After Telegram's cut (and Apple/
Google's 30% on in-app purchases), the creator withdrawal payout is:

| Buyer bought Stars on… | You receive per Star |
|---|---|
| Desktop / web / Fragment | ~$0.013 |
| iOS / Android in-app | ~$0.009 |

We plan on a conservative **~$0.010/Star** (mobile-heavy RU/KZ audience) and
verify the model still clears target at the $0.009 floor.

## The rule: 1 patron = $0.02 of AI cost

`CREDIT_COST_BASIS = 0.02` in `src/models.ts`. Every model charges:

```
credits = ceil(approxCostUsd / 0.02)
```

so **cost-per-patron is always ≤ $0.02**. Patrons are then sold at **9–12 ⭐**
each. At $0.010/Star that's $0.09–0.12 revenue per patron → **4.5×–6× base
margin**, and still **≥3.5×** at the $0.009 floor after the 10% referral share.

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

## Packs

Ladder in ⭐/patron (bigger pack = better rate). The cheapest rate (9⭐) is the
margin floor; smaller packs run richer.

| Pack | Patrons | Stars | ⭐/patron | You net (~$0.010) | Margin |
|---|---|---|---|---|---|
| Старт | 60 | 720 | 12 | $7.20 | 6.0× |
| Популярный | 200 | 2 200 | 11 | $22 | 5.5× |
| Про | 500 | 5 000 | 10 | $50 | 5.0× |
| Студия | 900 | 8 100 | 9 | $81 | 4.5× |

Play with the assumptions in the interactive calculator before changing these.

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
