# Mentor course analysis → NeuroShot product map

Source: full Telegram export of «Мастер группа "Нейро-Карьера"» (Seymur Ragimov,
@ragimovseymur) — Mar–Jul 2026, 181 messages, ~17 active students. This is the
partner whose audience lands in our bot via `c_<code>` deep links
(docs/creator-program.md, docs/course-funnel.md).

## 1. His teaching pipeline (what a student actually experiences)

**Cadence** — 2 live Zoom lessons/week (Tue+Fri, 19:00 МСК / 21:00 Астана),
announced same-day, link dropped at start time, recording posted within hours
with a recap. Weekly loop: Fri lesson + homework («реальное ТЗ от бизнеса») →
weekend work → Mon submission → Tue public review of every student's work
(«довели ролики до более "дорогого" результата»). Sunday is a declared day off.

**Support** — homework is checked in the chat *before* the student publishes;
stuck students are told to DM the mentor personally. High-touch, small cohort.

**Curriculum progression** (each stage = a sellable artifact):
1. Mobile editing in **VN** (8 short lessons, 1.5–32 min each; fonts + trailer
   SFX supplied as files: Trajan, Cinzel, Social Gothic — the "premium look" kit)
2. **Product video**: watch (часы) from 3–4 generated images → video; then a
   full product card: 11–12 images approved in chat → assembled into a clip
