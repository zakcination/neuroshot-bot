import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { UserFromGetMe } from "grammy/types";
import type { Context } from "grammy";
import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, InputMediaBuilder, Keyboard } from "grammy";
import { config } from "./config.js";
import {
  addCredits,
  claimWelcomeBonus,
  createPartnerCode,
  deactivatePartnerCode,
  deleteUserData,
  ensureRefCode,
  funnel,
  getGeneration,
  getOrCreateUser,
  getPartnerCode,
  getUser,
  getUserIdByRefCode,
  hasFreeScenario,
  joinPartnerProgram,
  listPartnerCodes,
  logEvent,
  myPartnerCodes,
  myWithdrawals,
  partnerAccount,
  pendingOrders,
  presetUsageCounts,
  resolveOrder,
  partnerStats,
  pendingWithdrawals,
  phoneClaimedFree,
  referralStats,
  requestWithdrawal,
  resolveWithdrawal,
  setPending,
  setUserPhone,
  stats,
  upsertPartnerCode,
  type PartnerCodeRow,
  type UserRow,
} from "./db.js";
import { isUploadedSource as isReusableUpload, modelByKey, runFreeScenario, runGeneration } from "./generate.js";
import { buildDigest, formatDigest } from "./monitor.js";
import {
  CAMPAIGNS,
  campaignById,
  entryLinkFor,
  FREE_SCENARIOS,
  freeScenarioById,
  IMAGE_MODEL_PICKER,
  MODELS,
  packById,
  PRESET_MODEL,
  presetModel,
  PRESETS,
  REFERRAL_MILESTONES,
  VIDEO_MODEL_PICKER,
  type Campaign,
  type EntryRoute,
  type Preset,
} from "./models.js";
import { grantPurchase, registerPayments, sendBalance } from "./payments.js";
import { nUnits, UNIT_EMOJI, withPhotoTip } from "./text.js";

async function user(
  ctx: { from?: { id: number; username?: string } },
  referrerId: number | null = null,
  partner: PartnerCodeRow | null = null,
  source: string | null = null,
): Promise<UserRow> {
  if (!ctx.from) throw new Error("no ctx.from");
  return getOrCreateUser(
    ctx.from.id,
    ctx.from.username,
    referrerId,
    config.freeCredits,
    config.referralJoinBonus,
    partner,
    source,
  );
}

/**
 * UX rules (vs the model-first aggregator bots):
 * - buttons name the OUTCOME, never the model;
 * - every path reaches a generation in ≤2 taps, no prompt required;
 * - price in credits on every button that spends;
 * - every delivered result carries a "next step" keyboard.
 *
 * @param opts.featured  prepend a one-tap "🆕 Новинка недели" row (recurring reason)
 * @param opts.hasPhoto  prepend "продолжить с вашим фото" (try-on-your-last-photo hook)
 * @param opts.claimPending  🔫 parked and unclaimed (see claimWelcomeBonus) — shown
 *   as the very first row since it's a zero-cost, zero-friction action that should
 *   resolve before anything else (an unclaimed newcomer has 0 spendable balance).
 */
export function mainMenu(
  opts: { featured?: Campaign; hasPhoto?: boolean; freeScenario?: boolean; claimPending?: number } = {},
): InlineKeyboard {
  // Deliberately minimal: only the anchors that get a newcomer to a result
  // fast (upload → wow). Secondary surfaces (product, text→image, top-models,
  // balance, invite) live behind commands (/buy, /ref) and inside the studio,
  // so the chat stays a clean, high-converting funnel — not a control panel.
  const kb = new InlineKeyboard();
  // 0) The claim gate: free patrons parked but not yet spendable (see db.ts
  // claimWelcomeBonus) — a deliberate "get your gift" tap onboards better than a
  // silent credit, per the product's welcome-flow design.
  if (opts.claimPending && opts.claimPending > 0) {
    kb.text(`🎁 Получить ${nUnits(opts.claimPending)} бесплатно`, "claim:welcome").row();
  }
  // 1) The hook: one free video from a single photo (shown until claimed).
  if (opts.freeScenario) kb.text("🎁 Бесплатное видео за 1 фото — без оплаты", "menu:free").row();
  // 2) Contextual fast path: keep going with the photo already on file.
  if (opts.hasPhoto) kb.text("📸 Продолжить с вашим фото", "menu:styles").row();
  // 3) The two core create anchors that showcase product quality.
  kb.text("📸 AI-фотосессия по вашему фото", "menu:photoshoot").row();
  kb.text("🎬 Сценарии: сказки • кумиры • кино", "menu:campaigns").row();
  // 4) The studio (create, gallery, pricing) — the full surface, one tap away.
  if (config.webappUrl) kb.webApp("🌐 Открыть студию NeuroShot", config.webappUrl).row();
  // 5) One extra row for the course ladder (real revenue, low clutter cost) —
  // everything else about the course lives behind /course, not the main menu.
  kb.text("🎓 Курс по AI-контенту", "menu:course").row();
  return kb;
}

/** /course overview text: the free → $9 → $50 ladder (docs/course-funnel.md). */
function courseText(): string {
  const fast = packById("course_fast");
  const flagship = packById("course_flagship");
  return (
    `🎓 <b>Курс по AI-контенту — от новичка до продаж</b>\n\n` +
    `📖 <b>Бесплатно</b> — 10 готовых промптов, каждый уже "зашит" в кнопку бота.\n` +
    (fast
      ? `🚀 <b>«Быстрый старт» — ${fast.kzt} ₸</b> — 5 уроков + ${nUnits(fast.credits)} внутри (с запасом на весь курс).\n`
      : "") +
    (flagship
      ? `🎓 <b>«AI-контент под ключ» — ${flagship.kzt} ₸</b> — 3 модуля + когорта + ${nUnits(flagship.credits)} + сертификат.\n\n`
      : "\n") +
    `Обучение — в приватном Telegram-канале вашей когорты; доступ к каналу открывается ` +
    `автоматически сразу после оплаты.`
  );
}

/** Buttons under /course: free guide + the two course packs (reuses buy:<id>). */
function courseKeyboard(): InlineKeyboard {
  const fast = packById("course_fast");
  const flagship = packById("course_flagship");
  const kb = new InlineKeyboard().text("📖 Бесплатный гайд: 10 промптов", "course:guide").row();
  if (fast) kb.text(`🚀 «Быстрый старт» — ${fast.kzt} ₸`, "buy:course_fast").row();
  if (flagship) kb.text(`🎓 «AI-контент под ключ» — ${flagship.kzt} ₸`, "buy:course_flagship").row();
  return kb;
}

/**
 * Free-guide content (docs/course/00-free-guide.md), condensed to Telegram
 * HTML and split into chunks that stay well under the 4096-char message limit.
 * Keeps the exact prompt text + bot-button pointers from the source; prose is
 * condensed.
 */
function freeGuideMessages(): string[] {
  const idKeep = "Keep the person's face and identity exactly as in the photo.";
  const msg1 =
    `📖 <b>10 готовых промптов, которые залетают</b>\n\n` +
    `Каждый промпт уже "зашит" одним тапом в боте — можно скопировать его в любой генератор вручную, ` +
    `а можно просто нажать кнопку и получить тот же результат за 10 секунд, без единого слова промпта.\n\n` +
    `<b>1. 💼 Бизнес-портрет</b> — строгий деловой хедшот из обычной селфи.\n` +
    `<i>Restyle into a professional corporate headshot: a tailored suit, soft studio key light with an 85mm ` +
    `lens look, clean neutral-gray backdrop, shallow depth of field, a confident expression, tack-sharp face. ${idKeep}</i>\n` +
    `→ 🖼 Редактирование фото → 💼 Бизнес-портрет\n\n` +
    `<b>2. 🕶 Fashion-съёмка</b> — обложка глянцевого журнала из телефонной фотографии.\n` +
    `<i>Restyle into a high-fashion editorial photo: a designer outfit, dramatic studio lighting, Vogue-style ` +
    `composition, subtle film grain, bold styling, tack-sharp face. ${idKeep}</i>\n` +
    `→ 🖼 Редактирование фото → 🕶 Fashion-съёмка\n\n` +
    `<b>3. 🌅 Закат на Санторини</b> — сильный хук для сторис "а я такая на Санторини 😍", без билета на самолёт.\n` +
    `<i>Place the person in a breathtaking golden-hour travel scene on a Santorini rooftop at sunset: warm rim ` +
    `light, an editorial travel-magazine look, tack-sharp face. ${idKeep}</i>\n` +
    `→ 🖼 Редактирование фото → 🌅 Закат на Санторини`;

  const msg2 =
    `<b>4. 🧍 Коллекционная фигурка</b> — вирусный формат "себя в виде игрушки в блистере".\n` +
    `<i>Turn the person into a highly detailed collectible action-figure version of themselves, posed inside ` +
    `clear blister packaging on a printed cardboard backer with a title header and small accessory items, ` +
    `studio product lighting, glossy plastic and vinyl textures, realistic toy proportions but a clearly ` +
    `recognizable face. ${idKeep}</i>\n` +
    `→ 🖼 Редактирование фото → 🧍 Коллекционная фигурка\n\n` +
    `<b>5. 🕰 Оживить старое фото</b> — самый эмоциональный хук: реставрация + раскраска + "как живые".\n` +
    `<i>Restore and colorize this old photograph: remove scratches, dust and damage, then add natural realistic ` +
    `colors true to the era — accurate skin tones, period-correct clothing colors, keep the authentic vintage ` +
    `composition. Preserve every person's identity and facial features exactly.</i>\n` +
    `→ 🎉 Кампании → 🕰 Оживить старое фото → 🎨 Реставрация + цвет (следующий тап оживляет фото в видео)\n\n` +
    `<b>6. 🛍 Продающая карточка товара</b> — телефонная фотка товара становится продающим фото для маркетплейса.\n` +
    `<i>Turn this into a premium e-commerce hero shot: the product on a clean seamless studio background with ` +
    `soft shadows, professional three-point lighting, subtle reflection, marketplace-listing composition, 4k ` +
    `quality. Keep the product's shape, colors and branding exactly as in the photo.</i>\n` +
    `→ 🖼 Сцена по фото → 🛍 Продающая карточка`;

  const msg3 =
    `<b>7. ⬜️ Белый фон для маркетплейса</b> — обязательный формат для Wildberries/Ozon/Kaspi.\n` +
    `<i>Cut out the product and place it on a pure seamless white studio background (#FFFFFF) with a soft ` +
    `natural shadow underneath, centered marketplace-listing composition, even professional lighting, 4k ` +
    `quality. Keep the product's shape, colors and branding exactly as in the photo.</i>\n` +
    `→ 🖼 Сцена по фото → ⬜️ Белый фон (маркетплейс)\n\n` +
    `<b>8. 📖 Сказка с вашим ребёнком</b> — фото ребёнка становится героем сказки.\n` +
    `<i>Place the child as the hero of a fairy tale in an enchanted glowing forest at golden hour: drifting ` +
    `fireflies, soft god-rays through the trees, wonder on their face, storybook-cinematic detail. Keep the ` +
    `child's face and identity exactly as in the photo.</i>\n` +
    `→ 🎉 Кампании → 📖 Сказка с вашим ребёнком → 🌲 Волшебный лес\n\n` +
    `<b>9. 🎬 Постер с тобой</b> — кинопостер главного героя из одной селфи.\n` +
    `<i>Turn the person into the star of a blockbuster action movie poster: a commanding hero pose, explosions ` +
    `and a city skyline behind, high-contrast cinematic grade, dramatic one-sheet composition with clean ` +
    `negative space at the top for a title. ${idKeep}</i>\n` +
    `→ 🎉 Кампании → 🎬 Постер с тобой → 💥 Боевик\n\n` +
    `<b>10. 🎬 Оживление фото</b> — любой результат выше превращается в 5-секундное видео одним тапом.\n` +
    `<i>Slow cinematic push-in as the subject's hair and clothing shift gently in the light, a soft natural ` +
    `gaze shift and the trace of a smile forming — one calm, lifelike beat, cinematic film-grade color.</i>\n` +
    `→ под любым результатом: 🎬 Оживить фото\n\n` +
    `Все 10 промптов доступны бесплатно в боте, без единой строчки текста — это и есть NeuroShot: результат, а ` +
    `не промпт-инжиниринг.\n\n` +
    `Хотите не только жать кнопки, но и научиться собирать из этого продающий контент, серии и кино — ` +
    `5-урочный курс «Быстрый старт» (3700 ₸, ${nUnits(60)} внутри) ждёт вас: /course`;

  return [msg1, msg2, msg3];
}

