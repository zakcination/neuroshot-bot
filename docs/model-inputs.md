# Model inputs — what the studio collects vs what fal accepts

An audit of every `MODELS[*].input()` builder against the live fal input schema,
and the composer controls that now expose the inputs that shape the result most.
Before this pass, the studio collected **only the prompt** (and source image):
aspect ratio, quality, and end-frame were all hardcoded or silently dropped.

## What was wrong

1. **Images rendered square by default.** Seedream forced `image_size 2048²`,
   GPT-Image-2 `1024²`, Nano Banana Pro fell back to `1:1` — no ratio control
   anywhere. For a vertical-first (TikTok/Reels) product this was the biggest
   expectation-collapse.
2. **The Kling aspect-ratio selector was a no-op.** Neither Kling 2.5 (`animate`)
   nor Kling 3.0 (`kling3`) has an `aspect_ratio` param; fal dropped it. Users
   thought they picked 9:16 and got the source ratio.
3. **End-frame was never offered.** Kling 3.0 and both Seedance models accept
   `end_image_url` (morph source → end frame). Unexposed.
4. **Quality tiers hardcoded.** Nano Banana pinned to 1K/2K (supports 4K),
   Seedance to 720p (supports 1080p/4K).

## What the composer now collects

| Input | Models | fal param (per model) | Where |
|---|---|---|---|
| **Aspect ratio** | all image models | Seedream/GPT → named `image_size` (`portrait_16_9`…); Nano Banana → `aspect_ratio` string | image composer + scenario photo screen |
| **Aspect ratio** | Seedance video | `aspect_ratio` (Kling/Hailuo have none → "Как фото" only, honestly) | video composer |
| **End frame** | Kling 3.0, Seedance | `end_image_url` (upload or pick an own work) | video composer |
| **Quality tier** | Nano Banana 2/Pro, Seedance | `resolution` (1K/2K/4K, 720p/1080p) | image + video composer |

Guards, mapping helpers (`sizeParam`/`arParam`/`endParam`), and the capability
descriptors (`ImageParams`, `VideoParams.endFrame`/`resolutions`, `ResTier`) live
in `src/models.ts`. `normalizeOpts` validates every option against the model's
declared capability (an unsupported ratio/tier/end-frame → `400 bad_opts`), and
`priceFor` scales credits by the chosen quality multiplier so **margin holds**
(`tier[0].mult = 1`, so base prices are unchanged unless the user opts up).

## Pricing of quality tiers

`ResTier.mult` is a **credit multiplier** covering the higher provider cost with
headroom (we round up, so we never under-charge even if the exact provider delta
differs): Nano Banana 2K ×1.5 / 4K ×2.5, Nano Banana Pro 4K ×1.8, Seedance
1080p ×1.6. Video multipliers stack on top of the per-second duration price.

## Still hardcoded (deliberately)

`num_images` (1), `seed` (random), GPT-Image-2 `quality` (high), and GPT-Image-2
edit's `mask_url` (inpainting) — none is a common studio lever today. The
inpainting mask is the most plausible next addition.
