# NeuroShot — product roadmap

Turns the owner's PR#3 brief into an actionable split, grounded in the 10-month
VeoSee/Neuroplace teardown (1,932 posts, Sep 2025–Jul 2026). Guiding thesis:
our users are **newcomers, not pros** — they never see a prompt unless they ask.
Every VeoSee weakness (prompt complexity → $200 course, format fatigue,
aggregator treadmill, reliability debt) is an opening we design against.

Legend — effort: **S** ≤1 day · **M** a few days · **L** 1–2 weeks.
Evidence tags cite the competitor's own numbers.

---

## 🔴 URGENT — this sprint (unblocks launch, low-risk, high-leverage)

### 1. Foundational base menu — proven formats as one-tap presets  · S
VeoSee's own top-viewed posts are our demand list, already A/B-tested at 40K subs.
Add each as a categorized preset (no prompt for the user):

| Preset | Category | Evidence (their views) |
|---|---|---|
| Пара «Love is» (вкладыш) | photo | 15.3K — their #1 ever |
| Обложка к 8 марта / журнал | seasonal | 12.3K |
| Портрет мама-дочь (акварель) | photo | 11.6K |
| Семейное фото (Новый год) | seasonal | 9–10K |
| Детский рисунок → реалистичный | photo | 8.2K |
| Твоё авто в кадре из «Форсажа» | photo | 10.6K |
| Instagram-сетка 3×3 для товара | product | 9.5K |
| Pixar-аватар | photo | 5.9K |

Mechanically this is data entry into `PRESETS` in `src/models.ts` — the engine
already renders them. Ship behind the existing category menus.

### 2. Newcomer interaction layer — inspiration-first  · M
The winning move against a "paste-200-words" competitor: lead with results, not tools.
- **First-run guided flow**: `/start` → "Отправьте селфи — покажем 3 стиля бесплатно"
  → auto-offer the 3 free credits on the first three taps. Zero reading.
- **Gallery/"сделать такое же"**: browsable example results (from `brand-assets/` +
  generations); each has a «Сделать со своим фото» button that pre-selects the preset.
- **«Удиви меня»**: one button → random on-trend preset applied to their photo.
Rationale: their complexity created a course market and capped mainstream reach.

### 3. Prompt library v1 — curated, browsable  · S–M
The library IS the preset system, surfaced as a first-class `/library` section:
categories (Люди · Товары · Тренды · Праздники), each a tap-to-run card.
No free-text prompting required; "✍️ свой промпт" stays as the escape hatch for pros.

### 4. Trend tracking v1 — manual but visible  · S
- `/trends` section: a hand-curated shortlist of "тренд недели", each a runnable preset.
- **New-model / new-trend push** (their single most reliable engagement lever): opt-in
  broadcast when we add a model or trend. Wire a simple admin broadcast + `subscribed` flag.

### 5. Reliability as a stated feature  · S
Their documented pain: charged-but-failed generations, DM-only refunds, multi-day
outages. We already auto-refund instantly — surface it in copy ("сбой = мгновенный
авто-возврат") and add a lightweight `/status` self-check.

---

## 🟡 BACKLOG — upcoming (bigger bets, sequence after launch signal)

### A. Community virality engine — turn each micro-creator into distribution  · L
Modeled on VeoSee's referral machine (5₽/click + 10% lifetime, same-day payouts,
earnings case studies) but cleaner:
- Referral leaderboard + earnings screenshots as in-bot social proof.
- **UGC contests** ("лучшая нейрофотосессия недели", prize = credits) — entries made in-bot.
- **"Сделано в NeuroShot"** soft attribution on shared results (toggle) → organic reach.
- Ambassador tier for micro-creators: higher rev-share + early model access.
- Share-to-earn: free credits for the first N friends who generate.

### B. Trend auto-ingestion — semi-automated pipeline  · L
Watch competitor channels / TikTok trend signals, draft candidate presets, human-approve
into `/trends`. Ship each trend as a *preset the same day* — "тренд дня уже кнопка".

### C. Prompt library v2 — search, favorites, "промпт дня"  · M
Full-text search, per-user favorites, seasonal auto-rotation, and a daily featured preset.

