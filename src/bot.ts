import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { UserFromGetMe } from "grammy/types";
import type { Context } from "grammy";
import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import { config } from "./config.js";
import {
  addCredits,
  funnel,
  getOrCreateUser,
  getPartnerCode,
  getUser,
  listPartnerCodes,
  logEvent,
  partnerStats,
  referralStats,
  setPending,
  stats,
  upsertPartnerCode,
  type PartnerCodeRow,
  type UserRow,
} from "./db.js";
import { modelByKey, runGeneration } from "./generate.js";
import {
  CAMPAIGNS,
  campaignById,
  featuredCampaign,
  IMAGE_MODEL_PICKER,
  MODELS,
  PRESET_MODEL,
  PRESETS,
  REFERRAL_MILESTONES,
  VIDEO_MODEL_PICKER,
  type Campaign,
  type Preset,
} from "./models.js";
import { registerPayments, sendBalance } from "./payments.js";
import { nUnits, UNIT_EMOJI } from "./text.js";

async function user(
  ctx: { from?: { id: number; username?: string } },
  referrerId: number | null = null,
  partner: PartnerCodeRow | null = null,
): Promise<UserRow> {
  if (!ctx.from) throw new Error("no ctx.from");
  return getOrCreateUser(
    ctx.from.id,
    ctx.from.username,
    referrerId,
    config.freeCredits,
    config.referralJoinBonus,
    partner,
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
 */
export function mainMenu(opts: { featured?: Campaign; hasPhoto?: boolean } = {}): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (opts.hasPhoto) kb.text("📸 Продолжить с вашим фото", "menu:styles").row();
  if (opts.featured) kb.text(`🆕 Новинка недели: ${opts.featured.label}`, `camp:${opts.featured.id}`).row();
  kb.text("📸 AI-фотосессия", "menu:photoshoot")
    .row()
    .text("🛍 Фото товара для маркетплейса", "menu:product")
    .row()
    .text(`🎬 Оживить фото в видео (от ${MODELS.animate.credits} 🔫)`, "menu:animate")
    .row()
    .text("🎉 Кампании: сказки, кумиры, старые фото", "menu:campaigns")
    .row()
    .text("✨ Картинка из текста", "menu:text")
    .row()
    .text("⚡ Топ AI-модели", "menu:models")
    .row();
  if (config.webappUrl) kb.webApp("🌐 Открыть приложение", config.webappUrl).row();
  return kb.text("💰 Баланс и пакеты", "menu:balance").text("🎁 Пригласить друга", "menu:ref");
}

/** Picker of the top text-to-image models (famous names, priced). */
function imageModelsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const key of IMAGE_MODEL_PICKER) {
    const m = MODELS[key];
    kb.text(`${m.label} (${m.credits} 🔫)`, `txt:${key}`).row();
  }
  return kb.text("🎬 Видео из фото →", "menu:animate").row().text("📋 Меню", "menu:main");
}

/** Picker of the top image-to-video models (famous names, priced). Needs a photo. */
function videoModelsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const key of VIDEO_MODEL_PICKER) {
    const m = MODELS[key];
    kb.text(`${m.label} (${m.credits} 🔫)`, `act:${key}`).row();
  }
  return kb.text("📋 Меню", "menu:main");
}

