/**
 * Brand + CTA watermark for FREE deliverables. Every free scenario video carries
 * two things so each share becomes an ad AND a conversion path:
 *   1) the NeuroShot logo (brand recognition), overlaid small near the top;
 *   2) a call-to-action bar at the bottom — "Сделай такое же бесплатно → @<bot>"
 *      — pointing at the actual Telegram bot handle, so a viewer who sees a
 *      shared clip knows exactly where to make their own, for free.
 *
 * Zero hard dependency: if ffmpeg OR the logo file is missing, `watermarkVideo`
 * returns null and the caller sends the un-watermarked source URL — the free
 * flow never breaks. If the CTA font is missing it degrades to logo-only, so a
 * partial toolchain still brands the clip.
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The NeuroShot logo lockup. Commit it here to enable branding. */
const LOGO_PATH = fileURLToPath(new URL("../public/watermark.png", import.meta.url));
/** Cyrillic-capable font for the CTA text (shipped via fonts-dejavu-core). */
const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
/** Padding from each edge, in px. */
const EDGE_PADDING = 40;
/** Rendered logo width in px (scaled from the source PNG, ratio preserved). */
const MARK_WIDTH = 300;
/** Logo overlay opacity (0–1): 0.85 reads as a solid brand badge with a soft edge. */
const MARK_OPACITY = 0.85;
/** CTA font size in px (tuned for 720–768p output; box keeps it readable). */
const CTA_FONTSIZE = 30;
/** Hard cap so a stuck ffmpeg can't wedge the request. */
const FFMPEG_TIMEOUT_MS = 60_000;

let logoReady: boolean | null = null;
let ffmpegReady: boolean | null = null;
let fontReady: boolean | null = null;

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

async function hasLogo(): Promise<boolean> {
  if (logoReady == null) logoReady = await fileExists(LOGO_PATH);
  return logoReady;
}

async function hasFont(): Promise<boolean> {
  if (fontReady == null) fontReady = await fileExists(FONT_PATH);
  return fontReady;
}

/** True when a call to watermarkVideo could actually brand the file. */
export async function watermarkEnabled(): Promise<boolean> {
  return (await hasLogo()) && (await hasFfmpeg());
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
 * The conversion line shown at the bottom of every free clip. Override the copy
 * with the WATERMARK_CTA env var (use `{bot}` where the handle should go) — so
 * the CTA can be A/B-tested without a code change. Default is the punchy option.
 */
function ctaText(botUsername?: string): string {
  const handle = botUsername ? `@${botUsername}` : "NeuroShot.ai";
  const template = process.env.WATERMARK_CTA || "Сделай такое же бесплатно → {bot}";
  return template.replace(/\{bot\}/g, handle);
}

/**
 * Download `url`, overlay the NeuroShot logo (top) and the bot-handle CTA
 * (bottom bar), and return the branded MP4 bytes — or null if branding is
 * unavailable or fails (caller then sends the source URL unchanged, so a
 * watermark hiccup never blocks a free result). Audio is copied through.
 *
 * `botUsername` (from config.webappBotUsername) drives the CTA so it always
 * points at the real bot — no hardcoded handle.
 */
export async function watermarkVideo(url: string, botUsername?: string): Promise<Buffer | null> {
  if (!(await watermarkEnabled())) return null;
  let dir: string | null = null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const src = Buffer.from(await res.arrayBuffer());
    dir = await mkdtemp(join(tmpdir(), "nswm-"));
    const inPath = join(dir, "in.mp4");
    const outPath = join(dir, "out.mp4");
    await writeFile(inPath, src);

    // Logo overlay: scale, apply opacity (RGBA-safe), place top-centre.
    const logo =
      `[1:v]scale=${MARK_WIDTH}:-1,format=rgba,colorchannelmixer=aa=${MARK_OPACITY}[wm];` +
      `[0:v][wm]overlay=x=(W-w)/2:y=${EDGE_PADDING}`;

    // CTA bar: white text on a translucent box, bottom-centre. Loaded from a
    // textfile so Cyrillic + punctuation need no filtergraph escaping. Degrades
    // to logo-only when the font is missing (drawtext would otherwise fail hard).
    let filter = logo;
    if (await hasFont()) {
      const ctaPath = join(dir, "cta.txt");
      await writeFile(ctaPath, ctaText(botUsername), "utf8");
      filter =
        `${logo}[bg];` +
        `[bg]drawtext=fontfile=${FONT_PATH}:textfile=${ctaPath}:fontcolor=white:` +
        `fontsize=${CTA_FONTSIZE}:box=1:boxcolor=black@0.5:boxborderw=16:` +
        `x=(w-tw)/2:y=h-th-${EDGE_PADDING}`;
    }

    const ok = await runFfmpeg([
      "-y",
      "-i", inPath,
      "-i", LOGO_PATH,
      "-filter_complex", filter,
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
