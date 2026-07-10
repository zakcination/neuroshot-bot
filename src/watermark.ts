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

/** The CTA badge artwork (RGBA PNG). Replace this file to change the watermark. */
const BADGE_PATH = fileURLToPath(new URL("../public/watermark.png", import.meta.url));
/** Padding from the bottom edge, in px. */
const BOTTOM_PADDING = 32;
/** Rendered badge width in px (scaled from the source, ratio preserved). Wide,
 * since the badge is a readable bottom banner rather than a small corner mark. */
const MARK_WIDTH = 640;
/** Overlay opacity (0–1). 0.95 keeps the CTA crisp and readable on any clip. */
const MARK_OPACITY = 0.95;
/** Hard cap so a stuck ffmpeg can't wedge the request. */
const FFMPEG_TIMEOUT_MS = 60_000;

let badgeReady: boolean | null = null;
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

async function hasBadge(): Promise<boolean> {
  if (badgeReady == null) badgeReady = await fileExists(BADGE_PATH);
  return badgeReady;
}

/** True when a call to watermarkVideo could actually brand the file. */
export async function watermarkEnabled(): Promise<boolean> {
  return (await hasBadge()) && (await hasFfmpeg());
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
export async function watermarkVideo(url: string): Promise<Buffer | null> {
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
    const ok = await runFfmpeg([
      "-y",
      "-i", inPath,
      "-i", BADGE_PATH,
      "-filter_complex",
      // Scale the badge, apply opacity (RGBA-safe — transparent corners stay
      // clear), overlay bottom-centre.
      `[1:v]scale=${MARK_WIDTH}:-1,format=rgba,colorchannelmixer=aa=${MARK_OPACITY}[wm];` +
        `[0:v][wm]overlay=x=(W-w)/2:y=H-h-${BOTTOM_PADDING}`,
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
export async function watermarkImage(url: string): Promise<Buffer | null> {
  if (!(await watermarkEnabled())) return null;
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
      "-i", BADGE_PATH,
      "-filter_complex",
      `[1:v]scale=${MARK_WIDTH}:-1,format=rgba,colorchannelmixer=aa=${MARK_OPACITY}[wm];` +
        `[0:v][wm]overlay=x=(W-w)/2:y=H-h-${BOTTOM_PADDING}`,
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
