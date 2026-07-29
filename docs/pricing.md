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

so **cost-per-patron is always ≤ $0.02** — about **9.5 ₸** at the rate the digest
uses, and flat across every model in the catalogue, because the credits column is
derived from cost rather than set per model.

Patrons are sold at **30–40 ₸** each (≈ $0.06–0.08) → **3.2–4.2× gross margin** on
any render anyone can make, with no model sold at a loss even at the floor. The
band was lowered from 47–62 ₸ in 2026-07: at a per-patron price this far above
provider cost, the number that decides revenue is how many people buy at all, not
what each patron earns.

## The two purpose-built sets

One generic "combo" used to serve both intents at 36 🔫. That is enough for three
of the *cheapest* videos and not one of the good ones — so the same pack was
oversized for someone who wanted to play with photo styles and useless to someone
who wanted a real video. Split in two, each sized from the recipe it is named
after.

### 🎁 Первый набор — 100 🔫 for 2 500 ₸ (the entry price, once per account)

25 ₸/🔫, deliberately **below** the band, and `once: true` rather than
`offer: true`. That distinction is the whole design. An offer has to expire to
stop being the standing rate, which means a countdown, which means pressure — and
a countdown that keeps coming back is the part buyers stop believing. A `once`
pack needs no clock: for any given person it is gone the moment they take it, and
from then on the same 100 🔫 costs the ladder price.

It is sized to match `photo_set` exactly (100 🔫 either way) so "было 3 800,
стало 2 500" is a comparison the buyer can check two tiles down rather than a
saving we assert.

Enforced against **granted** orders (`db.hasGrantedPack`), at the buy button, at
`POST /api/order`, and in what the Mini App is even sent. An abandoned or rejected
order does not burn it — people back out of a payment screen constantly. Two
payments genuinely in flight at once will grant both; `grantPurchase` alerts an
admin instead, because taking money and refusing the patrons is the worse failure.

### 🎨 Фото-сет — 100 🔫 for 3 800 ₸

38 ₸/🔫 — a standing ladder tier now, not a countdown offer. Buys 50 preset looks
(2 🔫), 25 fast frames (4 🔫) or 12 top-tier frames (8 🔫). Also the reference
price the entry set is discounted against.

### 🎬 Видео-сет — 650 🔫 for 21 000 ₸

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
32.3 ₸/🔫, between Про (34) and Студия (30), so "bigger pack, better rate"
still holds end to end. An e2e step asserts the 3–5 promise, the ladder
monotonicity, and that every rung stays inside the 30–40 band.

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
| 🎁 Первый набор (once) | 100 | 2 500 ₸ | 25 | $5.2 | ~2.6× |
| Старт | 60 | 2 400 ₸ | 40 | $5.0 | ~4.2× |
| 🎨 Фото-сет | 100 | 3 800 ₸ | 38 | $7.9 | ~4.0× |
| Популярный | 200 | 7 400 ₸ | 37 | $15 | ~3.9× |
| Про | 500 | 17 000 ₸ | 34 | $35 | ~3.6× |
| 🎬 Видео-сет | 650 | 21 000 ₸ | 32.3 | $44 | ~3.4× |
| Студия | 900 | 27 000 ₸ | 30 | $56 | ~3.2× |

\* vs the ~9.5 ₸/patron provider cost, at `KZT_PER_USD=480`, before Kaspi fees.
Only «Первый набор» sits below the ladder, and only once per account — every
standing price is inside the 30–40 ₸ band.

### Course tiers

The two course packs (`course_fast`, `course_flagship`) are bundles — patrons
plus teaching — so they are filtered out of every listing, keyboard and paywall
anchor (`!p.course`) and sold only through `/course`. That is a **listing**
decision, not a pricing exemption. The 2026-07 ladder move left them at 61.7 and
50 ₸/🔫 against a 30–40 band, which meant the most expensive patrons in the
catalogue were the ones sold to the people we had just persuaded to learn — and
made «Фото-сет» (100 🔫 for 3 800 ₸) a strictly better buy than the course that
was supposed to feed it.

Fixed by moving the **patrons**, not the sticker. Both tickets are unchanged, so
no Kaspi fixed-amount link has to be re-issued:

