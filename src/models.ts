/**
 * Model registry: every generation the bot can perform, its fal.ai endpoint,
 * price in credits, and rough provider cost (USD) for margin tracking.
 *
 * fal endpoint IDs drift as providers ship new versions — verify against
 * https://fal.ai/explore/models before deploying, and prefer updating here
 * over hardcoding IDs elsewhere.
 */
export type ModelKind = "image_edit" | "text_to_image" | "image_to_video";

export interface ModelSpec {
  key: string;
  kind: ModelKind;
  falEndpoint: string;
  credits: number;
  approxCostUsd: number;
  label: string;
  /** Builds the fal input payload. imageUrl is set for edit/video kinds. */
  input: (prompt: string, imageUrl?: string) => Record<string, unknown>;
}

export const MODELS = {
  photo_edit: {
    key: "photo_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana/edit",
    credits: 1,
    approxCostUsd: 0.06,
    label: "🖼 Редактирование фото",
    input: (prompt, imageUrl) => ({ prompt, image_urls: [imageUrl] }),
  },
  text_to_image: {
    key: "text_to_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/bytedance/seedream/v4/text-to-image",
    credits: 1,
    approxCostUsd: 0.03,
    label: "✨ Картинка из текста",
    input: (prompt) => ({ prompt }),
  },
  animate: {
    key: "animate",
    kind: "image_to_video",
    falEndpoint: "fal-ai/kling-video/v2.5-turbo/standard/image-to-video",
    credits: 8,
    approxCostUsd: 0.5,
    label: "🎬 Оживление фото",
    input: (prompt, imageUrl) => ({ prompt, image_url: imageUrl, duration: "5" }),
  },
  premium_image: {
    key: "premium_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/gpt-image-2",
    credits: 4,
    approxCostUsd: 0.21, // high quality, 1024x1024
    label: "💎 Премиум-картинка",
    input: (prompt) => ({ prompt, quality: "high", image_size: { width: 1024, height: 1024 } }),
  },
  premium_edit: {
    key: "premium_edit",
    kind: "image_edit",
    falEndpoint: "openai/gpt-image-2/edit",
    credits: 4,
    approxCostUsd: 0.22, // high quality, 1024x1024
    label: "💎 Премиум-правка",
    input: (prompt, imageUrl) => ({ prompt, image_urls: [imageUrl], quality: "high" }),
  },

  // --- Top-tier models (verified against fal.ai model pages, Jul 2026) ---
  // Endpoint IDs, params and USD costs confirmed from the fal model pages; credit
  // prices target ~2–3× provider cost at pack pricing. Re-verify before launch.

  // Nano Banana 2 (Google) — fast SOTA image, $0.08/img @1K.
  nb2_image: {
    key: "nb2_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/nano-banana-2",
    credits: 2,
    approxCostUsd: 0.08,
    label: "🍌 Nano Banana 2",
    input: (prompt) => ({ prompt, resolution: "1K" }),
  },
  nb2_edit: {
    key: "nb2_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana-2/edit",
    credits: 2,
    approxCostUsd: 0.08,
    label: "🍌 Nano Banana 2 — правка",
    input: (prompt, imageUrl) => ({ prompt, image_urls: [imageUrl] }),
  },
  // Nano Banana Pro (Gemini 3 Pro) — SOTA image, $0.15/img @1K–2K.
  nbpro_image: {
    key: "nbpro_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/nano-banana-pro",
    credits: 3,
    approxCostUsd: 0.15,
    label: "🍌 Nano Banana Pro",
    input: (prompt) => ({ prompt, resolution: "2K" }),
  },
  nbpro_edit: {
    key: "nbpro_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana-pro/edit",
    credits: 3,
    approxCostUsd: 0.15,
    label: "🍌 Nano Banana Pro — правка",
    input: (prompt, imageUrl) => ({ prompt, image_urls: [imageUrl], resolution: "2K" }),
  },
  // Kling 3.0 Pro — top image→video, $0.168/s audio-on → 5s ≈ $0.84.
  kling3: {
    key: "kling3",
    kind: "image_to_video",
    falEndpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    credits: 14,
    approxCostUsd: 0.84,
    label: "🎬 Kling 3.0",
    input: (prompt, imageUrl) => ({ prompt, start_image_url: imageUrl, duration: "5" }),
  },
  // Seedance 2.0 Fast (ByteDance) — economy premium video, $0.2419/s → 5s ≈ $1.21.
  seedance_fast: {
    key: "seedance_fast",
    kind: "image_to_video",
    falEndpoint: "fal-ai/bytedance/seedance-2.0/fast/image-to-video",
    credits: 20,
    approxCostUsd: 1.21,
    label: "🎬 Seedance 2.0 Fast",
    input: (prompt, imageUrl) => ({ prompt, image_url: imageUrl, resolution: "720p", duration: "5" }),
  },
  // Seedance 2.0 (ByteDance) — flagship video with audio/physics, $0.3024/s → 5s ≈ $1.51.
  seedance: {
    key: "seedance",
    kind: "image_to_video",
    falEndpoint: "fal-ai/bytedance/seedance-2.0/image-to-video",
    credits: 25,
    approxCostUsd: 1.51,
    label: "🎬 Seedance 2.0",
    input: (prompt, imageUrl) => ({ prompt, image_url: imageUrl, resolution: "720p", duration: "5" }),
  },
} satisfies Record<string, ModelSpec>;

