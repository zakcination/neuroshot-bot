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
};

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