| Pack | Patrons | Price | ₸/patron | Patrons alone | Tuition |
|---|---|---|---|---|---|
| 🎓 Быстрый старт | 60 → **100** | 3 700 → **3 800 ₸** | 61.7 → **38.0** | 3 800 ₸ | **0 ₸** |
| 🎓 AI-контент под ключ | 500 → **700** | 25 000 ₸ | 50.0 → **35.7** | 21 000 ₸ | **4 000 ₸** |

"Patrons alone" is `ladderValueOf(credits)` (`src/models.ts`) — what the same
patrons cost on the pay screen, valued at the rate of the smallest standing rung
that covers the size, so it is a number the buyer can check against a tile.

The two tiers answer the tuition question differently on purpose:

- **«Быстрый старт» is a tripwire.** Its patrons are worth *exactly* its ticket
  (100 🔫 = «Фото-сет» = 3 800 ₸), so «уроки идут бесплатно» is arithmetic the
  buyer verifies two tiles down rather than a claim. The e2e step pins the
  equality, so a future ladder move cannot quietly turn the pitch into a lie.
- **«Под ключ» charges real tuition.** 700 🔫 cost 21 000 ₸ at «Студии»'s rate;
  the remaining 4 000 ₸ buys three modules, the cohort and the certificate. A
  course priced at exactly its patron content is a course we are giving away.

Both stay inside the 30–40 band and **above** the once-per-account entry rate
(25 ₸/🔫): a course cheap enough to buy *for* the patrons stops being a course
and becomes a hole in the ladder with lessons attached. The e2e step asserts the
band, the entry-rate floor, monotonicity between the two tiers, and both tuition
rules.

⚠️ Still open (`docs/course/BLOCKERS.md`): the shipped `fastStartLessonMessages`
Lesson 2 homework costs ~143 🔫, which 100 🔫 still does not cover — the repackaged
45 🔫 version was never landed in the codebase. The pre-payment claim «с запасом на
весь курс» has been removed from `/course` in the meantime, so nothing is promised
that the budget cannot keep, but the lesson copy itself remains blocker 3's job.

The cheaper scenario stack also *reprices the value story*: a «Старт — 60 🔫»
pack now buys **~5 whole Hailuo scenarios** (12 🔫 each) instead of ~1 Kling
scenario. Same margin per patron, far better perceived value — the anchor a paid
social campaign needs.

## Seedance promo (2026-07-29, real and time-limited)

Every Seedance 2.0 variant is **30% cheaper** for `SEEDANCE_PROMO_DAYS` (default
7) from `SEEDANCE_PROMO_START` (default: process boot) — `src/offer.ts`
(`seedancePromoActive` / `seedancePromoMult`), applied inside `priceFor()` so
the discount reaches both the catalog display and the real charge from one
place. `costUsdFor()` is deliberately untouched — real provider cost doesn't
move, only what the buyer pays does, so the margin digest still reports true
COGS.

**30% is not a round number picked for how it sounds — it's the deepest cut
that still clears a 2× floor on the WORST-CASE standing pack rate** (30 ₸/🔫,
«Студия»), which is what matters because `CREDIT_COST_BASIS` makes every
patron cost the same ~9.5 ₸ regardless of which Seedance variant spends it:

| Модель | 15с 720p, полная цена | 15с 720p, −30% | Маржа на «Студии» (30 ₸/🔫) |
|---|---|---|---|
| Seedance 2.0 (флагман) | 228 🔫 | 160 🔫 | 2.20× |
| Seedance Fast | 182 🔫 | 128 🔫 | 2.20× |
| Seedance Mini | 114 🔫 | 80 🔫 | 2.20× |
| Seedance по фото (`seedance_ref`) | 114 🔫 | 80 🔫 | 2.20× |

A 36% cut is the mathematical floor (2.0×, no room for a Kaspi fee or a
refund); 30% leaves real headroom. `test/e2e.ts` pins this — the margin
floor, that the promo covers the whole family (not one variant), and that
`costUsdFor` stays real — so a future depth change can't ship past 36%
without the test failing first. `test/webapp.ts` runs with the promo pinned
to 0 by default (its `seedance_ref` price-invariance checks hardcode the
STANDING 38 🔫 base) and has one dedicated step that turns it on and proves
the discount reaches a real `/api/generate` charge, not just `priceFor()` in
isolation.

Turn it off entirely with `SEEDANCE_PROMO_PCT=0`; pin an exact end date with
`SEEDANCE_PROMO_START` the same way the combo offer does.

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