/**
 * «Быстрый старт» ($9, docs/course/01-fast-start.md), lesson by lesson —
 * condensed to Telegram HTML, same treatment as freeGuideMessages. Menu paths
 * mirror the free guide's own shorthand (e.g. "🖼 Редактирование фото", "🎉
 * Кампании" name the FEATURE, not a literal main-menu button — same convention
 * freeGuideMessages already uses above).
 *
 * Prices are pulled live from src/models.ts rather than hardcoded, which is
 * how two numbers in the source .md were caught drifting from the current
 * catalog (see PR description): the campaign image used to run on Nano Banana
 * 2 (4 🔫) and now runs on the cheaper Seedream default (PRESET_MODEL, 2 🔫);
 * the "🎬 Оживить сказку" one-tap upsell used to run on Kling (42 🔫) and now
 * runs on the cheap Hailuo default (10 🔫). Corrected here, not in the .md.
 */
export function fastStartLessonMessages(lessonNum: 1 | 2 | 3 | 4 | 5): string[] {
  const skazka = campaignById("skazka")!;
  const oldphoto = campaignById("oldphoto")!;
  switch (lessonNum) {
    case 1:
      return [
        `🚀 <b>«Быстрый старт» — Урок 1. Фото → 3 стиля</b>\n\n` +
          `Ваш первый результат должен случиться за 2 тапа — это и есть весь продукт: не "научись писать промпт", ` +
          `а "получи результат прямо сейчас".\n\n` +
          `<b>Как:</b>\n` +
          `1. /start → 🖼 Редактирование фото\n` +
          `2. Отправьте своё фото (селфи или обычное фото анфас)\n` +
          `3. Выберите пресет: <b>💼 Бизнес-портрет</b>, <b>🕶 Fashion-съёмка</b> или <b>🎥 Кино-портрет</b>\n` +
          `4. Результат — за 10–20 секунд\n\n` +
          `Каждый пресет держит <b>identity lock</b>: лицо остаётся 1:1 вашим, меняется только стиль, свет и одежда ` +
          `— то, на что в ручном промпт-инжиниринге уходит 20+ минут подбора формулировок.\n\n` +
          `<b>Цена:</b> ${PRESET_MODEL.credits} ${UNIT_EMOJI} за стиль.\n\n` +
          `📝 <b>Домашнее задание:</b> сделайте 3 разных стиля с одним и тем же фото, выберите лучший, пришлите в ` +
          `чат когорты.`,
      ];
    case 2:
      return [
        `🚀 <b>«Быстрый старт» — Урок 2. Карточка товара</b>\n\n` +
          `Это первый навык, который можно сразу продавать — карточка товара на маркетплейс или в Instagram-магазин. ` +
          `Мануально это студия, свет и фотограф; у вас — телефон и один тап.\n\n` +
          `<b>Как:</b>\n` +
          `1. Пришлите фото товара (можно прямо на столе при дневном свете)\n` +
          `2. На вопрос «Что сделать с этим фото?» выберите <b>🛍 Продающее фото товара</b>\n` +
          `3. Выберите подачу:\n` +
          `   • <b>⬜️ Белый фон (маркетплейс)</b> (${PRESET_MODEL.credits} ${UNIT_EMOJI}) — обязательный формат для ` +
          `Wildberries/Ozon/Kaspi\n` +
          `   • <b>🛍 Продающая карточка</b> (${MODELS.premium_edit.credits} ${UNIT_EMOJI}) — студийный свет, три ` +
          `источника, отражение; более сильный движок, чтобы держать текст на этикетке чётким\n` +
          `   • <b>🌿 Lifestyle-сцена</b> (${PRESET_MODEL.credits} ${UNIT_EMOJI}) — товар "в жизни", для Instagram\n\n` +
          `Для карточки с текстом на упаковке бот сам подставляет движок, который не "плывёт" по буквам — вы просто ` +
          `жмёте кнопку, ничего не настраиваете.\n\n` +
          `📝 <b>Домашнее задание</b> (то же ТЗ, что и в мастер-группе): снимите 11–12 фото одного товара с разных ` +
          `ракурсов, прогоните через <b>⬜️ Белый фон</b> и <b>🛍 Продающая карточка</b>, соберите из лучших 4–5 ` +
          `карточку для маркетплейса.`,
      ];
    case 3:
      return [
        `🚀 <b>«Быстрый старт» — Урок 3. Сказка с ребёнком (полная кампания)</b>\n\n` +
          `Ваш первый разбор кампании целиком — от фото до готового видео с апсейлом внутри. Кампании — не просто ` +
          `пресет, а мини-воронка: картинка → предложение оживить → видео.\n\n` +
          `<b>Как:</b>\n` +
          `1. /start → 🎉 Кампании → 📖 Сказка с вашим ребёнком\n` +
          `2. Пришлите фото ребёнка\n` +
          `3. Выберите сцену: <b>🌲 Волшебный лес</b>, <b>🐉 Дракон и герой</b> или <b>👑 Королевство</b>\n` +
          `4. Результат — картинка. Под ней сразу кнопка <b>🎬 Оживить в видео</b>\n` +
          `5. Тап — и картинка становится 5-секундным видео\n\n` +
          `<b>Почему это учебный пример, а не просто ещё один пресет:</b> здесь виден принцип всей воронки — ` +
          `картинка стоит <b>${PRESET_MODEL.credits} ${UNIT_EMOJI}</b> (хватает бесплатного лимита новичка), видео ` +
          `— <b>${skazka.animateModel.credits} ${UNIT_EMOJI}</b> (уже за пределами бесплатных патронов). Именно на ` +
          `этом шаге у обычного пользователя срабатывает пейволл — он уже видел вау-результат и хочет продолжения. ` +
          `Держите это в голове, строя свои продажи в Уроке 5: сначала бесплатный вау, потом платное продолжение.\n\n` +
          `📝 <b>Домашнее задание:</b> пройдите кампанию <b>${oldphoto.label}</b> (найдите дома старый снимок) — тот ` +
          `же принцип "картинка → оживить", но с самым сильным эмоциональным хуком на нашем рынке.`,
      ];
    case 4:
      return [
        `🚀 <b>«Быстрый старт» — Урок 4. Оживление фото</b>\n\n` +
          `Видео — то, что реально "залетает" в Reels/TikTok. Урок 3 уже показал видео внутри кампании; здесь — как ` +
          `оживить <b>любое</b> фото вне кампаний и как выбирать движок под задачу.\n\n` +
          `<b>Как:</b>\n` +
          `1. Под любым результатом фото — кнопка <b>🎬 Оживить в видео (Kling / Seedance)</b>\n` +
          `2. Простое, одно движение (поворот, улыбка, ветер треплет волосы) — бот ведёт на бюджетный движок\n` +
          `3. Для сложной сцены (несколько действий, физика, звук) — там же доступны более сильные движки; цена ` +
          `растёт, но это тот случай, когда результат должен быть "дорогим": трейлер, экшн-сцена\n\n` +
          `<b>Ценовой ориентир</b> (весь список цен бот показывает сразу, от дешёвого к дорогому): простое видео — ` +
          `от ${MODELS.hailuo_fast.credits} ${UNIT_EMOJI} (эконом-движок), кино-движение — ` +
          `${MODELS.kling3.credits} ${UNIT_EMOJI}, "эпичная" сцена со звуком и физикой — ` +
          `${MODELS.seedance_fast.credits}–${MODELS.seedance.credits} ${UNIT_EMOJI}.\n\n` +
          `📝 <b>Домашнее задание:</b> возьмите карточку товара из Урока 2, "оживите" её (например, товар медленно ` +
          `поворачивается или появляется на сцене) — так рождается видео-контент для маркетплейса, который ` +
          `увеличивает конверсию сильнее статичного фото.`,
      ];
    case 5: {
      const flagship = packById("course_flagship");
      return [
        `🚀 <b>«Быстрый старт» — Урок 5. Как продавать результат</b>\n\n` +
          `Готовый контент без упаковки и дистрибуции не работает. Этот урок — не про генерацию, а про то, что ` +
          `происходит после: как оформить профиль и выложить ролик так, чтобы его увидели.\n\n` +
          `<b>Оформление Instagram:</b>\n` +
          `1. Никнейм — короткий, запоминаемый, по теме\n` +
          `2. Шапка профиля — кто вы + что делаете + результат (не "интересуюсь ИИ", а "делаю продающие видео за 1 ` +
          `день")\n` +
          `3. Актуальные — раздел "о себе" + отзывы\n` +
          `4. Цветовая гамма — единая палитра во всех публикациях\n` +
          `5. Аватарка — узнаваемое лицо/логотип\n` +
          `6. Рилсы — основной формат для охвата\n\n` +
          `<b>Формула вирального ролика:</b>\n` +
          `1. Хук — первые 4–5 секунд должны зацепить\n` +
          `2. Сценарий — завлекающий, с развитием мысли, а не просто "вот что я сделал"\n` +
          `3. Обложка рилса — должна продавать сама по себе\n` +
          `4. Хештеги — 5 в описании + 25 скрытых в комментариях (10 гео + 10 общих + 10 узких)\n` +
          `5. Описание — завлекающее в посте, продублировано в комментарии\n\n` +
          `<b>Правило:</b> перед публикацией — самопроверка по всем 5 пунктам выше. Пропущенный пункт = потерянный ` +
          `охват.\n\n` +
          `📝 <b>Финальное домашнее задание курса:</b> соберите один полный ролик (фото → стиль или карточка → ` +
          `оживление), оформите по формуле выше и опубликуйте. Пришлите ссылку в чат когорты — лучшие разборы ` +
          `попадают в следующий поток как примеры.\n\n` +
          (flagship
            ? `🎓 Прошли все 5 уроков? Флагманский курс <b>«AI-контент под ключ»</b> (${flagship.kzt} ₸, ` +
              `${nUnits(flagship.credits)}, когорт-чат, сертификат) идёт дальше — цепочки персонажей, мини-фильмы ` +
              `со звуком и озвучкой, и полный плейбук запуска собственного продукта на этом навыке: /course`
            : ""),
      ];
    }
  }
}

