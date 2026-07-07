# Course funnel & campaign playbook

The product ladder that turns audience (yours + partners') into paying users,
and the viral campaigns that feed it. Campaigns are LIVE in the bot
(`CAMPAIGNS` in `src/models.ts`); the courses are packaged offers built on top.

> **Source material**: the mentor chat export (`raw_data/ChatExport_2026-07-07`)
> lives only on the owner's machine — push it to the repo and we mine it for
> the strongest prompts (→ more campaign presets) and course lesson content.

## The ladder (free → $9 → $50)

| Tier | Offer | Contents | Why it converts |
|---|---|---|---|
| **Free tripwire** | «10 готовых промптов + 5 🔫 в подарок» | Telegra.ph/PDF guide with 10 copy-paste prompts, each ending "или просто нажмите кнопку в боте"; a partner deep link (`?start=c_<code>`) grants +5 🔫 | Value up front (valuemaxxing); the gift lands them *inside* the bot with ammo to feel the magic |
| **$9 «Быстрый старт»** | Mini-course, 5 short lessons + **60 🔫 included** | Lessons: 1) фото → 3 стиля, 2) карточка товара, 3) сказка с ребёнком (campaign!), 4) оживление фото, 5) как продавать результат. Delivered as a private TG channel | The included 🔫 pack alone ≈ the price — the course feels free (valuemaxxing) |
| **$50 «AI-контент под ключ»** | Flagship, 3 modules + **500 🔫** + cohort chat + certificate | M1: фото/аватары, M2: видео и оживление, M3: продажи — маркетплейсы, клиенты, прайсинг. Homework runs in the bot | Serious buyers get a business skill + practice budget; mentor co-brand carries trust |

Payments: Stars today ($9 ≈ 500⭐, $50 ≈ 2800⭐ at user-facing rates); card
checkout (Kaspi/YooKassa, roadmap §F) unlocks the course audience fully.
Mentor sells it → his partner code earns his negotiated % automatically.

## Warming sequence (5 touches, repeatable per campaign)

1. **Hook** — post a campaign result (сказка/кумир/старое фото) with the story,
   not the tech. Comment magnet: «хотите такое же — ссылка в закрепе».
2. **Value** — free tripwire guide drop. Every reader lands in the bot with +5 🔫.
3. **Proof** — user-generated results, before/after, screen-recording of the
   one-tap flow (it takes literally two taps — show that).
4. **Open cart** — $9 mini-course, 48-hour window, «60 🔫 внутри».
5. **Ascend** — buyers of $9 get the $50 offer with the $9 credited.

## The 5 live campaigns (one-tap presets in the bot)

| Campaign | Hook | Pipeline | Revenue per full flow |
|---|---|---|---|
| 📖 Сказка с ребёнком | parents' hearts | photo → fairy-tale image (11 🔫) → «Оживить сказку» (25 🔫) | 36 🔫 |
| 🦸 Ребёнок и герой | SpongeBob/Гамбол/Три кота/D Billions/Baby Shark | same | 36 🔫 |
| ⚽️ Матч мечты | World Cup NOW — с Месси/Роналду/Ямалем | same | 36 🔫 |
| 🕰 Оживить старое фото | the strongest emotional hook in CIS | restore/colorize (11) → «как живые» (25) | 36 🔫 |
| 🎬 Постер с тобой | self-expression, shareable | poster (11) → living poster (25) | 36 🔫 |

Design notes:
- **One click**: no prompt-typing anywhere; curated prompts carry the quality.
- **The upsell is the funnel**: the image result instantly offers the video for
  one more tap — the 36 🔫 full flow doesn't fit the 12 free 🔫, so delighted
  users hit the paywall *after* seeing a real result. That's the moment packs sell.
- **The video animates the generated image** (not the raw photo) — a true
  two-step pipeline (`runGeneration` accepts direct URLs).
- ⚠️ **IP note**: the cartoon campaign names well-known characters for personal,
  non-commercial family images at the user's request. Providers may refuse some
  renders (auto-refund covers it). Don't use character names/images in *our own
  paid advertising* — promote that campaign with generic wording («любимый
  герой мультика») and let users pick inside the bot.

## Promo banners (Higgsfield MCP)

One banner/GIF per campaign for channel posts and the mentor's audience:
square 1:1 hero image per campaign + a 3–5s animated teaser (image→video →
GIF). Generate via the Higgsfield MCP when connected (`generate_image`,
`generate_video`) — prompts should show the *outcome* (a child as a storybook
hero, a restored family photo coming alive), never UI screenshots. Store under
`assets/campaigns/`.

## Measured funnel

Every campaign tap is logged (`select camp:*`, `preset cpre:*`, `gen_start`,
`paywall`, `purchase`) — `/funnel` already shows where users stall; compare
campaigns by preset events to double down on the winner.
