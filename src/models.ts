/**
 * Model registry: every generation the bot can perform, its fal.ai endpoint,
 * price in credits, and rough provider cost (USD) for margin tracking.
 *
 * fal endpoint IDs drift as providers ship new versions — verify against
 * https://fal.ai/explore/models before deploying, and prefer updating here
 * over hardcoding IDs elsewhere.
 */
import { UNIT_EMOJI } from "./text.js";

export type ModelKind = "image_edit" | "text_to_image" | "image_to_video";

/** Per-generation options the studio composer can set. */
export interface GenOpts {
  duration?: number; // video length in seconds
  aspectRatio?: string; // "auto" | "1:1" | "9:16" | "16:9" | "4:3" | "3:4"
  endImageUrl?: string; // video END frame (Kling 3.0 / Seedance) — start frame is the source image
  resolution?: string; // quality-tier id (model-specific: "1K"/"2K"/"4K", "720p"/"1080p")
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
  label: string;
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

/** Quality ladders (credit multiplier covers the higher provider cost with margin). */
const NB_RES: ResTier[] = [
  { id: "1K", label: "1K", mult: 1 },
  { id: "2K", label: "2K ✨", mult: 1.5 },
  { id: "4K", label: "4K 💎", mult: 2.5 },
];
const NBPRO_RES: ResTier[] = [
  { id: "2K", label: "2K", mult: 1 },
  { id: "4K", label: "4K 💎", mult: 1.8 },
];
const SEEDANCE_RES: ResTier[] = [
  { id: "720p", label: "720p", mult: 1 },
  { id: "1080p", label: "1080p 💎", mult: 1.6 },
];

export const MODELS = {
  photo_edit: {
    key: "photo_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana/edit",
    credits: 3,
    approxCostUsd: 0.06,
    label: "🖼 Редактирование фото",
    input: (prompt, imageUrl, opts) => ({ prompt, image_urls: [imageUrl], ...arParam(opts) }),
    image: { aspectRatios: IMAGE_ASPECTS },
  },
  text_to_image: {
    key: "text_to_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/bytedance/seedream/v4.5/text-to-image",
    credits: 2,
    approxCostUsd: 0.04,
    label: "✨ Картинка из текста",
    input: (prompt, _img, opts) => ({ prompt, ...sizeParam(opts, true) }),
    image: { aspectRatios: IMAGE_ASPECTS },
  },
  // Seedream 4.5 edit — the default scenario image engine (photo → styled scene).
  // Stronger face-anchored scene edits than v4 at the same 2 🔫 tier ($0.04/img);
  // same input contract (prompt + image_urls), so it's a drop-in over v4.
  // Label deliberately drops the provider codename: not in a model picker, but
  // this IS PRESET_MODEL, and payments.paywallText renders `model.label`
  // directly when a preset/campaign generation hits the insufficient-credits
  // paywall — so it does reach users, just not through a picker keyboard.
  seedream_edit: {
    key: "seedream_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/bytedance/seedream/v4.5/edit",
    credits: 2,
    approxCostUsd: 0.04,
    label: "🖼 Сцена по фото",
    input: (prompt, imageUrl, opts) => ({ prompt, image_urls: [imageUrl], ...sizeParam(opts, true) }),
    image: { aspectRatios: IMAGE_ASPECTS },
  },
  animate: {
    key: "animate",
    kind: "image_to_video",
    falEndpoint: "fal-ai/kling-video/v2.5-turbo/standard/image-to-video",
    credits: 25,
    approxCostUsd: 0.5,
    label: "🎬 Оживление фото",
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
    label: "💎 Премиум-картинка",
    input: (prompt, _img, opts) => ({ prompt, quality: "high", image_size: sizeParam(opts, false).image_size ?? "square" }),
    image: { aspectRatios: IMAGE_ASPECTS },
  },
  premium_edit: {
    key: "premium_edit",
    kind: "image_edit",
    falEndpoint: "openai/gpt-image-2/edit",
    credits: 11,
    approxCostUsd: 0.22, // high quality, 1024x1024
    label: "💎 Премиум-правка",
    input: (prompt, imageUrl, opts) => ({ prompt, image_urls: [imageUrl], quality: "high", ...sizeParam(opts, false) }),
    image: { aspectRatios: IMAGE_ASPECTS },
  },

  // --- Top-tier models (verified against fal.ai model pages, Jul 2026) ---
  // Endpoint IDs, params and USD costs confirmed from the fal model pages.
  // Credits = ceil(approxCostUsd / CREDIT_COST_BASIS) so cost-per-credit ≤ $0.02
  // (see CREDIT_COST_BASIS below); at pack pricing this yields ≥3.5× margin even
  // on mobile Stars payout and after the referral share. Re-verify before launch.

  // Nano Banana 2 (Google) — fast SOTA image, $0.08/img @1K.
  // Labels are benefit/tier-named, never the fal provider codename — "Nano
  // Banana" reads as a novelty app name to a user, not a professional tool.
  nb2_image: {
    key: "nb2_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/nano-banana-2",
    credits: 4,
    approxCostUsd: 0.08,
    label: "🎨 Картинка — быстро",
    input: (prompt, _img, opts) => ({ prompt, resolution: opts?.resolution ?? "1K", ...arParam(opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, resolutions: NB_RES },
  },
  nb2_edit: {
    key: "nb2_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana-2/edit",
    credits: 4,
    approxCostUsd: 0.08,
    label: "🎨 Правка — быстро",
    input: (prompt, imageUrl, opts) => ({ prompt, image_urls: [imageUrl], resolution: opts?.resolution ?? "1K", ...arParam(opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, resolutions: NB_RES },
  },
  // Nano Banana Pro (Gemini 3 Pro) — SOTA image, $0.15/img @1K–2K.
  nbpro_image: {
    key: "nbpro_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/nano-banana-pro",
    credits: 8,
    approxCostUsd: 0.15,
    label: "🎨 Картинка — детально (2K)",
    input: (prompt, _img, opts) => ({ prompt, resolution: opts?.resolution ?? "2K", ...arParam(opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, resolutions: NBPRO_RES },
  },
  nbpro_edit: {
    key: "nbpro_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana-pro/edit",
    credits: 8,
    approxCostUsd: 0.15,
    label: "🎨 Правка — детально (2K)",
    input: (prompt, imageUrl, opts) => ({ prompt, image_urls: [imageUrl], resolution: opts?.resolution ?? "2K", ...arParam(opts) }),
    image: { aspectRatios: IMAGE_ASPECTS, resolutions: NBPRO_RES },
  },
  // Kling 3.0 Pro — top image→video, $0.168/s audio-on → 5s ≈ $0.84.
  kling3: {
    key: "kling3",
    kind: "image_to_video",
    falEndpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    credits: 42,
    approxCostUsd: 0.84,
    label: "🎬 Кино-движение",
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
    label: "🎬 Эпичная сцена",
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
    label: "🎬 Видео со звуком",
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
    label: "⚡ Видео — эконом",
    input: (prompt, imageUrl, opts) => ({
      prompt,
      image_url: imageUrl,
      duration: String(opts?.duration ?? 6),
    }),
    video: { perSecondUsd: 0.032, durations: [6, 10], aspectRatios: ["auto"] },
  },
} satisfies Record<string, ModelSpec>;

/**
 * Model pickers surfaced in the bot — a price/quality ladder, labeled by
 * OUTCOME and TIER, never the fal provider codename (a raw name like "Nano
 * Banana Pro" reads as a novelty app, not a professional tool).
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
   * Optional per-look model override. Most presets render on the cheap
   * PRESET_MODEL (Seedream edit); looks that DEPEND on on-image text/typography
   * or heavy stylization (blister-pack titles, marketplace labels, 3D toon)
   * pin a stronger engine here — Seedream garbles text (see docs/prompt-craft.md).
   * The model stays implicit in the look — no extra user step — but the credit
   * price the user sees follows the chosen model. Mirrors CampaignPreset.tier.
   */
  model?: ModelSpec;
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
  return p.model ?? PRESET_MODEL;
}

// --- Curated-prompt guards (shared by presets, campaigns and free scenarios) ---
// Positive phrasing per Higgsfield's prompt guide — "keep exactly", "one single
// instance" and "exactly once" land better than "don't"/"never" negatives.
const KEEP_ID = "Keep the person's face and identity exactly as in the photo.";
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
    prompt:
      "Restyle into a professional corporate headshot: a tailored suit, soft studio key light with an 85mm lens " +
      `look, clean neutral-gray backdrop, shallow depth of field, a confident expression, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "fashion",
    label: "🕶 Fashion-съёмка",
    category: "photo",
    prompt:
      "Restyle into a high-fashion editorial photo: a designer outfit, dramatic studio lighting, Vogue-style " +
      `composition, subtle film grain, bold styling, tack-sharp face. ${KEEP_ID}`,
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
    prompt:
      "Restyle into a cinematic movie-still portrait: a 35mm anamorphic film look, dramatic soft side lighting, a " +
      `gentle teal-and-amber grade that keeps skin tones natural, tack-sharp face. ${KEEP_ID}`,
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
    model: MODELS.nbpro_edit,
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
    model: MODELS.premium_edit,
    prompt:
      "Turn the person into a highly detailed collectible action-figure version of themselves, posed inside clear " +
      "blister packaging on a printed cardboard backer with a title header and small accessory items, studio product " +
      `lighting, glossy plastic and vinyl textures, realistic toy proportions but a clearly recognizable face. ${KEEP_ID}`,
  },
  {
    id: "retro90s",
    label: "📼 Плёнка 90-х",
    category: "photo",
    prompt:
      "Restyle into an authentic 1990s film-photo portrait: warm slightly-faded color, soft grain, gentle on-camera " +
      "flash, period-accurate styling and hair, a nostalgic snapshot feel with subtle light leaks and true-to-film " +
      `skin tones, tack-sharp face. ${KEEP_ID}`,
  },
  {
    id: "product_hero",
    label: "🛍 Продающая карточка",
    category: "product",
    // Marketplace card keeps packaging labels/branding crisp — GPT Image 2 holds text.
    model: MODELS.premium_edit,
    prompt:
      "Turn this into a premium e-commerce hero shot: the product on a clean seamless studio background with soft " +
      "shadows, professional three-point lighting, subtle reflection, marketplace-listing composition, 4k quality. " +
      "Keep the product's shape, colors and branding exactly as in the photo.",
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
}

export const PACKS: Pack[] = [
  { id: "start", kzt: 3700, credits: 60, title: `Старт — 60 ${UNIT_EMOJI}` }, // ~62 ₸/🔫
  { id: "popular", kzt: 11000, credits: 200, title: `Популярный — 200 ${UNIT_EMOJI}` }, // 55 ₸/🔫
  { id: "pro", kzt: 25000, credits: 500, title: `Про — 500 ${UNIT_EMOJI}` }, // 50 ₸/🔫
  { id: "studio", kzt: 42000, credits: 900, title: `Студия — 900 ${UNIT_EMOJI}` }, // 47 ₸/🔫
  // Launch special — the acquisition hook: 3 scenario-videos (Seedream + Hailuo,
  // 12 🔫 each) for 1000 ₸ = 36 🔫. Deliberately BELOW the ladder (28 ₸/🔫), so it
  // is flagged `offer` and shown only with a countdown — a limited-time tripwire,
  // not a permanent tier (which would break the ladder).
  { id: "combo", kzt: 1000, credits: 36, title: "🔥 Комбо-сет: 3 видео", offer: true },
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
