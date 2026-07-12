#!/usr/bin/env bash
#
# Regenerate the top-level menu media in assets/menu/ (hero, text examples,
# animate video preview). Requires the Higgsfield CLI, an authenticated session
# and a selected workspace. Needs ImageMagick `convert` for image downscaling.
#
# Usage:  bash scripts/generate-menu-assets.sh
set -euo pipefail

HF="${HF:-hf}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/assets/menu"
mkdir -p "$DEST"

img() { # id aspect width prompt
  local id="$1" aspect="$2" width="$3" prompt="$4"
  echo "== $id"
  local url
  url=$("$HF" generate create gpt_image_2 --aspect_ratio "$aspect" --quality high --resolution 2k \
        --prompt "$prompt" --wait --wait-timeout 8m 2>&1 \
        | grep -oE 'https://\S+\.(png|jpe?g|webp)' | head -1)
  curl -fsSL "$url" -o /tmp/menu-$id.src
  convert /tmp/menu-$id.src -resize "${width}x>" -quality 82 "$DEST/$id.jpg"
  echo "  → $DEST/$id.jpg"
}

img hero 1:1 1080 \
  "A clean 2x2 grid collage, single photorealistic image divided into four equal quadrants by a thin white gutter, no text anywhere. Top-left: a professional corporate headshot, a person in a tailored dark blazer, warm approachable smile, soft studio key light, neutral gray backdrop, shallow depth of field, camera-facing. Top-right: an e-commerce product hero shot of an elegant leather handbag on a clean seamless white studio background, soft natural shadow, professional three-point lighting. Bottom-left: a warm restored vintage family photograph look, an old sepia photo brought back to life with natural realistic color, nostalgic golden tone, two generations smiling together. Bottom-right: a joyful, wholesome, family-friendly photorealistic scene of a child dressed as a storybook princess in a sparkling gown inside a warm castle ballroom, pure wonder and joy, fully modest clothing, magical golden light."
# NOTE: the previous hero prompt's "golden-hour travel portrait of a woman on
# a rooftop" panel rendered as a backless-dress glamour shot with no coverage
# constraint — read as AI-companion marketing, not a business tool, on the
# very first image every new user sees. Swapped for a product + family/kids
# use case instead — covers more of the actual product range and avoids the
# problem entirely rather than re-prompting around it.
img text_example_1 1:1 864 \
  "Ultra-detailed fantasy illustration: a floating island city at sunset with cascading waterfalls and airships, cinematic lighting, vibrant colors, high quality digital art."
img text_example_2 1:1 864 \
  "A cute 3D Pixar-style corgi astronaut floating inside a space station window, soft studio lighting, adorable, ultra detailed render."

# Animate preview: bring the travel portrait to life (image→video, economy Kling turbo, 720p).
echo "== animate (video)"
url=$("$HF" generate create kling3_0_turbo --start-image "$ROOT/assets/previews/travel.jpg" \
      --resolution 720p --aspect_ratio 9:16 --duration 5 \
      --prompt "Gentle cinematic motion: hair and dress flowing softly in the breeze, slow camera push-in, warm sunset light shimmering, subtle natural movement." \
      --wait --wait-timeout 12m 2>&1 | grep -oE 'https://\S+\.mp4' | head -1)
curl -fsSL "$url" -o "$DEST/animate.mp4"
echo "  → $DEST/animate.mp4"
echo "done"
