/**
 * Model registry: every generation the bot can perform, its fal.ai endpoint,
 * price in credits, and rough provider cost (USD) for margin tracking.
 *
 * fal endpoint IDs drift as providers ship new versions — verify against
 * https://fal.ai/explore/models before deploying, and prefer updating here
 * over hardcoding IDs elsewhere.
 */
import { config } from "./config.js";
import { UNIT_EMOJI } from "./text.js";

export type ModelKind = "image_edit" | "text_to_image" | "image_to_video";

/** Per-generation options the studio composer can set. */
export interface GenOpts {
  duration?: number; // video length in seconds
  aspectRatio?: string; // "auto" | "1:1" | "9:16" | "16:9" | "4:3" | "3:4"
  endImageUrl?: string; // video END frame (Kling 3.0 / Seedance) — start frame is the source image
  resolution?: string; // quality-tier id (model-specific: "1K"/"2K"/"4K", "480p"/"720p")
  numImages?: number; // output count — image models only, clamped to image.maxCount
  /**
   * A curated STYLE reference image, appended after the user's photo in
   * `image_urls` so the model can read our look (palette, light, materials)
   * instead of inferring it from words alone.
   *
   * SERVER-SET ONLY. normalizeOpts deliberately does not copy this field, so a
   * client can never put a URL here — otherwise /api/generate would become a
   * "fetch any URL you name and hand it to our provider" primitive. It is
   * assigned AFTER normalizeOpts, from the preset registry (styleRefUrl below).
   */
  styleRefUrl?: string;
  /**
   * ADDITIONAL photos of the SAME person, appended after the primary photo in
   * `image_urls`. More angles of one face give the model a far better likeness
   * than a single frame can — that is the whole point of this field, and why
   * refPrompt below tells the model these are one subject and not a group.
   *
   * SERVER-SET ONLY, exactly like styleRefUrl: normalizeOpts does not copy it,
   * so a client cannot smuggle URLs in through the opts bag. webapp.ts assigns
   * it after validating every entry against the media-host allow-list.
   */
  extraImageUrls?: string[];
}

/** A quality/resolution tier the composer can offer; `mult` scales credits AND cost. */
export interface ResTier {
  id: string;
  label: string; // RU-facing chip
  mult: number; // credit multiplier over the base `credits` (tier[0].mult = 1)
}

/** Image composer capabilities (aspect ratio + optional quality ladder). */
export interface ImageParams {
  aspectRatios: string[]; // selectable ratios; "auto" ⇒ model/source decides
  resolutions?: ResTier[]; // optional quality ladder; resolutions[0] = default
  /** Max output count via `num_images` (fal-verified — docs/cinema-studio-model-params.md P5).
   *  Every image endpoint in the registry declares `num_images`, confirmed against
   *  the live fal queue OpenAPI schemas. The cap here is OURS, not the provider's:
   *  it bounds the worst-case spend a single tap can trigger. */
  maxCount?: number;
  /** Max USER photos accepted as input, INCLUDING the primary one. Only edit
   *  models declare it (a text-to-image model has no photo input at all). Extra
   *  angles of the same face cost nothing extra — the providers composite the
   *  references into one output, so the charge still follows `num_images`. */
  maxInputs?: number;
}

/** Video composer capabilities + per-second pricing (credits scale with length). */
export interface VideoParams {
  perSecondUsd: number; // provider cost per second — the credit-scaling basis
  durations: number[]; // selectable seconds; durations[0] = default (matches `credits`)
  aspectRatios: string[]; // selectable ratios; "auto" keeps the source frame's ratio
  endFrame?: boolean; // accepts an optional end_image_url (morph source → end frame)
  resolutions?: ResTier[]; // optional quality ladder; resolutions[0] = default
}

export interface ModelSpec {
  key: string;
  kind: ModelKind;
  falEndpoint: string;
  credits: number; // charge for the DEFAULT settings (5s video / one image)
  approxCostUsd: number;
  /**
   * The provider's REAL model name, shown as-is. Users of this category already
   * know "Nano Banana Pro" / "Seedream" / "GPT Image" and search for exactly
   * those strings; inventing a house name for them adds a translation step and
   * hides which engine they are actually buying. (This reverses an earlier
   * benefit-naming decision — see git history.) Also rendered by
   * payments.paywallText, so it must read sensibly in a sentence.
   */
  label: string;
  /** One short line of what the model is FOR — the benefit the name doesn't carry. */
  note?: string;
  /** Builds the fal input payload. imageUrl set for edit/video; opts from the composer. */
  input: (prompt: string, imageUrl?: string, opts?: GenOpts) => Record<string, unknown>;
  /** Present on image models the composer can fine-tune (aspect ratio / quality). */
  image?: ImageParams;
  /** Present on image_to_video models the composer can fine-tune. */
  video?: VideoParams;
}

/** Aspect ratios offered for images ("auto" = model decides / keep source). */
export const IMAGE_ASPECTS = ["auto", "1:1", "9:16", "16:9", "4:3", "3:4"];

/**
 * Seedream & GPT-Image-2 take a NAMED `image_size`, not a ratio string — map the
 * composer's ratio onto the right preset (hd = Seedream's ~2K set, sd = GPT's set).
 */
const NAMED_SIZE: Record<string, { hd: string; sd: string }> = {
  "1:1": { hd: "square_hd", sd: "square" },
  "9:16": { hd: "portrait_16_9", sd: "portrait_16_9" },
  "16:9": { hd: "landscape_16_9", sd: "landscape_16_9" },
  "3:4": { hd: "portrait_4_3", sd: "portrait_4_3" },
  "4:3": { hd: "landscape_4_3", sd: "landscape_4_3" },
};
/** {image_size} for Seedream (hd) / GPT (sd) when a concrete ratio is chosen. */
function sizeParam(opts: GenOpts | undefined, hd: boolean): { image_size?: string } {
  const ar = opts?.aspectRatio;
  if (!ar || ar === "auto") return {};
  const m = NAMED_SIZE[ar];
  return m ? { image_size: hd ? m.hd : m.sd } : {};
}
/** {aspect_ratio} for models that take a ratio string directly (Nano Banana / Seedance). */
function arParam(opts: GenOpts | undefined): { aspect_ratio?: string } {
  return opts?.aspectRatio && opts.aspectRatio !== "auto" ? { aspect_ratio: opts.aspectRatio } : {};
}
/** {end_image_url} for video models that support an end frame. */
function endParam(opts: GenOpts | undefined): { end_image_url?: string } {
  return opts?.endImageUrl ? { end_image_url: opts.endImageUrl } : {};
}
/**
 * Resolve a preset's `styleRef` filename to an absolute URL fal can fetch.
 * Our own art under public/img, never a caller-supplied address — the filename
 * comes from the registry, so the set of reachable URLs is fixed at build time.
 * Returns undefined when WEBAPP_URL isn't configured (nothing public to serve
 * from): a style reference is an ENHANCEMENT, so its absence must degrade to a
 * words-only render, never to a failed generation.
 */
export function styleRefUrl(file: string | undefined): string | undefined {
  if (!file || !config.webappUrl) return undefined;
  return `${config.webappUrl.replace(/\/+$/, "")}/img/${file}`;
}
/**
 * The model payload's image list: the user's photos, then the optional style
 * reference. Order is load-bearing in both directions — the user's primary
 * photo stays FIRST (it is the identity anchor KEEP_ID refers to) and the style
 * plate stays LAST, which is what refPrompt below tells the model to expect.
 */
function refUrls(imageUrl: string | undefined, opts: GenOpts | undefined): string[] {
  return [imageUrl, ...(opts?.extraImageUrls ?? []), opts?.styleRefUrl].filter((u): u is string => !!u);
}
/**
 * Tells the model what the images after the first one are FOR. Without this the
 * list is ambiguous and the model reads extra images as extra PEOPLE — blending
 * faces or rendering a crowd, either of which breaks the one promise the product
 * actually makes. Both clauses are positional, so they stay correct however many
 * reference photos the user attached.
 */
function refPrompt(prompt: string, opts: GenOpts | undefined): string {
  const extra = opts?.extraImageUrls?.length ?? 0;
  const parts: string[] = [];
  if (extra) {
    // Phrased around IDENTITY, not headcount. An earlier version said "render
    // exactly ONE person", which was right for extra angles of one face and
    // flatly wrong for a couple or a family photo — it would have deleted
    // somebody. What actually needs saying is that the extra frames are the
    // same people again, not additional guests.
    parts.push(
      `The first ${extra + 1} images are reference photographs of the SAME subject or subjects, ` +
      `shot from different angles and in different lighting — read them together to get the ` +
      `faces right. They show the same people repeated, NOT extra people: the result must ` +
      `contain exactly the people who appear in them, no one added and no one dropped, ` +
      `and must never be a collage or a contact sheet.`,
    );
  }
  if (opts?.styleRefUrl) {
    parts.push(
      `The LAST image is a STYLE REFERENCE ONLY — copy its palette, lighting, ` +
      `materials and mood. Do not copy any person, face or body from it; the subject is ` +
      `taken solely from the ${extra ? "photographs above" : "first image"}.`,
    );
  }
  return parts.length ? `${prompt} ${parts.join(" ")}` : prompt;
}
/** {num_images} for image models — clamped to the model's declared maxCount, omitted at the default of 1. */
function countParam(maxCount: number, opts: GenOpts | undefined): { num_images?: number } {
  if (!opts?.numImages || opts.numImages <= 1) return {};
  return { num_images: Math.min(maxCount, Math.floor(opts.numImages)) };
}

/** Quality ladders (credit multiplier covers the higher provider cost with margin). */
// Nano Banana 2 native multi-resolution: 1K base, 2K = 1.5× rate, 4K = 2× rate
// (fal schema, verified 2026-07-22 — docs/cinema-studio-model-params.md P6).
const NB_RES: ResTier[] = [
  { id: "1K", label: "1K", mult: 1 },
  { id: "2K", label: "2K ✨", mult: 1.5 },
  { id: "4K", label: "4K 💎", mult: 2 },
];
// Nano Banana Pro: 1K/2K same rate, 4K = double rate (fal schema). We default/floor
// at 2K for quality (1K costs the same on fal, so it's a free quality win — P3).
const NBPRO_RES: ResTier[] = [
  { id: "2K", label: "2K", mult: 1 },
  { id: "4K", label: "4K 💎", mult: 2 },
];
// Seedance 2.0 resolution enum is 480p/720p (NOT 1080p — that tier doesn't exist on
// the 2.0 endpoint and a "1080p" request is rejected; fal schema, P1). 720p is the
// balanced default (base price); 480p is faster, priced the same until its real
// per-second cost is measured (then it can be discounted).
const SEEDANCE_RES: ResTier[] = [
  { id: "720p", label: "720p", mult: 1 },
  { id: "480p", label: "480p ⚡", mult: 1 },
];

