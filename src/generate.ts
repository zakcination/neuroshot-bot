import { fal } from "@fal-ai/client";
import type { Context } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { config } from "./config.js";
import {
  addCredits,
  consumeFreeResult,
  hasFreeResult,
  logEvent,
  logGeneration,
  setPending,
  spendCredits,
  type UserRow,
} from "./db.js";
import { MODELS, type ModelSpec } from "./models.js";
import { paywallKeyboard, paywallText } from "./payments.js";
import { craftPrompt } from "./promptcraft.js";

fal.config({ credentials: config.falKey });

/** Resolve a Telegram file_id to a publicly fetchable URL for fal input. */
async function telegramFileUrl(ctx: Context, fileId: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  return `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
}

function extractResultUrl(data: unknown): string | null {
  // fal responses vary by model: {images: [{url}]}, {image: {url}} or {video: {url}}
  const d = data as {
    images?: Array<{ url?: string }>;
    image?: { url?: string };
    video?: { url?: string };
  };
  return d?.images?.[0]?.url ?? d?.image?.url ?? d?.video?.url ?? null;
}

/**
 * Next-step keyboard on every delivered result. «Ещё стиль» only makes sense
 * when a source photo is still on file (image edits/presets/video); text→image
 * has no photo, so it gets a menu-only keyboard.
 */
export function afterKeyboard(hasPhoto: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasPhoto) kb.text("🎭 Ещё стиль", "menu:styles");
  return kb.text("📋 Меню", "menu:main");
}

/**
 * Charge credits, run the model, deliver the result. Refunds automatically on
 * provider failure. `fileId` may be a Telegram file_id OR a direct https URL
 * (e.g. a previous generation's output — powers campaign image→video chains).
 * Every prompt passes the promptcraft filter here; raw user text additionally
 * gets the craft mapping (curated presets set `crafted: true` to skip it).
 * Returns the output URL on success, null on paywall/failure.
 */
export async function runGeneration(
  ctx: Context,
  user: UserRow,
  model: ModelSpec,
  prompt: string,
  fileId?: string,
  opts: { crafted?: boolean; allowFreeFirst?: boolean } = {},
): Promise<string | null> {
  prompt = craftPrompt(model.kind, prompt, opts.crafted ?? false);
  // "First result on us": if a newcomer can't afford this and it's an eligible
  // (image) flow, render one free wow instead of walling them before any result.
  // Peek here, consume only on success (a provider failure must not burn it).
  let free = false;
  if (!(await spendCredits(user.id, model.credits, model.key))) {
    if ((opts.allowFreeFirst ?? false) && (await hasFreeResult(user.id))) {
      free = true;
    } else {
      await logEvent(user.id, "paywall", model.key);
      await ctx.reply(paywallText(model, user.credits), {
        parse_mode: "HTML",
        reply_markup: paywallKeyboard(model),
      });
      return null;
    }
  }
  await logEvent(user.id, "gen_start", model.key);
  // Keep the photo for one-tap follow-ups ("ещё стиль"), clear the prompt-await state.
  await setPending(user.id, fileId ? "await_action" : null, fileId ?? null);
  const after = afterKeyboard(!!fileId);
  const progress = await ctx.reply(
    model.kind === "image_to_video" ? "🎬 Рендерим видео (1–3 мин)…" : "✨ Генерируем…",
  );

  try {
    const imageUrl = fileId
      ? /^https?:\/\//.test(fileId)
        ? fileId
        : await telegramFileUrl(ctx, fileId)
      : undefined;
    const result = await fal.subscribe(model.falEndpoint, {
      input: model.input(prompt, imageUrl),
    });
    const url = extractResultUrl(result.data);
    if (!url) throw new Error(`No output URL in fal response for ${model.falEndpoint}`);

    if (model.kind === "image_to_video") {
      await ctx.replyWithVideo(new InputFile({ url }), { reply_markup: after });
    } else {
      await ctx.replyWithPhoto(new InputFile({ url }), { reply_markup: after });
    }
    // Charge-free first result: claim it now (won by exactly one call) and celebrate.
    if (free && (await consumeFreeResult(user.id))) {
      await ctx.reply("🎁 Первый результат — бесплатно, патроны не списаны! Дальше — за 🔫.");
    }
    await logGeneration(user.id, model.key, prompt, free ? 0 : model.credits, "ok", url);
    await logEvent(user.id, "gen_ok", model.key);
    return url;
  } catch (err) {
    if (!free) await addCredits(user.id, model.credits, "refund", model.key); // freebie: nothing charged
    await logGeneration(user.id, model.key, prompt, free ? 0 : model.credits, "error");
    await logEvent(user.id, "gen_error", model.key);
    console.error(`generation failed (${model.key}):`, err);
    await ctx.reply("⚠️ Не получилось — 🔫 патроны автоматически возвращены. Попробуйте ещё раз.");
    return null;
  } finally {
    await ctx.api.deleteMessage(progress.chat.id, progress.message_id).catch(() => {});
  }
}

export function modelByKey(key: string): ModelSpec | undefined {
  return (MODELS as Record<string, ModelSpec | undefined>)[key];
}
