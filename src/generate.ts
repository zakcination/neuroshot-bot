import { fal } from "@fal-ai/client";
import type { Context } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { config } from "./config.js";
import {
  addCredits,
  completeGeneration,
  consumeFreeResult,
  consumeFreeScenario,
  createPendingGeneration,
  hasFreeResult,
  hasFreeScenario,
  logEvent,
  logGeneration,
  setPending,
  spendCredits,
  type UserRow,
} from "./db.js";
import { MODELS, priceFor, type FreeScenario, type GenOpts, type ModelSpec } from "./models.js";
import { paywallKeyboard, paywallText } from "./payments.js";
import { craftPrompt } from "./promptcraft.js";
import { watermarkVideo } from "./watermark.js";

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

/** Run a model on fal and return the output URL (throws on provider failure). */
async function falRun(
  model: ModelSpec,
  prompt: string,
  imageUrl?: string,
  opts?: GenOpts,
): Promise<string> {
  const result = await fal.subscribe(model.falEndpoint, { input: model.input(prompt, imageUrl, opts) });
  const url = extractResultUrl(result.data);
  if (!url) throw new Error(`No output URL in fal response for ${model.falEndpoint}`);
  return url;
}

/**
 * Transport-agnostic generation for the web app: charge synchronously, insert a
 * 'pending' generations row, then run the provider in the background — the HTTP
 * response returns the row id immediately and the client polls it. Economics
 * mirror the bot path exactly: promptcraft on entry, refund on failure, the
 * same paywall/gen_* analytics events.
 */
export async function startWebGeneration(
  userId: number,
  model: ModelSpec,
  prompt: string,
  imageUrl?: string,
  crafted = false,
  opts?: GenOpts,
): Promise<{ ok: true; id: number; credits: number } | { ok: false; error: "empty_prompt" | "insufficient" }> {
  prompt = craftPrompt(model.kind, prompt, crafted);
  if (!prompt) return { ok: false, error: "empty_prompt" };
  const credits = priceFor(model, opts); // video charge scales with duration
  if (!(await spendCredits(userId, credits, model.key))) {
    await logEvent(userId, "paywall", model.key);
    return { ok: false, error: "insufficient" };
  }
  await logEvent(userId, "gen_start", model.key);
  const id = await createPendingGeneration(userId, model.key, prompt, credits);
  void (async () => {
    try {
      const url = await falRun(model, prompt, imageUrl, opts);
      await completeGeneration(id, "ok", url);
      await logEvent(userId, "gen_ok", model.key);
    } catch (err) {
      console.error(`web generation failed (${model.key}):`, err);
      await addCredits(userId, credits, "refund", model.key);
      await completeGeneration(id, "error");
      await logEvent(userId, "gen_error", model.key);
    }
  })();
  return { ok: true, id, credits };
}

/**
 * Next-step keyboard on every delivered result. «Ещё стиль» only makes sense
 * when a source photo is still on file (image edits/presets/video); text→image
 * has no photo, so it gets a menu-only keyboard.
 */
export function afterKeyboard(hasPhoto: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasPhoto) kb.text("🎭 Ещё стиль", "menu:styles");
  kb.text("📋 Меню", "menu:main");
  // Flagship surface: every delivered result routes into the app's studio/gallery.
  if (config.webappUrl) kb.row().webApp("🌐 Открыть в студии", config.webappUrl);
  return kb;
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
  // Nothing survived sanitation (empty / whitespace-only) → don't spend or call
  // the provider on an empty prompt; ask for a description instead.
  if (!prompt) {
    await ctx.reply("Напишите, что создать 🙂");
    return null;
  }
  // "First result on us": if a newcomer can't afford this and it's an eligible
  // IMAGE flow (never the expensive video upsell), render one free wow instead of
  // walling them before any result. Peek here, consume only on success (a
  // provider failure must not burn it).
  const freeEligible = (opts.allowFreeFirst ?? false) && model.kind !== "image_to_video";
  let free = false;
  if (!(await spendCredits(user.id, model.credits, model.key))) {
    if (freeEligible && (await hasFreeResult(user.id))) {
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
    const url = await falRun(model, prompt, imageUrl);

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

/**
 * The one-time FREE scenario (princess/football): render the WHOLE chain — photo
 * → Seedream styled scene → Hailuo video — at zero credits, then brand the video
 * with the NeuroShot watermark and deliver it. The free grant is claimed only on
 * a fully successful video (a provider failure leaves it intact so they retry).
 * `fileId` is the user's source photo (Telegram file_id). Returns true on deliver.
 */
export async function runFreeScenario(
  ctx: Context,
  user: UserRow,
  scenario: FreeScenario,
  fileId: string,
): Promise<boolean> {
  // Peek only — consume after success so a failed render doesn't burn the freebie.
  if (!(await hasFreeScenario(user.id))) {
    await ctx.reply("🎁 Бесплатный сценарий уже использован. Дальше — за 🔫 (их хватает надолго).");
    return false;
  }
  await logEvent(user.id, "gen_start", `free_${scenario.id}`);
  const progress = await ctx.reply("🎬 Снимаем ваш бесплатный сценарий (1–3 мин)… патроны не тратятся.");
  try {
    const photoUrl = await telegramFileUrl(ctx, fileId);
    // 1) Photo → styled scene image (Seedream edit). 2) Scene → short video (Hailuo).
    const sceneImg = await falRun(scenario.imageModel, scenario.imagePrompt, photoUrl);
    const videoUrl = await falRun(scenario.videoModel, scenario.videoPrompt, sceneImg);
    // Claim the freebie now (exactly one winner); if it was already claimed in a
    // race, fall back to charging is not needed — just deliver this once.
    await consumeFreeScenario(user.id);
    // Brand the video if the watermark is available; else send the source URL.
    const branded = await watermarkVideo(videoUrl);
    const video = branded ? new InputFile(branded, "neuroshot.mp4") : new InputFile({ url: videoUrl });
    await setPending(user.id, "await_action", sceneImg); // keep the scene for follow-ups
    await ctx.replyWithVideo(video, {
      caption: "🎁 Ваш бесплатный сценарий готов! Понравилось? Создайте свой — /menu",
      reply_markup: afterKeyboard(true),
    });
    await logGeneration(user.id, scenario.imageModel.key, scenario.imagePrompt, 0, "ok", sceneImg);
    await logGeneration(user.id, scenario.videoModel.key, scenario.videoPrompt, 0, "ok", videoUrl);
    await logEvent(user.id, "gen_ok", `free_${scenario.id}`);
    return true;
  } catch (err) {
    console.error(`free scenario failed (${scenario.id}):`, err);
    await logGeneration(user.id, scenario.videoModel.key, scenario.videoPrompt, 0, "error");
    await logEvent(user.id, "gen_error", `free_${scenario.id}`);
    await ctx.reply("⚠️ Не получилось снять сценарий — попробуйте ещё раз, бесплатная попытка сохранена.");
    return false;
  } finally {
    await ctx.api.deleteMessage(progress.chat.id, progress.message_id).catch(() => {});
  }
}
