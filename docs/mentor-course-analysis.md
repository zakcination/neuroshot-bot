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
   the core taught skill — exactly what our identity-preservation prompt lines
   do: the `KEEP_ID`/`KEEP_KID` constants in campaigns and the equivalent
   "Preserve the person's identity…" sentences embedded in presets.)
4. **Film/serial production**: character sheets (aged versions, relatives),
   scene-by-scene storyboards where every кадр = image prompt + narrator line;
   voiceover via **@steosvoice_bot** («Старец рассказчик») and **ElevenLabs**
5. **Tools covered in эфиры**: Kling 3, Seedance 2.2 («сиденс22»), Veo, Grok,
   ElevenLabs — the same model families our bot resells by the патрон (we ship
   Kling 3.0 and Seedance 2.0 today; version drift is a models.ts update away).
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

Patterns he teaches, and how they map to what `src/promptcraft.ts` + presets already do:

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
   tried, «Старт» pack anchored as «N результатов за 3 700 ₸», one dominant CTA
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

## 4. Competitors: anchor points & benefits

Live-researched Jul 2026 (web sources; figures marked ~ are reported ranges).
Six RU Telegram bots + five global apps = the landscape our users compare us to.

| # | Competitor | Positioning | Free tier | Entry anchor | Premium anchor | Signature UX trick |
|---|---|---|---|---|---|---|
| 1 | **Syntx AI** (@syntxaibot) | «90+ нейросетей в одном боте, без VPN, рублями» | 5 токенов + 5 LLM-запросов | Basic 890₽/мес (260 ток.) | VIP 3990₽ → Ultra 11990₽ | Токен-кошелёк + «безлимитные» дешёвые LLM создают ощущение бездонной подписки; результаты стираются через 60 дней |
| 2 | **@GPT4Telegrambot** (2.6M MAU) | All-in-one: ChatGPT/Claude/Midjourney | ~100 бесплатных запросов/нед на лёгких моделях | ~500₽/мес; Stars pay-as-you-go | ~100 GPT + 20 MJ генераций/день | Название бота = живой билборд («ChatGPT 5 \| Gemini 3 \| Nano Banana»); Stars-микрокошелёк прячет реальную цену юнита |
| 3 | **ChadGPT** (chadgpt.ru) | «Одна подписка заменяет десяток», на русском | 3–7 запросов/день на лёгких моделях | Мини 290₽/мес (120k «искр») | Плюс 1690₽ (900k искр, все 54 модели) | «Искры» как единая валюта текста/картинок/видео; крошечный дневной кран заставляет решиться за считанные дни |
| 4 | **BotHub** (@bothub_chat_bot) | 50+ моделей из России, MIR/рубли | 30 000 Caps разово (текст) | $3 = 2 000 000 Caps | Premium $7 / Elite $49 | Caps миллионами анкорят «щедрость»; кредиты **не сгорают** — «не платишь за воздух» как анти-подписочный оффер |
| 5 | **Kandinsky (Сбер) + Шедеврум (Яндекс)** | Бесплатные генерации от бигтеха | Kandinsky: полностью бесплатен; Шедеврум: безлимит в приложении / 70 img + 10 video в день на вебе | — | Шедеврум Про **100₽/мес**: без вотермарки, без публикации в ленту, без очереди, коммерческое использование | Задают ценовой пол рынка: «бесплатно, но с вотермаркой/лентой/очередью». Платные боты вынуждены продавать качество, лицо, скорость и приватность |
| 6 | **TurboText AI** (@TurboText_bot) | «Nano Banana 2 \| VEO3.1 \| Безлимит»; нейрофотосессия как флагман | ~10 пробных + ежедневный /get_bonus до 100 ток. + каждая 5-я генерация бесплатно | Токены от 2–3/картинка; тарифы «от 100₽», PRO-день 250₽ | Ultra/VIP 1090–15000₽ с обещанием «безлимита» | Казино-ретеншн: ежедневный бонус, каждая-5-я-бесплатно, лотерея для топ-спендера |
| 7 | **Remini** (100M MAU) | «Old blurry photos → HD in one tap» | Несколько улучшений/день за просмотр рекламы, с вотермаркой | Lite ~$4.99–7.99/**нед** | Pro $9.99/нед; годовой «−50%» | Результат показывают ДО пейволла; недельная микро-цена кажется мелочью (годом — дорого) |
| 8 | **Lensa AI** | «Influencers' best kept secret»: Magic Avatars | Нет (только 7-дневный триал редактора) | Пак аватаров $3.99/50 шт | $29.99–35.99/год + паки | Двойная монетизация: подписка продаётся как скидочная карта на паки аватаров |
| 9 | **PhotoAI.com** | «Fire your photographer» — AI-фотосессии | Нет («принципиально без freemium») | $19/мес (50 кредитов, 1 модель) — «$9/мес при годовой = 6 месяцев бесплатно» | Pro $49 → Ultra $199/мес | Живой счётчик «30 158 126 фото»; 48 бесплатных фото с каждой обученной моделью как свитнер после оплаты |
| 10 | **Higgsfield** | AI-native creative suite, 30+ моделей | Тонкий дневной кран кредитов, вотермарка | Starter $15/мес (200 кр., без топ-видео-моделей) | Plus $39 → Ultra $99/мес (годовые дают «unlimited»-карусель моделей) | Сгорающие кредиты + «безлимит» только на годовых тарифах толкают вверх и в 12-месячный лок-ин |
| 11 | **PhotoRoom** | «Sell at first sight» — фото товара для e-com | 250 экспортов/мес, вотермарка, без коммерческой лицензии | Pro $7.50/мес (годом) / $4.99/нед на мобиле | Max $20.99 → Ultra $82.50/мес | Вотермарка + запрет коммерческого использования как рычаг конверсии: инструмент работает полностью, но продавать результат нельзя, пока не заплатишь |

### Что это значит для NeuroShot (anchor-инсайты)

1. **Бесплатная проба везде = 2–5 генераций.** Наши 3 🔫 + гарантированный
   «первый результат за наш счёт» — в рынке, но с уникальным отличием: у нас
   первая проба — **премиум-качество с лицом пользователя**, а не урезанная
   модель. Это и есть наш «результат до пейволла» (приём Remini).
2. **RU-якорь входа: 290–890₽/мес.** Наш «Старт» (3 700 ₸ ≈ 1200–1400₽ разово)
   выше входного якоря. Тест (иллюстративно, не реализовано): «Проба» ≈930 ₸/15 🔫
   как **paywall-only** оффер (1 премиум-фото + ощущение прогресса) — цена
   получена по ставке текущего «Старт»-пакета (62 ₸/🔫, самая высокая ₸/🔫-ставка
   нашей лестницы), импульсная зона 290₽-нормы, маржа держится.
3. **Потребителю продают исходы, не кредиты** (50 аватаров, 48 фото, «фотосессия»).
   Пакеты в /buy подписать исходами: «Старт — 5 фотосессий или 2 оживления»,
   как уже сделано на пейволле («до N результатов»).
4. **Дифференциация от бесплатного бигтеха** (Шедеврум 0–100₽ задаёт пол):
   говорить в онбординге то, чего у них нет — **ваше лицо 1:1 без искажений,
   топ-модели (Kling 3/Seedance/GPT-Image), без вотермарки, без очереди, без
   публичной ленты, приватно**. Никогда не конкурировать с ними по цене.
5. **Стандартные краны ретеншена** (daily bonus, канал-подписка, каждая-5-я)
   у нас сознательно заменены purchase-gated экономикой. Безопасный аналог:
   разовый бонус за подписку на канал + «новинка недели» (уже есть).
6. **Премиум-рычаги рынка**: без вотермарки (у нас уже), коммерческая лицензия,
   приоритет/параллельность, топ-модели, разрешение. Дешевле всего добавить:
   **приоритетную очередь для пакетов 500+ 🔫 и 4K-апскейл за доплату**.
7. **Подписка — отдельный трек**: недельные микро-цены (консюмер) или годовые
   −50% (просьюмер). Наш текущий платёжный рельс (Kaspi) не даёт нативного
   recurring-биллинга «из коробки», так что подписка потребует отдельного
   механизма (периодические ссылки/напоминания или сторонний биллинг) —
   «PRO-проходка» (приоритет + скидка на пакеты, точная цена ₸/мес не выбрана)
   — кандидат в роадмап, но только после того, как пакетная экономика покажет
   стабильный LTV.
8. **UX-приёмы, которые стоит забрать**: имя бота как билборд моделей
   («NeuroShot \| Kling 3 \| Nano Banana»), живой счётчик генераций в вебапп,
   счётчик «фото до конца пакета» после каждого результата. Приём, который
   **не** берём: автоудаление результатов через 60 дней (Syntx) — враждебно.

## 5. Actions

1. **Partner launch with Seymur**: mint `c_seymur` (25%, +10 🔫) — his students
   arrive trained; add a «Домашка: товарное видео» campaign mirroring his ТЗ
   (11 images → clip) so the bot is the default homework tool.
2. **Preset additions from his library**: `product_macro` (macro detail shot),
   `cinema_3d` (Bilal-style warm 3D film still), «трейлер» video preset with
   shot-breakdown prompt for Kling 3.
3. **Premium ladder** (market-standard levers we lack): 4K upscale (+N 🔫),
   приоритетная очередь for 500+ pack holders, «серия кадров» (4 consistent
   shots, one tap); commercial-license wording in pack descriptions (free =
   personal use — the PhotoRoom lever, costs nothing to state).
4. **Pricing tests from the anchor scan**: paywall-only «Проба» pack ≈930 ₸/15 🔫
   (illustrative — priced at our «Старт» pack's 62 ₸/🔫 rate; impulse zone of
   the 290₽ RU entry norm, margin intact); outcome-subtitles on all packs
   («≈ N фотосессий»); subscription-tier PRO-проходка parked until pack LTV is
   proven.
5. **Positioning copy vs free big-tech**: onboarding and channel posts lead
   with what Шедеврум/Kandinsky can't do — ваше лицо 1:1, топ-модели, без
   вотермарки и очереди, приватно. Never compete on price with free.
6. **Content**: reuse his 7-day прогрев structure for our channel launch; his
   reels formula (hook/cover/hashtags) for campaign promo posts; bot name as
   model billboard («NeuroShot | Kling 3 | Nano Banana»).
