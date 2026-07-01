import type { UserFromGetMe } from "grammy/types";
import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { getOrCreateUser, setPending, stats, type UserRow } from "./db.js";
import { buyKeyboard, modelByKey, runGeneration } from "./generate.js";
import { MODELS, PRESET_MODEL, PRESETS } from "./models.js";
import { registerPayments, sendBalance } from "./payments.js";

function user(ctx: { from?: { id: number; username?: string } }, referrerId: number | null = null): UserRow {
  if (!ctx.from) throw new Error("no ctx.from");
  return getOrCreateUser(ctx.from.id, ctx.from.username, referrerId, config.freeCredits);
}

/** Build the bot with all handlers wired. Pass botInfo to skip the getMe call (tests). */
export function createBot(botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(config.botToken, botInfo ? { botInfo } : undefined);

  bot.command("start", async (ctx) => {
    const payload = ctx.match?.trim();
    const referrerId = payload && /^\d+$/.test(payload) ? Number(payload) : null;
    const u = user(ctx, referrerId);
    await ctx.reply(
      [
        "📸 *NeuroShot* — AI photoshoots & product videos in one bot.",
        "",
        "• Send a *photo* → edit it, restyle it with 💎 presets, or turn it into a video",
        "• Send a *text prompt* → generate an image (or /premium for top quality)",
        "",
        `You have *${u.credits} free credits*. Image = 1, 💎 premium = 4, video = 8.`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.command("balance", async (ctx) => sendBalance(ctx, user(ctx).credits));
  bot.command("buy", async (ctx) => sendBalance(ctx, user(ctx).credits));

  bot.command("ref", async (ctx) => {
    await ctx.reply(
      `🎁 Your referral link:\nhttps://t.me/${ctx.me.username}?start=${ctx.from!.id}\n\nYou earn 10% of every pack your referrals buy.`,
    );
  });

  // Premium text-to-image: /premium <prompt> (GPT Image 2, high quality).
  bot.command("premium", async (ctx) => {
    const u = user(ctx);
    const prompt = ctx.match?.trim();
    if (!prompt) {
      await ctx.reply(
        `💎 Premium image (GPT Image 2, ${MODELS.premium_image.credits} cr) — send the prompt right after the command:\n/premium a perfume bottle on wet black marble, dramatic light`,
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

  // Photo in → choose an action, then wait for the prompt.
  bot.on("message:photo", async (ctx) => {
    user(ctx);
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id; // largest size
    setPending(ctx.from.id, "await_action", fileId);
    const kb = new InlineKeyboard()
      .text(`${MODELS.photo_edit.label} (${MODELS.photo_edit.credits} cr)`, "act:photo_edit")
      .row()
      .text(`${MODELS.premium_edit.label} (${MODELS.premium_edit.credits} cr)`, "act:premium_edit")
      .row()
      .text(`🎭 Style presets (${PRESET_MODEL.credits} cr)`, "presets_menu")
      .row()
      .text(`${MODELS.animate.label} (${MODELS.animate.credits} cr)`, "act:animate");
    await ctx.reply("What should I do with this photo?", { reply_markup: kb });
  });

  // One-tap presets: pick a style, we apply a curated prompt via the premium model.
  bot.callbackQuery("presets_menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    if (!u.pending_file_id) {
      await ctx.reply("Send a photo first 🙂");
      return;
    }
    const kb = new InlineKeyboard();
    for (const p of PRESETS) kb.text(p.label, `preset:${p.id}`).row();
    await ctx.reply(
      `🎭 Pick a style — one tap, no prompt needed (${PRESET_MODEL.credits} cr):`,
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^preset:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    const preset = PRESETS.find((p) => p.id === ctx.match[1]);
    if (!preset) {
      await ctx.reply("That style is no longer available — send a photo and pick again 🙂");
      return;
    }
    if (!u.pending_file_id) {
      await ctx.reply("Send a photo first 🙂");
      return;
    }
    await runGeneration(ctx, u, PRESET_MODEL, preset.prompt, u.pending_file_id);
  });

  bot.callbackQuery(/^act:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = user(ctx);
    const model = modelByKey(ctx.match[1]);
    if (!model || !u.pending_file_id) {
      await ctx.reply("Send a photo first 🙂");
      return;
    }
    setPending(u.id, model.key, u.pending_file_id);
    await ctx.reply(
      model.kind === "image_to_video"
        ? "Describe the motion (e.g. “slow zoom in, hair moving in the wind”):"
        : "Describe the edit (e.g. “replace background with a Paris street at sunset”):",
    );
  });

  // Text in → either the prompt for a pending action, or a text-to-image request.
  bot.on("message:text", async (ctx) => {
    const u = user(ctx);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    if (u.pending_action && u.pending_action !== "await_action" && u.pending_file_id) {
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

export { buyKeyboard };
