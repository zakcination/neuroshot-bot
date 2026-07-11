# Product-building playbook — 20 ideas → 3 shipped

Distilled from the growth corpus's **Product building** pillar and adapted to
NeuroShot. The three principles: (A) one segment / one job / one visible result;
(B) design the recurring reason in from day one; (C) spend dev time on the first
30 seconds (photo in → wow → paywall).

## The 20 ideas

**A. One segment · one job · one visible result**
1. Outcome+deadline `/start` headline, not a 6-button model menu
2. Per-segment deep links (`?start=wb` → product cards; `?start=baby` → fairy-tale)
3. Rename generic buttons to concrete outcomes ("Резюме-портрет за 1 минуту")
4. One featured "результат дня" on top instead of equal-weight buttons
5. Before/after hero image on `/start` (show the transformation, not the tool)

**B. Design the recurring reason in from day one**
6. Weekly "новая модель — попробуйте на своём последнем фото" hook
7. **"Новинка недели": a rotating featured campaign** so there's always a fresh reason to spend
8. **"Продолжить с вашим фото" on return** (reuse the saved photo)
9. Abandoned-cart discount 24h after a paywall-no-buy (corpus #631)
10. Streak / daily nudge (kept tiny — anti-abuse)
11. Seasonal auto-rotation (World Cup now, New Year later)
12. Save gallery → "сделайте ещё стиль" re-engagement

**C. Spend dev time on the first 30 seconds**
13. **Guaranteed free first result** — never wall a newcomer before one real wow
14. Align free credits so exactly one premium result is reachable
15. `/start` asks for a photo immediately (skip menu friction)
16. **Paywall as a sales page** — outcome headline + anchored pack + "≈ N результатов" (corpus #488/#656)
17. Zero-input demo ("попробовать на примере")
18. Example-result album before asking for a photo (partly done)
19. Onboarding checklist (① фото ② стиль ③ готово)
20. Contextual paywall tied to the exact result they just tried

## The 3 shipped (highest leverage, in-request-path, abuse-safe)

### 1. First result on us — idea #13 (activation)
**Bug it fixes:** production `FREE_CREDITS=3`, but every preset/campaign costs
**11** 🔫. A new user hit the paywall on their **first tap, before any wow** —
breaking the corpus's #1 rule ("first result free, second paid").

**Behaviour:** if a newcomer can't afford their first *image* preset/campaign,
they get **one free render** instead of a wall — once per user, image-only
(video, the expensive upsell, is excluded). The freebie is peeked before render
and **consumed only on success**, so a provider failure never burns it, and the
referral/partner economy is untouched. Copy: "🎁 Первый результат — бесплатно".

`db.hasFreeResult` / `db.consumeFreeResult` · `runGeneration({ allowFreeFirst })`
· `users.free_result_used`.

### 2. Paywall as a sales page — ideas #16/#20 (conversion)
The naked "Не хватает 🔫" became a sell: an outcome headline, the exact model
they tried, and the **entry pack anchored** and framed as "до **N** таких
результатов", with one dominant CTA (buy the entry pack) + a secondary "все
пакеты". Contextual to what they were about to make.

`payments.paywallText` / `payments.paywallKeyboard`.

### 3. Recurring reason — ideas #7/#8 (retention)
A returning `/start` surfaces a **weekly-rotating "🆕 Новинка недели"** campaign
(deterministic by ISO week — no scheduler) plus a one-tap **"📸 Продолжить с
вашим фото"** shortcut when the last photo is still on file (the corpus's exact
"new model dropped, try it on your last photo" hook). Zero giveaway.

`models.featuredCampaign` / `models.weekIndex` · `mainMenu({ featured, hasPhoto })`.

### 4. Persona-routed entry links — idea #2 (acquisition→activation)
An acquisition-source deep link now **pre-selects the first action** that fits
the persona (strategy §04), so a targeted click lands straight on the converting
scenario instead of the generic menu. No extra patrons are granted (the free
scenario is the sized trial), so the public link stays un-farmable; `source` is
still recorded for first-touch attribution.

| Link | Lands on |
|---|---|
| `?start=src_football` | Football free scenario (photo → гол на стадионе) |
| `?start=src_princess` | Princess free scenario |
| `?start=src_revive` / `src_oldphoto` | «Оживить старое фото» campaign |
| `?start=src_poster` | «Постер с тобой» campaign |
| `?start=src_photoshoot` | AI-фотосессия (styles) |
| `?start=src_product` / `src_kaspi` | Product-photo flow (SMB sellers) |

`models.ENTRY_LINKS` / `models.entryLinkFor` · `bot.routeEntry`.

### 5. Photo-quality tip — first-30-seconds (activation)
Every face-photo ask now carries a one-line quality nudge (`text.PHOTO_TIP` /
`withPhotoTip`) — blurry/dark/tiny-face source photos are the silent churn driver
for non-technical users (a bad result reads as "продукт плохой", not "плохое
фото"). Applied to the free scenarios and campaign asks; product photos are
exempt (the tip is face-oriented).

### 6. 48-hour re-engagement nudge — ideas #6/#12 (retention)
A once-daily sweep on the existing `monitor.ts` loop DMs users who went **dormant
(no activity >48h) but were recently active (≤14d)**, **at most once each**
(`users.nudged_at`). The copy is tailored to the strongest reason to return:
never-claimed free gift → lead with it; 🔫 left → "your patrons are waiting";
else a fresh-content nudge. Marks before sending (a crash or a blocked user can
never spam), batch-capped (`REENGAGE_BATCH`, default 50/day) and rate-limit-safe,
with an env off-switch. This closes the CJM gap flagged in the strategy audit —
returning users previously had no scripted reason to come back.

`db.usersToNudge` / `db.markNudged` · `monitor.runReengagement` / `nudgeText`.

### 7. Identity-gate the free hook — anti-farm (unit economics)
Optional gate (`FREE_GATE_ENABLED`, default **off**) that, before the free
scenario, asks for a **verified phone** via a Telegram contact request and ties
the gift to the **phone number, not the Telegram account** — so multi-account
farming needs multiple real numbers (Higgsfield had to ban 40k farmed accounts).
`free_claims.phone` is a PK, so a number can claim once; the same owner may retry
a failed render, a different account with the same number is blocked. Kept **off**
by default because it adds onboarding friction — turn it on **before scaling paid
acquisition** into the free scenario, per the strategy audit.

`db.claimFreePhone` / `setUserPhone` · `bot` (free gate + `message:contact`) ·
`generate.runFreeScenario` prologue.

## Not shipped yet (need infra / a scheduler)
Abandoned-cart 24h discount (#9), weekly broadcast to past users (#6 full), and
daily streak (#10) — the next lifecycle steps. The re-engagement sweep is the
first scheduled-messaging job; the same loop can later target paywall-no-buy
users specifically.
