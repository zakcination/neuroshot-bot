import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { UserFromGetMe } from "grammy/types";
import type { Context } from "grammy";
import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import { config } from "./config.js";
import { funnel, getOrCreateUser, logEvent, setPending, stats, type UserRow } from "./db.js";
import { modelByKey, runGeneration } from "./generate.js";
import {
  IMAGE_MODEL_PICKER,
  MODELS,
  PRESET_MODEL,
  PRESETS,
  VIDEO_MODEL_PICKER,
  type Preset,
} from "./models.js";
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
  const kb = new InlineKeyboard()
    .text("📸 AI-фотосессия", "menu:photoshoot")
    .row()
    .text("🛍 Фото товара для маркетплейса", "menu:product")
    .row()
    .text(`🎬 Оживить фото в видео (${MODELS.animate.credits} кр)`, "menu:animate")
    .row()
    .text("✨ Картинка из текста", "menu:text")
    .row()
    .text("⚡ Топ AI-модели", "menu:models")
    .row();
  if (config.webappUrl) kb.webApp("🌐 Открыть приложение", config.webappUrl).row();
  return kb.text("💰 Баланс и пакеты", "menu:balance").text("🎁 Заработать 10%", "menu:ref");
}

/** Picker of the top text-to-image models (famous names, priced). */
function imageModelsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const key of IMAGE_MODEL_PICKER) {
    const m = MODELS[key];
    kb.text(`${m.label} (${m.credits} кр)`, `txt:${key}`).row();
  }
  return kb.text("🎬 Видео из фото →", "menu:animate").row().text("📋 Меню", "menu:main");
}

