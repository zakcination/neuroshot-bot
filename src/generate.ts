import { fal } from "@fal-ai/client";
import type { Context } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { config } from "./config.js";
import { addCredits, logGeneration, setPending, spendCredits, type UserRow } from "./db.js";
import { MODELS, type ModelSpec } from "./models.js";

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
  .text("💳 Buy credits", "show_packs");

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
  if (!spendCredits(user.id, model.credits, model.key)) {
    await ctx.reply(
      `Not enough credits: "${model.label}" costs ${model.credits}, you have ${user.credits}.`,
      { reply_markup: buyKeyboard },
    );
    return;
  }
  setPending(user.id, null, null);
  const progress = await ctx.reply(
    model.kind === "image_to_video" ? "🎬 Rendering video (1–3 min)…" : "✨ Generating…",
  );

  try {
    const imageUrl = fileId ? await telegramFileUrl(ctx, fileId) : undefined;
    const result = await fal.subscribe(model.falEndpoint, {
      input: model.input(prompt, imageUrl),
    });
    const url = extractResultUrl(result.data);
    if (!url) throw new Error(`No output URL in fal response for ${model.falEndpoint}`);

    if (model.kind === "image_to_video") {
      await ctx.replyWithVideo(new InputFile({ url }));
    } else {
      await ctx.replyWithPhoto(new InputFile({ url }));
    }
    logGeneration(user.id, model.key, prompt, model.credits, "ok");
  } catch (err) {
    addCredits(user.id, model.credits, "refund", model.key);
    logGeneration(user.id, model.key, prompt, model.credits, "error");
    console.error(`generation failed (${model.key}):`, err);
    await ctx.reply("⚠️ Generation failed — your credits were refunded. Please try again.");
  } finally {
    await ctx.api.deleteMessage(progress.chat.id, progress.message_id).catch(() => {});
  }
}

export function modelByKey(key: string): ModelSpec | undefined {
  return (MODELS as Record<string, ModelSpec | undefined>)[key];
}