/**
 * «AI-контент под ключ» ($50, docs/course/02-flagship.md), module by module —
 * same Telegram-HTML treatment as fastStartLessonMessages. Prices pulled live
 * from src/models.ts; the 7-day playbook table and frame/narrator table in the
 * source .md become plain numbered lists (Telegram HTML has no table markup).
 */
export function flagshipModuleMessages(moduleNum: 1 | 2 | 3): string[] {
  switch (moduleNum) {
    case 1:
      return [
        `🎓 <b>«AI-контент под ключ» — Модуль 1. Фото и аватары — identity lock</b>\n\n` +
          `Все "продвинутые" персонажные пайплайны в ручном режиме (смена одежды с сохранением лица, разные ` +
          `ракурсы, старение/омоложение) держатся на одном приёме — жёсткой фиксации личности между кадрами. В ` +
          `боте это не отдельный навык, а свойство каждого пресета.\n\n` +
          `<b>Пайплайн персонажа (4 шага, каждый — один тап):</b>\n` +
          `1. Крупный план с лицом → 🖼 Редактирование фото → любой портретный пресет (<b>💼 Бизнес-портрет</b>, ` +
          `<b>🎥 Кино-портрет</b>)\n` +
          `2. Дальний план того же человека: в полный рост или по пояс, с одним предметом → тот же пресет с другим ` +
          `фото, или <b>✍️ Свой промпт</b> с явным описанием кадра\n` +
          `3. Смена образа: другая одежда, аксессуары → пресеты вроде <b>🕶 Fashion-съёмка</b> или <b>📼 Плёнка ` +
          `90-х</b> меняют стиль, сохраняя лицо\n` +
          `4. Оживление → <b>🎬 Оживить в видео</b> на лучшем результате\n\n` +
          `Во всех четырёх шагах работает один и тот же guard, встроенный в каждый пресет: <i>Keep the person's ` +
          `face and identity exactly as in the photo.</i> В ручном промпт-инжиниринге это пишут явно каждый раз (и ` +
          `часто забывают, отчего лицо "плывёт" между кадрами) — здесь это гарантировано автоматически.\n\n` +
          `<b>Когда нужен «Свой промпт»</b> (${MODELS.premium_edit.credits} ${UNIT_EMOJI}): для нестандартной ` +
          `задачи, не покрытой готовым пресетом — вы описываете сцену текстом, guard на identity добавляется ` +
          `автоматически. Структура сильного промпта: [эпоха/место] → [кто в кадре + эмоция] → [свет] → [камера: ` +
          `план, объектив] → [фон] → [стиль/движок] → [формат]. Готовый образец этой формулы — пресеты кампании ` +
          `<b>🎞 Мини-фильм с вами</b> (<b>🌅 Тёплая драма</b>, <b>📼 Ретро 90-х</b>, <b>⚔️ Эпичное кино</b>).\n\n` +
          `📝 <b>Задание модуля:</b> соберите персонажную серию из ваших 4 шагов, включая минимум один "Свой ` +
          `промпт" по формуле выше.`,
      ];
    case 2:
      return [
        `🎓 <b>«AI-контент под ключ» — Модуль 2. Видео и оживление — сторибординг и озвучка</b>\n\n` +
          `Один ролик — ремесло одного тапа. Серия роликов, которая рассказывает историю (сериал, рекламная серия, ` +
          `кейс клиента) — это сторибординг: список кадров, где под каждым визуал + текст рассказчика.\n\n` +
          `<b>Структура кадра:</b>\n` +
          `Кадр N: [что видно на экране]\n` +
          `Рассказчик: [что говорит закадровый голос — 1–2 предложения]\n\n` +
          `<b>Пример 8-кадровой структуры (от завязки к развязке):</b>\n` +
          `1. Завязка — кто герой, где он сейчас\n` +
          `2. Первое препятствие — проблема, с которой герой сталкивается\n` +
          `3–4. Попытки, труд — нарастание сложности, стойкость героя\n` +
          `5. Поворотная точка — момент решения/перемены\n` +
          `6. Первый результат — маленькая победа\n` +
          `7. Развитие — как результат меняет жизнь героя вокруг\n` +
          `8. Финал — итог + текст на экране, закрепляющий смысл\n\n` +
          `Каждый кадр в боте — отдельная генерация через кампанию <b>🎞 Мини-фильм с вами</b> (своё фото + сцена ` +
          `из квиза "когда/тон") или через <b>🖼 Редактирование фото</b> для промежуточных состояний персонажа. ` +
          `Монтаж кадров в серию — на телефоне, в любом видеоредакторе.\n\n` +
          `<b>Озвучка</b> — отдельный шаг, двумя внешними инструментами:\n` +
          `• <b>@steosvoice_bot</b> → голос "Старец рассказчик" — быстрый бесплатный вариант для СНГ-аудитории\n` +
          `• <b>ElevenLabs</b> (elevenlabs.io) → более широкий выбор голосов и языков, платно\n` +
          `Готовую дорожку вставляете в видеоредактор поверх смонтированной серии.\n\n` +
          `<b>Апгрейд «со звуком» одним тапом:</b> для одного ролика (не серии) кампания <b>🎞 Мини-фильм с вами</b> ` +
          `включает опцию <b>🎞 Снять мини-фильм (со звуком)</b> — рендерит многокадровую сцену с собственным ` +
          `амбиентным звуком на флагманском видео-движке, без внешней озвучки. До ` +
          `${MODELS.seedance.credits} ${UNIT_EMOJI} за ролик — из 500 ${UNIT_EMOJI} модуля хватает на несколько ` +
          `таких попыток.\n\n` +
          `📝 <b>Задание модуля:</b> соберите 6–8-кадровую серию по структуре выше, озвучьте через steosvoice или ` +
          `ElevenLabs, смонтируйте в один ролик.`,
      ];
    case 3:
      return [
        `🎓 <b>«AI-контент под ключ» — Модуль 3. Продажи — от контента к клиентам</b>\n\n` +
          `Навык без дистрибуции не монетизируется. Этот модуль — как превратить то, что вы научились делать в ` +
          `Модулях 1–2, в первых клиентов и первый доход.\n\n` +
          `<b>Три способа заработать на навыке:</b>\n` +
          `1. Продавать карточки и ролики бизнесам — тот же формат, что в Уроке 2 «Быстрого старта», но как услугу: ` +
          `находите малый бизнес без нормального контента, делаете карточку/ролик за оплату\n` +
          `2. Вести собственный блог — публикуете по формуле из Урока 5, растите аудиторию, монетизируете рекламой/ ` +
          `своими услугами\n` +
          `3. Партнёрская программа NeuroShot — получаете свой код (<code>?start=c_&lt;код&gt;</code>), приводите ` +
          `аудиторию в бота, зарабатываете % с каждой их покупки — /partner показывает live-статистику\n\n` +
          `<b>7-дневный плейбук запуска:</b>\n` +
          `День 1. История — «Ещё месяц назад я вообще не думал, что буду делать контент через ИИ» — честно: как ` +
          `узнали, почему начали, что было сложным\n` +
          `День 2. Результат — покажите свои лучшие карточки/ролики + метрики. Не продавайте — пусть люди сами ` +
          `спрашивают\n` +
          `День 3. Возражения — «Почему у большинства не получается» — не в человеке дело, а в отсутствии системы\n` +
          `День 4. Польза — бесплатная ценность: «5 промптов, которые я использую» или ссылка на бесплатный гайд ` +
          `(/course) — доверие резко растёт\n` +
          `День 5. Спрос — опрос: «Было бы интересно сделать вам такую карточку/ролик под ключ?» Собираете реакции, ` +
          `не называя цену\n` +
          `День 6. Анонс — показываете программу услуги: что входит, для кого, без цены — только ценность\n` +
          `День 7. Продажа — открываете набор: для кого, что получат, сколько стоит, бонус первым, лимит мест, ` +
          `явный призыв к действию\n\n` +
          `📝 <b>Задание модуля (финальное задание всего курса):</b> пройдите 7-дневный плейбук от начала до конца ` +
          `с реальной публикацией каждый день, приведите минимум одного платящего клиента или партнёрского ` +
          `перехода. Разбор в когорт-чате, сертификат — по итогу.`,
      ];
    }
}

/** Picker of the top text-to-image models (famous names, priced). */
function imageModelsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const key of IMAGE_MODEL_PICKER) {
    const m = MODELS[key];
    kb.text(`${m.label} (${m.credits} ${UNIT_EMOJI})`, `txt:${key}`).row();
  }
  return kb.text("🎬 Видео из фото →", "menu:animate").row().text("📋 Меню", "menu:main");
}

/** Picker of the top image-to-video models (famous names, priced). Needs a photo. */
function videoModelsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const key of VIDEO_MODEL_PICKER) {
    const m = MODELS[key];
    kb.text(`${m.label} (${m.credits} ${UNIT_EMOJI})`, `act:${key}`).row();
  }
  return kb.text("📋 Меню", "menu:main");
}

function presetsKeyboard(category: Preset["category"]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PRESETS.filter((x) => x.category === category)) {
    kb.text(`${p.label} (${presetModel(p).credits} ${UNIT_EMOJI})`, `preset:${p.id}`).row();
  }
  const prices = PRESETS.map((p) => presetModel(p).credits);
  kb.text(`🎲 Удиви меня (${Math.min(...prices)}–${Math.max(...prices)} ${UNIT_EMOJI})`, "preset:surprise").row();
  kb.text(`✍️ Свой промпт (${MODELS.premium_edit.credits} ${UNIT_EMOJI})`, "act:premium_edit").row();
  kb.text("📋 Меню", "menu:main");
  return kb;
}

