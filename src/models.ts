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
    credits: 3,
    approxCostUsd: 0.06,
    label: "🖼 Редактирование фото",
    input: (prompt, imageUrl) => ({ prompt, image_urls: [imageUrl] }),
  },
  text_to_image: {
    key: "text_to_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/bytedance/seedream/v4/text-to-image",
    credits: 2,
    approxCostUsd: 0.03,
    label: "✨ Картинка из текста",
    input: (prompt) => ({ prompt }),
  },
  animate: {
    key: "animate",
    kind: "image_to_video",
    falEndpoint: "fal-ai/kling-video/v2.5-turbo/standard/image-to-video",
    credits: 25,
    approxCostUsd: 0.5,
    label: "🎬 Оживление фото",
    input: (prompt, imageUrl) => ({ prompt, image_url: imageUrl, duration: "5" }),
  },
  premium_image: {
    key: "premium_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/gpt-image-2",
    credits: 11,
    approxCostUsd: 0.21, // high quality, 1024x1024
    label: "💎 Премиум-картинка",
    input: (prompt) => ({ prompt, quality: "high", image_size: { width: 1024, height: 1024 } }),
  },
  premium_edit: {
    key: "premium_edit",
    kind: "image_edit",
    falEndpoint: "openai/gpt-image-2/edit",
    credits: 11,
    approxCostUsd: 0.22, // high quality, 1024x1024
    label: "💎 Премиум-правка",
    input: (prompt, imageUrl) => ({ prompt, image_urls: [imageUrl], quality: "high" }),
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
    label: "🍌 Nano Banana 2",
    input: (prompt) => ({ prompt, resolution: "1K" }),
  },
  nb2_edit: {
    key: "nb2_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana-2/edit",
    credits: 4,
    approxCostUsd: 0.08,
    label: "🍌 Nano Banana 2 — правка",
    input: (prompt, imageUrl) => ({ prompt, image_urls: [imageUrl] }),
  },
  // Nano Banana Pro (Gemini 3 Pro) — SOTA image, $0.15/img @1K–2K.
  nbpro_image: {
    key: "nbpro_image",
    kind: "text_to_image",
    falEndpoint: "fal-ai/nano-banana-pro",
    credits: 8,
    approxCostUsd: 0.15,
    label: "🍌 Nano Banana Pro",
    input: (prompt) => ({ prompt, resolution: "2K" }),
  },
  nbpro_edit: {
    key: "nbpro_edit",
    kind: "image_edit",
    falEndpoint: "fal-ai/nano-banana-pro/edit",
    credits: 8,
    approxCostUsd: 0.15,
    label: "🍌 Nano Banana Pro — правка",
    input: (prompt, imageUrl) => ({ prompt, image_urls: [imageUrl], resolution: "2K" }),
  },
  // Kling 3.0 Pro — top image→video, $0.168/s audio-on → 5s ≈ $0.84.
  kling3: {
    key: "kling3",
    kind: "image_to_video",
    falEndpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    credits: 42,
    approxCostUsd: 0.84,
    label: "🎬 Kling 3.0",
    input: (prompt, imageUrl) => ({ prompt, start_image_url: imageUrl, duration: "5" }),
  },
  // Seedance 2.0 Fast (ByteDance) — economy premium video, $0.2419/s → 5s ≈ $1.21.
  seedance_fast: {
    key: "seedance_fast",
    kind: "image_to_video",
    falEndpoint: "fal-ai/bytedance/seedance-2.0/fast/image-to-video",
    credits: 61,
    approxCostUsd: 1.21,
    label: "🎬 Seedance 2.0 Fast",
    input: (prompt, imageUrl) => ({ prompt, image_url: imageUrl, resolution: "720p", duration: "5" }),
  },
  // Seedance 2.0 (ByteDance) — flagship video with audio/physics, $0.3024/s → 5s ≈ $1.51.
  seedance: {
    key: "seedance",
    kind: "image_to_video",
    falEndpoint: "fal-ai/bytedance/seedance-2.0/image-to-video",
    credits: 76,
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
}
export interface Campaign {
  id: string;
  label: string; // menu button
  header: string; // shown above the preset keyboard
  ask: string; // what photo to send
  presets: CampaignPreset[];
  /** One-tap video upsell on the generated image (MODELS.animate). */
  animateLabel: string;
  animatePrompt: string;
}

