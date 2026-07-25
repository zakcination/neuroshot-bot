/**
 * Content moderation — screens every user-uploaded photo BEFORE it can be used
 * as generation input (whole-company audit finding: zero moderation existed
 * anywhere in the upload/generation pipeline, flagged critical given a
 * marketed children's-photo preset).
 *
 * Uses fal's own hosted classifier, `fal-ai/imageutils/nsfw` — no new vendor
 * or account, the same FAL_KEY the app already holds for generation. Wired
 * into both entry points where new image bytes enter the system: the Mini
 * App's `/api/upload` (src/webapp.ts) and the bot's Telegram-file resolution
 * (src/generate.ts telegramFileUrl) — every OTHER path (a previous own
 * generation reused by id/URL, a video end-frame) flows through one of those
 * two, so this is the single choke point.
 */
import { fal } from "@fal-ai/client";
import { config } from "./config.js";

/** Thrown when an image fails the safety check — callers must not generate on it. */
export class UnsafeImageError extends Error {
  constructor(public readonly nsfwProbability: number) {
    super(`image flagged unsafe (nsfw_probability=${nsfwProbability.toFixed(2)})`);
    this.name = "UnsafeImageError";
  }
}

/**
 * Screen an already-hosted, publicly fetchable image URL. Throws
 * UnsafeImageError if it's flagged OR if the classifier call itself fails —
 * failing CLOSED (treat as unsafe) rather than silently skipping the check on
 * a provider outage. A rare false block during an outage is preferable to
 * moderation silently going dark.
 */
export async function assertImageSafe(imageUrl: string): Promise<void> {
  let probability: number;
  try {
    const result = await fal.subscribe("fal-ai/imageutils/nsfw", { input: { image_url: imageUrl } });
    const p = (result.data as { nsfw_probability?: number } | undefined)?.nsfw_probability;
    if (typeof p !== "number" || Number.isNaN(p)) throw new Error("nsfw_probability missing from classifier response");
    probability = p;
  } catch (err) {
    console.error("content moderation check failed — failing closed:", err);
    throw new UnsafeImageError(1);
  }
  if (probability >= config.moderationNsfwThreshold) throw new UnsafeImageError(probability);
}