export const MODELS = {
  photo_edit: {
    key: "photo_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana/edit",
    credits: 3,
    approxCostUsd: 0.06,
    label: "Nano Banana",
    note: "правки по фото — быстро и дёшево",
    input: (prompt, imageUrl, opts) => ({ prompt: refPrompt(prompt, opts), image_urls: refUrls(imageUrl, opts), ...arParam(opts), ...countParam(4, opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, maxCount: 4, maxInputs: 4 },
  },
  text_to_image: {
    key: "text_to_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/bytedance/seedream/v4.5/text-to-image",
    credits: 2,
    approxCostUsd: 0.04,
    label: "Seedream 4.5",
    note: "картинка из текста",
    input: (prompt, _img, opts) => ({ prompt, ...sizeParam(opts, true), ...countParam(6, opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, maxCount: 6 },
  },
  // Seedream 4.5 edit — the default scenario image engine (photo → styled scene).
  // Stronger face-anchored scene edits than v4 at the same 2 🔫 tier ($0.04/img);
  // same input contract (prompt + image_urls), so it's a drop-in over v4.
  // NB this IS PRESET_MODEL, and payments.paywallText renders `model.label`
  // directly when a preset/campaign generation hits the insufficient-credits
  // paywall — so the name reaches users outside any picker too. "Seedream 4.5"
  // reads fine in that sentence.
  seedream_edit: {
    key: "seedream_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/bytedance/seedream/v4.5/edit",
    credits: 2,
    approxCostUsd: 0.04,
    label: "Seedream 4.5",
    note: "сцена по вашему фото",
    input: (prompt, imageUrl, opts) => ({ prompt: refPrompt(prompt, opts), image_urls: refUrls(imageUrl, opts), ...sizeParam(opts, true), ...countParam(6, opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, maxCount: 6, maxInputs: 4 },
  },
  animate: {
    key: "animate",
    kind: "image_to_video",
    falEndpoint: "fal-ai/kling-video/v2.5-turbo/standard/image-to-video",
    credits: 25,
    approxCostUsd: 0.5,
    label: "Kling 2.5 Turbo",
    note: "оживить фото",
    // Kling 2.5-turbo has NO aspect_ratio param (ratio is inherited from the frame)
    // and no end-frame — don't advertise settings fal will silently ignore.
    input: (prompt, imageUrl, opts) => ({
      prompt,
      image_url: imageUrl,
      duration: String(opts?.duration ?? 5),
    }),
    video: { perSecondUsd: 0.1, durations: [5, 10], aspectRatios: ["auto"] },
  },
  premium_image: {
    key: "premium_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/gpt-image-2",
    credits: 11,
    approxCostUsd: 0.21, // high quality, 1024x1024
    label: "GPT Image 2",
    note: "текст на картинке, сложные сцены",
    input: (prompt, _img, opts) => ({ prompt, quality: "high", image_size: sizeParam(opts, false).image_size ?? "square", ...countParam(2, opts) }),
    // Count capped at 2, not 4: this is the most expensive image tier we run
    // ($0.21/img), so a single tap must not be able to spend 44 🔫.
    image: { aspectRatios: IMAGE_ASPECTS, maxCount: 2 },
  },
  premium_edit: {
    key: "premium_edit",
    kind: "image_edit",
    falEndpoint: "openai/gpt-image-2/edit",
    credits: 11,
    approxCostUsd: 0.22, // high quality, 1024x1024
    label: "GPT Image 2",
    note: "правка с текстом и типографикой",
    // `image_urls` is an array here too, so a preset's curated style reference
    // rides along exactly as it does on the Seedream/Nano Banana edit paths —
    // without this a `styleRef` on a premium_edit preset would be silently dropped.
    input: (prompt, imageUrl, opts) => ({ prompt: refPrompt(prompt, opts), image_urls: refUrls(imageUrl, opts), quality: "high", ...sizeParam(opts, false), ...countParam(2, opts) }),
    // Fewer extra angles than the cheap tiers: every input image is billed
    // context on this endpoint, so the cap doubles as a cost guard.
    image: { aspectRatios: IMAGE_ASPECTS, maxCount: 2, maxInputs: 2 },
  },

  // --- Top-tier models (verified against fal.ai model pages, Jul 2026) ---
  // Endpoint IDs, params and USD costs confirmed from the fal model pages.
  // Credits = ceil(approxCostUsd / CREDIT_COST_BASIS) so cost-per-credit ≤ $0.02
  // (see CREDIT_COST_BASIS below); at pack pricing this yields ≥3.5× margin even
  // on mobile Stars payout and after the referral share. Re-verify before launch.

  // Nano Banana 2 (Google) — fast SOTA image, $0.08/img @1K.
  nb2_image: {
    key: "nb2_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/nano-banana-2",
    credits: 4,
    approxCostUsd: 0.08,
    label: "Nano Banana 2",
    note: "картинка из текста, до 4K",
    input: (prompt, _img, opts) => ({ prompt, resolution: opts?.resolution ?? "1K", ...arParam(opts), ...countParam(4, opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, resolutions: NB_RES, maxCount: 4 },
  },
  nb2_edit: {
    key: "nb2_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana-2/edit",
    credits: 4,
    approxCostUsd: 0.08,
    label: "Nano Banana 2",
    note: "правка по фото, до 4K",
    input: (prompt, imageUrl, opts) => ({ prompt: refPrompt(prompt, opts), image_urls: refUrls(imageUrl, opts), resolution: opts?.resolution ?? "1K", ...arParam(opts), ...countParam(4, opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, resolutions: NB_RES, maxCount: 4, maxInputs: 4 },
  },
  // Nano Banana Pro (Gemini 3 Pro) — SOTA image, $0.15/img @1K–2K.
  nbpro_image: {
    key: "nbpro_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/nano-banana-pro",
    credits: 8,
    approxCostUsd: 0.15,
    label: "Nano Banana Pro",
    note: "максимум деталей",
    input: (prompt, _img, opts) => ({ prompt, resolution: opts?.resolution ?? "2K", ...arParam(opts), ...countParam(4, opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, resolutions: NBPRO_RES, maxCount: 4 },
  },
  nbpro_edit: {
    key: "nbpro_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana-pro/edit",
    credits: 8,
    approxCostUsd: 0.15,
    label: "Nano Banana Pro",
    note: "правка с максимумом деталей",
    input: (prompt, imageUrl, opts) => ({ prompt: refPrompt(prompt, opts), image_urls: refUrls(imageUrl, opts), resolution: opts?.resolution ?? "2K", ...arParam(opts), ...countParam(4, opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, resolutions: NBPRO_RES, maxCount: 4, maxInputs: 4 },
  },
  // Kling 3.0 Pro — top image→video, $0.168/s audio-on → 5s ≈ $0.84.
  kling3: {
    key: "kling3",
    kind: "image_to_video",
    falEndpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    credits: 42,
    approxCostUsd: 0.84,
    label: "Kling 3.0 Pro",
    note: "кинематографичное движение, финальный кадр",
    // Kling 3.0 has NO aspect_ratio param (ratio inherited from the start frame)
    // but DOES support an end frame — morph from the source image into end_image_url.
    input: (prompt, imageUrl, opts) => ({
      prompt,
      start_image_url: imageUrl,
      duration: String(opts?.duration ?? 5),
      ...endParam(opts),
    }),
    video: { perSecondUsd: 0.168, durations: [5, 10], aspectRatios: ["auto"], endFrame: true },
  },
  // Seedance 2.0 Fast (ByteDance) — economy premium video, $0.2419/s → 5s ≈ $1.21.
  seedance_fast: {
    key: "seedance_fast",
    kind: "image_to_video",
    falEndpoint: "bytedance/seedance-2.0/fast/image-to-video",
    credits: 61,
    approxCostUsd: 1.21,
    label: "Seedance 2.0 Fast",
    note: "физика и сложные сцены",
    input: (prompt, imageUrl, opts) => ({
      prompt,
      image_url: imageUrl,
      resolution: opts?.resolution ?? "720p",
      duration: String(opts?.duration ?? 5),
      ...arParam(opts),
      ...endParam(opts),
    }),
    video: {
      perSecondUsd: 0.2419,
      durations: [5, 10],
      aspectRatios: ["auto", "9:16", "16:9", "1:1", "4:3", "3:4"],
      endFrame: true,
      resolutions: SEEDANCE_RES,
    },
  },
  // Seedance 2.0 (ByteDance) — flagship video with audio/physics, $0.3034/s @720p → 5s ≈ $1.52.
  // NOTE: Seedance 2.0 lives in the "bytedance/" namespace on fal (NO fal-ai/ prefix).
  seedance: {
    key: "seedance",
    kind: "image_to_video",
    falEndpoint: "bytedance/seedance-2.0/image-to-video",
    credits: 76,
    approxCostUsd: 1.52,
    label: "Seedance 2.0",
    note: "со звуком — флагман",
    input: (prompt, imageUrl, opts) => ({
      prompt,
      image_url: imageUrl,
      resolution: opts?.resolution ?? "720p",
      generate_audio: true, // the flagship's whole point — real synced sound
      duration: String(opts?.duration ?? 5),
      ...arParam(opts),
      ...endParam(opts),
    }),
    video: {
      perSecondUsd: 0.3034,
      durations: [5, 10],
      aspectRatios: ["auto", "9:16", "16:9", "1:1", "4:3", "3:4"],
      endFrame: true,
      resolutions: SEEDANCE_RES,
    },
  },
  // MiniMax Hailuo 2.3 Fast [Standard] — the DEFAULT scenario video engine:
  // fast, cheap, great for simple one-action motion. $0.19/6s → 10 🔫, $0.32/10s.
  // 768p, keeps the source frame's ratio (no aspect_ratio param). Durations 6/10.
  // perSecondUsd = 0.032 makes the 10s charge resolve to 16 🔫 (ceil(0.32/0.02)).
  hailuo_fast: {
    key: "hailuo_fast",
    kind: "image_to_video",
    falEndpoint: "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video",
    credits: 10,
    approxCostUsd: 0.19,
    label: "Hailuo 2.3 Fast",
    note: "самое дешёвое видео",
    input: (prompt, imageUrl, opts) => ({
      prompt,
      image_url: imageUrl,
      duration: String(opts?.duration ?? 6),
    }),
    video: { perSecondUsd: 0.032, durations: [6, 10], aspectRatios: ["auto"] },
  },
} satisfies Record<string, ModelSpec>;

/**
 * Model pickers surfaced in the bot — a price/quality ladder under the models'
 * REAL names (see ModelSpec.label); `note` carries what each one is for.
 * Order = display order; each entry must be a real MODELS key of the right kind.
 * Default lineup (Jul 2026): fast SOTA image → detailed 2K → premium/GPT for
 * images; the cheap "эконом" video entry leads, then cinematic → epic → audio.
 */
export const IMAGE_MODEL_PICKER = ["text_to_image", "nb2_image", "nbpro_image", "premium_image"] as const;
// The cheap "эконом" default leads: users keep it until they swap up to a
// cinematic or physics/audio tier in the composer.
export const VIDEO_MODEL_PICKER = ["hailuo_fast", "kling3", "animate", "seedance_fast", "seedance"] as const;

/** Default image→video model for campaign upsells and one-tap animate flows. */
export const DEFAULT_VIDEO: ModelSpec = MODELS.hailuo_fast;

/** The engine epic (physics/multi-actor/audio) scenario scenes are gated to. */
export const EPIC_VIDEO: ModelSpec = MODELS.seedance_fast;

/**
 * The cheapest model of a kind — the daily digest surfaces it, and the news
 * banner marks it as the free-trial entry (free 🔫 must cover at least one
 * run of it). Recomputed from the registry, so a price update moves it.
 */
export function cheapestModel(kind: ModelKind): ModelSpec {
  return Object.values(MODELS as Record<string, ModelSpec>)
    .filter((m) => m.kind === kind)
    .reduce((a, m) => (m.approxCostUsd < a.approxCostUsd ? m : a));
}

/**
 * Credit charge for a generation given composer options. Video credits scale
 * with the chosen duration (cost is per-second); images and default settings
 * use the fixed `credits`. Kept ≥1 and rounded up so margin never inverts.
 */
export function priceFor(model: ModelSpec, opts?: GenOpts): number {
  let credits = model.credits;
  // Video: scale with the chosen duration (cost is per-second).
  if (model.video && opts?.duration && opts.duration !== model.video.durations[0]) {
    credits = Math.max(1, Math.ceil((model.video.perSecondUsd * opts.duration) / CREDIT_COST_BASIS));
  }
  // Higher resolution/quality tier costs more provider $ — scale the charge so
  // margin holds (tier[0].mult = 1, so the base price is unchanged by default).
  const tiers = model.image?.resolutions ?? model.video?.resolutions;
  if (tiers && opts?.resolution) {
    const t = tiers.find((x) => x.id === opts.resolution);
    if (t && t.mult !== 1) credits = Math.max(1, Math.ceil(credits * t.mult));
  }
  // Output count: N images ≈ N provider runs — the charge scales linearly
  // (docs/cinema-studio-model-params.md §4). Images only; clamped to maxCount.
  const maxCount = model.image?.maxCount;
  if (maxCount && opts?.numImages && opts.numImages > 1) {
    const n = Math.min(maxCount, Math.floor(opts.numImages));
    credits = Math.max(1, Math.ceil(credits * n));
  }
  return credits;
}

/**
 * The real provider cost in USD for a generation — the single source of truth
 * COGS accounting, per-user cost caps, and the patron exchange-rate display
 * are all computed from (see docs/pricing.md § cost tracking). Mirrors
 * priceFor's duration/resolution scaling exactly, but returns USD instead of
 * a patron charge, so it reflects what the run actually cost, not what the
 * user was billed. Rounded to 6 decimal places (well below cent-level) purely
 * to keep stored/logged values clean — floating-point multiplication of the
 * per-second rates otherwise leaves noise like 1.6800000000000002.
 */
export function costUsdFor(model: ModelSpec, opts?: GenOpts): number {
  let usd = model.approxCostUsd;
  if (model.video && opts?.duration && opts.duration !== model.video.durations[0]) {
    usd = model.video.perSecondUsd * opts.duration;
  }
  const tiers = model.image?.resolutions ?? model.video?.resolutions;
  if (tiers && opts?.resolution) {
    const t = tiers.find((x) => x.id === opts.resolution);
    if (t && t.mult !== 1) usd *= t.mult;
  }
  const maxCount = model.image?.maxCount;
  if (maxCount && opts?.numImages && opts.numImages > 1) {
    usd *= Math.min(maxCount, Math.floor(opts.numImages));
  }
  return Math.round(usd * 1e6) / 1e6;
}

/** Validate composer options against a model's declared capabilities. */
export function normalizeOpts(model: ModelSpec, opts?: GenOpts): GenOpts | null {
  if (!opts) return {};
  const out: GenOpts = {};
  // Aspect ratio — valid against the image OR video capability (whichever exists).
  const aspects = model.image?.aspectRatios ?? model.video?.aspectRatios;
  if (opts.aspectRatio != null) {
    if (!aspects || !aspects.includes(opts.aspectRatio)) return null;
    out.aspectRatio = opts.aspectRatio;
  }
  // Duration — video only.
  if (opts.duration != null) {
    if (!model.video || !model.video.durations.includes(opts.duration)) return null;
    out.duration = opts.duration;
  }
  // Resolution/quality tier — image or video ladder.
  const tiers = model.image?.resolutions ?? model.video?.resolutions;
  if (opts.resolution != null) {
    if (!tiers || !tiers.some((t) => t.id === opts.resolution)) return null;
    out.resolution = opts.resolution;
  }
  // End frame — only video models that declare support (URL format checked by caller).
  if (opts.endImageUrl != null) {
    if (!model.video?.endFrame) return null;
    out.endImageUrl = opts.endImageUrl;
  }
  // Output count — image models that declare maxCount only; must be a valid
  // integer in [1, maxCount] (same reject-on-invalid convention as the others).
  if (opts.numImages != null) {
    const max = model.image?.maxCount;
    if (!max || !Number.isInteger(opts.numImages) || opts.numImages < 1 || opts.numImages > max) return null;
    out.numImages = opts.numImages;
  }
  return out;
}

/**
 * The video story composer (web studio): fine-tune ANY image→video render with
 * a few taps. Fragments are appended to the motion prompt SERVER-SIDE (client
 * sends ids only). Personalization (hobby / pet / loved things) is a sanitized
 * free-text field handled alongside — see webapp.ts.
 */
export const VIDEO_STORY: QuizStep[] = [
  {
    id: "action",
    question: "Что происходит в кадре?",
    options: [
      { id: "reveal", label: "✨ Эффектное появление", fragment: "a cinematic reveal as the subject steps into the light" },
      { id: "approach", label: "🚶 Идёт к камере", fragment: "the subject walks confidently toward the camera" },
      { id: "turn", label: "🔄 Оборачивается", fragment: "the subject turns to face the camera and smiles" },
      { id: "celebrate", label: "🎉 Празднует", fragment: "the subject celebrates joyfully with expressive gestures" },
      { id: "calm", label: "🌊 Спокойное движение", fragment: "subtle lifelike motion — gentle breathing, a soft gaze shift" },
    ],
  },
  {
    id: "genre",
    question: "Жанр",
    options: [
      { id: "cinematic", label: "🎬 Кино", fragment: "cinematic film-grade color and lighting" },
      { id: "action", label: "💥 Экшн", fragment: "high-energy action style with dynamic camera moves" },
      { id: "dreamy", label: "🌙 Мечтательный", fragment: "dreamy soft-focus atmosphere with warm glow" },
      { id: "fashion", label: "🕶 Fashion", fragment: "sleek high-fashion editorial look" },
    ],
  },
  {
    id: "emotion",
    question: "Эмоция",
    options: [
      { id: "joy", label: "😊 Радость", fragment: "radiating warmth and happiness" },
      { id: "epic", label: "⚡ Мощь", fragment: "powerful, confident and heroic mood" },
      { id: "tender", label: "🤍 Нежность", fragment: "tender, intimate and heartfelt mood" },
      { id: "mystery", label: "🔮 Загадка", fragment: "mysterious, intriguing atmosphere" },
    ],
  },
  {
    id: "camera",
    question: "Камера",
    options: [
      { id: "pushin", label: "🎥 Наезд", fragment: "a slow dramatic push-in" },
      { id: "orbit", label: "🌀 Облёт", fragment: "a smooth orbiting camera move around the subject" },
      { id: "handheld", label: "📹 Ручная", fragment: "subtle handheld camera with a documentary feel" },
      { id: "static", label: "🎞 Статичная", fragment: "a locked-off static frame, motion within the scene" },
    ],
  },
];

/**
 * Model news for the web app's sliding banner: every new/updated model gets a
 * headline here and becomes instantly triable from the studio. Order = display
 * order (newest first). Update alongside any MODELS change.
 */
export interface ModelNews {
  key: keyof typeof MODELS;
  title: string; // RU headline
  tag: string; // short chip: what's special
}
export const MODEL_NEWS: ModelNews[] = [
  { key: "hailuo_fast", title: `Видео-сценарий за 10 ${UNIT_EMOJI}`, tag: "⚡ дёшево" },
  { key: "seedance", title: "Видео со звуком и физикой", tag: "🆕 звук" },
  { key: "seedance_fast", title: "Эпичные сцены на видео", tag: "🎞 эпик" },
  { key: "kling3", title: "Кино-движение и консистентность", tag: "🎬 видео" },
  { key: "nbpro_image", title: "Детализация уровня 2K", tag: "💎 2K" },
  { key: "text_to_image", title: `Картинка из текста за 2 ${UNIT_EMOJI}`, tag: "🎁 бесплатно" },
];

/**
 * One-tap style presets (Higgsfield-style): a curated prompt applied to the
 * user's photo via the premium edit model — no prompt-writing needed.
 */
export interface Preset {
  id: string;
  label: string;
  /** Which use-case menu the preset belongs to. */
  category: "photo" | "product";
  prompt: string;
  /**
   * Optional curated STYLE reference — a filename under public/img, resolved to
   * an absolute URL by styleRefUrl() and appended after the user's photo in
   * image_urls. Use it when a look is easier to SHOW the model than to describe
   * (a specific grade, material or lighting). Two hard rules: the art must be
   * ours, and it must contain no usable face — a reference with a face invites
   * the model to blend identities, which is the one thing this product cannot
   * do. Applied only on the fal-verified edit models (see the params doc P7).
   */
  styleRef?: string;
  /**
   * Optional per-look model override. Most presets render on the cheap
   * PRESET_MODEL (Seedream edit); looks that DEPEND on on-image text/typography
   * or heavy stylization (blister-pack titles, marketplace labels, 3D toon)
   * pin a stronger engine here — Seedream garbles text (see docs/prompt-craft.md).
   * The model stays implicit in the look — no extra user step — but the credit
   * price the user sees follows the chosen model. Mirrors CampaignPreset.tier.
   * A KEY into MODELS (not a captured ModelSpec ref) so it resolves at call time,
   * never at module-init — robust to any evaluation-order quirk.
   */
  model?: keyof typeof MODELS;
  /**
   * Optional aspect ratio the look PINS (e.g. marketplace cards must be 3:4 —
   * docs/growth-campaign-2026-07.md "killer feature"). Applied server-side as
   * the DEFAULT when the user didn't pick a ratio themselves, so one tap yields
   * a spec-correct result while an explicit user choice still wins. Must be a
   * ratio the preset's model actually supports (checked by normalizeOpts).
   */
  aspect?: string;
}

/**
 * Model used to render presets AND every campaign scenario image — a checked
 * reference, so a key drift fails typecheck. Seedream 4.5 edit: strong identity
 * fidelity at $0.04 (2 🔫), half the cost of Nano Banana 2 — this is the lever
 * that makes a whole free scenario affordable. GPT-Image-2 stays available via
 * «Свой промпт» and the top-models picker for typography-heavy instructions.
 */
export const PRESET_MODEL: ModelSpec = MODELS.seedream_edit;

/**
 * Which model renders a given preset: its own override if it pins one, else the
 * shared cheap default. One implicit choice per look — no extra user step — and
 * the credit price the user sees follows it. Mirrors sceneModel() for video.
 */
export function presetModel(p: Preset): ModelSpec {
  return p.model ? MODELS[p.model] : PRESET_MODEL;
}

// --- Curated-prompt guards (shared by presets, campaigns and free scenarios) ---
// Positive phrasing per Higgsfield's prompt guide — "keep exactly", "one single
// instance" and "exactly once" land better than "don't"/"never" negatives.
// Written in the PLURAL on purpose. The old singular ("the person's face")
// quietly told the model that the answer contains one human, so a photo of a
// couple or a family came back cropped to one of them — the user's own group
// shot, minus their people. Every curated prompt ends with this clause, so
// stating the headcount rule here fixes all of them at once, and it must stay
// last: it has to win against the singular phrasing inside individual prompts
// ("the person as a Bronze Age king"), which reads as one subject.
const KEEP_ID =
  "Keep the face and identity of EVERY person in the photo exactly as they are. " +
  "Keep the SAME NUMBER of people as the source photo: if it shows two or more people, " +
  "all of them appear together in the result, each with their own real face. " +
  "Everyone in the photo stays in the shot.";
const KEEP_KID = "Keep the child's face and identity exactly as in the photo.";
/**
 * Composition guard for kid+character scenes: models love to push the real
 * child into the background and to duplicate the famous character. Bake the
 * fix into every curated prompt (curated prompts skip the craft mapping).
 */
const KID_FOCUS =
  "Keep the real child as the clear hero — foreground, centered, face sharp and well lit. " +
  "Include one single instance of the character, just beside and slightly behind the child.";
/** De-dup guard for scenes with a real-world star (two Messis = ruined shot). */
const NO_CLONES = "Show each person exactly once in the frame.";

export const PRESETS: Preset[] = [
  {
    id: "headshot",
    label: "💼 Бизнес-портрет",
    category: "photo",
    // "Restyle" left the POSE alone, so a selfie went in and a selfie in a
    // blazer came out — arm still raised, phone still in frame. A corporate
    // headshot is defined as much by its posture as by its wardrobe, and most
    // of what people upload is a selfie, so the restaging has to be explicit:
    // drop the arm, remove the device, square the shoulders, put the camera on
    // a tripod at eye level. Naming what must LEAVE the frame is what makes
    // this work — an edit model keeps whatever you don't ask it to remove.
    prompt:
      "Restage as a professional corporate headshot taken by a photographer — NOT a selfie.\n" +
      "POSE: both arms DOWN and relaxed at the sides or lightly crossed; shoulders squared to the camera and " +
      "slightly turned; chin level; a calm, confident expression.\n" +
      "REMOVE from the frame entirely: any raised arm, any hand near the face, any phone, camera or held object, " +
      "and any selfie framing or wide-angle distortion. If the source is a selfie, rebuild the shot as if a " +
      "photographer stood two metres away with the camera on a tripod at eye level.\n" +
      "WARDROBE: a well-fitted tailored jacket over a plain top, no logos.\n" +
      "LIGHT: soft studio key with gentle fill, clean neutral-gray seamless backdrop, 85mm lens look, shallow " +
      `depth of field, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "fashion",
    label: "🕶 Fashion-съёмка",
    category: "photo",
    // "A designer outfit, Vogue-style" was doing the opposite of high fashion:
    // it pulled generic luxury-logo clothing, and it named a real magazine.
    // Both are dropped. Logos are now explicitly forbidden — a monogram print
    // is a trademark we have no right to put on a user's chest, and it is also
    // simply worse styling than a strong silhouette.
    //
    // What replaces it is what actually makes an editorial: a CONCEPT, one
    // committed PROP, and hair treated as sculpture. Same "choose one and
    // commit" structure as the retro look — a stacked list of ideas produces a
    // cluttered frame, one idea produces a cover.
    //
    // Every menu now branches MENSWEAR / WOMENSWEAR. The first version drew
    // all four menus from womenswear vocabulary alone — voluminous sleeves,
    // sculpted updos, a bloom held to the jaw, an elongated neck and dropped
    // shoulder — and never once said "tailoring", which is the whole core of
    // menswear editorial. Given a man the model had nothing register-correct
    // to reach for, so it produced a suit plus a feminine prop: a look that
    // belongs to neither. Half our subjects deserve their own vocabulary,
    // not the least-wrong item from someone else's.
    aspect: "3:4",
    prompt:
      "Restage the person — or ALL the people, if the photo shows more than one — as a high-fashion magazine " +
      "COVER shoot built on a concept, not on expensive clothes. A pair or group is styled as one editorial, " +
      "posed together in the same frame. " +
      "NO brand names, NO logos, NO monograms, NO designer labels anywhere in frame — the styling must carry " +
      "the image on its own.\n" +
      "FIRST read the person in the photo and choose the editorial REGISTER that genuinely suits them — " +
      "MENSWEAR or WOMENSWEAR. Both are equally high fashion; pick one and take every choice below from it. " +
      "In a mixed pair each person gets their own register, tied together by one shared concept and palette.\n" +
      "CONCEPT — choose ONE and commit completely. Bold monochrome colour-blocking, outfit and seamless " +
      "backdrop in the same saturated hue (either register). MENSWEAR: severe tailoring — a sharply cut " +
      "double-breasted suit with squared shoulders, a long structured overcoat worn open over bare skin, or a " +
      "high-necked knit under a hard-edged jacket. WOMENSWEAR: a sculptural silhouette — a vast voluminous " +
      "sleeve, a column gown, an exaggerated shoulder line. Or, for either: sharp minimalism in raw unbleached " +
      "fabric against concrete, or high-contrast graphic black-and-white with strong geometry.\n" +
      "PROP — one strong object used with intent. MENSWEAR: a plain wooden chair straddled or gripped by the " +
      "back, a cigarette-free hand pushed through the hair, a sheet of rippling silk caught mid-air behind the " +
      "shoulders, a shard of mirror reflecting one eye. WOMENSWEAR: an oversized bloom held to the jaw, " +
      "trailing fabric, a shard of mirror, a single vintage chair used as a frame within the frame.\n" +
      "HAIR — part of the sculpture. MENSWEAR: wet-look slicked straight back, a hard side part, or " +
      "deliberately dishevelled and pushed off the forehead; facial hair kept sharp and intentional. " +
      "WOMENSWEAR: an architectural sculpted updo, a sleek deep side part, or wind-blown across the face.\n" +
      "POSE AND EXPRESSION — editorial attitude, taken from the same register. MENSWEAR: a squared grounded " +
      "stance with weight on one leg, hands loose or one in a pocket, shoulders wide, chin level, jaw set; or " +
      "seated forward, elbows on knees, staring down the lens. WOMENSWEAR: an elongated neck and dropped " +
      "shoulder, a hand framing the jaw, a long diagonal line through the body. Either way: a cool level gaze " +
      "straight down the lens or eyes closed in stillness. Confident, never smiling for the camera.\n" +
      "LIGHT — one dramatic hard key with a deep falloff, crisp shadow edges, subtle film grain, shot on 85mm. " +
      "Cover-shoot framing — the subject sits low enough in the frame that a cover would have room above them, " +
      "but the backdrop must continue edge to edge: NO white bar, NO border, NO blank band, and NO text, " +
      `masthead or lettering anywhere in the image. Tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "travel",
    label: "🌅 Закат на Санторини",
    category: "photo",
    prompt:
      "Place the person in a breathtaking golden-hour travel scene on a Santorini rooftop at sunset: warm rim " +
      `light, an editorial travel-magazine look, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "cinematic",
    label: "🎥 Кино-портрет",
    category: "photo",
    aspect: "3:4",
    // The old prompt asked for a GRADE and a LENS — "35mm anamorphic, dramatic
    // side lighting, teal-and-amber" — and gave the model no film to be a still
    // FROM: no place, no moment, no wardrobe, no blocking. So it did the only
    // thing available and pushed colour onto the photo it already had. In the
    // 4-subject grid this was the one preset that changed nothing on any of
    // them; it read as a filter, because that is all it asked for.
    //
    // What makes a frame read as cinema is not the grade. It is DEPTH (lights
    // receding behind the subject), an INTERRUPTED MOMENT (a still is always
    // cut out of a movement), MOTIVATED LIGHT (from a named thing in the scene,
    // not from nowhere), and COSTUME that implies a story. Those are what this
    // now asks for; the grade follows from the scene instead of replacing it.
    //
    // Genre is a choose-ONE menu for the same reason as the fashion look: a
    // stacked list averages into the same murky frame every time. And it
    // branches by subject, because neo-noir is wrong for a child and a family
    // photo is not a lone-figure-in-the-rain shot — the earlier failure of
    // giving every subject one vocabulary is exactly what that produced.
    prompt:
      "Restage the person — or ALL the people, if the photo shows more than one — inside a single frame from a " +
      "film, as if the camera were rolling and this frame was cut out of a moving scene. Not a colour filter on " +
      "the existing photo: build the SHOT.\n" +
      "FIRST read who is in the photo and choose the register that suits them — an ADULT drama, or, if the " +
      "subject is a CHILD, a warm family-film register with no danger, no smoking, no bars or nightlife. A pair " +
      "or a group is staged together as one scene, each person given something to be doing.\n" +
      "GENRE — choose ONE and commit completely. NEO-NOIR: a wet night street, neon signage bleeding across the " +
      "puddles, the subject in a dark coat with the collar up, caught mid-turn. WARM DRAMA: a lived-in kitchen or " +
      "a train compartment at dusk, low sun through a window, a quiet look away from the camera. PERIOD: a hotel " +
      "lobby or a station platform, tailored wool, luggage in the frame, someone about to leave. SCI-FI: a " +
      "corridor of cold practical lights, a technical jacket, a face lit by a screen just out of frame. " +
      "FAMILY-FILM (for a child or a family): a summer field at golden hour or a bright cluttered living room, " +
      "mid-laugh, mid-run.\n" +
      "DEPTH is mandatory: put light sources BEHIND the subject that recede into the distance and fall out of " +
      "focus — street lamps, windows, signage, headlights. A flat backdrop reads as a portrait, never as a film.\n" +
      "MOMENT, not a pose: the subject is interrupted — turning, rising, pausing in a doorway, listening to " +
      "someone outside the frame. Eyes need not meet the camera.\n" +
      "BLOCKING: place them off-centre with room to look into, and let one soft out-of-focus element cross the " +
      "foreground — a shoulder, a railing, rain, glass.\n" +
      "LIGHT must be MOTIVATED — it comes from something visible in the scene, and its colour follows that " +
      "source. Skin stays natural; the grade comes from the location's own light, not from a preset wash. " +
      `Anamorphic 35mm frame, shallow depth of field, fine film grain, tack-sharp face. ${KEEP_ID}`,
  },
  // Curated one-tap looks for the prompt library: high-recurrence, single-photo,
  // identity-locked scenarios from a market that already pays for them (product +
  // fashion). Provenance and how to expand the set: docs/prompt-library.md.
  {
    id: "candid_lux",
    label: "🚗 Lux-селфи в авто",
    category: "photo",
    prompt:
      "Restyle into an ultra-realistic luxury-fashion candid selfie taken inside a car, shot handheld from a slightly " +
      "low side angle for a living-moment feel. Voluminous loose hair with natural texture, an expensive restrained " +
      "look — a structured jacket with clean shoulders over a soft top, narrow dark sunglasses, thin jewellery, warm " +
      `daylight through the window, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "bento_birthday",
    label: "🎂 Бенто-торт с детским фото",
    category: "photo",
    // The whole look hangs on "HAPPY BIRTHDAY" being READABLE on the cake, so
    // it pins the typography engine per the rule above — Seedream garbles text,
    // and garbled icing is the one thing that kills this trend.
    //
    // Two separate likenesses of the SAME person share the frame, which is the
    // hard part: an adult standing behind the cake, and a small printed photo
    // cutout of them as a CHILD standing up out of the icing. The prompt has to
    // keep them apart in three ways — the cutout is named as flat printed paper
    // rather than a person, its scale is pinned to the cake, and the adult is
    // stated to stay an adult. Without that separation the model either de-ages
    // the real subject or renders an actual child as a second guest.
    //
    // NO_CLONES is deliberately NOT used here: it forbids the same face twice,
    // which is exactly what this composition requires.
    model: "premium_edit",
    aspect: "3:4",
    prompt:
      "A warm night-time birthday moment, shot as a candid phone photo at a party. THE PERSON FROM THE PHOTO, " +
      // "as an ADULT with their real grown-up face" aged up every child who
      // used this look — it told the model to replace the hero rather than
      // celebrate them. The birthday person is whoever is in the photo, at the
      // age they are in it; only the paper cutout is younger, and it is a
      // PROP, so it must be described as one and never as the subject.
      "AT THEIR OWN AGE exactly as in the source photo — if the photo is of a child, the birthday person is that " +
      "child and must NOT be aged up; if of an adult, they stay an adult — " +
      "stands behind a small round minimalist bento cake, lit almost " +
      "entirely by its candle flame. They wear a striped cone party hat with a paper pom-pom on top, elastic " +
      "under the chin, and they are laughing or grinning, caught mid-moment as friends sing to them; a couple of " +
      "out-of-focus hands and faces of friends edge into the frame in the dark.\n" +
      "THE CAKE — a small cream-white bento cake on a white board, matte buttercream, with the words " +
      "\"HAPPY BIRTHDAY\" hand-piped across the side in slightly wobbly BLACK icing letters, two lines: " +
      "\"HAPPY\" above and \"BIRTHDAY\" below. Exactly one slim lit candle. The icing text must be clean, " +
      "correctly spelled and fully readable.\n" +
      "THE CAKE TOPPER — standing upright out of the top of the cake is a FLAT PRINTED PHOTO CUTOUT on paper, " +
      "roughly the height of the cake itself: a vintage baby-or-toddler portrait of THAT SAME PERSON at a much " +
      "YOUNGER age than they are in the source photo — this cutout is a PROP on the cake, never the birthday " +
      "person themselves, " +
      "same features, same eyes, in an old-fashioned little suit, with a tiny red-and-white striped paper party " +
      "hat sitting on the cutout's head. It is a piece of printed card stuck into the icing, with a visible cut " +
      "paper edge — not a real child and not a second guest at the party.\n" +
      "LIGHT AND MOOD — dark room, the candle as the only real light source, warm orange glow on the faces from " +
      "below, deep shadows behind, slight handheld blur and phone-camera grain, genuine joyful atmosphere. " +
      `Shot at eye level. ${KEEP_ID}`,
  },
  {
    id: "paris_rain",
    label: "🗼 Париж под дождём",
    category: "photo",
    prompt:
      "Place the person in a cinematic quiet-luxury lifestyle photo in Paris near the Eiffel Tower in soft rainy " +
      "weather: a long structured beige-brown coat with a clean silhouette, Parisian-chic styling, holding a light " +
      "umbrella and a coffee cup, wet asphalt with soft reflections, diffused overcast daylight, calm and elegant " +
      `mood, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "pixar_me",
    label: "🧸 Pixar мини-я",
    category: "photo",
    // Heavy 3D-toon stylization — Nano Banana Pro renders it far cleaner than Seedream.
    model: "nbpro_edit",
    prompt:
      "Create a Pixar-style 3D mini-version of the person standing next to their realistic self on a minimalist " +
      "light-gray studio background with soft shadows. One figure stays a realistic human, the other is a cute Pixar " +
      "mini-character with a large head and small body, standing in front and closer to the camera; the realistic " +
      `person rests a hand on the mini-character's head, both looking at the camera, playful modern aesthetic. ${KEEP_ID}`,
  },
  // Original, identity-locked looks written in NeuroShot's own voice, filling the
  // two highest-recurrence gaps the VeoSee research flagged (collectible figurine,
  // retro film) without copying competitor prompt text.
  {
    id: "figurine",
    label: "🧍 Коллекционная фигурка",
    category: "photo",
    // Blister-pack title header = on-image text — route to GPT Image 2 (Seedream garbles text).
    model: "premium_edit",
    prompt:
      "Turn the person into a highly detailed collectible action-figure version of themselves, posed inside clear " +
      "blister packaging on a printed cardboard backer with a title header and small accessory items, studio product " +
      `lighting, glossy plastic and vinyl textures, realistic toy proportions but a clearly recognizable face. ${KEEP_ID}`,
  },
  {
    id: "retro90s",
    label: "📼 Ретро-фотосессия",
    category: "photo",
    // The old version only regraded the image — faded colour, grain, light
    // leaks — and left the person's pose, clothes and expression exactly as
    // uploaded. That reads as "the photo, but yellower", not as a shoot.
    //
    // So the direction is explicit about the three things that actually make it
    // a photoshoot: a NEW pose, a CHANGED wardrobe, and a chosen expression.
    // The wardrobe is offered as a menu with "pick ONE that suits the person"
    // rather than a list, because stacking every item produces a polka-dot
    // dress and an oversize suit in the same frame — and because a look that
    // fits one person doesn't fit another. The user's own words (appended after
    // this prompt as "Extra details") are given final say, which is what makes
    // the result vary with the request instead of being one fixed costume.
    aspect: "3:4",
    prompt:
      "Restage EVERYONE in the photo as a full RETRO PHOTOSHOOT — not a filter on the original snapshot. Change " +
      "the poses, the wardrobe and the expressions; do not keep the pose from the source photo. If the photo " +
      "shows several people, style them ALL and pose them together as one group.\n" +
      "WARDROBE — choose ONE complete look per person that genuinely suits them, from a shared era so the " +
      "group reads as one shoot: a polka-dot " +
      "midi dress with a nipped waist; a silk headscarf tied under the chin with cat-eye sunglasses; a wide " +
      "oversized double-breasted suit with strong SQUARED structured shoulders (tailored and sharp, never gathered or puffed) and pleated trousers; a knitted vintage cardigan " +
      "over a collared shirt; a tailored trench with leather gloves and a wide-brimmed hat. Add period " +
      "headwear where it fits the look — a headscarf, beret, fedora or pillbox hat.\n" +
      "SETTING — a vintage street scene with a polished chrome-heavy retro car in frame: leaning back against " +
      "the door, seated on the bonnet, or half-out of the driver's window, with period shopfronts and signage " +
      "softly out of focus behind.\n" +
      "POSE AND EMOTION — pick one per person and play it fully: a confident hand-on-hip stance with a direct " +
      "look; a caught-mid-laugh moment with the head tilted back; a wistful glance away over the shoulder; a " +
      "hand adjusting the hat or sunglasses. Every face must be alive and acting, not a neutral passport " +
      "expression.\n" +
      "FINISH — warm slightly-faded film colour, soft grain, gentle on-camera flash, subtle light leaks, " +
      "true-to-film skin tones, medium shot on a 35mm lens. If the user asked for a specific outfit, era, car " +
      `or mood below, THAT overrides these choices. Tack-sharp face. ${KEEP_ID}`,
  },
  // More curated one-tap looks adapted from the VeoSee prompt-library research
  // (docs/prompt-library.md): rewritten in NeuroShot's voice, identity-locked,
  // brand/aspect stripped. Mix of aspirational editorial + viral shareables.
  {
    id: "cafe_night",
    label: "🌃 Кафе ночью",
    category: "photo",
    prompt:
      "Place the person in a cinematic cozy outdoor café at night: seated in a woven rattan chair looking up at the " +
      "camera, warm luxury atmosphere, glowing skin, minimal dewy makeup, soft ambient light with gentle bokeh, an " +
      `editorial magazine look, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "yacht_lux",
    label: "🛥 Яхта-люкс",
    category: "photo",
    prompt:
      "Place the person in an ultra-realistic luxury yacht editorial, waist-up crop, dramatic top-down camera angle " +
      "over the stainless-steel railing toward the sea, confident posture and gaze, bright daylight on open water, " +
      `aspirational fashion-magazine mood, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "photobooth_bw",
    label: "🖤 Фотобудка Ч/Б",
    category: "photo",
    // Noir and "cozy" pull in opposite directions, so they are assigned to
    // DIFFERENT things rather than averaged into flat grey: noir is the grade
    // INSIDE the frames (hard chiaroscuro, deep blacks), cozy is the physical
    // print — a real strip lying tilted on a warm surface. Asking one image to
    // be both moody and warm at once is what produced the flat studio look.
    // The strip is pinned to THREE frames and the sunglasses to the MIDDLE one,
    // because "one of them" left the model free to put shades on all three.
    aspect: "3:4",
    prompt:
      "Restyle into a vintage black-and-white photobooth strip — one single VERTICAL strip of exactly THREE " +
      "stacked square frames (not a grid, not four), thin white borders between them. EVERY person from the source " +
      "photo appears in EVERY one of the three frames, squeezed into the booth together — if the photo shows a " +
      "couple or a group, all of them are in each frame. Behind them hangs a heavy pleated curtain backdrop, " +
      "its folds catching the light. TOP frame: warm natural half-smiles toward the lens. MIDDLE frame: the " +
      "same people wearing retro 70s sunglasses, chins lifted, playful. BOTTOM frame: a quiet three-quarter " +
      "turn, eyes down. The hair is smooth, sleek and softly " +
      "styled — controlled, close to the head, NOT frizzy, NOT puffed out, no flyaways. Hard noir lighting: a " +
      "single low key light raking across the face so bright speculars catch the cheekbones, brow and bridge of " +
      "the nose, deep black shadows on the opposite side, strong chiaroscuro contrast, rich blacks, glowing " +
      "highlights, fine silver film grain. The three photographs are COMPLETELY BLACK AND WHITE — fully " +
      "desaturated, no colour anywhere inside the frames and no selective-colour accents: clothing, tie and " +
      "background are all pure greyscale. Only the table and lamplight AROUND the printed strip carry warm " +
      "colour. The finished paper strip lies at a gentle diagonal TILT on a warm " +
      "wooden table beside a coffee cup, soft lamplight and a shallow depth of field around it — a cosy, " +
      `lived-in keepsake photographed from above. Tack-sharp face in every frame. ${KEEP_ID}`,
  },
  {
    id: "paper_doll",
    label: "✂️ Бумажная кукла",
    category: "photo",
    prompt:
      "Turn the person into a realistic paper-doll cutout: keep the original face, hairstyle, outfit and pose, add a " +
      "thick white paper outline around the whole figure with small folded paper tabs at the edges, a vintage " +
      `scrapbook collage aesthetic, photorealistic, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "low_battery",
    label: "🔋 На 1% зарядки",
    category: "photo",
    prompt:
      "Turn the person into a funny 'low battery' portrait: a big-head small-body style with a highly recognizable " +
      "face, a sleepy drained low-energy expression with heavy eyelids and slumped posture, a small red 1% battery " +
      `icon above the head and a charging cable nearby, a clean playful background, tack-sharp face. ${KEEP_ID}`,
  },
  // Third curation batch, adapted from the VeoSee prompt-library research
  // (docs/prompt-library.md): rewritten in NeuroShot's voice, identity-locked,
  // brand/aspect stripped. Mix of billionaire-lifestyle aspirational editorial
  // and viral shareables (pet cameo, chibi squad, sketchbook doodle). Each is
  // pinned to the SAME engine VeoSee's own tutorial used for that recipe —
  // that's the model the result was authored/tested against, so matching it
  // keeps the quality and composition the source actually demonstrated.
  {
    id: "billionaire_heli",
    label: "🚁 Миллиардер-лайфстайл",
    category: "photo",
    // VeoSee's recipe was shot on Nano Banana 2 — match its engine.
    model: "nb2_edit",
    prompt:
      "Place the person in an ultra-realistic billionaire-lifestyle editorial exiting a glossy black helicopter on a " +
      "private rooftop helipad: a confident dominant pose with wind-blown hair, an expensive quiet-luxury linen suit, " +
      `bright daylight with a city skyline and distant mountains behind, glossy campaign mood, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "alpine_lux",
    label: "🏔 Альпийский люкс",
    category: "photo",
    // VeoSee's recipe was shot on Nano Banana Pro — match its engine.
    model: "nbpro_edit",
    prompt:
      "Place the person in an ultra-realistic alpine-luxury editorial, lying relaxed in a dry mountain meadow among " +
      "tall grass with snow-capped peaks and a deep cobalt sky behind, a beige trench jacket and lace top with loose " +
      `sunlit hair, quiet-luxury Swiss-vacation styling, warm cinematic color grading, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "kitten_editorial",
    label: "🐱 Съёмка с котятами",
    category: "photo",
    // VeoSee's recipe was shot on Nano Banana 2 — match its engine.
    model: "nb2_edit",
    prompt:
      "Place the person in a minimalist luxury fashion editorial seated cross-legged on a soft beige-grey studio " +
      "background, several small kittens playfully interacting on their shoulders, arms and around them, relaxed " +
      `premium styling with soft diffused studio lighting and warm cinematic grading, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "mini_squad",
    label: "👥 Мини-я команда",
    category: "photo",
    // VeoSee's recipe was shot on Nano Banana 2 — match its engine.
    model: "nb2_edit",
    prompt:
      "Surround the person with several small chibi-style mini versions of themselves — big heads, expressive faces " +
      "— each doing a different playful activity: one sitting on their head, one cheering with arms raised, one " +
      "lifting a dumbbell, one drinking from a shaker bottle, one lying down on a phone, one climbing up their leg, " +
      `a clean playful background, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "sketch_journal",
    label: "✏️ Скетчбук",
    category: "photo",
    // VeoSee's recipe was shot on Nano Banana Pro — match its engine.
    model: "nbpro_edit",
    prompt:
      "Turn the photo into a hand-drawn sketchbook illustration on lined notepad paper: detailed colored-pencil and " +
      "ink linework with cross-hatching and shading, playful comic-style doodles and notes scattered around the " +
      "character (arrows, 'WOW', 'COOL!'), a warm-toned designer-sketchbook aesthetic, keeping the same pose and " +
      `full-body proportions as the original photo, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "product_hero",
    label: "🛍 Продающая карточка",
    category: "product",
    // Marketplace card keeps packaging labels/branding crisp — GPT Image 2 holds text.
    model: "premium_edit",
    prompt:
      "Turn this into a premium e-commerce hero shot: the product on a clean seamless studio background with soft " +
      "shadows, professional three-point lighting, subtle reflection, marketplace-listing composition, 4k quality. " +
      "Keep the product's shape, colors and branding exactly as in the photo.",
  },
  // --- Marketplace-spec cards (the growth plan's killer feature): one tap →
  // an upload-READY listing card at the real marketplace spec — 3:4 portrait
  // (900×1200 class), correct background per category (white for general goods,
  // #f2f3f5 light-gray for apparel). Spec grounded in docs/growth-campaign-2026-07.md.
  // Cheap Seedream (2 🔫) on purpose: this is the first-session hook for sellers.
  {
    id: "kaspi_card",
    label: "🛒 Карточка Kaspi/WB",
    category: "product",
    aspect: "3:4",
    prompt:
      "Create a marketplace product listing card: cut out the product and place it on a pure seamless white " +
      "studio background (#FFFFFF), vertical 3:4 portrait composition sized like a 900x1200 marketplace card, " +
      "product centered and filling about 85% of the frame, soft natural shadow underneath, even professional " +
      "e-commerce lighting, crisp focus, 4k quality. Keep the product's shape, colors, labels and branding " +
      "exactly as in the photo — one single instance of the product.",
  },
  {
    id: "wb_apparel_card",
    label: "👕 Карточка одежды (WB)",
    category: "product",
    aspect: "3:4",
    prompt:
      "Create an apparel marketplace listing card: place the clothing item on a seamless light-gray studio " +
      "background (#f2f3f5), vertical 3:4 portrait composition sized like a 900x1200 marketplace card, garment " +
      "neatly presented and centered filling most of the frame, soft even studio lighting with a subtle floor " +
      "shadow, fabric texture crisp and true to life, 4k quality. Keep the garment's cut, colors, patterns, " +
      "prints and brand tags exactly as in the photo — one single instance of the garment.",
  },
  {
    id: "product_white",
    label: "⬜️ Белый фон (маркетплейс)",
    category: "product",
    // Highest-volume, most utilitarian op: a mechanical cutout that PRESERVES the
    // existing label (no new text generated) — Seedream handles it, kept cheap.
    prompt:
      "Cut out the product and place it on a pure seamless white studio background (#FFFFFF) with a soft natural " +
      "shadow underneath, centered marketplace-listing composition, even professional lighting, 4k quality. " +
      "Keep the product's shape, colors and branding exactly as in the photo.",
  },
  {
    id: "product_lifestyle",
    label: "🌿 Lifestyle-сцена",
    category: "product",
    prompt:
      "Place the product into a premium lifestyle scene that matches its category: natural materials, soft daylight, " +
      "shallow depth of field, aspirational magazine look, 4k quality. Keep the product's shape, colors and branding " +
      "exactly as in the photo.",
  },
  {
    id: "product_editorial",
    label: "🧴 Люкс-эдиториал",
    category: "product",
    // Editorial packshot keeps label text crisp — GPT Image 2 holds on-image text.
    model: "premium_edit",
    prompt:
      "Turn this into a luxurious editorial product packshot: the item resting in dense plush faux fur in warm golden " +
      "caramel and honey tones, a soft close-up still-life composition, glossy highlights, magazine-quality finish. " +
      "Keep the product's shape, colors, label text and branding exactly as in the photo.",
  },
  {
    id: "product_drama",
    label: "💧 Драма-съёмка",
    category: "product",
    // Cinematic packshot with label typography — GPT Image 2 keeps text legible.
    model: "premium_edit",
    prompt:
      "Turn this into dramatic low-angle cinematic product photography: the item on the sharp edge of a transparent " +
      "glass podium shot from below, clear water elegantly dripping down the sides, a deep gradient background, strong " +
      "highlights and deep shadows for a luxurious sensual mood, highly detailed. Keep the product's shape, colors, " +
      "label text and branding exactly as in the photo.",
  },
  {
    id: "product_jewelry",
    label: "💎 Ювелирная съёмка",
    category: "product",
    // VeoSee's recipe was shot on Nano Banana 2 — match its engine.
    model: "nb2_edit",
    prompt:
      "Turn this into a luxury jewelry product shot: the piece centered on polished black stone in a dark premium " +
      "studio, a soft champagne key light with a thin rim light, deep shadows, controlled sparkle and expensive " +
      "reflections on the metal and stones, museum-quality high-jewelry campaign look, 4k quality. Keep the " +
      "product's shape, colors and branding exactly as in the photo.",
  },
  {
    id: "product_action",
    label: "💥 Экшн-съёмка",
    category: "product",
    // VeoSee's recipe was shot on GPT Image 2 — match its engine.
    model: "premium_edit",
    prompt:
      "Turn this into a dynamic cinematic product advertisement: the product dominant and off-center in a low " +
      "macro-angle, a dramatic action moment frozen in time with water splashes, sparks or drifting dust particles " +
      "matching the product's category, strong key and rim lighting with deep contrast and glowing highlights, " +
      "high-end global-campaign quality, 4k quality. Keep the product's shape, colors and branding exactly as in " +
      "the photo.",
  },
];

/**
 * Marketing campaigns: seasonal/viral one-click scenarios (docs/course-funnel.md).
 * Each campaign = a photo in → one-tap premium image (PRESET_MODEL), then an
 * optional one-tap «Оживить» upsell that animates the GENERATED image (kling).
 * Zero prompting for the user — presets carry curated prompts.
 *
 * ⚠️ The cartoon campaign references well-known characters at the user's
 * request (personal, non-commercial family images). Providers may filter some
 * names; if a render is refused it fails-and-refunds automatically.
 */
export interface CampaignPreset {
  id: string;
  label: string;
  prompt: string;
  /**
   * Optional curated STYLE reference — a filename under public/img, resolved to
   * an absolute URL by styleRefUrl() and appended after the user's photo in
   * image_urls. Use it when a look is easier to SHOW the model than to describe
   * (a specific grade, material or lighting). Two hard rules: the art must be
   * ours, and it must contain no usable face — a reference with a face invites
   * the model to blend identities, which is the one thing this product cannot
   * do. Applied only on the fal-verified edit models (see the params doc P7).
   */
  styleRef?: string;
  /**
   * Difficulty tier for video scenes only (unset ⇒ "simple"). "simple" motion
   * (one clean action) runs on the cheap Hailuo default; "epic" scenes with
   * physics / multiple actors / audio are gated to Seedance (EPIC_VIDEO) — the
   * composer swaps the model and reprices automatically. Image presets ignore it.
   */
  tier?: "simple" | "epic";
}

/** The video model a scene runs on: epic ⇒ Seedance, else the campaign default. */
export function sceneModel(scene: CampaignPreset, fallback: ModelSpec): ModelSpec {
  return scene.tier === "epic" ? EPIC_VIDEO : fallback;
}
/**
 * Story-builder quiz (web studio): quick picks that refine a campaign preset.
 * Each selected option's `fragment` is appended to the curated prompt
 * SERVER-SIDE (the client only sends option ids), so prompts stay curated.
 */
export interface QuizOption {
  id: string;
  label: string; // RU chip shown to the user
  fragment: string; // EN sentence appended to the prompt
}
export interface QuizStep {
  id: string;
  question: string;
  options: QuizOption[];
}

export interface Campaign {
  id: string;
  label: string; // menu button
  header: string; // shown above the preset keyboard
  ask: string; // what photo to send
  presets: CampaignPreset[];
  /** One-tap video upsell on the generated image. */
  animateLabel: string;
  animatePrompt: string;
  /** Video model for the upsell: Kling 3.0 by default; Seedance for story flows. */
  animateModel: ModelSpec;
  /** Optional story-builder steps (web studio) — see QuizStep. */
  quiz?: QuizStep[];
  /**
   * On-theme viral video scenes for the composer: one-tap trendy motion ideas
   * specific to THIS scenario (football → score a goal / cheer in the stands /
   * lift the trophy). Selecting one sets the base motion; the story quiz +
   * personalization still layer on top. Curated (crafted), so they skip mapping.
   */
  videoScenes?: CampaignPreset[];
}

export const CAMPAIGNS: Campaign[] = [
  {
    id: "skazka",
    label: "📖 Сказка с вашим ребёнком",
    header: "Выберите сказку — один тап, без промптов:",
    ask: "Пришлите фото ребёнка 👶 — и он станет героем собственной сказки.",
    presets: [
      {
        id: "forest",
        label: "🌲 Волшебный лес",
        prompt:
          "Place the child as the hero of a fairy tale in an enchanted glowing forest at golden hour: drifting " +
          "fireflies, soft god-rays through the trees, wonder on their face, storybook-cinematic detail. " +
          `${KEEP_KID}`,
      },
      {
        id: "dragon",
        label: "🐉 Дракон и герой",
        prompt:
          "Make the child a brave storybook knight standing beside one friendly majestic dragon, an epic castle " +
          `behind them in warm sunset light, heroic fairy-tale mood, cinematic detail. ${KEEP_KID}`,
      },
      {
        id: "royal",
        label: "👑 Королевство",
        prompt:
          "Dress the child in royal fairy-tale attire in a grand candle-lit castle ballroom: a delicate crown, " +
          `an elegant costume, sparkling chandeliers, warm magical glow, storybook grandeur. ${KEEP_KID}`,
      },
    ],
    animateLabel: "🎬 Оживить сказку",
    // One-shot, motion-first: camera as narrator + a single wonder beat.
    animatePrompt:
      "Slow cinematic push-in as fireflies drift past and warm light blooms; a light breeze lifts the child's hair " +
      "and clothing and they break into a wonder-struck smile — one calm magical beat, storybook atmosphere.",
    animateModel: MODELS.hailuo_fast,
    videoScenes: [
      {
        id: "flydragon",
        label: "🐉 Полёт на драконе",
        tier: "epic",
        prompt:
          "The camera sweeps alongside as the child soars on the friendly dragon's back, wind rushing through their " +
          "hair, glowing clouds and trailing sparkles streaming past, pure joy on their face — one continuous " +
          "heroic flight, cinematic slow motion.",
      },
      {
        id: "castspell",
        label: "🪄 Волшебное заклинание",
        prompt:
          "Slow push-in as the child lifts a glowing wand and casts a shimmering spell — sparks swirl upward into " +
          "ribbons of light, eyes widening with wonder, enchanted particles filling the air — one magical beat.",
      },
      {
        id: "portal",
        label: "✨ Портал в сказку",
        prompt:
          "The camera holds as the child steps through a blooming magical portal, radiant light washing over their " +
          "awe-struck face, sparks spiralling around them — one dreamy reveal into the fairy-tale world.",
      },
    ],
    quiz: [
      {
        id: "hero",
        question: "Кто ваш герой?",
        options: [
          { id: "knight", label: "⚔️ Рыцарь", fragment: "Dress the child as a brave young knight in shining storybook armor." },
          { id: "princess", label: "👸 Принцесса", fragment: "Dress the child as a graceful fairy-tale princess in a flowing gown." },
          { id: "wizard", label: "🪄 Волшебник", fragment: "Dress the child as a young wizard with a glowing magic staff." },
          { id: "self", label: "🙂 Как есть", fragment: "Keep the child's own clothing exactly as in the photo." },
        ],
      },
      {
        id: "friend",
        question: "Кто рядом?",
        options: [
          { id: "dragon", label: "🐉 Дракончик", fragment: "Add exactly one friendly small baby dragon companion beside the child." },
          { id: "unicorn", label: "🦄 Единорог", fragment: "Add exactly one gentle white unicorn standing beside the child." },
          { id: "fox", label: "🦊 Лисёнок", fragment: "Add exactly one clever magical fox companion beside the child." },
          { id: "solo", label: "🌟 Без спутников", fragment: "The child is the sole hero of the scene — no companions." },
        ],
      },
      {
        id: "mood",
        question: "Какой финал?",
        options: [
          { id: "bright", label: "☀️ Светлый", fragment: "Bright joyful golden light — a triumphant happy ending." },
          { id: "mystic", label: "🌙 Таинственный", fragment: "Mysterious twilight with fireflies and soft mist." },
          { id: "epic", label: "⚡ Эпичный", fragment: "Epic dramatic skies with god rays — a heroic climax." },
        ],
      },
    ],
  },
  {
    id: "cartoon",
    label: "🦸 Ребёнок и любимый герой",
    header: "С кем встречаемся? Один тап:",
    ask: "Пришлите фото ребёнка 👶 — и он встретится с любимым героем мультика.",
    presets: [
      {
        id: "sponge",
        label: "🧽 Губка Боб",
        prompt:
          "Place the child laughing beside SpongeBob SquarePants in colorful underwater Bikini Bottom, the cartoon " +
          `world blended photorealistically around them, bright joyful scene. ${KID_FOCUS} ${KEEP_KID}`,
      },
      {
        id: "gumball",
        label: "😺 Гамбол",
        prompt:
          "Place the child beside Gumball Watterson in the town of Elmore, playful mixed cartoon-and-photo style, " +
          `bright cheerful colors, both laughing together. ${KID_FOCUS} ${KEEP_KID}`,
      },
      {
        id: "trikota",
        label: "🐱 Три кота",
        prompt:
          "Place the child with the three cheerful kittens of «Три кота» (Kid-E-Cats) in their cozy cartoon town, " +
          "warm family atmosphere, bright friendly colors. Keep the real child as the clear hero — foreground, " +
          `centered, face sharp and well lit — with each kitten shown once beside and behind them. ${KEEP_KID}`,
      },
      {
        id: "dbillions",
        label: "🎵 D Billions",
        prompt:
          "Place the child dancing with the colorful D Billions characters on a bright festive stage, confetti, " +
          "joyful kids-show energy, vivid colors. Keep the real child as the clear hero — foreground, centered, " +
          `face sharp and well lit — with each character shown once around and behind them. ${KEEP_KID}`,
      },
      {
        id: "shark",
        label: "🦈 Baby Shark",
        prompt:
          "Place the child in a cheerful underwater scene swimming beside Baby Shark, bubbles and sunbeams through " +
          `the water, bright preschool-cartoon joy blended around the real child. ${KID_FOCUS} ${KEEP_KID}`,
      },
    ],
    animateLabel: "🎬 Оживить встречу",
    animatePrompt:
      "The cartoon character waves and bounces playfully while the child laughs and claps; confetti or bubbles " +
      "drift through the frame, gentle camera push-in — one lively, joyful kids-show beat.",
    animateModel: MODELS.hailuo_fast,
    videoScenes: [
      {
        id: "dance",
        label: "💃 Танцуют вместе",
        prompt:
          "The child and the cartoon character dance together in sync, both laughing, bright confetti bursting " +
          "around them — one bouncy, joyful viral kids-dance beat, lively motion.",
      },
      {
        id: "adventure",
        label: "🚀 Весёлое приключение",
        prompt:
          "The camera tracks alongside as the child and the cartoon character dash off on an adventure, laughing " +
          "and high-fiving, the bright cartoon world rushing past — one energetic, playful beat.",
      },
      {
        id: "fly",
        label: "🦸 Полёт супергероев",
        tier: "epic",
        prompt:
          "The camera rises with them as the child and the cartoon character soar through a bright sky as little " +
          "superheroes, capes fluttering, huge happy smiles — one heroic, joyful flight.",
      },
    ],
  },
  {
    id: "worldcup",
    label: "⚽️ Матч мечты",
    header: "С кем выходим на поле? Один тап:",
    ask: "Пришлите своё фото ⚽️ — и окажитесь на поле финала с кумиром.",
    presets: [
      {
        id: "messi",
        label: "🇦🇷 С Месси",
        prompt:
          "Put the person on the pitch of a floodlit World Cup final at night, shoulder to shoulder with Lionel " +
          `Messi, both in football kits, confetti falling, a roaring crowd behind, sports-photography realism. ${NO_CLONES} ${KEEP_ID}`,
      },
      {
        id: "ronaldo",
        label: "🇵🇹 С Роналду",
        prompt:
          "Put the person on the pitch of a floodlit World Cup final at night, celebrating side by side with " +
          `Cristiano Ronaldo, both in football kits, dramatic stadium light, sports-photography realism. ${NO_CLONES} ${KEEP_ID}`,
      },
      {
        id: "yamal",
        label: "🇪🇸 С Ямалем",
        prompt:
          "Put the person on the pitch of a packed World Cup final celebrating beside Lamine Yamal, both in " +
          `football kits, golden confetti falling, electric atmosphere, sports-photography realism. ${NO_CLONES} ${KEEP_ID}`,
      },
      {
        id: "kit",
        label: "🏟 Я в форме сборной",
        prompt:
          "Turn the person into a professional footballer celebrating a goal in a packed World Cup stadium: " +
          `national-team kit, roaring crowd, floodlights, confetti, epic sports-photography shot. ${KEEP_ID}`,
      },
    ],
    animateLabel: "🎬 Оживить момент",
    animatePrompt:
      "Slow heroic camera orbit around the pair as the floodlit crowd roars and waves flags, confetti drifting " +
      "down, lens flares catching the light — one triumphant stadium beat.",
    animateModel: MODELS.hailuo_fast,
    videoScenes: [
      {
        id: "score",
        label: "⚽️ Легендарный гол",
        tier: "epic",
        prompt:
          "In one continuous broadcast shot the person latches onto a through-ball and fires it into the net — the " +
          "net ripples, the packed stadium erupts, teammates rush in to celebrate — cinematic slow-motion.",
      },
      {
        id: "fan",
        label: "📣 Фанат на трибуне",
        prompt:
          "The person leaps and chants in the packed stands, team scarf raised high, flares and confetti smoking " +
          "around them, a roaring sea of supporters behind — one electric fan-cam beat.",
      },
      {
        id: "trophy",
        label: "🏆 Победа с командой",
        tier: "epic",
        prompt:
          "The person lifts the championship trophy overhead beside the superstar as golden confetti rains down and " +
          "teammates leap in to celebrate — one triumphant slow-motion beat.",
      },
      {
        id: "freekick",
        label: "🎯 Гол со штрафного",
        tier: "epic",
        prompt:
          "The person strikes a dramatic free kick that curls over the wall into the top corner; the keeper dives " +
          "too late, the crowd explodes, arms flying up in triumph — one epic slow-motion beat.",
      },
    ],
  },
  {
    id: "oldphoto",
    label: "🕰 Оживить старое фото",
    header: "Что делаем со снимком? Один тап:",
    ask: "Пришлите старую фотографию 🕰 (можно скан или фото снимка) — вернём её к жизни.",
    presets: [
      {
        id: "restore",
        label: "✨ Реставрация",
        prompt:
          "Restore this old photograph: remove scratches, dust, creases and noise, repair damaged areas, fix fading, " +
          "enhance sharpness and fine detail, natural tones, keep the authentic vintage character and composition. " +
          "Preserve every person's identity and facial features exactly.",
      },
      {
        id: "color",
        label: "🎨 Реставрация + цвет",
        prompt:
          "Restore and colorize this old photograph: remove scratches, dust and damage, then add natural realistic " +
          "colors true to the era — accurate skin tones, period-correct clothing colors, keep the authentic vintage " +
          "composition. Preserve every person's identity and facial features exactly.",
      },
    ],
    animateLabel: "🎬 Оживить (как живые)",
    animatePrompt:
      "Subtle, respectful living-memory motion: the people gently blink, breathe and let a soft smile form, a " +
      "slight natural head turn, a gentle shift of warm light — one tender, lifelike beat.",
    animateModel: MODELS.hailuo_fast,
    videoScenes: [
      {
        id: "alive",
        label: "🤍 Оживают нежно",
        prompt:
          "The people gently come to life — they blink, breathe, let a soft smile form and glance warmly at each " +
          "other — one tender living-memory beat, respectful natural motion, soft nostalgic light.",
      },
      {
        id: "wave",
        label: "👋 Улыбается и машет",
        prompt:
          "The person warmly smiles and raises a hand to wave at the viewer, eyes lighting up — one heartfelt " +
          "living-memory beat, gentle natural motion.",
      },
      {
        id: "together",
        label: "🫂 Семья вместе",
        prompt:
          "The family turns to each other with warm smiles and settles into a gentle embrace — one touching " +
          "nostalgic beat brought to life, soft natural movement and light.",
      },
    ],
  },
  {
    id: "poster",
    label: "🎬 Постер с тобой",
    header: "Жанр вашего фильма? Один тап:",
    ask: "Пришлите своё фото 🎬 — и станьте звездой кинопостера.",
    presets: [
      {
        id: "action",
        label: "💥 Боевик",
        prompt:
          "Turn the person into the star of a blockbuster action movie poster: a commanding hero pose, explosions " +
          "and a city skyline behind, high-contrast cinematic grade, dramatic one-sheet composition with clean " +
          `negative space at the top for a title. ${KEEP_ID}`,
      },
      {
        id: "romance",
        label: "❤️ Мелодрама",
        prompt:
          "Turn the person into the lead of a romantic-drama movie poster: soft golden-hour light, gentle wind, " +
          "emotional cinematic atmosphere, elegant one-sheet composition with clean negative space for a title. " +
          `${KEEP_ID}`,
      },
      {
        id: "scifi",
        label: "🚀 Фантастика",
        prompt:
          "Turn the person into the hero of an epic sci-fi movie poster: a sleek futuristic suit, a neon-lit alien " +
          "world with starships above, cinematic one-sheet composition with clean negative space for a title. " +
          `${KEEP_ID}`,
      },
    ],
    animateLabel: "🎬 Оживить постер",
    animatePrompt:
      "The poster comes alive: slow parallax depth as drifting smoke and light flares cross the frame, hair and " +
      "clothing stirring in the wind, the hero's gaze locking to camera — one dramatic trailer-style beat.",
    animateModel: MODELS.hailuo_fast,
    videoScenes: [
      {
        id: "explosion",
        label: "💥 Уход от взрыва",
        tier: "epic",
        prompt:
          "The person strides toward camera in slow motion as a huge explosion blooms behind them, sparks and " +
          "debris flying, unshaken action-hero energy — one cinematic blockbuster beat.",
      },
      {
        id: "turn",
        label: "🎬 Драматичный разворот",
        prompt:
          "Slow cinematic push-in as the person turns to camera with an intense, dramatic gaze, wind and " +
          "atmospheric haze swirling around them — one epic movie-trailer beat.",
      },
      {
        id: "heroic",
        label: "⚡ Геройский облёт",
        tier: "epic",
        prompt:
          "The camera orbits the person as they stand heroically, god-ray light and lens flares sweeping across " +
          "the frame — one climactic movie-trailer beat.",
      },
    ],
  },
  // Story flow: film-still image (mentor's scene formula: era/place → emotion →
  // rim light → 35mm framing → style tag) → Seedance multi-shot narrative clip.
  {
    id: "minifilm",
    label: "🎞 Мини-фильм с вами",
    header: "Выберите сцену вашего фильма — один тап:",
    ask: "Пришлите своё фото 🎞 — и станьте героем короткого фильма со звуком.",
    presets: [
      {
        id: "drama",
        label: "🌅 Тёплая драма",
        prompt:
          "Cinematic 3D-animation film still in a warm realistic style: golden morning light in a cozy family " +
          "kitchen, the person at the center of a quiet emotional moment, soft rim light, medium shot at eye " +
          `level with a 35mm lens, gently blurred background, sandy-honey palette, ultra high resolution. ${KEEP_ID}`,
      },
      {
        id: "retro",
        label: "📼 Ретро 90-х",
        prompt:
          "Cinematic film still set in the 1990s: nostalgic street scene with period-correct cars and signage, " +
          "warm faded film colors and grain, the person mid-story with an expressive look, medium shot, 35mm " +
          `lens, shallow depth of field, authentic retro atmosphere. ${KEEP_ID}`,
      },
      {
        id: "epic",
        label: "⚔️ Эпичное кино",
        prompt:
          "Epic cinematic film still: the person as the hero at a dramatic turning point, sweeping landscape " +
          "behind, atmospheric haze and god rays, IMAX-scale composition, low-angle medium shot, teal-and-gold " +
          `grade, ultra high resolution. ${KEEP_ID}`,
      },
    ],
    animateLabel: "🎞 Снять мини-фильм (со звуком)",
    animatePrompt:
      "Cinematic multi-shot narrative sequence with ambient sound: open on a slow establishing push-in, cut to a " +
      "medium shot as the subject turns and reacts with genuine emotion, finish on a close-up with a subtle " +
      "camera drift; natural motion, consistent identity and wardrobe across every shot, film-grade color, " +
      "ambient atmosphere audio matching the scene.",
    // Flagship Seedance 2.0 (audio + physics) — the mini-film's «со звуком»
    // promise runs on the real thing, not the mute economy Fast variant.
    animateModel: MODELS.seedance,
    quiz: [
      {
        id: "era",
        question: "Когда происходит действие?",
        options: [
          { id: "now", label: "🏙 Наши дни", fragment: "Set the scene in the present day." },
          { id: "retro", label: "📼 90-е", fragment: "Set the scene in the 1990s with period-correct details." },
          { id: "future", label: "🚀 Будущее", fragment: "Set the scene in a sleek near-future world." },
        ],
      },
      {
        id: "tone",
        question: "Тон фильма?",
        options: [
          { id: "warm", label: "🌅 Тёплый", fragment: "Warm heartfelt emotional tone." },
          { id: "noir", label: "🕶 Триллер", fragment: "Tense noir-thriller atmosphere with moody shadows." },
          { id: "fun", label: "😄 Комедия", fragment: "Light comedic tone with playful energy." },
        ],
      },
    ],
  },
  // Bronze-Age Homeric epic — our own trend drop, riding the fact that the myth
  // is culturally in the air right now. Built on the EPIC ITSELF (Homer, public
  // domain for ~2700 years), never on any studio's film, its title, or its cast:
  //   • the whole product promise is that the user keeps THEIR face (KEEP_ID) —
  //     rendering someone else's likeness would defeat the point, not serve it;
  //   • an unreleased film has no visual reference a model can reliably reach
  //     for, so "like the movie" yields mush while the real visual language
  //     (hammered bronze, Aegean light, torchlit megaron, IMAX framing) yields
  //     a shot every time.
  // Deliberately covers both a warrior and a queen/goddess route so the core
  // 25–34F segment gets a hero of their own, not a token option.
  {
    id: "odyssey",
    label: "🏛 Одиссея — вы в эпосе",
    header: "Кем вы будете в эпосе — один тап:",
    ask: "Пришлите своё фото 🏛 — и станьте героем «Одиссеи»: бронза, море, свет факелов.",
    presets: [
      {
        id: "king",
        label: "👑 Одиссей",
        // Our own cover plate — shot from behind, no usable face, so it can only
        // hand the model palette/light/materials, never an identity.
        styleRef: "card-odyssey.jpg",
        prompt:
          "Epic cinematic film still: the person as a Bronze Age Greek king-warrior on the deck of a wooden ship " +
          "at dawn — hammered bronze cuirass with a deep-red wool cloak, leather bracers, a weathered sword at " +
          "the hip, salt spray and rope rigging around them, the Aegean sea and distant islands behind, low-angle " +
          "medium shot, hard morning sun with deep shadow, teal-and-bronze grade, IMAX-scale composition, " +
          `photorealistic textures. ${KEEP_ID}`,
      },
      {
        id: "agamemnon",
        label: "🗡 Агамемнон — царь царей",
        // Its own plate, in a COLD blue-steel-and-gold key — the rest of the
        // campaign is warm amber/bronze, and Agamemnon is the one role that
        // should read as command rather than adventure. Shot from behind with
        // the head turned away: like every styleRef here, it carries palette,
        // metal and cloth, never a face.
        styleRef: "card-agamemnon.jpg",
        prompt:
          "Epic cinematic film still: the person as the high king and supreme commander of the Greek host, " +
          "standing on the stone steps of a torchlit citadel at dusk — polished STEEL-BLUE plate armour, " +
          "cold blue-grey metal with crisp warm gold edging and gold filigree; a heavy struck-gold coin " +
          "medallion at each shoulder; a tall steel-blue helmet with a sculpted mask-like faceplate — hinged " +
          "cheek guards and a nasal bar framing the face but leaving it fully visible — crowned with a tall " +
          "dark navy-black horsehair crest, and a column of articulated GOLD VERTEBRAE running down the back " +
          "of the helmet to the nape; a heavy dark cloak, leather pteruges, a sheathed sword at the hip; " +
          "ranks of spears and shields blurred in the haze behind. THE CAMERA IS LOW, on the steps below " +
          "him, looking UP so he towers over the frame — medium shot. Hard torch rim light rakes across " +
          "hammered, scratched, battle-worn metal; cold steel-blue and gold against warm flame, deep shadow. " +
          "The face is weathered and alive — set jaw, the weight of ten years of war in the eyes, real skin " +
          "with sweat, dust and stubble, not a smooth render. Shot on 85mm, shallow depth of field, " +
          `photorealistic — a photograph, never CGI or a 3D game model. ${KEEP_ID}`,
      },
      {
        id: "warrior",
        label: "⚔️ Воин Трои",
        styleRef: "card-odyssey.jpg",
        prompt:
          "Epic cinematic film still: the person as a battle-worn Bronze Age Greek warrior before the walls of a " +
          "besieged citadel — crested bronze helmet pushed back off the face, scarred bronze breastplate, round " +
          "shield and spear, dust and ash in the air, ranks of soldiers blurred behind, low-angle medium shot, " +
          `harsh side light through haze, muted bronze-and-ochre grade, photorealistic. ${KEEP_ID}`,
      },
      {
        id: "athena",
        label: "🦉 Афина — богиня войны",
        prompt:
          "Epic cinematic film still: the person as the grey-eyed goddess of war and wisdom — polished bronze " +
          "armour over a flowing chiton, a tall crested helmet held at the side, an owl perched nearby, standing " +
          "in a shaft of divine light on marble temple steps, wind moving fabric, medium shot at eye level, " +
          `cool silver-and-bronze grade, awe-struck scale, photorealistic. ${KEEP_ID}`,
      },
      {
        id: "penelope",
        label: "🕯 Пенелопа — царица Итаки",
        prompt:
          "Epic cinematic film still: the person as the queen of Ithaca in a torchlit stone megaron — a rich " +
          "draped robe with gold shoulder pins, a great loom half-woven beside them, hand resting on the thread, " +
          "quiet unbreakable resolve on the face, firelight flickering across stone columns, medium shot, warm " +
          `amber-and-shadow grade, painterly cinematic detail. ${KEEP_ID}`,
      },
      {
        id: "horse",
        label: "🐴 Ночь троянского коня",
        prompt:
          "Epic cinematic film still at night: the person in bronze armour standing before the enormous wooden " +
          "horse inside the citadel gates, torches guttering in the wind, smoke and embers drifting, the crowd a " +
          "dark silhouette behind, wide-to-medium shot from low angle, firelight rim on the armour against deep " +
          `blue night, ominous grandeur, photorealistic textures. ${KEEP_ID}`,
      },
    ],
    animateLabel: "🎬 Оживить эпос",
    // Default beat is deliberately cheap and simple — wind, cloak, one turn to
    // camera. The physics-heavy scenes below carry tier:"epic" and auto-upgrade.
    animatePrompt:
      "Wind drives the cloak and hair as the subject slowly turns to face the camera, chin lifting, eyes hard; " +
      "dust and sea spray drift through hard low sunlight, slow cinematic push-in — one steady, monumental beat.",
    animateModel: MODELS.hailuo_fast,
    videoScenes: [
      {
        id: "turn",
        label: "🌬 Ветер и взгляд",
        prompt:
          "The cloak snaps in a hard sea wind and the subject turns slowly to the camera, jaw set, holding the " +
          "look; light haze and spray drift past, slow push-in — one still, monumental beat.",
      },
      {
        id: "storm",
        label: "🌊 Гнев Посейдона",
        tier: "epic",
        prompt:
          "A towering wave breaks over the ship's deck as the subject braces against the mast, drenched, rigging " +
          "whipping, the hull pitching hard under black storm sky with lightning; the camera rolls with the deck — " +
          "roaring sea and thunder, one violent, breathtaking beat.",
      },
      {
        id: "battle",
        label: "⚔️ Стена щитов",
        tier: "epic",
        prompt:
          "The subject drives forward at the head of a bronze shield wall, spears levelling, dust exploding " +
          "underfoot, war cries and clashing bronze all around; the camera tracks alongside at low angle — one " +
          "thunderous, chaotic charge.",
      },
      {
        id: "bow",
        label: "🏹 Великий лук",
        tier: "epic",
        prompt:
          "In a torchlit hall the subject draws an enormous war bow in one slow, impossible motion, the string " +
          "creaking, the room falling silent around them, firelight sliding across bronze; the camera pushes in " +
          "to the eyes as the arrow is loosed — one held-breath beat.",
      },
    ],
    quiz: [
      {
        id: "place",
        question: "Где вы?",
        options: [
          { id: "sea", label: "🌊 В море", fragment: "Set the scene on the open Aegean sea aboard a wooden ship." },
          { id: "palace", label: "🏛 Во дворце", fragment: "Set the scene inside a torchlit stone palace hall with painted columns." },
          { id: "field", label: "⚔️ На поле битвы", fragment: "Set the scene on a dusty battlefield before high citadel walls." },
        ],
      },
      {
        id: "light",
        question: "Какой свет?",
        options: [
          { id: "dawn", label: "🌅 Рассвет", fragment: "Hard low dawn light with long shadows and golden rim light." },
          { id: "torch", label: "🔥 Факелы", fragment: "Flickering torchlight and deep shadow, warm amber on bronze." },
          { id: "storm", label: "⛈ Гроза", fragment: "Black storm sky with cold lightning flashes and driving rain." },
        ],
      },
    ],
  },
];

export function campaignById(id: string): Campaign | undefined {
  return CAMPAIGNS.find((c) => c.id === id);
}

/**
 * The one-time FREE scenario offer (the onboarding hook): a newcomer picks ONE
 * — princess or footballer — and gets the WHOLE scenario (Seedream photo→scene
 * image, then a Hailuo video) rendered free, watermarked with the NeuroShot
 * logo so every share markets us. Deliberately single-subject / simple motion:
 * no celebrities, no multi-actor physics — the cheapest, most reliable wow.
 * Claimed once per user (users.free_scenario_used); the 4 free 🔫 are untouched.
 */
export interface FreeScenario {
  id: "princess" | "football";
  label: string;
  ask: string;
  imageModel: ModelSpec; // photo → styled scene
  videoModel: ModelSpec; // scene → short clip
  imagePrompt: string;
  videoPrompt: string;
}
export const FREE_SCENARIOS: FreeScenario[] = [
  {
    id: "princess",
    label: "👸 Принцесса",
    ask: "Пришлите фото ребёнка 👶 — и мы бесплатно снимем сказку про принцессу.",
    imageModel: PRESET_MODEL,
    videoModel: DEFAULT_VIDEO,
    imagePrompt:
      "Dress the child as a graceful fairy-tale princess in a flowing sparkling gown inside a grand castle " +
      `ballroom: a delicate crown, glittering chandeliers, warm magical light, storybook grandeur. ${KEEP_KID}`,
    videoPrompt:
      "Slow graceful push-in as the princess turns toward the camera and lights up with a wonder-struck smile, " +
      "her gown and hair flowing softly, magical sparkles drifting past — one calm, enchanting beat.",
  },
  {
    id: "football",
    label: "⚽️ Футболист",
    ask: "Пришлите своё фото ⚽️ — и мы бесплатно снимем ваш гол на стадионе.",
    imageModel: PRESET_MODEL,
    videoModel: DEFAULT_VIDEO,
    imagePrompt:
      "Turn the person into a professional footballer on the pitch of a packed stadium at night: national-team " +
      `kit, bright floodlights, a roaring crowd behind, epic sports-photography look. ${KEEP_ID}`,
    videoPrompt:
      "The footballer wheels away with both arms raised in a roaring goal celebration, golden confetti raining " +
      "down and the floodlit crowd erupting behind — one clear, triumphant sports-broadcast beat.",
  },
];

export function freeScenarioById(id: string): FreeScenario | undefined {
  return FREE_SCENARIOS.find((s) => s.id === id);
}

/**
 * Persona-routed entry links (docs/growth-product.md). An acquisition-source slug
 * (t.me/<bot>?start=src_football) can pre-select the FIRST action that hits that
 * persona's priority gap — so a football-ad click lands straight on the football
 * scenario, an "оживи фото" click on the restore flow, a Kaspi-seller click on
 * the product-photo flow. The free scenario IS the sized trial, so routing grants
 * NO extra patrons here — that keeps the public link un-farmable (identity-gating
 * is the separate lever for any future bonus). Unknown slugs just fall through to
 * the normal welcome, and source is still recorded for first-touch attribution.
 */
export type EntryRoute =
  | { kind: "free"; id: FreeScenario["id"]; headline: string }
  | { kind: "camp"; id: string; headline: string }
  | { kind: "photoshoot"; headline: string }
  | { kind: "product"; headline: string };

export const ENTRY_LINKS: Record<string, EntryRoute> = {
  src_football: { kind: "free", id: "football", headline: "⚽️ Ваш гол на стадионе — бесплатно!" },
  src_princess: { kind: "free", id: "princess", headline: "👸 Сказка про принцессу — бесплатно!" },
  src_revive: { kind: "camp", id: "oldphoto", headline: "🕰 Оживим старое фото — пришлите снимок." },
  src_oldphoto: { kind: "camp", id: "oldphoto", headline: "🕰 Оживим старое фото — пришлите снимок." },
  src_poster: { kind: "camp", id: "poster", headline: "🎬 Ваш кинопостер — пришлите фото." },
  src_photoshoot: { kind: "photoshoot", headline: "📸 AI-фотосессия — пришлите ваш портрет." },
  src_product: { kind: "product", headline: "🛍 Продающие фото товара — пришлите снимок." },
  src_kaspi: { kind: "product", headline: "🛍 Фото товара для Kaspi/Instagram — пришлите снимок." },
};

/** Resolve an acquisition-source slug to its pre-selected first action, if any. */
export function entryLinkFor(source: string | null | undefined): EntryRoute | null {
  if (!source) return null;
  return ENTRY_LINKS[source] ?? null;
}

/**
 * Whole ISO weeks (Monday-aligned, UTC) as a stable, monotonically rising index.
 * The Unix epoch (1970-01-01) is a Thursday, so +3 days shifts the boundary to
 * Monday 00:00 UTC — the rotation flips on Mondays, matching docs.
 */
export function weekIndex(date: Date): number {
  const days = Math.floor(date.getTime() / (24 * 60 * 60 * 1000));
  return Math.floor((days + 3) / 7);
}

/**
 * The "🆕 Новинка недели" — a deterministic weekly rotation over the campaigns,
 * so returning users always find a fresh reason to spend (recurring-reason hook).
 * No scheduler needed: it's a pure function of the current week.
 */
export function featuredCampaign(date: Date): Campaign {
  return CAMPAIGNS[weekIndex(date) % CAMPAIGNS.length];
}

/**
 * The AI-cost each credit is priced to cover. Credits per model = ceil(cost /
 * this). Keep this in sync with any provider-cost changes; it's the anchor the
 * whole margin model rests on. See docs/pricing.md.
 */
export const CREDIT_COST_BASIS = 0.02; // USD of provider cost per credit

/**
 * Credit packs sold in Kazakhstani tenge (₸), paid via Kaspi. Ladder in ₸/patron
 * (bigger pack = better rate): 62 → 55 → 50 → 47. Anchored so every pack clears a
 * healthy margin over the ≤$0.02/patron provider cost after the referral share.
 * See docs/pricing.md.
 */
export interface Pack {
  id: string;
  kzt: number; // price in Kazakhstani tenge (paid via Kaspi)
  credits: number;
  title: string;
  /** A limited-time promo (shown with a sale countdown) — priced below the ladder. */
  offer?: boolean;
  /**
   * GenAI course tier (docs/course/README.md) — grants patrons AND a one-time
   * invite into that tier's private cohort channel (payments.ts grantPurchase
   * → inviteToCourseCohort). Excluded from the generic packsKeyboard() listing
   * (payments.ts) so plain credit top-up buyers never see it; surfaced only via
   * the dedicated /course command.
   */
  course?: "fast" | "flagship";
  /**
   * Withdrawn from sale, kept ONLY so historical orders still resolve. An order
   * stores its pack id and re-reads PACKS at grant time (see grantPurchase and
   * the reconciler, which logs "pack X no longer exists — cannot grant" and
   * parks the order for manual review). Deleting a pack outright would strand
   * anything still pending against it, so retired packs stay in the array and
   * are filtered out of every listing, keyboard and paywall anchor instead.
   */
  retired?: boolean;
}

export const PACKS: Pack[] = [
  { id: "start", kzt: 3700, credits: 60, title: `Старт — 60 ${UNIT_EMOJI}` }, // ~62 ₸/🔫
  { id: "popular", kzt: 11000, credits: 200, title: `Популярный — 200 ${UNIT_EMOJI}` }, // 55 ₸/🔫
  { id: "pro", kzt: 25000, credits: 500, title: `Про — 500 ${UNIT_EMOJI}` }, // 50 ₸/🔫
  { id: "studio", kzt: 42000, credits: 900, title: `Студия — 900 ${UNIT_EMOJI}` }, // 47 ₸/🔫
  // --- Purpose-built sets ---------------------------------------------------
  // One generic "combo" used to serve both intents at 36 🔫, which is enough for
  // three of the CHEAPEST videos and not one of the good ones. Split in two, each
  // sized from the real recipe it is named after.

  // Photo set — the tripwire. 100 🔫 buys 50 preset looks (Seedream edit, 2 🔫),
  // 25 Nano Banana 2 frames (4 🔫) or 12 Nano Banana Pro frames (8 🔫): enough to
  // play through a whole gallery rather than peek at it. Deliberately BELOW the
  // ladder at 29 ₸/🔫, so it is flagged `offer` and shown only with a countdown —
  // a limited-time hook, not a permanent tier (which would break the ladder).
  { id: "photo_set", kzt: 2900, credits: 100, title: `🎨 Фото-сет — 100 ${UNIT_EMOJI}`, offer: true },

  // Video set — sized from what one GOOD video actually costs. The recipe is two
  // strong frames (the still is what carries likeness and composition) and then
  // ten seconds of motion:
  //   2× Nano Banana 2   +  Seedance 2.0 Fast 10s  =   8 + 121 = 129 🔫
  //   2× Nano Banana Pro +  Seedance 2.0 Fast 10s  =  16 + 121 = 137 🔫
  //   2× Nano Banana Pro +  Seedance 2.0 10s+звук  =  16 + 152 = 168 🔫
  //   2× GPT Image 2     +  Seedance 2.0 10s+звук  =  22 + 152 = 174 🔫
  // 650 🔫 covers 5 / 4 / 3 / 3 of those — "three to five finished videos"
  // whichever tier the buyer works at, which is the promise the title makes.
  // NOT an `offer`: at this size a countdown would be pressure, not a launch
  // hook. Priced at 47.7 ₸/🔫 — between Про (50) and Студия (46.7), so the
  // "bigger pack, better rate" ladder still holds end to end.
  { id: "video_set", kzt: 31000, credits: 650, title: `🎬 Видео-сет — 650 ${UNIT_EMOJI}` },

  // Retired: the old one-size combo. Kept ONLY so orders already placed against
  // it can still be granted (see Pack.retired) — never listed, never anchored.
  { id: "combo", kzt: 1000, credits: 36, title: "🔥 Комбо-сет: 3 видео", offer: true, retired: true },

  // --- GenAI course tiers (docs/course-funnel.md, docs/course/README.md) ---
  // Priced identically to `start`/`pro` on purpose — the course-funnel pricing
  // is the same ladder anchor, just packaged with a cohort invite on top, so the
  // included 🔫 alone already covers most of the sticker price.
  {
    id: "course_fast",
    kzt: 3700,
    credits: 60,
    title: `🎓 Быстрый старт (курс) — 60 ${UNIT_EMOJI} + 5 уроков`,
    course: "fast",
  },
  {
    id: "course_flagship",
    kzt: 25000,
    credits: 500,
    title: `🎓 AI-контент под ключ — 500 ${UNIT_EMOJI} + когорта`,
    course: "flagship",
  },
];

export function packById(id: string): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}

/**
 * Referral rewards (scalars are env-tunable via config). Structure is abuse-safe: the
 * referrer's rewards are PURCHASE-gated (they only pay out when a referred
 * friend spends real Stars), so multi-accounting can't farm them — a farm would
 * have to spend real money to earn anything. Milestones count *paying* friends.
 */
export interface Milestone {
  friends: number; // distinct referred friends who have purchased at least once
  bonus: number; // credits awarded to the referrer when this tier is reached
}
export const REFERRAL_MILESTONES: Milestone[] = [
  { friends: 3, bonus: 20 },
  { friends: 10, bonus: 75 },
  { friends: 25, bonus: 250 },
];