const KEEP_ID = "Preserve the person's identity and facial features exactly.";
const KEEP_KID = "Preserve the child's identity and facial features exactly.";

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
          "Transform this child into the hero of a magical fairy tale: an enchanted glowing forest, drifting " +
          "fireflies, soft golden light, storybook-illustration-meets-cinematic look, wonder on their face, richly " +
          `detailed. ${KEEP_KID}`,
      },
      {
        id: "dragon",
        label: "🐉 Дракон и герой",
        prompt:
          "Turn this child into a brave storybook knight standing beside a friendly majestic dragon, epic castle in " +
          `the background, warm sunset light, heroic fairy-tale atmosphere, cinematic detail. ${KEEP_KID}`,
      },
      {
        id: "royal",
        label: "👑 Королевство",
        prompt:
          "Dress this child in royal fairy-tale attire inside a grand castle ballroom: crown, elegant costume, " +
          `sparkling chandeliers, magical festive atmosphere, storybook grandeur. ${KEEP_KID}`,
      },
    ],
    animateLabel: "🎬 Оживить сказку",
    animatePrompt:
      "Gentle magical motion: soft camera push-in, fireflies drifting, hair and clothing moving in a light breeze, " +
      "the child smiles with wonder, cinematic storybook atmosphere.",
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
          "Place this child happily standing next to SpongeBob SquarePants in colorful underwater Bikini Bottom, " +
          `the cartoon world blended photorealistically around the real child, joyful vibrant scene. ${KEEP_KID}`,
      },
      {
        id: "gumball",
        label: "😺 Гамбол",
        prompt:
          "Place this child next to Gumball Watterson from The Amazing World of Gumball in the town of Elmore, " +
          `playful mixed cartoon-and-photo style, bright cheerful colors, both laughing together. ${KEEP_KID}`,
      },
      {
        id: "trikota",
        label: "🐱 Три кота",
        prompt:
          "Place this child alongside the three cheerful kitten characters of the cartoon «Три кота» (Kid-E-Cats) " +
          `in their cozy cartoon town, warm family atmosphere, bright friendly colors. ${KEEP_KID}`,
      },
      {
        id: "dbillions",
        label: "🎵 D Billions",
        prompt:
          "Place this child dancing together with the colorful D Billions characters on a bright festive stage, " +
          `confetti, joyful kids-show energy, vivid colors. ${KEEP_KID}`,
      },
      {
        id: "shark",
        label: "🦈 Baby Shark",
        prompt:
          "Place this child in a cheerful underwater scene swimming alongside Baby Shark and family, bubbles and " +
          `sunbeams through the water, bright preschool-cartoon joy blended with the real child. ${KEEP_KID}`,
      },
    ],
    animateLabel: "🎬 Оживить встречу",
    animatePrompt:
      "Playful lively motion: the cartoon character waves and bounces, the child laughs, confetti or bubbles drift, " +
      "gentle camera push-in, joyful kids-show energy.",
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
          "Place this person on the pitch of a packed World Cup final stadium at night, standing shoulder to " +
          "shoulder with Lionel Messi, both in football kits, stadium lights blazing, confetti falling, " +
          `sports-photography realism. ${KEEP_ID}`,
      },
      {
        id: "ronaldo",
        label: "🇵🇹 С Роналду",
        prompt:
          "Place this person on the pitch of a packed World Cup final stadium at night, celebrating side by side " +
          `with Cristiano Ronaldo, both in football kits, dramatic stadium lighting, sports-photography realism. ${KEEP_ID}`,
      },
      {
        id: "yamal",
        label: "🇪🇸 С Ямалем",
        prompt:
          "Place this person on the pitch of a packed World Cup final stadium celebrating with Lamine Yamal, both " +
          `in football kits, golden confetti falling, electric atmosphere, sports-photography realism. ${KEEP_ID}`,
      },
      {
        id: "kit",
        label: "🏟 Я в форме сборной",
        prompt:
          "Transform this person into a professional footballer celebrating a goal in a packed World Cup stadium: " +
          `national-team kit, roaring crowd, floodlights, confetti, epic sports-photography shot. ${KEEP_ID}`,
      },
    ],
    animateLabel: "🎬 Оживить момент",
    animatePrompt:
      "Epic stadium motion: crowd roaring and waving flags, confetti falling, floodlight flares, slow heroic camera " +
      "orbit around the subjects.",
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
      "Subtle lifelike motion, respectful and warm: the people gently blink, breathe and smile softly, a slight " +
      "natural head movement, soft light shift — like a living memory.",
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
          "Turn this person into the star of a blockbuster action movie poster: dramatic pose, explosions and " +
          `cityscape behind, bold title typography, high-contrast cinematic grade, theatrical one-sheet layout. ${KEEP_ID}`,
      },
      {
        id: "romance",
        label: "❤️ Мелодрама",
        prompt:
          "Turn this person into the lead of a romantic drama movie poster: golden-hour light, soft wind, elegant " +
          `serif title typography, emotional cinematic atmosphere, theatrical one-sheet layout. ${KEEP_ID}`,
      },
      {
        id: "scifi",
        label: "🚀 Фантастика",
        prompt:
          "Turn this person into the hero of an epic sci-fi movie poster: futuristic suit, neon-lit alien world, " +
          `starships above, glowing title typography, cinematic one-sheet composition. ${KEEP_ID}`,
      },
    ],
    animateLabel: "🎬 Оживить постер",
    animatePrompt:
      "Cinematic poster comes alive: slow parallax depth, drifting smoke and light flares, hair and clothing move " +
      "in the wind, dramatic trailer-style atmosphere.",
  },
];

export function campaignById(id: string): Campaign | undefined {
  return CAMPAIGNS.find((c) => c.id === id);
}

/** Whole weeks since the Unix epoch — a stable, monotonically rising index. */
export function weekIndex(date: Date): number {
  return Math.floor(date.getTime() / (7 * 24 * 60 * 60 * 1000));
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
 * Credit packs sold via Telegram Stars (XTR). Price ladder in ⭐/credit:
 * 12 → 11 → 10 → 9 (bigger pack = better rate). At the conservative ~$0.010
 * Stars payout, even the cheapest 9⭐/credit clears ≥3.5× on every model after
 * the referral share; smaller packs run 4.5–6×. See docs/pricing.md.
 */
export interface Pack {
  id: string;
  stars: number;
  credits: number;
  title: string;
}

export const PACKS: Pack[] = [
  { id: "start", stars: 720, credits: 60, title: "Старт — 60 🔫" }, // 12 ⭐/cr
  { id: "popular", stars: 2200, credits: 200, title: "Популярный — 200 🔫" }, // 11 ⭐/cr
  { id: "pro", stars: 5000, credits: 500, title: "Про — 500 🔫" }, // 10 ⭐/cr
  { id: "studio", stars: 8100, credits: 900, title: "Студия — 900 🔫" }, // 9 ⭐/cr
];

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
