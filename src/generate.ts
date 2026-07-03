import { fal } from "@fal-ai/client";
import type { Context } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { config } from "./config.js";
import { addCredits, logEvent, logGeneration, setPending, spendCredits, type UserRow } from "./db.js";
import { MODELS, type ModelSpec } from "./models.js";
import { nCredits } from "./text.js";

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

export const buyKeyboard = new InlineKeyboard()
  .text("💳 Купить кредиты", "show_packs");

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
 * Charge credits, run the model, deliver the result.
 * Refunds automatically on provider failure.
 */
export async function runGeneration(
  ctx: Context,
  user: UserRow,
  model: ModelSpec,
  prompt: string,
  fileId?: string,
): Promise<void> {
  if (!(await spendCredits(user.id, model.credits, model.key))) {
    await logEvent(user.id, "paywall", model.key);
    await ctx.reply(
      `Не хватает кредитов: «${model.label}» стоит ${nCredits(model.credits)}, у вас ${nCredits(user.credits)}.`,
      { reply_markup: buyKeyboard },
    );
    return;
  }
  await logEvent(user.id, "gen_start", model.key);
  // Keep the photo for one-tap follow-ups ("ещё стиль"), clear the prompt-await state.
  await setPending(user.id, fileId ? "await_action" : null, fileId ?? null);
  const after = afterKeyboard(!!fileId);
  const progress = await ctx.reply(
    model.kind === "image_to_video" ? "🎬 Рендерим видео (1–3 мин)…" : "✨ Генерируем…",
  );

  try {
    const imageUrl = fileId ? await telegramFileUrl(ctx, fileId) : undefined;
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
    await logGeneration(user.id, model.key, prompt, model.credits, "ok", url);
    await logEvent(user.id, "gen_ok", model.key);
  } catch (err) {
    await addCredits(user.id, model.credits, "refund", model.key);
    await logGeneration(user.id, model.key, prompt, model.credits, "error");
    await logEvent(user.id, "gen_error", model.key);
    console.error(`generation failed (${model.key}):`, err);
    await ctx.reply("⚠️ Не получилось — кредиты автоматически возвращены. Попробуйте ещё раз.");
  } finally {
    await ctx.api.deleteMessage(progress.chat.id, progress.message_id).catch(() => {});
  }
}

export function modelByKey(key: string): ModelSpec | undefined {
  return (MODELS as Record<string, ModelSpec | undefined>)[key];
}
