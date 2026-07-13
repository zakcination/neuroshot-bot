import { fal } from "@fal-ai/client";
import type { Context } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { config } from "./config.js";
import {
  addCredits,
  claimFreePhone,
  completeGeneration,
  consumeFreeResult,
  consumeFreeScenario,
  createPendingGeneration,
  logEvent,
  restoreFreeResult,
  restoreFreeScenario,
  setPending,
  spendCredits,
  type UserRow,
} from "./db.js";
import { costUsdFor, MODELS, priceFor, type FreeScenario, type GenOpts, type ModelSpec } from "./models.js";
import { paywallKeyboard, paywallText } from "./payments.js";
import { craftPrompt } from "./promptcraft.js";
import { brandForDelivery } from "./watermark.js";

fal.config({ credentials: config.falKey });

/**
 * Detached render tails (the 1–3 min provider calls) run OFF grammY's update
 * loop so a render never blocks other commands. We keep a handle on each so a
 * graceful shutdown can await in-flight renders, and tests can settle them
 * deterministically before asserting.
 */
const inFlight = new Set<Promise<void>>();
function track(p: Promise<void>): void {
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}
/** Await all in-flight render tails (bounded) — for graceful shutdown and tests. */
export async function drainRenders(timeoutMs = 25_000): Promise<void> {
  if (!inFlight.size) return;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}
export function inFlightRenders(): number {
  return inFlight.size;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Durably record a DELIVERED render's terminal 'ok' state — retry through
 * transient DB blips so a render the user already received is never left
 * 'pending' (which the reaper would otherwise mark 'error' and refund). A
 * sustained DB outage still degrades to the reaper's customer-favourable refund;
 * the retry closes the realistic transient window.
 */
async function markOk(genId: number, url: string, costUsd: number, requestId: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await completeGeneration(genId, "ok", url, costUsd, requestId);
      return;
    } catch (e) {
      if (i === 2) {
        console.error("completeGeneration(ok) failed after retries:", e);
        return;
      }
      await sleep(150 * (i + 1));
    }
  }
}

/**
 * Detect a user-uploaded source (Telegram file_id) vs a generated output (https
 * URL). The core invariant of the fresh-photo fix: pending_file_id is only ever a
 * reusable UPLOAD, never a generated output URL.
 */
export function isUploadedSource(fileId: string | null | undefined): boolean {
  return !!fileId && !/^https?:\/\//.test(fileId);
}

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

/** Run a model on fal; returns the output URL + fal's request id (throws on provider failure). */
async function falRun(
  model: ModelSpec,
  prompt: string,
  imageUrl?: string,
  opts?: GenOpts,
): Promise<{ url: string; requestId: string }> {
  const result = await fal.subscribe(model.falEndpoint, { input: model.input(prompt, imageUrl, opts) });
  const url = extractResultUrl(result.data);
  if (!url) throw new Error(`No output URL in fal response for ${model.falEndpoint}`);
  return { url, requestId: result.requestId };
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
    // Provider metadata hoisted so a failed tail can still record what fal
    // actually billed us (populated only once falRun succeeds).
    let costUsd: number | undefined;
    let requestId: string | undefined;
    try {
      const r = await falRun(model, prompt, imageUrl, opts);
      costUsd = costUsdFor(model, opts);
      requestId = r.requestId;
      await completeGeneration(id, "ok", r.url, costUsd, requestId);
      // Analytics must never be able to trigger compensation: swallow its errors
      // so a post-'ok' logEvent blip can't fall into the catch and refund a
      // render we already completed and delivered.
      await logEvent(userId, "gen_ok", model.key).catch(() => {});
    } catch (err) {
      console.error(`web generation failed (${model.key}):`, err);
      // Refund ONLY if we win the pending→error CAS. If the 'ok' write already
      // landed (e.g. this catch was reached by a later throw), the CAS loses and
      // we must NOT refund a successful generation. Persist the provider cost we
      // were billed onto the error row so COGS accounting stays accurate.
      if (await completeGeneration(id, "error", undefined, costUsd, requestId)) {
        await addCredits(userId, credits, "refund", model.key);
      }
      await logEvent(userId, "gen_error", model.key).catch(() => {});
    }
  })();
  return { ok: true, id, credits };
}

