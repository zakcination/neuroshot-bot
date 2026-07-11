/**
 * Brand + CTA watermark for FREE deliverables. Every free scenario video gets a
 * pre-designed CTA badge overlaid at the bottom — "Хочешь так же? Бесплатно:
 * ✈️ @neuroshot_ai_bot" (the artwork lives in `public/watermark.png`) — so each
 * shared clip is both an ad and a conversion path: a viewer sees exactly where
 * to make their own, for free. The copy + handle + Telegram glyph are baked into
 * the image, so there's no text rendering (and no font dependency) here.
 *
 * Zero hard dependency: if ffmpeg OR the badge file is missing, `watermarkVideo`
 * returns null and the caller sends the un-watermarked source URL — the free
 * flow never breaks and paid renders are never touched.
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Two watermark styles share this module:
 *  • "cta"    — the full-width bottom CTA banner ("Хочешь так же? Бесплатно…").
 *               Loud on purpose: the free-scenario gift is where an explicit
 *               call-to-action belongs. Always used for free deliverables.
 *  • "corner" — a small, low-opacity corner mark (logo/@handle only, no CTA
 *               sentence) for content a creator posts to their OWN feed (the UGC
 *               bounty): attributable without reading like a third-party ad.
 * The corner asset (public/corner_watermark.png) is optional — until it's added,
 * the corner style is a safe no-op (returns null → source sent unbranded).
 */
export type WatermarkStyle = "cta" | "corner";

/** The CTA badge artwork (RGBA PNG). Replace this file to change the watermark. */
const BADGE_PATH = fileURLToPath(new URL("../public/watermark.png", import.meta.url));
/** The corner mark artwork (RGBA PNG) — optional; drop in public/corner_watermark.png. */
const CORNER_PATH = fileURLToPath(new URL("../public/corner_watermark.png", import.meta.url));
/** Padding from the frame edge, in px (both styles). */
const BOTTOM_PADDING = 32;
/** Rendered badge width in px (scaled from the source, ratio preserved). Wide,
 * since the CTA badge is a readable bottom banner rather than a small corner mark. */
const MARK_WIDTH = 640;
/** Corner mark width in px — small, so reposted content doesn't read as an ad. */
const CORNER_WIDTH = 150;
/** Overlay opacity (0–1). 0.95 keeps the CTA crisp; the corner mark stays subtle. */
const MARK_OPACITY = 0.95;
const CORNER_OPACITY = 0.7;
/** Hard cap so a stuck ffmpeg can't wedge the request. */
const FFMPEG_TIMEOUT_MS = 60_000;

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
  if (style === "corner") {
    return {
      path: CORNER_PATH,
      width: CORNER_WIDTH,
      opacity: CORNER_OPACITY,
      x: `W-w-${BOTTOM_PADDING}`, // bottom-right corner
      y: `H-h-${BOTTOM_PADDING}`,
    };
  }
  return { path: BADGE_PATH, width: MARK_WIDTH, opacity: MARK_OPACITY, x: "(W-w)/2", y: `H-h-${BOTTOM_PADDING}` };
}
/** filter_complex for compositing a style's badge over input [0:v]. */
function overlayFilter(spec: StyleSpec): string {
  return (
    `[1:v]scale=${spec.width}:-1,format=rgba,colorchannelmixer=aa=${spec.opacity}[wm];` +
    `[0:v][wm]overlay=x=${spec.x}:y=${spec.y}`
  );
}

const badgeReady: Record<string, boolean | null> = { cta: null, corner: null };
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

async function hasBadge(style: WatermarkStyle): Promise<boolean> {
  if (badgeReady[style] == null) badgeReady[style] = await fileExists(styleSpec(style).path);
  return badgeReady[style]!;
}

/** True when a call to watermark* with this style could actually brand the file. */
export async function watermarkEnabled(style: WatermarkStyle = "cta"): Promise<boolean> {
  return (await hasBadge(style)) && (await hasFfmpeg());
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
 * Download `url`, overlay the CTA badge at the bottom-centre, and return the
 * branded MP4 bytes — or null if branding is unavailable or fails (caller then
 * sends the source URL unchanged, so a watermark hiccup never blocks a free
 * result). Audio is copied through untouched.
 */
export async function watermarkVideo(url: string, style: WatermarkStyle = "cta"): Promise<Buffer | null> {
  if (!(await watermarkEnabled(style))) return null;
  const spec = styleSpec(style);
  let dir: string | null = null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const src = Buffer.from(await res.arrayBuffer());
    dir = await mkdtemp(join(tmpdir(), "nswm-"));
    const inPath = join(dir, "in.mp4");
    const outPath = join(dir, "out.mp4");
    await writeFile(inPath, src);
    const ok = await runFfmpeg([
      "-y",
      "-i", inPath,
      "-i", spec.path,
      // Scale the badge, apply opacity (RGBA-safe — transparent corners stay
      // clear), overlay at the style's anchor.
      "-filter_complex", overlayFilter(spec),
      "-c:a", "copy",
      "-movflags", "+faststart",
      outPath,
    ]);
    if (!ok) return null;
    return await readFile(outPath);
  } catch (err) {
    console.error("watermarkVideo failed:", err);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Same badge overlay for a still image — download, composite the CTA badge at
 * bottom-centre, return the branded PNG bytes (or null if unavailable/failed, so
 * the caller falls back to the source URL). Used to brand image deliverables.
 */
export async function watermarkImage(url: string, style: WatermarkStyle = "cta"): Promise<Buffer | null> {
  if (!(await watermarkEnabled(style))) return null;
  const spec = styleSpec(style);
  let dir: string | null = null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const src = Buffer.from(await res.arrayBuffer());
    dir = await mkdtemp(join(tmpdir(), "nswm-"));
    const inPath = join(dir, "in");
    const outPath = join(dir, "out.png");
    await writeFile(inPath, src);
    const ok = await runFfmpeg([
      "-y",
      "-i", inPath,
      "-i", spec.path,
      "-filter_complex", overlayFilter(spec),
      "-frames:v", "1",
      outPath,
    ]);
    if (!ok) return null;
    return await readFile(outPath);
  } catch (err) {
    console.error("watermarkImage failed:", err);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
