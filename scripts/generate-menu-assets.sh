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

img hero 16:9 1280 \
  "A premium 2x2 grid marketing collage for an AI photo studio app. Four cohesive high-end panels: top-left a professional business headshot of a confident woman; top-right a luxury amber product bottle on a clean white studio background; bottom-left a cinematic teal-and-orange film-style portrait of a man; bottom-right a golden-hour travel portrait of a woman on a rooftop. Thin subtle dividers, vibrant, scroll-stopping, no text."
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
