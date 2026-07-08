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

## Not shipped yet (need infra / a scheduler)
Abandoned-cart 24h discount (#9), weekly broadcast to past users (#6), daily
streak (#10) — all need a cron/broadcast layer the ephemeral env doesn't have
yet. Next infra step: a scheduled job that reads the event log and messages
paywall-no-buy users.