// Preview images (expected results) live next to the built bot; shipped in the repo.
const PREVIEW_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "previews");

/** Example-results album for a category, so newcomers see outcomes before spending. */
async function sendPreviewAlbum(ctx: Context, category: Preset["category"]): Promise<void> {
  const items = PRESETS.filter((p) => p.category === category)
    .map((p) => ({ p, file: join(PREVIEW_DIR, `${p.id}.jpg`) }))
    .filter((x) => existsSync(x.file));
  if (items.length >= 2) {
    try {
      await ctx.replyWithMediaGroup(
        items.map((x) => InputMediaBuilder.photo(new InputFile(x.file), { caption: x.p.label })),
      );
    } catch (e) {
      // Previews are a nicety — never let an album failure block the keyboard below.
      console.error("preview album failed:", e);
    }
  }
}

/** Preview album + the tappable preset keyboard (used once a photo is on file). */
async function showPresets(ctx: Context, category: Preset["category"], header: string): Promise<void> {
  await sendPreviewAlbum(ctx, category);
  await ctx.reply(header, { reply_markup: presetsKeyboard(category) });
}

// Menu-level media (hero, per-flow examples) shipped in the repo.
const MENU_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "menu");

/** Main menu with the hero image (if shipped) carrying the caption + keyboard. */
async function sendMainMenu(
  ctx: Context,
  caption: string,
  menuOpts: { featured?: Campaign; hasPhoto?: boolean; freeScenario?: boolean; claimPending?: number } = {},
): Promise<void> {
  const hero = join(MENU_DIR, "hero.jpg");
  if (existsSync(hero)) {
    try {
      await ctx.replyWithPhoto(new InputFile(hero), {
        caption,
        parse_mode: "HTML",
        reply_markup: mainMenu(menuOpts),
      });
      return;
    } catch (e) {
      console.error("hero image failed:", e);
    }
  }
  await ctx.reply(caption, { parse_mode: "HTML", reply_markup: mainMenu(menuOpts) });
}

/** Send a menu example video (e.g. the animate preview) if the asset exists. */
async function sendMenuVideo(ctx: Context, name: string): Promise<void> {
  const file = join(MENU_DIR, `${name}.mp4`);
  if (!existsSync(file)) return;
  try {
    await ctx.replyWithVideo(new InputFile(file));
  } catch (e) {
    console.error(`menu video ${name} failed:`, e);
  }
}

/** Send a small album of example images for a flow (e.g. text-to-image). */
async function sendMenuAlbum(ctx: Context, names: string[]): Promise<void> {
  const files = names.map((n) => join(MENU_DIR, `${n}.jpg`)).filter((f) => existsSync(f));
  if (files.length < 2) return;
  try {
    await ctx.replyWithMediaGroup(files.map((f) => InputMediaBuilder.photo(new InputFile(f))));
  } catch (e) {
    console.error("menu album failed:", e);
  }
}

const WELCOME = [
  "📸 <b>NeuroShot</b> — AI-фотосессии и продающие фото товаров в один тап.",
  "",
  "Никаких промптов: выбираете, что хотите получить — остальное сделаем мы.",
  "",
  "Что создаём?",
].join("\n");

/**
 * Persona-routed entry: pre-select the first action for an acquisition-source
 * deep link (see ENTRY_LINKS) so a targeted click lands straight on the scenario
 * that fits — set the pending mode, show the relevant preview, and ask for the
 * right photo (with the quality tip), all in ONE message (`intro` carries the
 * welcome/credits line, so no separate generic menu is sent). Returns false when
 * it can't route (e.g. the free gift is already used) so the caller falls back to
 * the normal menu. No extra patrons are granted, so the public link stays
 * un-farmable.
 */
async function routeEntry(
  ctx: Context,
  userId: number,
  route: EntryRoute,
  intro = "",
): Promise<boolean> {
  const lead = intro ? `${intro}\n\n` : "";
  const say = (body: string) => ctx.reply(`${lead}${body}`, { parse_mode: "HTML" });
  if (route.kind === "free") {
    if (!(await hasFreeScenario(userId))) return false; // gift used → let the menu show
    const s = freeScenarioById(route.id);
    if (!s) return false;
    await setPending(userId, `mode_free_${s.id}`, null);
    await say(`${route.headline}\n\n${withPhotoTip(s.ask)}`);
    return true;
  }
  if (route.kind === "camp") {
    const c = campaignById(route.id);
    if (!c) return false;
    await setPending(userId, `mode_camp_${c.id}`, null);
    await say(`${route.headline}\n\n${withPhotoTip(c.ask)}`);
    return true;
  }
  if (route.kind === "product") {
    await setPending(userId, "mode_product", null); // product photos: no face-tip
    await sendPreviewAlbum(ctx, "product");
    await say(route.headline);
    return true;
  }
  // photoshoot: mirror the menu:photoshoot flow so the next photo lands in styles.
  await setPending(userId, "mode_photo", null);
  await sendPreviewAlbum(ctx, "photo");
  await say(withPhotoTip(route.headline));
  return true;
}