/** Picker of the top image-to-video models (famous names, priced). Needs a photo. */
function videoModelsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const key of VIDEO_MODEL_PICKER) {
    const m = MODELS[key];
    kb.text(`${m.label} (${m.credits} кр)`, `act:${key}`).row();
  }
  return kb.text("📋 Меню", "menu:main");
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
async function sendMainMenu(ctx: Context, caption: string): Promise<void> {
  const hero = join(MENU_DIR, "hero.jpg");
  if (existsSync(hero)) {
    try {
      await ctx.replyWithPhoto(new InputFile(hero), {
        caption,
        parse_mode: "HTML",
        reply_markup: mainMenu(),
      });
      return;
    } catch (e) {
      console.error("hero image failed:", e);
    }
  }
  await ctx.reply(caption, { parse_mode: "HTML", reply_markup: mainMenu() });
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
          if (data.startsWith("preset:")) logEvent(from.id, "preset", data.slice(7));
          else logEvent(from.id, "select", data); // menu:* | act:* | buy:* | show_packs
        } else if (ctx.message?.photo) {
          logEvent(from.id, "photo");
        } else if (ctx.message?.text?.startsWith("/start")) {
          logEvent(from.id, "menu_open", "start");
        } else if (ctx.message?.text === "/menu") {
          logEvent(from.id, "menu_open", "menu");
        }
      } catch (e) {
        console.error("analytics log failed:", e);
      }
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    const payload = ctx.match?.trim();
    const referrerId = payload && /^\d+$/.test(payload) ? Number(payload) : null;
    const u = user(ctx, referrerId);
    await sendMainMenu(ctx, `${WELCOME}\n\n🎁 У вас <b>${u.credits} бесплатных кредита</b>.`);
    // Deep link from the Mini App's "Пополнить" button.
    if (payload === "buy") await sendBalance(ctx, u.credits);
  });

  bot.command("menu", async (ctx) => {
    const u = user(ctx);
    setPending(u.id, null, u.pending_file_id); // escape any mode/prompt-await, keep the photo
    await sendMainMenu(ctx, "Что создаём?");
  });

  bot.command("app", async (ctx) => {
    user(ctx);
    if (!config.webappUrl) {
      await ctx.reply("Приложение скоро откроется 🌐");
      return;
    }
    await ctx.reply("🌐 Ваш личный кабинет: баланс, галерея работ и статистика.", {
      reply_markup: new InlineKeyboard().webApp("Открыть приложение", config.webappUrl),
    });
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

  // Admin conversion funnel + "why didn't they order" drop-off buckets.
  bot.command("funnel", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const f = funnel();
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
    const u = user(ctx);
    setPending(u.id, null, u.pending_file_id); // escape any mode/prompt-await, keep the photo
    await ctx.reply("Что создаём?", { reply_markup: mainMenu() });
  });

  bot.callbackQuery("menu:photoshoot", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    if (u.pending_file_id) {
      await showPresets(ctx, "photo", "Выберите стиль — один тап, без промптов:");
      return;
    }
    setPending(u.id, "mode_photo", null);
    await sendPreviewAlbum(ctx, "photo");
    await ctx.reply(
      "Вот что можно получить 👆 Пришлите своё фото 📸 (портрет без ретуши работает лучше всего) — и выберите стиль.",
    );
  });

  bot.callbackQuery("menu:product", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    if (u.pending_file_id) {
      await showPresets(ctx, "product", "Выберите подачу товара:");
      return;
    }
    setPending(u.id, "mode_product", null);
    await sendPreviewAlbum(ctx, "product");
    await ctx.reply("Вот примеры 👆 Пришлите фото товара 🛍 (можно прямо со стола — фон мы заменим).");
  });

  bot.callbackQuery("menu:animate", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    await sendMenuVideo(ctx, "animate"); // example of the expected result
    if (u.pending_file_id) {
      await ctx.reply("🎬 Выберите видео-модель:", { reply_markup: videoModelsKeyboard() });
      return;
    }
    setPending(u.id, "mode_animate", null);
    await ctx.reply("Вот пример 👆 Пришлите фото 🎬 — и выберите модель (Kling / Seedance).");
  });

  bot.callbackQuery("menu:videopick", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    if (!u.pending_file_id) {
      await ctx.reply("Сначала пришлите фото 🙂");
      return;
    }
    await ctx.reply("🎬 Выберите видео-модель:", { reply_markup: videoModelsKeyboard() });
  });

  bot.callbackQuery("menu:text", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    setPending(u.id, null, u.pending_file_id); // leave photo mode so the next text becomes a t2i prompt
    await sendMenuAlbum(ctx, ["text_example_1", "text_example_2"]); // examples of the expected result
    await ctx.reply("✨ Выберите модель для картинки по тексту:", {
      reply_markup: imageModelsKeyboard(),
    });
  });

  // Top-models hub: image-model picker + a route into the video-model picker.
  bot.callbackQuery("menu:models", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    setPending(u.id, null, u.pending_file_id);
    await ctx.reply(
      "⚡ Топовые модели ИИ.\nКартинка по тексту — выберите модель (или пришлите фото для видео):",
      { reply_markup: imageModelsKeyboard() },
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
    await showPresets(ctx, "photo", "Выберите стиль:");
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
      await showPresets(ctx, "product", "Отличный кадр! Выберите подачу товара:");
      return;
    }
    if (mode === "mode_photo") {
      setPending(u.id, "await_action", fileId);
      await showPresets(ctx, "photo", "Выберите стиль — один тап, без промптов:");
      return;
    }
    if (mode === "mode_animate") {
      setPending(u.id, "await_action", fileId);
      await ctx.reply("🎬 Выберите видео-модель:", { reply_markup: videoModelsKeyboard() });
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
      .text("🎬 Оживить в видео (Kling / Seedance)", "menu:videopick");
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

  // Text-to-image model picked from a picker — no photo needed, next text runs it.
  bot.callbackQuery(/^txt:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    const model = modelByKey(ctx.match[1]);
    if (!model || model.kind !== "text_to_image") {
      await ctx.reply("Модель недоступна 🙂");
      return;
    }
    setPending(u.id, model.key, null); // text model: no photo
    await ctx.reply(`✍️ Напишите, что нарисовать — ${model.label} (${model.credits} кр):`);
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
