/**
 * Brand watermark for FREE deliverables — every free scenario video carries the
 * NeuroShot logo + wordmark so each share markets us (the viral loop). Overlays
 * `public/watermark.png` (a transparent logo+"NeuroShot.ai" lockup) at the
 * bottom-center of the video via ffmpeg.
 *
 * Zero hard dependency: if ffmpeg OR the logo file is missing, `watermarkVideo`
 * returns null and the caller simply sends the un-watermarked source URL. So the
 * whole free flow keeps working before the logo asset is committed / ffmpeg is
 * added to the image — the watermark switches on automatically once both exist.
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The logo+wordmark lockup (transparent PNG). Commit it here to enable branding. */
const LOGO_PATH = fileURLToPath(new URL("../public/watermark.png", import.meta.url));
/** Padding from the bottom edge, in px (spec: 40–50). */
const BOTTOM_PADDING = 45;
/** Rendered watermark width in px (scaled from the source PNG, ratio preserved). */
const MARK_WIDTH = 320;
/** Hard cap so a stuck ffmpeg can't wedge the request. */
const FFMPEG_TIMEOUT_MS = 60_000;

let logoReady: boolean | null = null;
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

async function hasLogo(): Promise<boolean> {
  if (logoReady == null) logoReady = await fileExists(LOGO_PATH);
  return logoReady;
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
 * Download `url`, overlay the brand mark at bottom-center (BOTTOM_PADDING px up),
 * and return the branded MP4 bytes — or null if branding is unavailable or fails
 * (caller then sends the source URL unchanged, so a watermark hiccup never blocks
 * a free result). Audio is copied through untouched.
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
      "-i", LOGO_PATH,
      "-filter_complex",
      `[1:v]scale=${MARK_WIDTH}:-1[wm];[0:v][wm]overlay=x=(W-w)/2:y=H-h-${BOTTOM_PADDING}`,
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