/**
 * A WhatsApp share deep link for a delivered result. WhatsApp is KZ's dominant
 * messenger (~83% of the population vs. Telegram's ~25% among youth — see
 * docs/growth-product.md), yet it's where a happy user actually forwards a clip
 * to family. We can't push the media itself, so the button opens WhatsApp with a
 * source-tagged bot link (`?start=src_wa`) — spreading the acquisition link
 * through the channel people really use. Null when the bot username isn't set.
 */
export function whatsappShareUrl(): string | null {
  const bot = config.webappBotUsername;
  if (!bot) return null;
  const text = `Смотри, что я сделал в NeuroShot 🔥 Сделай своё бесплатно: https://t.me/${bot}?start=src_wa`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/**
 * Next-step keyboard on every delivered result. «Ещё стиль» only makes sense
 * when a source photo is still on file (image edits/presets/video); text→image
 * has no photo, so it gets a menu-only keyboard. A "share to WhatsApp" button
 * turns every result into word-of-mouth on KZ's biggest messenger.
 *
 * `animate` attaches the campaign "оживить" upsell — it carries the RESULT by its
 * generation id (`camv:<campId>:<genId>`), NOT via pending_file_id, so a generated
 * output is never silently reused as the next input (pending_file_id stays the
 * user's uploaded source). The handler resolves the result via getGeneration.
 */
export function afterKeyboard(hasPhoto: boolean, animate?: { campId: string; genId: number }): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (animate) kb.text("🎬 Оживить в видео", `camv:${animate.campId}:${animate.genId}`).row();
  if (hasPhoto) kb.text("🎭 Ещё стиль", "menu:styles");
  kb.text("📋 Меню", "menu:main");
  const wa = whatsappShareUrl();
  if (wa) kb.row().url("📲 Поделиться в WhatsApp", wa);
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
  opts: { crafted?: boolean; allowFreeFirst?: boolean; animate?: string } = {},
): Promise<void> {
  prompt = craftPrompt(model.kind, prompt, opts.crafted ?? false);
  // Nothing survived sanitation (empty / whitespace-only) → don't spend or call
  // the provider on an empty prompt; ask for a description instead.
  if (!prompt) {
    await ctx.reply("Напишите, что создать 🙂");
    return;
  }
  // ---- PROLOGUE (synchronous, serialized by grammY's sequential dispatch) ----
  // Commit every money/state decision here, BEFORE detaching, so concurrent
  // updates can never interleave a charge or a state write.
  //
  // "First result on us": a newcomer who can't afford an eligible IMAGE flow gets
  // one free wow. Claim the freebie ATOMICALLY up front (not a peek) so it's
  // spent exactly once across all transports; restore it if the render fails.
  const freeEligible = (opts.allowFreeFirst ?? false) && model.kind !== "image_to_video";
  let free = false;
  if (!(await spendCredits(user.id, model.credits, model.key))) {
    if (freeEligible && (await consumeFreeResult(user.id))) {
      free = true;
    } else {
      await logEvent(user.id, "paywall", model.key);
      await ctx.reply(paywallText(model, user.credits), {
        parse_mode: "HTML",
        reply_markup: paywallKeyboard(model, user),
      });
      return;
    }
  }
  await logEvent(user.id, "gen_start", model.key);
  // pending_file_id MUST only ever hold a user upload (never a generated URL): an
  // uploaded source is kept for "ещё стиль"; a URL continuation (camv) leaves the
  // stored upload intact; text→image clears the photo state.
  const isUpload = isUploadedSource(fileId);
  if (isUpload) await setPending(user.id, "await_action", fileId!);
  else if (!fileId) await setPending(user.id, null, null);

  const charged = free ? 0 : model.credits;
  const genId = await createPendingGeneration(user.id, model.key, prompt, charged);
  const chatId = ctx.chatId ?? user.id;
  const isVideo = model.kind === "image_to_video";
  const progress = await ctx.reply(isVideo ? "🎬 Рендерим видео (1–3 мин)…" : "✨ Генерируем…");

  // ---- TAIL (detached: the 1–3 min provider call runs OFF the update loop) ----
  track(
    (async () => {
      let delivered = false;
      // Hoisted so a delivery failure AFTER a successful provider call can still
      // record what fal billed us on the error row (accurate COGS). Populated
      // only once falRun returns.
      let costUsd: number | undefined;
      let requestId: string | undefined;
      try {
        const imageUrl = fileId
          ? /^https?:\/\//.test(fileId)
            ? fileId
            : await telegramFileUrl(ctx, fileId)
          : undefined;
        const r = await falRun(model, prompt, imageUrl);
        const url = r.url;
        costUsd = costUsdFor(model);
        requestId = r.requestId;
        const after = afterKeyboard(isUpload, opts.animate && !isVideo ? { campId: opts.animate, genId } : undefined);
        // Every deliverable carries the mandatory AI-generated disclosure; the
        // promo CTA is added on top only when the user's watermark setting is on.
        if (isVideo) {
          const branded = await brandForDelivery(url, "video", { promo: user.watermark_enabled });
          const media = branded ? new InputFile(branded, "neuroshot.mp4") : new InputFile({ url });
          await ctx.api.sendVideo(chatId, media, { reply_markup: after });
        } else {
          const branded = await brandForDelivery(url, "image", { promo: user.watermark_enabled });
          const media = branded ? new InputFile(branded, "neuroshot.png") : new InputFile({ url });
          await ctx.api.sendPhoto(chatId, media, { reply_markup: after });
        }
        delivered = true;
        // Terminal transition first (the pending row IS the generation record —
        // no separate logGeneration, or the render would double-count). Post-
        // delivery bookkeeping below must never be able to trigger compensation.
        await markOk(genId, url, costUsd, requestId);
        if (free) {
          await ctx.api
            .sendMessage(chatId, "🎁 Первый результат — бесплатно, патроны не списаны! Дальше — за 🔫.")
            .catch(() => {});
        }
        await logEvent(user.id, "gen_ok", model.key).catch(() => {});
      } catch (err) {
        console.error(`generation failed (${model.key}):`, err);
        // Compensate ONLY if we never delivered, and ONLY if we win the pending→
        // error CAS — so a post-delivery error can't refund a delivered render and
        // the reaper can't double-refund. Exactly-once.
        if (!delivered && (await completeGeneration(genId, "error", undefined, costUsd, requestId))) {
          if (!free) await addCredits(user.id, model.credits, "refund", model.key);
          else await restoreFreeResult(user.id);
          await ctx.api
            .sendMessage(chatId, "⚠️ Не получилось — 🔫 патроны автоматически возвращены. Попробуйте ещё раз.")
            .catch(() => {});
        }
        await logEvent(user.id, "gen_error", model.key).catch(() => {});
      } finally {
        await ctx.api.deleteMessage(progress.chat.id, progress.message_id).catch(() => {});
      }
    })(),
  );
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
): Promise<void> {
  // ---- PROLOGUE (serialized) ----
  // Identity gate (optional): the gift is one-per-PHONE. Claim the phone
  // atomically FIRST (the cross-account anti-farm guard) before consuming the
  // per-account flag, so N throwaway accounts sharing one number get one gift.
  if (config.freeGateEnabled) {
    if (!user.phone) {
      await ctx.reply("🔒 Сначала подтвердите номер телефона в /menu → бесплатный подарок 🙂");
      return;
    }
    if (!(await claimFreePhone(user.phone, user.id))) {
      await ctx.reply("Этот номер уже получал бесплатный подарок 🙂 Создайте всё за 🔫 — /menu");
      return;
    }
  }
  // Claim the freebie ATOMICALLY up front so the whole expensive two-model chain
  // is gated on winning it exactly once; restore it if the render fails (below),
  // so a failure never burns the gift (the same-owner phone claim allows a retry).
  if (!(await consumeFreeScenario(user.id))) {
    await ctx.reply("🎁 Бесплатный сценарий уже использован. Дальше — за 🔫 (их хватает надолго).");
    return;
  }
  await logEvent(user.id, "gen_start", `free_${scenario.id}`);
  // Keep the user's uploaded photo (a Telegram file_id) for "ещё стиль" — never
  // the generated scene URL, so a top-level flow can't reuse a generated output.
  await setPending(user.id, "await_action", fileId);
  const genId = await createPendingGeneration(user.id, scenario.videoModel.key, scenario.videoPrompt, 0);
  const chatId = ctx.chatId ?? user.id;
  const progress = await ctx.reply("🎬 Снимаем ваш бесплатный сценарий (1–3 мин)… патроны не тратятся.");

  // ---- TAIL (detached) ----
  track(
    (async () => {
      let delivered = false;
      // Hoisted so a delivery failure after BOTH provider legs succeed still
      // records the combined chain cost + audit id on the error row.
      let chainCostUsd: number | undefined;
      let providerRequestId: string | undefined;
      try {
        const photoUrl = await telegramFileUrl(ctx, fileId);
        // 1) Photo → styled scene image (Seedream edit). 2) Scene → short video (Hailuo).
        const scene = await falRun(scenario.imageModel, scenario.imagePrompt, photoUrl);
        const videoResult = await falRun(scenario.videoModel, scenario.videoPrompt, scene.url);
        const videoUrl = videoResult.url;
        // This ONE generations row represents the whole free chain — the actual
        // cost NeuroShot paid is both legs combined (the highest-COGS acquisition
        // path in the product, hence the two-model chain being worth tracking
        // precisely); the video leg's request id is the primary audit trail since
        // it's the delivered artifact.
        chainCostUsd = costUsdFor(scenario.imageModel) + costUsdFor(scenario.videoModel);
        providerRequestId = videoResult.requestId;
        // Free scenarios carry the AI disclosure AND the promo CTA (the badge is
        // the price of "free").
        const branded = await brandForDelivery(videoUrl, "video", { promo: true });
        const video = branded ? new InputFile(branded, "neuroshot.mp4") : new InputFile({ url: videoUrl });
        await ctx.api.sendVideo(chatId, video, {
          caption: "🎁 Ваш бесплатный сценарий готов! Понравилось? Создайте свой — /menu",
          reply_markup: afterKeyboard(true),
        });
        delivered = true;
        await markOk(genId, videoUrl, chainCostUsd, providerRequestId); // durable terminal write (retry through blips)
        await logEvent(user.id, "gen_ok", `free_${scenario.id}`).catch(() => {});
      } catch (err) {
        console.error(`free scenario failed (${scenario.id}):`, err);
        if (!delivered && (await completeGeneration(genId, "error", undefined, chainCostUsd, providerRequestId))) {
          await restoreFreeScenario(user.id); // return the gift so they can retry
          await ctx.api
            .sendMessage(chatId, "⚠️ Не получилось снять сценарий — попробуйте ещё раз, бесплатная попытка сохранена.")
            .catch(() => {});
        }
        await logEvent(user.id, "gen_error", `free_${scenario.id}`).catch(() => {});
      } finally {
        await ctx.api.deleteMessage(progress.chat.id, progress.message_id).catch(() => {});
      }
    })(),
  );
}
