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

export const MODELS: Record<string, ModelSpec> = {
  photo_edit: {
    key: "photo_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana/edit",
    credits: 1,
    approxCostUsd: 0.06,
    label: "🖼 Edit photo",
    input: (prompt, imageUrl) => ({ prompt, image_urls: [imageUrl] }),
  },
  text_to_image: {
    key: "text_to_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/bytedance/seedream/v4/text-to-image",
    credits: 1,
    approxCostUsd: 0.03,
    label: "✨ Generate image",
    input: (prompt) => ({ prompt }),
  },
  animate: {
    key: "animate",
    kind: "image_to_video",
    falEndpoint: "fal-ai/kling-video/v2.5-turbo/standard/image-to-video",
    credits: 8,
    approxCostUsd: 0.5,
    label: "🎬 Animate photo",
    input: (prompt, imageUrl) => ({ prompt, image_url: imageUrl, duration: "5" }),
  },
  premium_image: {
    key: "premium_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/gpt-image-2",
    credits: 4,
    approxCostUsd: 0.21, // high quality, 1024x1024
    label: "💎 Premium image",
    input: (prompt) => ({ prompt, quality: "high", image_size: { width: 1024, height: 1024 } }),
  },
  premium_edit: {
    key: "premium_edit",
    kind: "image_edit",
    falEndpoint: "openai/gpt-image-2/edit",
    credits: 4,
    approxCostUsd: 0.22, // high quality, 1024x1024
    label: "💎 Premium edit",
    input: (prompt, imageUrl) => ({ prompt, image_urls: [imageUrl], quality: "high" }),
  },
};

/**
 * One-tap style presets (Higgsfield-style): a curated prompt applied to the
 * user's photo via the premium edit model — no prompt-writing needed.
 */
export interface Preset {
  id: string;
  label: string;
  prompt: string;
}

/** Model used to render presets. */
export const PRESET_MODEL = "premium_edit";

export const PRESETS: Preset[] = [
  {
    id: "headshot",
    label: "💼 Business headshot",
    prompt:
      "Transform into a professional corporate headshot: tailored suit, soft studio key light, " +
      "clean neutral gray backdrop, shallow depth of field, confident expression, magazine-cover retouching. " +
      "Preserve the person's identity and facial features exactly.",
  },
  {
    id: "fashion",
    label: "🕶 Fashion editorial",
    prompt:
      "Transform into a high-fashion editorial photo: designer outfit, dramatic cinematic lighting, " +
      "Vogue-style composition, film grain, bold styling. Preserve the person's identity and facial features exactly.",
  },
  {
    id: "travel",
    label: "🌅 Golden-hour travel",
    prompt:
      "Place the subject in a breathtaking golden-hour travel scene: Santorini rooftop at sunset, warm rim light, " +
      "editorial travel-magazine look. Preserve the subject's identity exactly.",
  },
  {
    id: "product_hero",
    label: "🛍 Product hero card",
    prompt:
      "Turn this into a premium e-commerce hero shot: the product on a clean seamless studio background with soft " +
      "shadows, professional three-point lighting, subtle reflection, marketplace-listing composition, 4k quality. " +
      "Keep the product's shape, colors and branding exactly as in the photo.",
  },
  {
    id: "cinematic",
    label: "🎥 Cinematic portrait",
    prompt:
      "Transform into a cinematic movie-still portrait: anamorphic look, teal-and-orange grade, atmospheric haze, " +
      "dramatic side lighting, 35mm film aesthetic. Preserve the person's identity and facial features exactly.",
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
  { id: "mini", stars: 150, credits: 15, title: "Mini — 15 credits" },
  { id: "standard", stars: 450, credits: 50, title: "Standard — 50 credits" },
  { id: "pro", stars: 1200, credits: 150, title: "Pro — 150 credits" },
];

/** Share of purchased credits granted to the referrer. */
export const REFERRAL_BONUS = 0.1;