function presetsKeyboard(category: Preset["category"]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PRESETS.filter((x) => x.category === category)) {
    kb.text(`${p.label} (${PRESET_MODEL.credits} 🔫)`, `preset:${p.id}`).row();
  }
  kb.text(`✍️ Свой промпт (${MODELS.premium_edit.credits} 🔫)`, "act:premium_edit").row();
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
  menuOpts: { featured?: Campaign; hasPhoto?: boolean } = {},
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
    // Deep-link payloads: numeric = friend referral, c_<code> = creator/partner code.
    const referrerId = payload && /^\d+$/.test(payload) ? Number(payload) : null;
    const partner = payload?.startsWith("c_")
      ? ((await getPartnerCode(payload.slice(2).toLowerCase())) ?? null)
      : null;
    const u = await user(ctx, referrerId, partner);
    let msg = `${WELCOME}\n\n`;
    if (u.justCreated) {
      msg += `🎁 Вам начислено <b>${UNIT_EMOJI} ${nUnits(u.credits)}</b> на старт.`;
      if (u.joinBonus && u.joinBonus > 0) {
        msg +=
          u.joinVia === "partner"
            ? `\nИз них <b>+${nUnits(u.joinBonus)}</b> — подарок от ${partner?.title ?? "партнёра"} 🤝`
            : `\nИз них <b>+${nUnits(u.joinBonus)}</b> — бонус за приглашение. Спасибо другу! 🤝`;
      }
    } else {
      msg += `💰 На балансе: <b>${UNIT_EMOJI} ${nUnits(u.credits)}</b>.`;
    }
    // Returning users get a fresh reason to come back: the weekly rotating
    // "новинка недели" + a one-tap continue-with-your-last-photo shortcut.
    const menuOpts = u.justCreated
      ? {}
      : { featured: featuredCampaign(new Date()), hasPhoto: !!u.pending_file_id };
    if (menuOpts.featured) msg += `\n\n🆕 Новинка недели: <b>${menuOpts.featured.label}</b> — попробуйте!`;
    await sendMainMenu(ctx, msg, menuOpts);
    // Deep link from the Mini App's "Пополнить" button.
    if (payload === "buy") await sendBalance(ctx, u.credits);
  });

  bot.command("menu", async (ctx) => {
    const u = await user(ctx);
    await setPending(u.id, null, u.pending_file_id); // escape any mode/prompt-await, keep the photo
    await sendMainMenu(ctx, "Что создаём?");
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

  // Creator/partner dashboard: per-code funnel + link for negotiated deals.
  bot.command("partner", async (ctx) => {
    const u = await user(ctx);
    const codes = await listPartnerCodes(u.id);
    if (!codes.length) {
      await ctx.reply(
        "🤝 Партнёрская программа для авторов, блогеров и школ: персональный код, " +
          "повышенный процент с покупок вашей аудитории и подарочные 🔫 подписчикам.\n\n" +
          "Напишите нам — обсудим условия. А пока работает обычная реферальная ссылка: /ref",
      );
      return;
    }
    const blocks: string[] = [];
    for (const c of codes) {
      const st = await partnerStats(c.code);
      blocks.push(
        `🔗 <b>${c.title ?? c.code}</b>\n` +
          `<code>https://t.me/${ctx.me.username}?start=c_${c.code}</code>\n` +
          `👥 пришло: <b>${st.joined}</b> · 💳 покупают: <b>${st.paying}</b> · ` +
          `заработано: <b>${UNIT_EMOJI} ${nUnits(st.earned)}</b>\n` +
          `условия: ${Math.round(c.percent * 100)}% с покупок · +${c.join_bonus} 🔫 новым`,
      );
    }
    await ctx.reply(`🤝 <b>Ваши партнёрские коды</b>\n\n${blocks.join("\n\n")}`, { parse_mode: "HTML" });
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
      `✅ Код <code>c_${code}</code> → ${ownerId}: ${pct}% с покупок, +${Math.floor(bonus)} 🔫 новым.\n` +
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
        `💎 Премиум-картинка (${MODELS.premium_image.credits} 🔫) — напишите запрос сразу после команды:\n/premium флакон духов на мокром чёрном мраморе`,
      );
      return;
    }
    await runGeneration(ctx, u, MODELS.premium_image, prompt);
  });

  bot.command("stats", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const s = await stats();
    await ctx.reply(
      `👥 Users: ${s.users}\n💳 Paying: ${s.paid}\n🎨 Generations: ${s.generations}\n⭐ Stars revenue: ${s.starsRevenue}`,
    );
  });

  // Admin: top up 🔫 for testing (self by default, or a target user).
  // /grant <amount>  |  /grant <tg_id> <amount>  (amount may be negative to deduct)
  bot.command("grant", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const targetId = args.length >= 2 ? Number(args[0]) : ctx.from.id;
    const amount = Number(args.length >= 2 ? args[1] : args[0]);
    if (!Number.isInteger(targetId) || !Number.isInteger(amount) || amount === 0) {
      await ctx.reply("Формат: /grant <кол-во> или /grant <tg_id> <кол-во>\nПример: /grant 9999");
      return;
    }
    const target = await getUser(targetId);
    if (!target) {
      await ctx.reply(`Пользователь ${targetId} не найден — пусть сначала откроет /start.`);
      return;
    }
    await addCredits(targetId, amount, "admin_grant", String(ctx.from.id));
    const updated = await getUser(targetId);
    await ctx.reply(
      `✅ ${amount > 0 ? "Начислено" : "Списано"} ${UNIT_EMOJI} ${nUnits(Math.abs(amount))} → ${targetId}. ` +
        `Баланс: ${nUnits(updated!.credits)}.`,
    );
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

  bot.callbackQuery("menu:photoshoot", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (u.pending_file_id) {
      await showPresets(ctx, "photo", "Выберите стиль — один тап, без промптов:");
      return;
    }
    await setPending(u.id, "mode_photo", null);
    await sendPreviewAlbum(ctx, "photo");
    await ctx.reply(
      "Вот что можно получить 👆 Пришлите своё фото 📸 (портрет без ретуши работает лучше всего) — и выберите стиль.",
    );
  });

  bot.callbackQuery("menu:product", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (u.pending_file_id) {
      await showPresets(ctx, "product", "Выберите подачу товара:");
      return;
    }
    await setPending(u.id, "mode_product", null);
    await sendPreviewAlbum(ctx, "product");
    await ctx.reply("Вот примеры 👆 Пришлите фото товара 🛍 (можно прямо со стола — фон мы заменим).");
  });

  // ---- Campaigns: one-click viral scenarios (image → optional video upsell) ----

  function campaignPresetKeyboard(c: Campaign): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const p of c.presets) kb.text(`${p.label} (${PRESET_MODEL.credits} 🔫)`, `cpre:${c.id}:${p.id}`).row();
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
    if (u.pending_file_id) {
      await ctx.reply(c.header, { reply_markup: campaignPresetKeyboard(c) });
      return;
    }
    await setPending(u.id, `mode_camp_${c.id}`, null);
    await ctx.reply(c.ask);
  });

  // One-tap campaign render; on success, offer the one-tap animate upsell that
  // runs on the GENERATED image (the pending photo is swapped to the result).
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
      await ctx.reply(c.ask);
      return;
    }
    const url = await runGeneration(ctx, u, PRESET_MODEL, preset.prompt, u.pending_file_id, {
      crafted: true,
      allowFreeFirst: true,
    });
    if (url) {
      await setPending(u.id, "await_action", url);
      await ctx.reply("Хотите оживить результат в видео? 👇", {
        reply_markup: new InlineKeyboard().text(
          `${c.animateLabel} (${MODELS.animate.credits} 🔫)`,
          `camv:${c.id}`,
        ),
      });
    }
  });

  bot.callbackQuery(/^camv:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = campaignById(ctx.match[1]);
    const u = await user(ctx);
    if (!c || !u.pending_file_id) {
      await ctx.reply("Сначала создайте картинку в кампании 🙂");
      return;
    }
    await runGeneration(ctx, u, MODELS.animate, c.animatePrompt, u.pending_file_id, { crafted: true });
  });

  bot.callbackQuery("menu:animate", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await sendMenuVideo(ctx, "animate"); // example of the expected result
    if (u.pending_file_id) {
      await ctx.reply("🎬 Выберите видео-модель:", { reply_markup: videoModelsKeyboard() });
      return;
    }
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
    const link = `https://t.me/${ctx.me.username}?start=${u.id}`;
    const st = await referralStats(u.id);
    const pct = Math.round(config.referralPercent * 100);

    // One-tap share: opens Telegram's share sheet with the link + a prefilled pitch.
    const pitch =
      `Держи ${nUnits(config.referralJoinBonus)} 🔫 в подарок на AI-фото и видео в NeuroShot 🎁 ` +
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
      .text("📸 AI-фотосессия — стили", "menu:photoshoot")
      .row()
      .text("🛍 Продающее фото товара", "menu:product")
      .row()
      .text(`🖼 Редактировать по описанию (${MODELS.photo_edit.credits} 🔫)`, "act:photo_edit")
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
    await ctx.reply(`✍️ Напишите, что нарисовать — ${model.label} (${model.credits} 🔫):`);
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
    await runGeneration(ctx, u, PRESET_MODEL, preset.prompt, u.pending_file_id, {
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