export function createBot(botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(config.botToken, botInfo ? { botInfo } : undefined);

  // Behavioural analytics: one central logger for every interaction (sessions,
  // menu selects, photo uploads). Generation/paywall/purchase events are logged
  // at their source. Runs before handlers; never blocks them.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (from) {
      try {
        const data = ctx.callbackQuery?.data;
        if (data) {
          if (data.startsWith("preset:")) await logEvent(from.id, "preset", data.slice(7));
          else if (data.startsWith("cpre:")) await logEvent(from.id, "preset", data.slice(5));
          else await logEvent(from.id, "select", data); // menu:* | camp:* | act:* | buy:* | show_packs
        } else if (ctx.message?.photo) {
          await logEvent(from.id, "photo");
        } else if (ctx.message?.text?.startsWith("/start")) {
          await logEvent(from.id, "menu_open", "start");
        } else if (ctx.message?.text === "/menu") {
          await logEvent(from.id, "menu_open", "menu");
        }
      } catch (e) {
        console.error("analytics log failed:", e);
      }
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    const payload = ctx.match?.trim();
    // Deep-link payloads: numeric = a LEGACY friend-referral link (raw tg id —
    // links minted before the opaque ref_code existed; still honored so old
    // shares keep crediting), c_<code>/p_<code> = creator/partner code,
    // anything else = try it as the new opaque ref_code, else it's an
    // acquisition-source slug (t.me/<bot>?start=src_tiktok1) for /dash.
    const legacyReferrerId = payload && /^\d+$/.test(payload) ? Number(payload) : null;
    // c_<code> = admin creator deal · p_<code> = self-serve partner code — both
    // live in partner_codes, so one lookup resolves either (first-touch attribution).
    const partner =
      payload && /^[cp]_/.test(payload)
        ? ((await getPartnerCode(payload.slice(2).toLowerCase())) ?? null)
        : null;
    // New opaque referral code (never the raw tg id) — a lookup, not a format
    // guess, so it can never collide with a future source-slug naming choice.
    const codeReferrerId =
      payload && !legacyReferrerId && !partner ? await getUserIdByRefCode(payload) : null;
    const referrerId = legacyReferrerId ?? codeReferrerId;
    const source =
      payload && !referrerId && !partner && payload !== "buy"
        ? payload.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || null
        : null;
    const u = await user(ctx, referrerId, partner, source);
    // The welcome bonus (signup + any join bonus) is claim-gated — parked in
    // pending_* until the user taps "🎁 Получить" (see claimWelcomeBonus). A
    // brand-new/unclaimed account has 0 spendable credits until then.
    let pending = u.pendingSignupCredits + u.pendingJoinBonus;
    let claimable = !u.welcomeBonusClaimed && pending > 0;
    // Persona-routed deep link (src_football / src_revive / src_product …): the
    // paid-acquisition promise is "≤2 taps to a result" (see mainMenu's doc
    // comment) — inserting a claim tap here would break that funnel. So THIS one
    // path auto-claims silently before routing; the generic /start below still
    // shows the deliberate "🎁 Получить" tap (better activation/onboarding for
    // organic signups, where there's no ad-funnel latency budget to protect).
    const route = entryLinkFor(source);
    if (route && claimable) {
      const claimed = await claimWelcomeBonus(u.id);
      if (claimed) {
        u.credits += claimed.granted;
        pending = 0;
        claimable = false;
      }
    }
    let msg = `${WELCOME}\n\n`;
    if (claimable) {
      msg += `🎁 Для вас — <b>${UNIT_EMOJI} ${nUnits(pending)}</b> бесплатно на старт.`;
      if (u.joinBonus && u.joinBonus > 0) {
        msg +=
          u.joinVia === "partner"
            ? `\nИз них <b>+${nUnits(u.joinBonus)}</b> — подарок от ${partner?.title ?? "партнёра"} 🤝`
            : `\nИз них <b>+${nUnits(u.joinBonus)}</b> — бонус за приглашение. Спасибо другу! 🤝`;
      }
      msg += `\nНажмите «🎁 Получить», чтобы забрать.`;
    } else {
      msg += `💰 На балансе: <b>${UNIT_EMOJI} ${nUnits(u.credits)}</b>.`;
    }
    // Lean funnel: the free gift is the headline, plus a one-tap continue-with-
    // your-last-photo shortcut for returning users. No secondary noise.
    const freeScenario = await hasFreeScenario(u.id);
    const menuOpts = u.justCreated
      ? { freeScenario, claimPending: claimable ? pending : undefined }
      : { hasPhoto: !!u.pending_file_id, freeScenario, claimPending: claimable ? pending : undefined };
    if (freeScenario) msg += `\n\n🎁 <b>Подарок:</b> одно фото → видео (принцесса или футбол) — бесплатно, без оплаты!`;
    // Lands STRAIGHT on the matching first action — one message (balance line +
    // the scenario prompt), no generic menu. Still skipped while claimable (e.g.
    // the free-scenario gift was already used, so there was nothing to auto-claim
    // above) — an unclaimed newcomer then sees the menu instead, "🎁 Получить" on
    // top. Falls back to the menu too if it can't route.
    const intro = `💰 Баланс: <b>${UNIT_EMOJI} ${nUnits(u.credits)}</b>`;
    const routed = !claimable && route ? await routeEntry(ctx, u.id, route, intro) : false;
    if (!routed) await sendMainMenu(ctx, msg, menuOpts);
    // Deep link from the Mini App's "Пополнить" button.
    if (payload === "buy") await sendBalance(ctx, u.credits);
  });

  bot.callbackQuery("claim:welcome", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    const res = await claimWelcomeBonus(u.id);
    if (!res) {
      // Already claimed (e.g. double-tap) — just show the current balance, no error.
      await sendBalance(ctx, u.credits);
      return;
    }
    let msg = `✅ Начислено <b>${UNIT_EMOJI} ${nUnits(res.granted)}</b>! Баланс: <b>${UNIT_EMOJI} ${nUnits(u.credits + res.granted)}</b>.`;
    if (res.joinBonus > 0) {
      if (res.joinVia === "partner") {
        const partner = res.joinMeta ? await getPartnerCode(res.joinMeta) : undefined;
        msg += `\nИз них <b>+${nUnits(res.joinBonus)}</b> — подарок от ${partner?.title ?? "партнёра"} 🤝`;
      } else {
        msg += `\nИз них <b>+${nUnits(res.joinBonus)}</b> — бонус за приглашение. Спасибо другу! 🤝`;
      }
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
    const freeScenario = await hasFreeScenario(u.id);
    await sendMainMenu(ctx, "Что создаём? Одно фото — и готово 👇", {
      hasPhoto: !!u.pending_file_id,
      freeScenario,
    });
  });

  bot.command("menu", async (ctx) => {
    const u = await user(ctx);
    await setPending(u.id, null, u.pending_file_id); // escape any mode/prompt-await, keep the photo
    const pending = u.pendingSignupCredits + u.pendingJoinBonus;
    await sendMainMenu(ctx, "Что создаём? Одно фото — и готово 👇", {
      hasPhoto: !!u.pending_file_id,
      freeScenario: await hasFreeScenario(u.id),
      claimPending: !u.welcomeBonusClaimed && pending > 0 ? pending : undefined,
    });
  });

  bot.command("app", async (ctx) => {
    await user(ctx);
    if (!config.webappUrl) {
      await ctx.reply("Приложение скоро откроется 🌐");
      return;
    }
    await ctx.reply("🌐 Ваш личный кабинет: баланс, галерея работ и статистика.", {
      reply_markup: new InlineKeyboard().webApp("Открыть приложение", config.webappUrl),
    });
  });

  bot.command("balance", async (ctx) => sendBalance(ctx, (await user(ctx)).credits));
  bot.command("buy", async (ctx) => sendBalance(ctx, (await user(ctx)).credits));

  bot.command("ref", async (ctx) => sendRefLink(ctx));

  // Self-serve data deletion (Privacy Policy §4/§5) — a confirm step gates the
  // irreversible action, mirroring how other destructive-adjacent flows in this
  // bot (partner code deactivation) ask before acting rather than acting on the
  // command alone.
  bot.command("delete_me", async (ctx) => {
    await user(ctx);
    await ctx.reply(
      "⚠️ <b>Удаление данных аккаунта</b>\n\n" +
        "Это необратимо. При подтверждении:\n" +
        "• личные данные (имя пользователя, телефон) будут стёрты;\n" +
        "• история промптов и ссылок на созданный контент — удалена;\n" +
        `• неиспользованные ${UNIT_EMOJI} патроны — сгорают (это не возврат денег — для возврата за неизрасходованный пакет см. /buy → политику возврата, отдельная процедура);\n` +
        "• партнёрские коды (если есть) — деактивируются.\n\n" +
        "Финансовые записи о платежах сохраняются в обезличенном виде — этого требует бухгалтерский/налоговый учёт.\n\n" +
        "Продолжить?",
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("❌ Да, удалить всё", "del:confirm").row().text("Отмена", "del:cancel") },
    );
  });

  bot.callbackQuery("del:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Отменено — данные не тронуты.");
  });

  bot.callbackQuery("del:confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const result = await deleteUserData(ctx.from.id);
    await ctx.reply(
      result
        ? `✅ Готово. Данные удалены${result.forfeitedCredits > 0 ? ` (${nUnits(result.forfeitedCredits)} сгорели)` : ""}. ` +
            "Аккаунт можно начать заново командой /start."
        : "Аккаунт не найден или уже был удалён ранее.",
    );
  });

  bot.command("course", async (ctx) => {
    await user(ctx);
    await ctx.reply(courseText(), { parse_mode: "HTML", reply_markup: courseKeyboard() });
  });

  bot.callbackQuery("menu:course", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(courseText(), { parse_mode: "HTML", reply_markup: courseKeyboard() });
  });

  // Free tripwire (docs/course/00-free-guide.md), condensed to Telegram HTML and
  // split to stay well under the 4096-char message limit.
  bot.callbackQuery("course:guide", async (ctx) => {
    await ctx.answerCallbackQuery();
    for (const msg of freeGuideMessages()) {
      await ctx.reply(msg, { parse_mode: "HTML" });
    }
  });

  // Admin: publish one lesson/module of the paid course into its cohort
  // channel (COURSE_FAST_CHANNEL_ID / COURSE_FLAGSHIP_CHANNEL_ID, config.ts).
  // The purchase flow (payments.ts inviteToCourseCohort) only invites buyers
  // into the channel — it never posts content, so without this an admin
  // running each of these 8 commands once (fast 1–5, flagship 1–3) is the only
  // way the channel has anything in it before a buyer arrives.
  // /course_post <fast|flagship> <n>
  bot.command("course_post", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const [tier, nS] = (ctx.match ?? "").trim().split(/\s+/);
    const n = Number(nS);
    const usage =
      "Формат: /course_post <fast|flagship> <n>\n" +
      "fast: 1–5 (уроки «Быстрого старта»)\n" +
      "flagship: 1–3 (модули «AI-контента под ключ»)";

    let messages: string[];
    let channelId: string;
    let label: string;
    if (tier === "fast" && [1, 2, 3, 4, 5].includes(n)) {
      messages = fastStartLessonMessages(n as 1 | 2 | 3 | 4 | 5);
      channelId = config.courseFastChannelId;
      label = `Урок ${n} «Быстрый старт»`;
    } else if (tier === "flagship" && [1, 2, 3].includes(n)) {
      messages = flagshipModuleMessages(n as 1 | 2 | 3);
      channelId = config.courseFlagshipChannelId;
      label = `Модуль ${n} «AI-контент под ключ»`;
    } else {
      await ctx.reply(usage);
      return;
    }

    if (!channelId) {
      await ctx.reply(
        `⚠️ ${tier === "fast" ? "COURSE_FAST_CHANNEL_ID" : "COURSE_FLAGSHIP_CHANNEL_ID"} не настроен — сначала ` +
          `создайте приватный канал когорты и пропишите его id в конфиге (см. docs/course/README.md), затем ` +
          `повторите /course_post ${tier} ${n}.`,
      );
      return;
    }

    try {
      for (const msg of messages) {
        await ctx.api.sendMessage(channelId, msg, { parse_mode: "HTML" });
      }
    } catch (e) {
      console.error(`course_post ${tier} ${n} failed:`, e);
      await ctx.api
        .sendMessage(
          ctx.from.id,
          `❌ Не удалось опубликовать ${label} в канал (${channelId}). Проверьте, что бот — админ канала с правом ` +
            `отправки сообщений. Ошибка: ${e instanceof Error ? e.message : String(e)}`,
        )
        .catch(() => {});
      return;
    }

    await ctx.api
      .sendMessage(ctx.from.id, `✅ ${label} опубликован в ${tier === "fast" ? "COURSE_FAST" : "COURSE_FLAGSHIP"}.`)
      .catch(() => {});
  });

  // Self-serve partner program (docs/partner-program.md): join → get welcome
  // bonus + personal codes → 15% cashback → withdraw. Admin creator deals (c_)
  // still exist via /partner_add and show read-only below.
  /** Read-only block for admin-negotiated creator (c_) codes, if the user owns any. */
  async function creatorCodesBlock(ctx: Context, userId: number): Promise<string> {
    const creator = (await listPartnerCodes(userId)).filter((c) => c.kind === "creator");
    if (!creator.length) return "";
    const blocks: string[] = [];
    for (const c of creator) {
      const st = await partnerStats(c.code);
      blocks.push(
        `🔗 <b>${c.title ?? c.code}</b> · <code>https://t.me/${ctx.me.username}?start=c_${c.code}</code>\n` +
          `   👥 пришло: <b>${st.joined}</b> · 💳 покупают: <b>${st.paying}</b> · ` +
          `заработано: <b>${nUnits(st.earned)}</b> · ${Math.round(c.percent * 100)}%`,
      );
    }
    return `🎓 <b>Ваши авторские коды (по договорённости)</b>\n${blocks.join("\n")}\n\n`;
  }

  async function sendPartnerDash(ctx: Context): Promise<void> {
    const u = await user(ctx);
    const acct = await partnerAccount(u.id);
    const pct = Math.round(config.partnerPercent * 100);
    const creatorBlock = await creatorCodesBlock(ctx, u.id);

    if (!acct.joined) {
      // Partnerships are ADMIN-SERVED — there is no self-serve join (an admin
      // enrolls partners with /partner_grant). Non-partners see the pitch + how to
      // apply, never a button that grants the welcome bonus to whoever taps it.
      await ctx.reply(
        creatorBlock +
          `🤝 <b>Партнёрская программа NeuroShot</b>\n\n` +
          `• <b>${pct}% кэшбэка</b> с каждой оплаты приглашённых пользователей\n` +
          `• Кэшбэк — в токенах: тратьте в NeuroShot или <b>выводите деньгами раз в 2 недели</b>\n` +
          `• Персональные ссылки и приветственный бонус для подключённых партнёров\n\n` +
          `Программа — <b>по приглашению</b>. Хотите участвовать? Напишите нам — подключим вручную.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const codes = await myPartnerCodes(u.id);
    const codeBlocks = codes.length
      ? codes
          .map(
            (c) =>
              `🔗 <code>https://t.me/${ctx.me.username}?start=p_${c.code}</code>\n` +
              `   👥 <b>${c.joined}</b> · 💳 <b>${c.paying}</b> · заработано <b>${nUnits(c.earned)}</b>`,
          )
          .join("\n")
      : "У вас пока нет ссылок — создайте первую 👇";

    const kb = new InlineKeyboard();
    if (acct.activeCodes < config.partnerMaxCodes) kb.text("➕ Новая ссылка", "partner:newcode");
    if (acct.withdrawable >= config.withdrawMin) kb.text(`💸 Вывести ${acct.withdrawable} ${UNIT_EMOJI}`, "partner:withdraw");
    kb.row().text("📜 История выплат", "partner:history");
    if (codes.length) kb.text("⚙️ Управление ссылками", "partner:manage");

    await ctx.reply(
      creatorBlock +
        `🤝 <b>Партнёрский кабинет</b>\n\n` +
        `👥 Приглашено: <b>${acct.invited}</b> · 💳 покупают: <b>${acct.paying}</b>\n` +
        `💰 Всего заработано: <b>${UNIT_EMOJI} ${nUnits(acct.earned)}</b>\n` +
        `💸 Доступно к выводу: <b>${UNIT_EMOJI} ${nUnits(acct.withdrawable)}</b> ` +
        `(мин. ${config.withdrawMin}, раз в 2 недели)\n\n` +
        `<b>Ваши ссылки</b> (${acct.activeCodes}/${config.partnerMaxCodes}):\n${codeBlocks}\n\n` +
        `Условия: <b>${pct}%</b> кэшбэка с покупок · +${config.partnerInviteeBonus} ${UNIT_EMOJI} новым по вашей ссылке.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  }

  bot.command("partner", (ctx) => sendPartnerDash(ctx));

  // Self-serve join is REMOVED — partnerships are admin-served (/partner_grant).
  // This handler only catches stale "Стать партнёром" buttons from old chats and
  // re-opens the dashboard (which now shows the by-invitation notice). It grants
  // nothing.
  bot.callbackQuery("partner:join", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPartnerDash(ctx);
  });

  bot.callbackQuery("partner:newcode", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!(await partnerAccount(u.id)).joined) { await sendPartnerDash(ctx); return; }
    const res = await createPartnerCode(u.id, config.partnerPercent, config.partnerInviteeBonus, config.partnerMaxCodes);
    if (!res.ok) {
      await ctx.reply(`Достигнут лимит в ${config.partnerMaxCodes} активных ссылок. Деактивируйте одну, чтобы создать новую.`);
      return;
    }
    await ctx.reply(
      `✅ Новая ссылка готова:\n<code>https://t.me/${ctx.me.username}?start=p_${res.code}</code>`,
      { parse_mode: "HTML" },
    );
    await sendPartnerDash(ctx);
  });

  bot.callbackQuery("partner:withdraw", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    const acct = await partnerAccount(u.id);
    if (!acct.joined) { await sendPartnerDash(ctx); return; }
    const res = await requestWithdrawal(u.id, acct.withdrawable, config.withdrawMin);
    if (!res.ok) {
      const msg =
        res.error === "too_small"
          ? `Минимальная сумма вывода — ${config.withdrawMin} ${UNIT_EMOJI}.`
          : res.error === "pending"
            ? "У вас уже есть заявка на вывод в обработке."
            : "Недостаточно средств к выводу.";
      await ctx.reply(msg);
      return;
    }
    await ctx.reply(
      `💸 Заявка на вывод <b>${UNIT_EMOJI} ${nUnits(acct.withdrawable)}</b> создана (№${res.id}). ` +
        `Выплаты обрабатываются раз в 2 недели — мы свяжемся с вами.`,
      { parse_mode: "HTML" },
    );
    for (const adminId of config.adminIds)
      await ctx.api.sendMessage(adminId, `💸 Заявка на вывод №${res.id}: ${acct.withdrawable} ${UNIT_EMOJI} от ${u.id}. /payouts`).catch(() => {});
  });

  bot.callbackQuery("partner:manage", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!(await partnerAccount(u.id)).joined) { await sendPartnerDash(ctx); return; }
    const codes = await myPartnerCodes(u.id);
    const kb = new InlineKeyboard();
    for (const c of codes) kb.text(`🗑 ${c.code} (${c.paying} 💳)`, `partner:deact:${c.code}`).row();
    kb.text("← Назад", "partner:back");
    await ctx.reply(
      "⚙️ Деактивация освобождает слот для новой ссылки. Уже приглашённые по ней продолжат приносить кэшбэк.",
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^partner:deact:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!(await partnerAccount(u.id)).joined) { await sendPartnerDash(ctx); return; }
    const ok = await deactivatePartnerCode(u.id, ctx.match[1]);
    await ctx.reply(ok ? "✅ Ссылка деактивирована." : "Ссылка не найдена.");
    await sendPartnerDash(ctx);
  });

  bot.callbackQuery("partner:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPartnerDash(ctx);
  });

  bot.callbackQuery("partner:history", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!(await partnerAccount(u.id)).joined) { await sendPartnerDash(ctx); return; }
    const rows = await myWithdrawals(u.id);
    if (!rows.length) {
      await ctx.reply("Заявок на вывод ещё не было.");
      return;
    }
    const label = (s: string) => (s === "paid" ? "✅ выплачено" : s === "rejected" ? "↩️ отклонено" : "⏳ в обработке");
    await ctx.reply(
      "📜 <b>История выплат</b>\n" +
        rows.map((r) => `№${r.id} · ${nUnits(r.amount)} · ${label(r.status)}`).join("\n"),
      { parse_mode: "HTML" },
    );
  });

  // Admin: pending cash-outs + resolve. /payouts | /payout <id> ok|no
  bot.command("payouts", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const rows = await pendingWithdrawals();
    if (!rows.length) {
      await ctx.reply("Заявок на вывод нет.");
      return;
    }
    await ctx.reply(
      "💸 <b>Заявки на вывод</b>\n" +
        rows.map((r) => `№${r.id} · пользователь ${r.user_id} · ${nUnits(r.amount)}`).join("\n") +
        "\n\nОбработать: /payout <id> ok  или  /payout <id> no",
      { parse_mode: "HTML" },
    );
  });

  bot.command("payout", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const [idS, verdict] = (ctx.match ?? "").trim().split(/\s+/);
    const id = Number(idS);
    if (!Number.isInteger(id) || (verdict !== "ok" && verdict !== "no")) {
      await ctx.reply("Формат: /payout <id> ok|no");
      return;
    }
    const ok = await resolveWithdrawal(id, verdict === "ok");
    if (!ok) {
      await ctx.reply(`Заявка №${id} не найдена или уже обработана.`);
      return;
    }
    await ctx.reply(verdict === "ok" ? `✅ Заявка №${id} отмечена выплаченной.` : `↩️ Заявка №${id} отклонена, ${UNIT_EMOJI} возвращены.`);
  });

  // Admin: pending Kaspi purchase orders + confirm. /orders | /order <id> ok|no
  bot.command("orders", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const rows = await pendingOrders();
    if (!rows.length) {
      await ctx.reply("Заявок на оплату нет.");
      return;
    }
    await ctx.reply(
      "🧾 <b>Заявки на оплату (Kaspi)</b>\n" +
        rows.map((r) => `№${r.id} · пользователь ${r.user_id} · ${r.pack_id} · ${r.amount_kzt} ₸`).join("\n") +
        "\n\nПодтвердить: /order <id> ok  или  /order <id> no",
      { parse_mode: "HTML" },
    );
  });

  bot.command("order", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const [idS, verdict] = (ctx.match ?? "").trim().split(/\s+/);
    const id = Number(idS);
    if (!Number.isInteger(id) || (verdict !== "ok" && verdict !== "no")) {
      await ctx.reply("Формат: /order <id> ok|no");
      return;
    }
    const order = await resolveOrder(id, verdict === "ok");
    if (!order) {
      await ctx.reply(`Заявка №${id} не найдена или уже обработана.`);
      return;
    }
    if (verdict === "ok") {
      const pack = packById(order.pack_id);
      if (!pack) {
        await ctx.reply(`Заявка №${id}: пакет «${order.pack_id}» больше не существует.`);
        return;
      }
      await grantPurchase(ctx.api, order.user_id, pack, order.id); // credits + referral/partner payouts + notify
      await ctx.reply(`✅ Заявка №${id} подтверждена — начислено ${pack.credits} ${UNIT_EMOJI} пользователю ${order.user_id}.`);
    } else {
      await ctx.reply(`↩️ Заявка №${id} отклонена.`);
    }
  });

  // Admin: enroll a user into the partner program. Partnerships are admin-served,
  // never self-serve — this is the ONLY way the welcome bonus + first code are
  // granted. The target must have started the bot first (/start).
  // /partner_grant <tg_id>
  bot.command("partner_grant", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const targetId = Number((ctx.match ?? "").trim());
    if (!Number.isInteger(targetId) || targetId <= 0) {
      await ctx.reply("Формат: /partner_grant <tg_id>. Пользователь должен сначала запустить бота (/start).");
      return;
    }
    const res = await joinPartnerProgram(targetId, config.partnerWelcome);
    if (!res.justJoined) {
      await ctx.reply(`Пользователь ${targetId} уже партнёр — или ещё не запускал бота (/start).`);
      return;
    }
    // Mint the partner's first shareable code, mirroring the old join flow.
    await createPartnerCode(targetId, config.partnerPercent, config.partnerInviteeBonus, config.partnerMaxCodes);
    await ctx.api
      .sendMessage(
        targetId,
        `🎉 Вас подключили к партнёрской программе NeuroShot! Начислен бонус ${UNIT_EMOJI} ${nUnits(res.welcome)}. Откройте /partner — там ваша персональная ссылка.`,
      )
      .catch(() => {});
    await ctx.reply(`✅ ${targetId} подключён к партнёрской программе (+${nUnits(res.welcome)}, ссылка создана).`);
  });

  // Admin: create/update a creator code with per-deal terms.
  // /partner_add <code> <tg_id> <percent 1–50> <join_bonus> [display title]
  bot.command("partner_add", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const [rawCode, idS, pctS, bonusS, ...titleParts] = args;
    const ownerId = Number(idS);
    const pct = Number(pctS);
    const bonus = Number(bonusS ?? 0);
    if (!rawCode || !/^[a-z0-9_]{2,32}$/i.test(rawCode) || !Number.isFinite(ownerId) || !Number.isFinite(pct) || pct <= 0 || pct > 50 || !Number.isFinite(bonus) || bonus < 0) {
      await ctx.reply(
        "Формат: /partner_add <код a-z0-9_> <tg_id> <процент 1–50> <бонус_новым> [название]\n" +
          "Пример: /partner_add mentor 123456789 25 10 Курс Ментора\n" +
          "⚠️ >25% съедает целевую маржу 3.5× на минимальном пакете — см. docs/creator-program.md",
      );
      return;
    }
    const code = rawCode.toLowerCase();
    await upsertPartnerCode(code, ownerId, pct / 100, Math.floor(bonus), titleParts.join(" ") || null);
    await ctx.reply(
      `✅ Код <code>c_${code}</code> → ${ownerId}: ${pct}% с покупок, +${Math.floor(bonus)} ${UNIT_EMOJI} новым.\n` +
        `Ссылка: https://t.me/${ctx.me.username}?start=c_${code}`,
      { parse_mode: "HTML" },
    );
  });

  // Premium text-to-image: /premium <prompt> (GPT Image 2, high quality).
  bot.command("premium", async (ctx) => {
    const u = await user(ctx);
    const prompt = ctx.match?.trim();
    if (!prompt) {
      await ctx.reply(
        `💎 Премиум-картинка (${MODELS.premium_image.credits} ${UNIT_EMOJI}) — напишите запрос сразу после команды:\n/premium флакон духов на мокром чёрном мраморе`,
      );
      return;
    }
    await runGeneration(ctx, u, MODELS.premium_image, prompt);
  });

  bot.command("stats", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const s = await stats();
    await ctx.reply(
      `👥 Users: ${s.users}\n💳 Paying: ${s.paid}\n🎨 Generations: ${s.generations}\n💰 Выручка: ${s.kztRevenue} ₸`,
    );
  });

  // Admin: top up 🔫 for testing (self by default, or a target user).
  // /grant <amount>  |  /grant <tg_id> <amount>  (amount may be negative to deduct)
  bot.command("grant", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const targetId = args.length === 2 ? Number(args[0]) : ctx.from.id;
    const amount = Number(args.length === 2 ? args[1] : args[0]);
    // Exactly 1 or 2 args — reject trailing tokens so a mistyped command can't
    // silently grant something other than what the admin meant.
    if (
      args.length < 1 ||
      args.length > 2 ||
      !Number.isInteger(targetId) ||
      !Number.isInteger(amount) ||
      amount === 0
    ) {
      await ctx.reply("Формат: /grant <кол-во> или /grant <tg_id> <кол-во>\nПример: /grant 9999");
      return;
    }
    const target = await getUser(targetId);
    if (!target) {
      await ctx.reply(`Пользователь ${targetId} не найден — пусть сначала откроет /start.`);
      return;
    }
    await addCredits(targetId, amount, "admin_grant", String(ctx.from.id));
    // Defensive re-read: fall back to the computed balance if the row vanished.
    const balance = (await getUser(targetId))?.credits ?? target.credits + amount;
    await ctx.reply(
      `✅ ${amount > 0 ? "Начислено" : "Списано"} ${UNIT_EMOJI} ${nUnits(Math.abs(amount))} → ${targetId}. ` +
        `Баланс: ${UNIT_EMOJI} ${nUnits(balance)}.`,
    );
  });

  // Admin: the daily digest on demand — /dash [days], default 24h, cap 30d.
  // Same 6 numbers the scheduler pushes each morning (src/monitor.ts).
  bot.command("dash", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const days = Math.min(30, Math.max(1, Number((ctx.match ?? "").trim()) || 1));
    await ctx.reply(formatDigest(await buildDigest(days * 24)), { parse_mode: "HTML" });
  });

  // Admin conversion funnel + "why didn't they order" drop-off buckets.
  bot.command("funnel", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const f = await funnel();
    const pct = (n: number) => (f.visitors ? `${Math.round((n / f.visitors) * 100)}%` : "—");
    await ctx.reply(
      [
        "📊 Воронка (по посетителям)",
        `Визитов: ${f.visits} · Уникальных: ${f.visitors}`,
        `📸 Загрузили фото: ${f.uploadedPhoto} (${pct(f.uploadedPhoto)})`,
        `⚙️ Начали генерацию: ${f.startedGen} (${pct(f.startedGen)})`,
        `✅ Получили результат: ${f.succeededGen} (${pct(f.succeededGen)})`,
        `💳 Дошли до оплаты: ${f.hitPaywall} (${pct(f.hitPaywall)})`,
        `💰 Купили: ${f.paid} (${pct(f.paid)})`,
        "",
        "❓ Почему не купили:",
        `• не начали генерить: ${f.dropoff.neverGenerated} (активация)`,
        `• была ошибка провайдера: ${f.dropoff.genFailedNoPaid} (надёжность)`,
        `• видели пейволл, не купили: ${f.dropoff.paywallNoPaid} (цена/ценность)`,
        `• израсходовали бесплатные, не купили: ${f.dropoff.triedFreeNoPaid} (ценность)`,
      ].join("\n"),
    );
  });

  registerPayments(bot);

  // ---- Main menu navigation ----

  bot.callbackQuery("menu:main", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await setPending(u.id, null, u.pending_file_id); // escape any mode/prompt-await, keep the photo
    await ctx.reply("Что создаём?", { reply_markup: mainMenu() });
  });

  // Top-level entry: always ask for a FRESH photo (a new request must never
  // silently reuse a previous photo). The "just-uploaded" convenience lives in
  // the pick:* handlers below; deliberate reuse lives in menu:styles.
  bot.callbackQuery("menu:photoshoot", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await setPending(u.id, "mode_photo", null);
    await sendPreviewAlbum(ctx, "photo");
    await ctx.reply(
      "Вот что можно получить 👆 Пришлите своё фото 📸 (портрет без ретуши работает лучше всего) — и выберите стиль.",
    );
  });

  bot.callbackQuery("menu:product", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await setPending(u.id, "mode_product", null);
    await sendPreviewAlbum(ctx, "product");
    await ctx.reply("Вот примеры 👆 Пришлите фото товара 🛍 (можно прямо со стола — фон мы заменим).");
  });

  // "What to do with this photo" shortcuts: use the photo the user JUST uploaded
  // (pending_file_id is a fresh upload here) — reuse only within the upload flow.
  bot.callbackQuery("pick:photo", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!isReusableUpload(u.pending_file_id)) {
      await ctx.reply("Пришлите фото 📸 — и выберите стиль.");
      return;
    }
    await showPresets(ctx, "photo", "Выберите стиль — один тап, без промптов:");
  });

  bot.callbackQuery("pick:product", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!isReusableUpload(u.pending_file_id)) {
      await ctx.reply("Пришлите фото товара 🛍.");
      return;
    }
    await showPresets(ctx, "product", "Выберите подачу товара:");
  });

  // ---- Free one-time scenario (onboarding hook): princess or football ----
  // Whole chain (Seedream scene → Hailuo video) at zero credits, watermarked.

  bot.callbackQuery("menu:free", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!(await hasFreeScenario(u.id))) {
      await ctx.reply("🎁 Бесплатный сценарий уже использован. Создайте свой в /menu 🙂");
      return;
    }
    const kb = new InlineKeyboard();
    for (const s of FREE_SCENARIOS) kb.text(s.label, `free:${s.id}`).row();
    kb.text("📋 Меню", "menu:main");
    await ctx.reply(
      "🎁 Один сценарий-видео — бесплатно и без списания патронов! Что снимаем?",
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^free:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = freeScenarioById(ctx.match[1]);
    if (!s) return;
    const u = await user(ctx);
    if (!(await hasFreeScenario(u.id))) {
      await ctx.reply("🎁 Бесплатный сценарий уже использован 🙂");
      return;
    }
    // Identity gate (optional, default off): verify a phone before unlocking the
    // gift, so it can't be farmed across throwaway accounts. Remember the chosen
    // scenario; the contact handler resumes it once the number is shared.
    if (config.freeGateEnabled && !u.phone) {
      await setPending(u.id, `gate_free_${s.id}`, null);
      await ctx.reply(
        "🔒 Чтобы получить бесплатный подарок, подтвердите номер телефона — так мы защищаем подарок от накрутки. Это займёт секунду 👇",
        { reply_markup: new Keyboard().requestContact("📱 Поделиться номером").resized().oneTime() },
      );
      return;
    }
    // Always ask for the right photo (child vs self) — don't reuse a stale one.
    await setPending(u.id, `mode_free_${s.id}`, null);
    await ctx.reply(withPhotoTip(s.ask));
  });

  // Phone shared → verify identity and resume a gated free scenario (or just ack).
  bot.on("message:contact", async (ctx) => {
    const u = await user(ctx);
    const contact = ctx.message.contact;
    // Only accept the sender's OWN number (a forwarded contact carries a different user_id).
    if (contact.user_id && contact.user_id !== ctx.from?.id) {
      await ctx.reply("Пожалуйста, поделитесь СВОИМ номером 🙂");
      return;
    }
    await setUserPhone(u.id, contact.phone_number);
    const gated = u.pending_action?.startsWith("gate_free_") ? freeScenarioById(u.pending_action.slice("gate_free_".length)) : null;
    if (gated) {
      if (await phoneClaimedFree(contact.phone_number)) {
        await setPending(u.id, null, null);
        await ctx.reply(`Этот номер уже получал бесплатный подарок 🙂 Но всё можно создать за ${UNIT_EMOJI} — /menu`, {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
      await setPending(u.id, `mode_free_${gated.id}`, null);
      await ctx.reply(`✅ Номер подтверждён!\n\n${withPhotoTip(gated.ask)}`, { reply_markup: { remove_keyboard: true } });
      return;
    }
    await ctx.reply("✅ Спасибо, номер подтверждён!", { reply_markup: { remove_keyboard: true } });
  });

  // ---- Campaigns: one-click viral scenarios (image → optional video upsell) ----

  function campaignPresetKeyboard(c: Campaign): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const p of c.presets) kb.text(`${p.label} (${PRESET_MODEL.credits} ${UNIT_EMOJI})`, `cpre:${c.id}:${p.id}`).row();
    kb.text("📋 Меню", "menu:main");
    return kb;
  }

  bot.callbackQuery("menu:campaigns", async (ctx) => {
    await ctx.answerCallbackQuery();
    await user(ctx);
    const kb = new InlineKeyboard();
    for (const c of CAMPAIGNS) kb.text(c.label, `camp:${c.id}`).row();
    kb.text("📋 Меню", "menu:main");
    await ctx.reply("🎉 Готовые сценарии — один тап, результат сразу:", { reply_markup: kb });
  });

  bot.callbackQuery(/^camp:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = campaignById(ctx.match[1]);
    if (!c) return;
    const u = await user(ctx);
    // Always ask for a fresh photo — each scenario wants its own (a kid's photo
    // for a fairy tale, your own for football) — never reuse a leftover photo.
    await setPending(u.id, `mode_camp_${c.id}`, null);
    await ctx.reply(withPhotoTip(c.ask));
  });

  // One-tap campaign render; on success, offer the one-tap animate upsell that
  // runs on the GENERATED image (referenced by generation id on the result kb).
  bot.callbackQuery(/^cpre:([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = campaignById(ctx.match[1]);
    const preset = c?.presets.find((p) => p.id === ctx.match[2]);
    if (!c || !preset) {
      await ctx.reply("Эта кампания больше недоступна — откройте /menu 🙂");
      return;
    }
    const u = await user(ctx);
    if (!u.pending_file_id) {
      await ctx.reply(withPhotoTip(c.ask));
      return;
    }
    // The delivered result carries the "оживить" upsell (camv:<camp>:<genId>) on
    // its keyboard — referencing the result by id, not by stashing its URL in
    // pending_file_id (which must stay the user's upload).
    await runGeneration(ctx, u, PRESET_MODEL, preset.prompt, u.pending_file_id, {
      crafted: true,
      allowFreeFirst: true,
      animate: c.id,
    });
  });

  // Animate a specific campaign RESULT (referenced by generation id, resolved
  // from the gallery) — never reuses a stale pending photo.
  bot.callbackQuery(/^camv:([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = campaignById(ctx.match[1]);
    const u = await user(ctx);
    const gen = await getGeneration(Number(ctx.match[2]), u.id);
    if (!c || !gen || !gen.output_url) {
      await ctx.reply("Сначала создайте картинку в кампании 🙂");
      return;
    }
    await runGeneration(ctx, u, c.animateModel, c.animatePrompt, gen.output_url, { crafted: true });
  });

  bot.callbackQuery("menu:animate", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await sendMenuVideo(ctx, "animate"); // example of the expected result
    // Top-level entry → always ask for a fresh photo (menu:videopick keeps the
    // just-uploaded photo for the in-flow "pick a video model" step).
    await setPending(u.id, "mode_animate", null);
    await ctx.reply("Вот пример 👆 Пришлите фото 🎬 — и выберите модель (Kling / Seedance).");
  });

  bot.callbackQuery("menu:videopick", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!u.pending_file_id) {
      await ctx.reply("Сначала пришлите фото 🙂");
      return;
    }
    await ctx.reply("🎬 Выберите видео-модель:", { reply_markup: videoModelsKeyboard() });
  });

  bot.callbackQuery("menu:text", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await setPending(u.id, null, u.pending_file_id); // leave photo mode so the next text becomes a t2i prompt
    await sendMenuAlbum(ctx, ["text_example_1", "text_example_2"]); // examples of the expected result
    await ctx.reply("✨ Выберите модель для картинки по тексту:", {
      reply_markup: imageModelsKeyboard(),
    });
  });

  // Top-models hub: image-model picker + a route into the video-model picker.
  bot.callbackQuery("menu:models", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await setPending(u.id, null, u.pending_file_id);
    await ctx.reply(
      "⚡ Топовые модели ИИ.\nКартинка по тексту — выберите модель (или пришлите фото для видео):",
      { reply_markup: imageModelsKeyboard() },
    );
  });

  bot.callbackQuery("menu:balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendBalance(ctx, (await user(ctx)).credits);
  });

  bot.callbackQuery("menu:ref", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendRefLink(ctx);
  });

  // "Ещё стиль" on a delivered result: reuse the last photo if we still have it.
  bot.callbackQuery("menu:styles", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!u.pending_file_id) {
      await ctx.reply("Пришлите фото — и выбирайте стиль 🙂");
      return;
    }
    await showPresets(ctx, "photo", "Выберите стиль:");
  });

  async function sendRefLink(ctx: Context) {
    const u = await user(ctx);
    const code = await ensureRefCode(u.id);
    const link = `https://t.me/${ctx.me.username}?start=${code}`;
    const st = await referralStats(u.id);
    const pct = Math.round(config.referralPercent * 100);

    // One-tap share: opens Telegram's share sheet with the link + a prefilled pitch.
    const pitch =
      `Держи ${nUnits(config.referralJoinBonus)} ${UNIT_EMOJI} в подарок на AI-фото и видео в NeuroShot 🎁 ` +
      `Оживляй фото, делай карточки товара и аватары:`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(pitch)}`;

    const next = REFERRAL_MILESTONES.find((m) => st.paying < m.friends);
    const milestone = next
      ? `🏆 До бонуса <b>+${nUnits(next.bonus)}</b>: ещё ${next.friends - st.paying} друзей с покупкой`
      : "🏆 Все бонусы-вехи получены — вы легенда! 🔥";

    const text =
      `🎁 <b>Приглашайте друзей — зарабатывайте ${UNIT_EMOJI} патроны</b>\n\n` +
      `👥 Приглашено: <b>${st.invited}</b>   ·   💳 покупают: <b>${st.paying}</b>\n` +
      `💰 Всего заработано: <b>${UNIT_EMOJI} ${nUnits(st.earned)}</b>\n\n` +
      `<b>Как это работает:</b>\n` +
      `• Друг получает <b>+${nUnits(config.referralJoinBonus)}</b> при входе по ссылке\n` +
      `• Вы — <b>+${nUnits(config.referralFirstPurchaseBonus)}</b> за его первую покупку\n` +
      `• И <b>${pct}%</b> с каждого его пакета — навсегда\n` +
      `• ${milestone}\n\n` +
      `🔗 Ваша ссылка:\n<code>${link}</code>`;

    const kb = new InlineKeyboard().url("📣 Поделиться с другом", shareUrl);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }

  // ---- Photo in → route by selected mode (or show the action menu) ----

  bot.on("message:photo", async (ctx) => {
    const u = await user(ctx);
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id; // largest size
    const mode = u.pending_action;

    if (mode === "mode_product") {
      await setPending(u.id, "await_action", fileId);
      await showPresets(ctx, "product", "Отличный кадр! Выберите подачу товара:");
      return;
    }
    if (mode === "mode_photo") {
      await setPending(u.id, "await_action", fileId);
      await showPresets(ctx, "photo", "Выберите стиль — один тап, без промптов:");
      return;
    }
    if (mode === "mode_animate") {
      await setPending(u.id, "await_action", fileId);
      await ctx.reply("🎬 Выберите видео-модель:", { reply_markup: videoModelsKeyboard() });
      return;
    }
    if (mode?.startsWith("mode_free_")) {
      const s = freeScenarioById(mode.slice("mode_free_".length));
      if (s) {
        // runFreeScenario manages pending state (and keeps the freebie on failure).
        await runFreeScenario(ctx, u, s, fileId);
        return;
      }
    }
    if (mode?.startsWith("mode_camp_")) {
      const c = campaignById(mode.slice("mode_camp_".length));
      if (c) {
        await setPending(u.id, "await_action", fileId);
        await ctx.reply(c.header, { reply_markup: campaignPresetKeyboard(c) });
        return;
      }
    }

    await setPending(u.id, "await_action", fileId);
    const kb = new InlineKeyboard()
      .text("📸 AI-фотосессия — стили", "pick:photo")
      .row()
      .text("🛍 Продающее фото товара", "pick:product")
      .row()
      .text(`🖼 Редактировать по описанию (${MODELS.photo_edit.credits} ${UNIT_EMOJI})`, "act:photo_edit")
      .row()
      .text("🎬 Оживить в видео (Kling / Seedance)", "menu:videopick");
    await ctx.reply("Что сделать с этим фото?", { reply_markup: kb });
  });

  bot.callbackQuery(/^act:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    const model = modelByKey(ctx.match[1]);
    if (!model || !u.pending_file_id) {
      await ctx.reply("Сначала пришлите фото 🙂");
      return;
    }
    await setPending(u.id, model.key, u.pending_file_id);
    await ctx.reply(
      model.kind === "image_to_video"
        ? "Опишите движение (например: «медленный наезд камеры, волосы развеваются»):"
        : "Опишите, что изменить (например: «замени фон на парижскую улицу на закате»):",
    );
  });

  // Text-to-image model picked from a picker — no photo needed, next text runs it.
  bot.callbackQuery(/^txt:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    const model = modelByKey(ctx.match[1]);
    if (!model || model.kind !== "text_to_image") {
      await ctx.reply("Модель недоступна 🙂");
      return;
    }
    await setPending(u.id, model.key, null); // text model: no photo
    await ctx.reply(`✍️ Напишите, что нарисовать — ${model.label} (${model.credits} ${UNIT_EMOJI}):`);
  });

  // "Удиви меня" — one random on-trend preset (docs/product-roadmap.md Tier 1
  // item #2). Registered BEFORE the general /^preset:(.+)$/ handler below so
  // this exact-string match wins for "preset:surprise" (grammY stops at the
  // first matching callbackQuery handler). Weighted toward the top-5 tapped
  // presets when real usage data exists (same trending set the Mini App's
  // Style Gallery badges — presetUsageCounts, src/db.ts); a fresh deploy with
  // zero taps falls back to fully random across the whole catalog, same
  // graceful "no fake trending" fallback the Style Gallery itself uses.
  bot.callbackQuery("preset:surprise", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!u.pending_file_id) {
      await ctx.reply("Сначала пришлите фото 🙂");
      return;
    }
    const usage = await presetUsageCounts();
    const trending = [...PRESETS].sort((a, b) => (usage[b.id] ?? 0) - (usage[a.id] ?? 0)).slice(0, 5);
    const pool = trending.some((p) => (usage[p.id] ?? 0) > 0) ? trending : PRESETS;
    const preset = pool[Math.floor(Math.random() * pool.length)];
    await ctx.reply(`🎲 Выпало: ${preset.label}`);
    await runGeneration(ctx, u, presetModel(preset), preset.prompt, u.pending_file_id, {
      crafted: true,
      allowFreeFirst: true,
    });
  });

  // One-tap presets: curated prompt through the premium model, no typing.
  bot.callbackQuery(/^preset:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    const preset = PRESETS.find((p) => p.id === ctx.match[1]);
    if (!preset) {
      await ctx.reply("Этот стиль больше недоступен — пришлите фото и выберите заново 🙂");
      return;
    }
    if (!u.pending_file_id) {
      await ctx.reply("Сначала пришлите фото 🙂");
      return;
    }
    await runGeneration(ctx, u, presetModel(preset), preset.prompt, u.pending_file_id, {
      crafted: true,
      allowFreeFirst: true,
    });
  });

  // ---- Text in → prompt for a pending action, or plain text-to-image ----

  bot.on("message:text", async (ctx) => {
    const u = await user(ctx);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    if (u.pending_action?.startsWith("mode_")) {
      // They picked a photo-based use case but typed text — gently re-route.
      if (u.pending_action !== "mode_animate" || !u.pending_file_id) {
        await ctx.reply("Пришлите фото 📸 — или просто напишите /menu, чтобы выбрать другое.");
        return;
      }
    }

    if (u.pending_action && u.pending_action !== "await_action" && !u.pending_action.startsWith("mode_")) {
      const model = modelByKey(u.pending_action);
      if (model?.kind === "text_to_image") {
        await runGeneration(ctx, u, model, text); // picked text model, no photo needed
        return;
      }
      if (model && u.pending_file_id) {
        await runGeneration(ctx, u, model, text, u.pending_file_id);
        return;
      }
    }
    await runGeneration(ctx, u, MODELS.text_to_image, text);
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) console.error("telegram error:", e.description);
    else if (e instanceof HttpError) console.error("network error:", e);
    else console.error("unhandled error:", e);
  });

  return bot;
}
