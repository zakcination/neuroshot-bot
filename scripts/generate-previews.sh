#!/usr/bin/env bash
#
# Regenerate the per-preset preview images in assets/previews/.
# Requires the Higgsfield CLI (`npm i -g @higgsfield/cli`), an authenticated
# session (`hf auth login`) and a selected workspace (`hf workspace set <id>`).
#
# People presets → Soul V2 (cheap, high-fashion); products → GPT Image 2.
# Output is written straight into assets/previews/<preset_id>.jpg after a
# downscale pass (needs ImageMagick `convert`, or edit to use your tool).
#
# Usage:  bash scripts/generate-previews.sh
set -euo pipefail

HF="${HF:-hf}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/assets/previews"
mkdir -p "$DEST"

gen() { # id model aspect extra-args... prompt
  local id="$1" model="$2" aspect="$3"; shift 3
  local prompt="${!#}"; set -- "${@:1:$(($#-1))}"
  echo "== $id ($model $aspect)"
  local url
  url=$("$HF" generate create "$model" --aspect_ratio "$aspect" "$@" \
        --prompt "$prompt" --wait --wait-timeout 10m 2>&1 \
        | grep -oE 'https://\S+\.(png|jpe?g|webp)' | head -1)
  [ -z "$url" ] && { echo "  no url for $id"; return 1; }
  curl -fsSL "$url" -o /tmp/prev-$id.src
  # downscale to ~864px JPEG q82 to keep the repo light
  convert /tmp/prev-$id.src -resize '864x864>' -quality 82 "$DEST/$id.jpg"
  echo "  → $DEST/$id.jpg"
}

# headshot/fashion moved off Soul V2 (a fashion-editorial-biased model) to
# gpt_image_2: Soul V2 + "magazine-cover retouching"/"Vogue-style" language
# rendered as a literal fake-Vogue-cover mockup with garbled AI text for
# headshot, and a near-nude editorial look for fashion — the opposite of the
# "business tool" impression these previews are supposed to sell. Prompts
# below are explicit about full coverage and drop any magazine/cover framing.
gen headshot          gpt_image_2 3:4 --quality high --resolution 2k \
  "A genuine corporate LinkedIn-style business headshot, photorealistic. A person in a well-tailored charcoal suit, arms confidently crossed, warm professional smile, soft studio key light, clean neutral gray softly blurred backdrop, shallow depth of field, magazine-cover-caliber retouching. Absolutely no text, no typography, no logo, no magazine masthead anywhere in the image — a plain clean photographic portrait only."
gen fashion           gpt_image_2 3:4 --quality high --resolution 2k \
  "A tasteful modern high-fashion editorial portrait, photorealistic. A person in a sharply tailored designer coat, fully covered and elegant, dramatic moody studio lighting with a single rim light, confident poised stance, magazine-editorial quality in the style of a premium fashion retailer's lookbook. Sophisticated, professional, modest styling — no visible logos, no text overlay, no readable typography anywhere in the frame."
gen travel            text2image_soul_v2 3:4 --quality 2k \
  "Golden-hour travel editorial portrait, woman on a Santorini rooftop at sunset, warm rim light, flowing linen dress, travel-magazine composition, breathtaking, cinematic."
gen cinematic         text2image_soul_v2 3:4 --quality 2k \
  "Cinematic movie-still portrait of a man, anamorphic look, teal-and-orange color grade, atmospheric haze, dramatic side lighting, 35mm film aesthetic, ultra premium."
gen product_hero      gpt_image_2 1:1 --quality high --resolution 2k \
  "Premium e-commerce hero shot of a luxury amber glass serum bottle on a seamless dark studio background, soft shadow, three-point lighting, subtle reflection, water droplets, 4k product photography."
gen product_white     gpt_image_2 1:1 --quality high --resolution 2k \
  "E-commerce product photo of a white premium sneaker on a pure seamless white background (#FFFFFF), soft natural drop shadow, centered marketplace-listing composition, even professional lighting, ultra sharp 4k."
gen product_lifestyle gpt_image_2 1:1 --quality high --resolution 2k \
  "Lifestyle product scene: an artisan ceramic coffee mug on a light wooden table by a window with soft natural daylight, shallow depth of field, steam rising, aspirational magazine look, 4k."

echo "done"
