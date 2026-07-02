import type { UserFromGetMe } from "grammy/types";
import type { Context } from "grammy";
import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { getOrCreateUser, setPending, stats, type UserRow } from "./db.js";
import { modelByKey, runGeneration } from "./generate.js";
import { MODELS, PRESET_MODEL, PRESETS, type Preset } from "./models.js";
import { registerPayments, sendBalance } from "./payments.js";

function user(ctx: { from?: { id: number; username?: string } }, referrerId: number | null = null): UserRow {
  if (!ctx.from) throw new Error("no ctx.from");
  return getOrCreateUser(ctx.from.id, ctx.from.username, referrerId, config.freeCredits);
}

/**
 * UX rules (vs the model-first aggregator bots):
 * - buttons name the OUTCOME, never the model;
 * - every path reaches a generation in ≤2 taps, no prompt required;
 * - price in credits on every button that spends;
 * - every delivered result carries a "next step" keyboard.
 */
export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📸 AI-фотосессия", "menu:photoshoot")
    .row()
    .text("🛍 Фото товара для маркетплейса", "menu:product")
    .row()
    .text(`🎬 Оживить фото в видео (${MODELS.animate.credits} кр)`, "menu:animate")
    .row()
    .text("✨ Картинка из текста", "menu:text")
    .row()
    .text("💰 Баланс и пакеты", "menu:balance")
    .text("🎁 Заработать 10%", "menu:ref");
}