/**
 * Model pickers surfaced in the bot ("market bombing" the famous models by name).
 * Order = display order; each entry must be a real MODELS key of the right kind.
 */
export const IMAGE_MODEL_PICKER = ["text_to_image", "nb2_image", "nbpro_image", "premium_image"] as const;
export const VIDEO_MODEL_PICKER = ["animate", "kling3", "seedance_fast", "seedance"] as const;

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
}

/** Model used to render presets — a checked reference, so a key drift fails typecheck. */
export const PRESET_MODEL: ModelSpec = MODELS.premium_edit;

export const PRESETS: Preset[] = [
  {
    id: "headshot",
    label: "💼 Бизнес-портрет",
    category: "photo",
    prompt:
      "Transform into a professional corporate headshot: tailored suit, soft studio key light, " +
      "clean neutral gray backdrop, shallow depth of field, confident expression, magazine-cover retouching. " +
      "Preserve the person's identity and facial features exactly.",
  },
  {
    id: "fashion",
    label: "🕶 Fashion-съёмка",
    category: "photo",
    prompt:
      "Transform into a high-fashion editorial photo: designer outfit, dramatic cinematic lighting, " +
      "Vogue-style composition, film grain, bold styling. Preserve the person's identity and facial features exactly.",
  },
  {
    id: "travel",
    label: "🌅 Закат на Санторини",
    category: "photo",
    prompt:
      "Place the subject in a breathtaking golden-hour travel scene: Santorini rooftop at sunset, warm rim light, " +
      "editorial travel-magazine look. Preserve the subject's identity exactly.",
  },
  {
    id: "cinematic",
    label: "🎥 Кино-портрет",
    category: "photo",
    prompt:
      "Transform into a cinematic movie-still portrait: anamorphic look, teal-and-orange grade, atmospheric haze, " +
      "dramatic side lighting, 35mm film aesthetic. Preserve the person's identity and facial features exactly.",
  },
  {
    id: "product_hero",
    label: "🛍 Продающая карточка",
    category: "product",
    prompt:
      "Turn this into a premium e-commerce hero shot: the product on a clean seamless studio background with soft " +
      "shadows, professional three-point lighting, subtle reflection, marketplace-listing composition, 4k quality. " +
      "Keep the product's shape, colors and branding exactly as in the photo.",
  },
  {
    id: "product_white",
    label: "⬜️ Белый фон (маркетплейс)",
    category: "product",
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

/** Credit packs sold via Telegram Stars (XTR). 1 star ≈ $0.013 gross. */
export interface Pack {
  id: string;
  stars: number;
  credits: number;
  title: string;
}

export const PACKS: Pack[] = [
  { id: "mini", stars: 150, credits: 15, title: "Мини — 15 кредитов" },
  { id: "standard", stars: 450, credits: 50, title: "Стандарт — 50 кредитов" },
  { id: "pro", stars: 1200, credits: 150, title: "Про — 150 кредитов" },
];

/** Share of purchased credits granted to the referrer. */
export const REFERRAL_BONUS = 0.1;