3. **Character pipeline**: close-up with the face → full-height/waist shots
   with a prop → outfit/accessory change → animate. (Identity consistency is
   the core taught skill — exactly what our presets' `KEEP_ID` lines do.)
4. **Film/serial production**: character sheets (aged versions, relatives),
   scene-by-scene storyboards where every кадр = image prompt + narrator line;
   voiceover via **@steosvoice_bot** («Старец рассказчик») and **ElevenLabs**
5. **Tools covered in эфиры**: Kling 3, Seedance 2.2 («сиденс22»), Veo, Grok,
   ElevenLabs — the exact model set our bot resells by the патрон.
6. **Distribution & monetization**: Instagram packaging (nick, bio, highlights,
   palette, avatar), the "залетающий" reels formula (hook ≤5s, script, cover,
   5 visible + 25 hidden hashtags split 10 geo / 10 broad / 10 topical,
   description duplicated in comments), daily-posting homework with pre-flight
   review, a Google-Sheet of TG-каналы и биржи for selling the skill, and a
   **7-day launch playbook** for selling your own AI course (история → результат
   → возражения → бесплатная польза → опрос → анонс → продажа, cap "20 мест").

**Gamification** — public score table (50–67 points per student), places 1–3
win promotion on the mentor's page; runners-up get gifts. Contest homework:
«ФИЛЬМ + ТОВАР — первые три места заработают рекламу на странице».

### Why this matters to us
His students are trained to spend on exactly our catalog (Kling/Seedance/
premium image edits), produce *series* of renders per assignment (10+ images,
multiple video takes — that's 100–300 🔫 per homework at our prices), and are
told to publish daily. A partner code + a «Домашка Нейро-Карьеры» campaign
in the bot converts his curriculum into our recurring usage.

## 2. His prompt library (mined from the export)

Patterns he teaches, and how they map to what `promptcraft.ts` + presets already do:

| His pattern | Example from the chat | In NeuroShot today |
|---|---|---|
| **Scene formula for film stills**: era/place → characters+emotion → light (контровой) → camera (средний план, уровень глаз, 35 мм) → blurred bg → engine/style tag → AR/res | «1990-е. Утро. Кухня. …Солнечный свет… Камера: средний план, 35 мм… Unreal Engine 5, Pixar-уровень реализма. 16:9, ультра высокое разрешение» + «тёплые песочно-медовые оттенки, вдохновлённая Bilal» | `craftPrompt` appends materials/lighting/camera coherence; presets carry the full formula. **Gap**: no «кино-кадр 3D-драмы» preset — add one modeled on this exact structure |
| **Identity lock**: face 1:1 from reference, no beautification | «Face: Strict 1:1 replication of reference image @Image 1… no beautification or stylization» | Our `KEEP_ID`/`KEEP_KID` suffixes do this in every preset ✅ |
| **Pro video prompt anatomy** (the tokusatsu transformation): theme → character setup → environment → visual quality (IMAX, Panavision 35mm, 1/4 aperture, palette) → effects → **one continuous take** camera path → per-3-seconds shot breakdown → audio spec (SFX only, no music) | the full EN "dark knight + capybara Taotie" prompt | Our `animatePrompt`s are the lite version (single dominant camera move). **Gap**: a «трейлер»-tier video preset with shot-breakdown structure for Kling 3/Seedance |
| **Macro product shot** | «ЭКСТРЕМАЛЬНО МАКРО МИКРО КАДР БЛИЖНИЙ на… циферблат, стрелка, боковая кнопка» | **Gap**: add `product_macro` preset — sellers need the detail shot for card #2 |
| **Storyboard = кадр + рассказчик** pairs, 6–8 frames, closing on-screen text | Серия 22 «Три работы» (8 кадров) | **Gap/roadmap**: «Сериал» campaign — N images + narrator lines; needs TTS partner (he uses steosvoice/ElevenLabs) |
| **Mega role-prompts for text** (copywriter fused from 13 legends; marketer-mentor; 8–12-stories прогрев with AIDA/PAS/4P + 5 сценарных схем) | «Воплоти в себе мастерство Stefan Georgi…», «Ты — виртуальный ментор…» | Out of our image/video scope — but his own funnel copy is built with these; useful for OUR channel posts |

## 3. What a user sees when activating NeuroShot today (activation audit)

Flow as deployed (bot @neuroshot_ai_bot, code refs in `src/bot.ts`):

1. `/start` (or `?start=c_mentor`) → hero image + «📸 NeuroShot — AI-фотосессии
   и продающие фото товаров в один тап. Никаких промптов…» + **3 free 🔫**
   (+gift патроны if via partner/referral link, with the partner's name shown)
2. Menu of outcomes (never models): AI-фотосессия / Фото товара / Оживить фото
   (от 25 🔫) / 🎉 Кампании / Картинка из текста / Топ AI-модели / 🌐 приложение
   / Баланс / Пригласить друга
3. Tap a use case → **preview album of expected results** → «пришлите фото»
4. Photo in → one-tap preset keyboard with prices on every button
5. First preset costs 11 🔫 > 3 free → **«первый результат за наш счёт»** fires:
   the render happens anyway, «🎁 Первый результат — бесплатно» (PR #19)
6. Result arrives with next-step keyboard («Ещё стиль» / Меню); campaigns
   immediately offer the one-tap video upsell (25 🔫) on the generated image
7. Second attempt → **sales-page paywall**: outcome headline, the model they
   tried, «Старт» pack anchored as «N результатов за ⭐720», one dominant CTA
8. Returning `/start` → «🆕 Новинка недели» (weekly-rotating campaign) +
   «📸 Продолжить с вашим фото»

**The premium experience today** = патроны, not a subscription: payers unlock
the top-model pickers (Nano Banana Pro 8, GPT Image 2 11, Kling 3.0 42,
Seedance 2.0 61–76 🔫), campaign image→video chains, and the 🌐 Mini App
(wallet with count-up, gallery of their renders, in-app packs, referral card).
No watermarks anywhere, auto-refund on provider failure, results in chat + app.

**Gaps vs "premium" as the market defines it** (see §4): no priority queue, no
4K/upscale tier, no multi-shot series per character, no subscription floor, no
TTS/voice. Cheapest fixes first: upscale pass + «серия из 4 кадров» button.

## 4. Ten competitors: anchor points & benefits

_To be filled from live research (agents running) — placeholder._

## 5. Actions

1. **Partner launch with Seymur**: mint `c_seymur` (25%, +10 🔫) — his students
   arrive trained; add a «Домашка: товарное видео» campaign mirroring his ТЗ
   (11 images → clip) so the bot is the default homework tool.
2. **Preset additions from his library**: `product_macro` (macro detail shot),
   `cinema_3d` (Bilal-style warm 3D film still), «трейлер» video preset with
   shot-breakdown prompt for Kling 3.
3. **Premium ladder**: 4K upscale (+N 🔫), приоритетная очередь for 500+ pack
   holders, «серия кадров» (4 consistent shots, one tap).
4. **Content**: reuse his 7-day прогрев structure for our channel launch; his
   reels formula (hook/cover/hashtags) for campaign promo posts.