function presetsKeyboard(category: Preset["category"]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PRESETS.filter((x) => x.category === category)) {
    kb.text(`${p.label} (${PRESET_MODEL.credits} кр)`, `preset:${p.id}`).row();
  }
  kb.text(`✍️ Свой промпт (${MODELS.premium_edit.credits} кр)`, "act:premium_edit").row();
  kb.text("📋 Меню", "menu:main");
  return kb;
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

  bot.command("start", async (ctx) => {
    const payload = ctx.match?.trim();
    const referrerId = payload && /^\d+$/.test(payload) ? Number(payload) : null;
    const u = user(ctx, referrerId);
    await ctx.reply(`${WELCOME}\n\n🎁 У вас <b>${u.credits} бесплатных кредита</b>.`, {
      parse_mode: "HTML",
      reply_markup: mainMenu(),
    });
  });

  bot.command("menu", async (ctx) => {
    user(ctx);
    await ctx.reply("Что создаём?", { reply_markup: mainMenu() });
  });

  bot.command("balance", async (ctx) => sendBalance(ctx, user(ctx).credits));
  bot.command("buy", async (ctx) => sendBalance(ctx, user(ctx).credits));

  bot.command("ref", async (ctx) => sendRefLink(ctx));

  // Premium text-to-image: /premium <prompt> (GPT Image 2, high quality).
  bot.command("premium", async (ctx) => {
    const u = user(ctx);
    const prompt = ctx.match?.trim();
    if (!prompt) {
      await ctx.reply(
        `💎 Премиум-картинка (${MODELS.premium_image.credits} кр) — напишите запрос сразу после команды:\n/premium флакон духов на мокром чёрном мраморе`,
      );
      return;
    }
    await runGeneration(ctx, u, MODELS.premium_image, prompt);
  });

  bot.command("stats", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const s = stats();
    await ctx.reply(
      `👥 Users: ${s.users}\n💳 Paying: ${s.paid}\n🎨 Generations: ${s.generations}\n⭐ Stars revenue: ${s.starsRevenue}`,
    );
  });

  registerPayments(bot);

  // ---- Main menu navigation ----

  bot.callbackQuery("menu:main", async (ctx) => {
    await ctx.answerCallbackQuery();
    user(ctx);
    await ctx.reply("Что создаём?", { reply_markup: mainMenu() });
  });

  bot.callbackQuery("menu:photoshoot", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    if (u.pending_file_id) {
      await ctx.reply("Выберите стиль — один тап, без промптов:", {
        reply_markup: presetsKeyboard("photo"),
      });
      return;
    }
    setPending(u.id, "mode_photo", null);
    await ctx.reply("Пришлите своё фото 📸 (портрет без ретуши работает лучше всего) — и выберете стиль.");
  });

  bot.callbackQuery("menu:product", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    if (u.pending_file_id) {
      await ctx.reply("Выберите подачу товара:", { reply_markup: presetsKeyboard("product") });
      return;
    }
    setPending(u.id, "mode_product", null);
    await ctx.reply("Пришлите фото товара 🛍 (можно прямо со стола — фон мы заменим).");
  });

  bot.callbackQuery("menu:animate", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    setPending(u.id, "mode_animate", u.pending_file_id);
    await ctx.reply(
      u.pending_file_id
        ? "Опишите движение (например: «медленный наезд камеры, волосы развеваются»):"
        : "Пришлите фото 🎬 — превратим его в 5-секундное видео.",
    );
    if (u.pending_file_id) setPending(u.id, "animate", u.pending_file_id);
  });

  bot.callbackQuery("menu:text", async (ctx) => {
    await ctx.answerCallbackQuery();
    user(ctx);
    await ctx.reply(
      [
        `✨ Просто напишите сообщением, что нарисовать (${MODELS.text_to_image.credits} кр).`,
        `💎 Максимальное качество: /premium ваш запрос (${MODELS.premium_image.credits} кр).`,
      ].join("\n"),
    );
  });

  bot.callbackQuery("menu:balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendBalance(ctx, user(ctx).credits);
  });

  bot.callbackQuery("menu:ref", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendRefLink(ctx);
  });

  // "Ещё стиль" on a delivered result: reuse the last photo if we still have it.
  bot.callbackQuery("menu:styles", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    if (!u.pending_file_id) {
      await ctx.reply("Пришлите фото — и выбирайте стиль 🙂");
      return;
    }
    await ctx.reply("Выберите стиль:", { reply_markup: presetsKeyboard("photo") });
  });

  async function sendRefLink(ctx: Context) {
    await ctx.reply(
      `🎁 Ваша ссылка:\nhttps://t.me/${ctx.me.username}?start=${ctx.from!.id}\n\nВы получаете 10% кредитов с каждого пакета, купленного по вашей ссылке.`,
    );
  }

  // ---- Photo in → route by selected mode (or show the action menu) ----

  bot.on("message:photo", async (ctx) => {
    const u = user(ctx);
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id; // largest size
    const mode = u.pending_action;

    if (mode === "mode_product") {
      setPending(u.id, "await_action", fileId);
      await ctx.reply("Отличный кадр! Выберите подачу товара:", {
        reply_markup: presetsKeyboard("product"),
      });
      return;
    }
    if (mode === "mode_photo") {
      setPending(u.id, "await_action", fileId);
      await ctx.reply("Выберите стиль — один тап, без промптов:", {
        reply_markup: presetsKeyboard("photo"),
      });
      return;
    }
    if (mode === "mode_animate") {
      setPending(u.id, "animate", fileId);
      await ctx.reply("Опишите движение (например: «медленный наезд камеры, волосы развеваются»):");
      return;
    }

    setPending(u.id, "await_action", fileId);
    const kb = new InlineKeyboard()
      .text("📸 AI-фотосессия — стили", "menu:photoshoot")
      .row()
      .text("🛍 Продающее фото товара", "menu:product")
      .row()
      .text(`🖼 Редактировать по описанию (${MODELS.photo_edit.credits} кр)`, "act:photo_edit")
      .row()
      .text(`🎬 Оживить в видео (${MODELS.animate.credits} кр)`, "act:animate");
    await ctx.reply("Что сделать с этим фото?", { reply_markup: kb });
  });

  bot.callbackQuery(/^act:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    const model = modelByKey(ctx.match[1]);
    if (!model || !u.pending_file_id) {
      await ctx.reply("Сначала пришлите фото 🙂");
      return;
    }
    setPending(u.id, model.key, u.pending_file_id);
    await ctx.reply(
      model.kind === "image_to_video"
        ? "Опишите движение (например: «медленный наезд камеры, волосы развеваются»):"
        : "Опишите, что изменить (например: «замени фон на парижскую улицу на закате»):",
    );
  });

  // One-tap presets: curated prompt through the premium model, no typing.
  bot.callbackQuery(/^preset:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    const preset = PRESETS.find((p) => p.id === ctx.match[1]);
    if (!preset) {
      await ctx.reply("Этот стиль больше недоступен — пришлите фото и выберите заново 🙂");
      return;
    }
    if (!u.pending_file_id) {
      await ctx.reply("Сначала пришлите фото 🙂");
      return;
    }
    await runGeneration(ctx, u, PRESET_MODEL, preset.prompt, u.pending_file_id);
  });

  // ---- Text in → prompt for a pending action, or plain text-to-image ----

  bot.on("message:text", async (ctx) => {
    const u = user(ctx);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    if (u.pending_action?.startsWith("mode_")) {
      // They picked a photo-based use case but typed text — gently re-route.
      if (u.pending_action !== "mode_animate" || !u.pending_file_id) {
        await ctx.reply("Пришлите фото 📸 — или просто напишите /menu, чтобы выбрать другое.");
        return;
      }
    }

    if (u.pending_action && u.pending_action !== "await_action" && !u.pending_action.startsWith("mode_") && u.pending_file_id) {
      const model = modelByKey(u.pending_action);
      if (model) {
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
