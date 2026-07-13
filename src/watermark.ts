/**
 * Deliverable branding + the mandatory AI-generated-content disclosure.
 *
 * Two independent concerns live here, composited in ONE ffmpeg pass so a render
 * is only re-encoded once:
 *
 *  1. AI DISCLOSURE (legal, non-optional) — Kazakhstan's Law No. 230-VIII
 *     "On Artificial Intelligence" (Art. 21, in force 2026-01-18) requires the
 *     distribution of AI-generated ("synthetic") output to carry BOTH a
 *     machine-readable marking AND a human-perceptible warning. The duty is on
 *     the AI-system operator (that's us), not the end user. So EVERY delivered
 *     image/video gets the `ai_generated.png` badge overlaid AND an AI-generated
 *     metadata tag embedded — independent of the user's promo-watermark setting,
 *     which they can turn off (that toggle governs marketing branding only, not
 *     this legal mark). See docs/compliance.md.
 *
 *  2. PROMO BRANDING (marketing, optional) — the CTA badge ("Хочешь так же?…",
 *     `watermark.png`) turns a shared free clip into an ad. Applied when the
 *     caller asks for it (free scenarios always; paid renders when the user's
 *     watermark setting is on).
 *
 * Zero hard dependency: if ffmpeg OR a required badge file is missing, the
 * affected overlay is skipped; if nothing can be applied the function returns
 * null and the caller sends the un-branded source URL — a branding hiccup never
 * blocks a result. (In production ffmpeg + the assets are always present — see
 * Dockerfile — so the disclosure ships on every real delivery.)
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Overlay styles:
 *  • "ai"     — the mandatory "AI Generated" disclosure badge, top-left.
 *  • "cta"    — the full-width bottom CTA banner ("Хочешь так же? Бесплатно…").
 *  • "corner" — a small low-opacity logo/@handle mark for creator-posted UGC.
 */
export type WatermarkStyle = "ai" | "cta" | "corner";
export type MediaKind = "image" | "video";

/** The AI-disclosure badge (RGBA PNG) — the human-perceptible legal warning. */
const AI_PATH = fileURLToPath(new URL("../public/ai_generated.png", import.meta.url));
/** The CTA badge artwork (RGBA PNG). Replace this file to change the promo mark. */
const BADGE_PATH = fileURLToPath(new URL("../public/watermark.png", import.meta.url));
/** The corner mark artwork (RGBA PNG) — optional; drop in public/corner_watermark.png. */
const CORNER_PATH = fileURLToPath(new URL("../public/corner_watermark.png", import.meta.url));

/** Padding from the frame edge, in px. */
const PADDING = 32;
/** Rendered badge widths in px (scaled from the source, ratio preserved).
 * Fixed-px (not proportional) to reuse the proven, prod-validated overlay filter
 * primitive — a scale2ref proportional graph is a possible follow-up once it can
 * be validated against real ffmpeg. On typical ≥1024px outputs 400px is clearly
 * perceptible (~20–40% width) without dominating; tune here if needed. */
const AI_WIDTH = 400; // the mandatory legal disclosure — err visible
const CTA_WIDTH = 640; // promo CTA: a readable bottom banner
const CORNER_WIDTH = 150; // small so reposted content doesn't read as an ad
/** Overlay opacity (0–1). */
const AI_OPACITY = 0.95; // the legal warning must be plainly perceptible
const CTA_OPACITY = 0.95;
const CORNER_OPACITY = 0.7;
/** Hard cap so a stuck ffmpeg can't wedge the request. */
const FFMPEG_TIMEOUT_MS = 60_000;

/** A machine-readable AI-generated marker embedded in the output container. */
const AI_METADATA_COMMENT =
  "AI-generated content created with NeuroShot. Synthetic media marked per " +
  "Republic of Kazakhstan Law No. 230-VIII 'On Artificial Intelligence', Art. 21.";

/** Per-style layout: which asset, how wide, how opaque, and where it sits. */
interface StyleSpec {
  path: string;
  width: number;
  opacity: number;
  /** ffmpeg overlay x/y expressions. */
  x: string;
  y: string;
}
function styleSpec(style: WatermarkStyle): StyleSpec {
  if (style === "ai") {
    return { path: AI_PATH, width: AI_WIDTH, opacity: AI_OPACITY, x: `${PADDING}`, y: `${PADDING}` };
  }
  if (style === "corner") {
    return {
      path: CORNER_PATH,
      width: CORNER_WIDTH,
      opacity: CORNER_OPACITY,
      x: `W-w-${PADDING}`,
      y: `H-h-${PADDING}`,
    };
  }
  return { path: BADGE_PATH, width: CTA_WIDTH, opacity: CTA_OPACITY, x: "(W-w)/2", y: `H-h-${PADDING}` };
}

/**
 * Build one filter_complex that chains every badge over the base video [0:v].
 * Badge i is ffmpeg input (i+1). Pure/deterministic — unit-tested.
 */