### D. Platform expansion  · L
Mini App (galleries, model picker) → web app + SEO landings per use case. Bring this
earlier if RU is primary: VeoSee took a real revenue hit from the March 2026 TG block —
collect an email/contact channel from day one as a hedge.

### E. Advanced creator tools  · L
Soul-style character/identity consistency, batch generation, brand kits for sellers,
premium video tier (Veo/Sora via reseller with fal fallback).

### F. Payments & monetization — from the competitor Mini-App teardown  · L
The incumbent leads its welcome copy with **"ОПЛАТА ДОСТУПНА АБСОЛЮТНО ВСЕМИ СПОСОБАМИ
(Любые карты, Crypto, PayPal), оплата из любой точки земли"** — payment breadth is a
*headline* differentiator in this market, not a nice-to-have (RU-card sanctions make
"pay from anywhere" a real pain point they solve). Their checkout (Mini App) offers:
Карта МИР, ЮKassa (RU cards), СБП, Visa/MC (KZ/СНГ), PayPal, SEPA (EUR), Apple Pay,
**Kaspi.kz**, Crypto — plus email-for-receipt, promo code, and currency (USD/RUB) select.

Adopt (in the Mini App checkout — Telegram Stars alone can't cover this):
- **Multi-provider card checkout** · L — YooKassa (RU cards + СБП + Мир), **Kaspi** (KZ,
  essential), **Crypto** (CryptoBot/TON — no entity, cross-border, the sanctions hedge),
  PayPal, cards for KZ/CIS, SEPA. Each path just credits the same ledger. (See the payment
  options analysis; sequence: Crypto → Kaspi → YooKassa.)
- **Email-for-receipt + currency select** · S — required for card/fiscal receipts
  (RU 54-ФЗ / YooKassa needs email); show price in USD/RUB/KZT.
- **Promo codes** · S — % or fixed discount at checkout, capped activations (they ran
  `VALENTIN -20%`, 100 uses). Great for посевы attribution and seasonal campaigns.
- **Subscription tiers** · M — recurring monthly plans (their "Start 100 кр / $7.5·600₽,
  доступ ко всем моделям, +5% реф-выплата") alongside one-off packs. Recurring revenue;
  depends on card billing above. Keep our tiers use-case-framed, not "all neural nets".

Already covered (do NOT rebuild): profile + credit balance, generation-history gallery,
partnership/affiliate tab → shipped in the Mini App / on the roadmap (§A).

Reviewed and **not adopting** (against the wedge — see Anti-goals):
- **Audio AI, Text/LLM AI** menu sections — pure aggregator surface; dilutes the
  "AI photoshoots & product videos" wedge. Skip.
- **Persistent reply-keyboard menu** — cosmetic; our guided inline flow is a deliberate
  UX choice and reads better for newcomers. Skip (revisit only if data shows menu friction).
- **"Самые низкие цены" / lowest-price positioning** — that's the price-war trap that
  compressed their margins. Compete on one-tap UX + results, not price.

Small standalone win worth pulling forward: **`/support`** contact (command + link) — they
expose "Служба поддержки"; we have none. · S

---

## ⚠️ Anti-goals (errors to avoid — from the decline curve)
1. **Don't become an aggregator.** Their view-count halved over 10 months of "все нейросети".
   Stay wedge-first: models live behind use cases, never as a menu of names.
2. **Don't make prompts the product.** That's what built their $200 course and capped adoption.
3. **No urgency theatre / price wars.** They cut premium prices 60–70% under comment pressure
   and run perpetual "последний день акции" — it monetizes short-term and bleeds trust.
4. **Don't relax moderation for growth.** Their "без цензуры" angle is a payments/platform risk.
5. **Don't stay Telegram-only past traction.** Hedge the platform early.

---

## Suggested next sprint (concrete)
Ship URGENT #1 + #3 together (proven presets + `/library`) — pure `models.ts` +
one menu section, low risk, extends PR#3. Then #2 (onboarding) and #4 (trends + push)
as the retention layer. Everything above is additive to the current preset engine.
