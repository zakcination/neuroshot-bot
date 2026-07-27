/**
 * Screening for the NON-IMAGE reference files a user can attach to a video
 * (Seedance reference mode): audio clips and short video clips.
 *
 * WHAT THIS CAN AND CANNOT DO. Our content gate is an image classifier. That
 * covers a video — one frame is extracted and screened like any upload — but
 * there is no classifier for audio anywhere in this system. An audio reference
 * therefore reaches the provider unscreened, and the schema is explicit that
 * audio exists to drive a person's SPEECH. The product's answer is an explicit
 * warning plus a recorded acknowledgement that the uploader holds the rights
 * (owner's decision, 2026-07-27). Be clear-eyed about what that buys: it settles
 * responsibility BETWEEN us and the uploader; it does not remove our own duties
 * as the operator processing the file, and a voice sample is biometric data
 * under the Republic of Kazakhstan's personal-data law.
 *
 * The duration and size caps below are the ENDPOINT's, not ours, except where
 * noted — a file that fails them would be rejected by the provider after we had
 * already paid to host and move it.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Provider limits (bytedance/seedance-2.0/*\/reference-to-video). */
export const REF_LIMITS = {
  images: { max: 9 },
  audio: { max: 3, combinedSeconds: 15 },
  video: { max: 3, minCombinedSeconds: 2, maxCombinedSeconds: 15 },
  /** Across ALL modalities, images included. The endpoint's own ceiling. */
  totalFiles: 12,
} as const;

/**
 * Per-file byte caps. The endpoint is more generous (30 MB an image, 15 MB an
 * audio file, 50 MB of video in total) but every upload arrives base64 inside a
 * JSON body and is held in memory on a small machine that is also running
 * ffmpeg. These are OUR limits, chosen so a single upload cannot take the
 * process down, and the UI states them.
 */
export const MEDIA_BYTES = { audio: 15 * 1024 * 1024, video: 12 * 1024 * 1024 } as const;

export const AUDIO_MIME = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"]);
export const VIDEO_MIME = new Set(["video/mp4", "video/quicktime"]);

const FFPROBE_TIMEOUT_MS = 20_000;

/** Run a command, capture stdout, resolve null on failure/timeout. */
function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, FFPROBE_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

export interface MediaProbe {
  seconds: number;
  width: number;
  height: number;
}

/**
 * Read duration and dimensions from bytes on disk. Returns null when ffprobe is
 * unavailable or the file is unreadable — callers must treat that as a REJECT,
 * not as "no limits apply": an unprobeable file is one we cannot vouch for.
 */
export async function probeMedia(path: string): Promise<MediaProbe | null> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=width,height",
    "-of", "json",
    path,
  ]);
  if (!out) return null;
  try {
    const j = JSON.parse(out) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number }> };
    const seconds = Number(j.format?.duration ?? NaN);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const withSize = (j.streams ?? []).find((s) => s.width && s.height);
    return { seconds, width: withSize?.width ?? 0, height: withSize?.height ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Pull a single frame out of a video so the image classifier has something to
 * screen. Taken one second in rather than at 0:00 — the first frame of a phone
 * recording is very often black, and a black frame tells a classifier nothing.
 * Falls back to the very first frame for clips shorter than that.
 */
export async function extractFrame(videoPath: string, seconds: number): Promise<Buffer | null> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "nsprobe-"));
    const out = join(dir, "frame.png");
    const at = seconds > 1.5 ? "1" : "0";
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn("ffmpeg", ["-y", "-ss", at, "-i", videoPath, "-frames:v", "1", out], { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, FFPROBE_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    if (!ok) return null;
    const { readFile } = await import("node:fs/promises");
    return await readFile(out);
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Write bytes to a scratch file and hand back the path plus a cleanup. */
export async function withTempFile<T>(bytes: Buffer, ext: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "nsmedia-"));
  try {
    const path = join(dir, `in.${ext}`);
    await writeFile(path, bytes);
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** File extension for a MIME type we accept. */
export function extensionFor(mime: string): string {
  switch (mime) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "video/quicktime":
      return "mov";
    default:
      return "mp4";
  }
}

/**
 * The warning shown before a user may attach audio or video, and recorded when
 * they accept. Kept here next to the limits so the copy and the rules cannot
 * drift apart.
 */
export const REFERENCE_RIGHTS_NOTICE =
  "Загружая аудио или видео, вы подтверждаете, что имеете право использовать этот материал: " +
  "это ваша запись, либо у вас есть согласие людей, чьи голос и лицо на ней. " +
  "Ответственность за загруженные файлы несёт загрузивший. " +
  "Не загружайте записи чужого голоса без разрешения — это нарушает закон и наши условия.";