export function buildOverlayFilter(specs: StyleSpec[]): string {
  const scales: string[] = [];
  const chain: string[] = [];
  let prev = "[0:v]";
  specs.forEach((spec, i) => {
    const inLabel = `[${i + 1}:v]`;
    const wm = `[wm${i}]`;
    scales.push(`${inLabel}scale=${spec.width}:-1,format=rgba,colorchannelmixer=aa=${spec.opacity}${wm}`);
    const last = i === specs.length - 1;
    const out = last ? "" : `[b${i}]`;
    chain.push(`${prev}${wm}overlay=x=${spec.x}:y=${spec.y}${out}`);
    prev = `[b${i}]`;
  });
  return [...scales, ...chain].join(";");
}

/**
 * Which overlays a delivery gets. The AI disclosure is ALWAYS first (legal,
 * non-optional); the promo CTA is appended only when requested. Pure — unit-tested.
 */
export function deliveryStyles(promo: boolean): WatermarkStyle[] {
  return promo ? ["ai", "cta"] : ["ai"];
}

const assetReady: Partial<Record<WatermarkStyle, boolean>> = {};
let ffmpegReady: boolean | null = null;

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** ffmpeg present on PATH? Cached after the first probe. */
function hasFfmpeg(): Promise<boolean> {
  if (ffmpegReady != null) return Promise.resolve(ffmpegReady);
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve((ffmpegReady = false)));
    child.on("close", (code) => resolve((ffmpegReady = code === 0)));
  });
}

async function hasAsset(style: WatermarkStyle): Promise<boolean> {
  if (assetReady[style] == null) assetReady[style] = await fileExists(styleSpec(style).path);
  return assetReady[style]!;
}

/** True when the mandatory AI-disclosure overlay could actually be applied. */
export async function disclosureAvailable(): Promise<boolean> {
  return (await hasFfmpeg()) && (await hasAsset("ai"));
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, FFMPEG_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Download `url`, composite the requested badges (AI disclosure + any promo) in
 * one pass, embed the AI-generated metadata marker, and return the branded bytes
 * — or null if branding is unavailable/failed (caller then sends the source URL
 * unchanged). `kind` selects the still-image vs video encode path.
 */
async function brand(url: string, kind: MediaKind, styles: WatermarkStyle[]): Promise<Buffer | null> {
  if (!(await hasFfmpeg())) return null;
  // Keep styles whose asset is on disk. The "ai" disclosure is MANDATORY: if its
  // asset is missing we must NOT ship a promo-only (undisclosed) output — bail
  // entirely so the caller sends the raw source rather than a non-compliant one.
  const specs: StyleSpec[] = [];
  for (const s of styles) {
    if (await hasAsset(s)) specs.push(styleSpec(s));
    else if (s === "ai") return null;
  }
  if (!specs.length) return null; // nothing to apply → let caller send the source

  let dir: string | null = null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const src = Buffer.from(await res.arrayBuffer());
    dir = await mkdtemp(join(tmpdir(), "nswm-"));
    // Keep the SOURCE's video extension on the input: some ffmpeg builds pick the
    // demuxer by extension rather than probing content, so a bare "in" (or a
    // wrong ".mp4" for webm/mov bytes) can intermittently fail to open the file.
    const videoExt = (url.match(/\.(mp4|webm|mov)(?:\?|$)/i)?.[1] ?? "mp4").toLowerCase();
    const inPath = join(dir, kind === "video" ? `in.${videoExt}` : "in");
    const outPath = join(dir, kind === "video" ? "out.mp4" : "out.png");
    await writeFile(inPath, src);

    const inputs = specs.flatMap((spec) => ["-i", spec.path]);
    const meta = ["-metadata", `comment=${AI_METADATA_COMMENT}`, "-metadata", "ai_generated=true"];
    const encode =
      kind === "video"
        ? ["-c:a", "copy", "-movflags", "+faststart", ...meta, outPath]
        : ["-frames:v", "1", ...meta, outPath];

    const ok = await runFfmpeg([
      "-y",
      "-i", inPath,
      ...inputs,
      "-filter_complex", buildOverlayFilter(specs),
      ...encode,
    ]);
    if (!ok) return null;
    return await readFile(outPath);
  } catch (err) {
    console.error(`brand(${kind}) failed:`, err);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Brand a delivered result for sending. ALWAYS applies the mandatory AI-generated
 * disclosure (badge + metadata); additionally applies the promo CTA when
 * `opts.promo` is true. Returns branded bytes, or null if branding is
 * unavailable/failed (caller falls back to the raw source URL).
 */
export function brandForDelivery(
  url: string,
  kind: MediaKind,
  opts: { promo: boolean },
): Promise<Buffer | null> {
  return brand(url, kind, deliveryStyles(opts.promo));
}
