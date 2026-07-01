/**
 * Content population: generates the bot's brand assets with GPT Image 2 (high
 * quality) — avatar candidates, seed-post creatives for TG посевы, and
 * onboarding example images. Downloads everything to ./brand-assets/.
 *
 * Run: FAL_KEY=... npx tsx scripts/brand-assets.mts        (~$2.50 total)
 * Needs a positive fal.ai balance.
 */
import { fal } from "@fal-ai/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (!process.env.FAL_KEY) throw new Error("FAL_KEY not set");
fal.config({ credentials: process.env.FAL_KEY });

const OUT = "brand-assets";
mkdirSync(OUT, { recursive: true });

interface Asset {
  file: string;
  prompt: string;
  size: { width: number; height: number };
}

const ASSETS: Asset[] = [
  // --- Bot avatar candidates (square, must read at 64px) ---
  {
    file: "avatar-1.png",
    size: { width: 1024, height: 1024 },
    prompt:
      "App icon for an AI photo studio called NeuroShot: a minimal glowing camera aperture morphing into a neural " +
      "spark, deep violet-to-magenta gradient background, soft neon glow, centered, flat premium design, no text. " +
      "Must stay readable at very small sizes.",
  },
  {
    file: "avatar-2.png",
    size: { width: 1024, height: 1024 },
    prompt:
      "App icon: stylized letter N formed by a camera shutter blade and a lightning bolt, electric blue and hot pink " +
      "on near-black, glassmorphism, premium minimal, centered, no text. Must stay readable at very small sizes.",
  },
  {
    file: "avatar-3.png",
    size: { width: 1024, height: 1024 },
    prompt:
      "App icon: a sleek robot eye as a camera lens with a warm golden flash reflection, dark charcoal background, " +
      "single bold focal element, premium minimal 3D render, no text. Must stay readable at very small sizes.",
  },
  // --- Seed-post creatives (TG channel посевы, 16:9-ish) ---
  {
    file: "post-marketplace-sellers.png",
    size: { width: 1920, height: 1080 },
    prompt:
      "Advertising creative, split before/after: left — a dull smartphone snapshot of a sneaker on a messy table; " +
      "right — the same sneaker as a stunning e-commerce hero shot with studio lighting and soft shadows on seamless " +
      "background. Bold headline area at top left intentionally left empty for overlay text. Vibrant, scroll-stopping, " +
      "premium ad quality.",
  },
  {
    file: "post-ai-photoshoot.png",
    size: { width: 1920, height: 1080 },
    prompt:
      "Advertising creative, split before/after: left — a casual selfie of a young woman in a dim room; right — the " +
      "same woman as a professional business headshot with studio lighting, and as a fashion editorial shot. Collage " +
      "style, bold and premium, space at top for overlay text, scroll-stopping.",
  },
  {
    file: "post-animate.png",
    size: { width: 1920, height: 1080 },
    prompt:
      "Advertising creative showing a still photo of a couple on a beach coming alive into a cinematic video: film " +
      "frames flying out of a phone screen, motion blur trails, play button motif, sunset colors, premium and dynamic, " +
      "space at top for overlay text.",
  },
  // --- Onboarding / pinned-message examples (what the bot can do) ---
  {
    file: "example-product.png",
    size: { width: 1024, height: 1024 },
    prompt:
      "Premium e-commerce hero shot: a small brown glass cosmetics dropper bottle on wet black slate, dramatic " +
      "spotlight, water droplets, soft reflection, 4k product photography.",
  },
  {
    file: "example-portrait.png",
    size: { width: 1024, height: 1536 },
    prompt:
      "Cinematic editorial portrait of a confident young man, anamorphic bokeh, teal-and-orange grade, dramatic side " +
      "light, 35mm film aesthetic, magazine quality.",
  },
];

for (const a of ASSETS) {
  const t0 = Date.now();
  process.stdout.write(`▶ ${a.file} … `);
  const result = await fal.subscribe("fal-ai/gpt-image-2", {
    input: { prompt: a.prompt, quality: "high", image_size: a.size, output_format: "png" },
  });
  const url = (result.data as { images?: Array<{ url?: string }> })?.images?.[0]?.url;
  if (!url) throw new Error(`no image URL for ${a.file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed for ${a.file}: HTTP ${res.status}`);
  writeFileSync(join(OUT, a.file), Buffer.from(await res.arrayBuffer()));
  console.log(`ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

console.log(`\nDone — ${ASSETS.length} assets in ./${OUT}/`);
