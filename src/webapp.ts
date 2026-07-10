/**
 * Telegram Mini App backend — the shared web layer. Serves the app HTML and a
 * JSON API backed by the SAME SQLite state as the bot (credits, gallery,
 * dashboard), so a user's content and balance are identical in bot and web.
 *
 * Auth: every API call carries Telegram WebApp `initData`, validated by HMAC
 * against the bot token (Telegram spec) — no separate login.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fal } from "@fal-ai/client";
import { config } from "./config.js";
import { issueSession, verifySession } from "./auth.js";
import { getGeneration, getOrCreateUser, getUser, recentGenerations, userDashboard } from "./db.js";
import { modelByKey, startWebGeneration } from "./generate.js";
import { sanitizePrompt } from "./promptcraft.js";
import {
  campaignById,
  CAMPAIGNS,
  EPIC_VIDEO,
  IMAGE_MODEL_PICKER,
  MODEL_NEWS,
  MODELS,
  normalizeOpts,
  PACKS,
  PRESET_MODEL,
  PRESETS,
  priceFor,
  sceneModel,
  VIDEO_MODEL_PICKER,
  VIDEO_STORY,
  type GenOpts,
  type ModelSpec,
} from "./models.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Static PWA assets live in public/ (Vercel serves them at root automatically;
// the Node server below mirrors that) — one source of truth for both hosts.
const PUBLIC_DIR = join(HERE, "..", "public");
const APP_HTML = readFileSync(join(PUBLIC_DIR, "app.html"), "utf8");

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

/** Minimal header bag shared by node:http and Vercel request objects. */
export type Headers = Record<string, string | string[] | undefined>;

/**
 * Validate Telegram WebApp initData and return the user, or null if invalid.
 * secret = HMAC_SHA256("WebAppData", bot_token); check = HMAC_SHA256(secret, dcs).
 */
export function verifyInitData(initData: string, botToken: string, maxAgeSec = 86400): TgUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  const pairs: string[] = [];
  for (const [k, v] of params) if (k !== "hash") pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Require a valid auth_date and reject stale or future-dated payloads
  // (missing/non-numeric auth_date must NOT be treated as always-fresh).
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  const ageSec = Date.now() / 1000 - authDate;
  if (maxAgeSec > 0 && ageSec > maxAgeSec) return null;
  if (ageSec < -300) return null; // >5min in the future → clock skew / forged

  try {
    const user = JSON.parse(params.get("user") ?? "null") as TgUser | null;
    return user && typeof user.id === "number" ? user : null;
  } catch {
    return null;
  }
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}
/** Enforce a route's HTTP method; on mismatch write 405 and return false. */
function methodIs(res: ServerResponse, method: string | undefined, allowed: string): boolean {
  if (method === allowed) return true;
  res.setHeader("Allow", allowed);
  json(res, 405, { error: "method_not_allowed" });
  return false;
}
function json(res: ServerResponse, status: number, obj: unknown): void {
  send(res, status, JSON.stringify(obj), "application/json; charset=utf-8");
}

function header(headers: Headers, name: string): string {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** initData from `Authorization: tma <initData>` (Telegram convention) or the alt header. */
function initDataFromHeaders(headers: Headers): string {
  const auth = header(headers, "authorization");
  if (auth.startsWith("tma ")) return auth.slice(4);
  return header(headers, "x-telegram-init-data");
}

/** Session JWT from `Authorization: Bearer <token>` (non-Telegram clients: PWA/iOS). */
function bearerFromHeaders(headers: Headers): string {
  const auth = header(headers, "authorization");
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

/**
 * Resolve the caller from request headers, accepting EITHER credential:
 *   • Telegram Mini App → `initData` (verified by HMAC against the bot token);
 *   • PWA / iOS / any non-Telegram client → a `Bearer` session token.
 * Returns null when neither is present or valid.
 */
export function resolveUser(headers: Headers): TgUser | null {
  const initData = initDataFromHeaders(headers);
  if (initData) return verifyInitData(initData, config.botToken);

  const token = bearerFromHeaders(headers);
  if (token) {
    const claims = verifySession(token, config.botToken);
    if (claims) return { id: claims.sub, username: claims.username, first_name: claims.first_name };
  }
  return null;
}

/**
 * POST /api/auth — exchange Telegram `initData` for a client-agnostic session
 * token. Called once at Mini App launch; the client keeps the token so it can
 * hit the same API later outside Telegram (installed PWA, native app).
 */
export function authResponse(headers: Headers): { status: number; body: Record<string, unknown> } {
  const user = verifyInitData(initDataFromHeaders(headers), config.botToken);
  if (!user) return { status: 401, body: { error: "unauthorized" } };
  const { token, expiresAt } = issueSession(
    { sub: user.id, username: user.username, first_name: user.first_name },
    config.botToken,
  );
  return {
    status: 200,
    body: {
      token,
      token_type: "Bearer",
      expires_at: expiresAt,
      user: { id: user.id, username: user.username, first_name: user.first_name },
    },
  };
}

/** Pack catalog payload — one source of truth with the bot's /buy. */
function packsPayload(): Array<Record<string, unknown>> {
  return PACKS.map((p) => ({ id: p.id, title: p.title, credits: p.credits, stars: p.stars }));
}

/**
 * The creation catalog for the in-app studio: everything the bot can render,
 * with prices — presets, campaigns (incl. their video upsell) and the top-model
 * pickers. Ids are validated server-side on /api/generate, so the client never
 * supplies prompts for curated flows.
 */
function catalogPayload(): Record<string, unknown> {
  return {
    presetCredits: PRESET_MODEL.credits,
    presets: PRESETS.map((p) => ({ id: p.id, label: p.label, category: p.category })),
    campaigns: CAMPAIGNS.map((c) => ({
      id: c.id,
      label: c.label,
      header: c.header,
      ask: c.ask,
      presets: c.presets.map((p) => ({ id: p.id, label: p.label })),
      imageCredits: PRESET_MODEL.credits,
      animateLabel: c.animateLabel,
      videoCredits: c.animateModel.credits,
      videoModelKey: c.animateModel.key, // composer reads its duration/ratio params
      // On-theme viral video scenes (prompts stay server-side — labels/ids only).
      // Epic scenes carry the Seedance engine they're gated to + its price so the
      // app can badge them and show the right cost before the user commits.
      videoScenes: (c.videoScenes ?? []).map((s) => {
        const m = sceneModel(s, c.animateModel);
        return {
          id: s.id,
          label: s.label,
          tier: s.tier ?? "simple",
          videoModelKey: m.key,
          videoCredits: m.credits,
        };
      }),
      // Story-builder steps (fragments stay server-side — labels/ids only).
      quiz: (c.quiz ?? []).map((s) => ({
        id: s.id,
        question: s.question,
        options: s.options.map((o) => ({ id: o.id, label: o.label })),
      })),
    })),
    imageModels: IMAGE_MODEL_PICKER.map((k) => ({
      key: k,
      label: MODELS[k].label,
      credits: MODELS[k].credits,
    })),
    videoModels: VIDEO_MODEL_PICKER.map((k) => ({
      key: k,
      label: MODELS[k].label,
      credits: MODELS[k].credits,
      // Composer capabilities: selectable durations (with per-length price) + ratios.
      video: MODELS[k].video
        ? {
            durations: MODELS[k].video!.durations.map((d) => ({
              seconds: d,
              credits: priceFor(MODELS[k], { duration: d }),
            })),
            aspectRatios: MODELS[k].video!.aspectRatios,
          }
        : null,
    })),
    // Video story composer (personalize any image→video): ids/labels only.
    videoStory: VIDEO_STORY.map((s) => ({
      id: s.id,
      question: s.question,
      options: s.options.map((o) => ({ id: o.id, label: o.label })),
    })),
    // Sliding news banner: newest models, instantly triable from the studio.
    // The cheapest image model is flagged as the free-trial entry.
    news: MODEL_NEWS.map((n) => ({
      key: n.key,
      title: n.title,
      tag: n.tag,
      credits: MODELS[n.key].credits,
      kind: MODELS[n.key].kind,
      freeTrial: MODELS[n.key].credits <= config.freeCredits,
    })),
  };
}

/** Fetch the caller's shared state for the Mini App (onboards idempotently). */
export async function meResponse(user: TgUser): Promise<Record<string, unknown>> {
  await getOrCreateUser(user.id, user.username, null, config.freeCredits);
  const [dashboard, generations] = await Promise.all([
    userDashboard(user.id),
    recentGenerations(user.id, 30),
  ]);
  return {
    user: { id: user.id, username: user.username, first_name: user.first_name },
    dashboard,
    generations,
    bot_username: config.webappBotUsername,
    // Pack catalog for the app's pricing section — same source as the bot.
    packs: packsPayload(),
    catalog: catalogPayload(),
  };
}

/** Read a JSON request body with a hard size cap (uploads are base64 images). */
function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

const UPLOAD_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const UPLOAD_LIMIT = 9 * 1024 * 1024; // ~6.5MB of image as base64 JSON

/** data:image/...;base64,… → public fal storage URL usable as model input. */
export async function uploadResponse(
  body: Record<string, unknown> | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const data = typeof body?.data === "string" ? body.data : "";
  const m = /^data:([a-z/+.-]+);base64,(.+)$/is.exec(data);
  if (!m || !UPLOAD_MIME.has(m[1].toLowerCase())) {
    return { status: 400, body: { error: "bad_image" } };
  }
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) return { status: 400, body: { error: "bad_image" } };
  const url = await fal.storage.upload(new Blob([new Uint8Array(buf)], { type: m[1].toLowerCase() }));
  return { status: 200, body: { url } };
}

/** Only ever feed generated/uploaded HTTPS URLs back into models. */
function isHttpsUrl(v: unknown): v is string {
  return typeof v === "string" && v.length < 2048 && /^https:\/\//.test(v);
}

/** id → English fragment for the video story composer (curated, server-side). */
const VIDEO_FRAGMENTS = new Map(VIDEO_STORY.flatMap((s) => s.options.map((o) => [o.id, o.fragment])));

/**
 * Append the video composer's selections onto a base motion prompt: validated
 * story-fragment ids + a sanitized personalization field (hobby / pet / loved
 * things). Returns null on an unknown option id.
 */
function composeVideoStory(base: string, body: Record<string, unknown> | null): string | null {
  let out = base;
  for (const raw of Array.isArray(body?.options) ? (body.options as unknown[]) : []) {
    const frag = VIDEO_FRAGMENTS.get(String(raw));
    if (!frag) return null;
    out += ` ${frag}`;
  }
  const custom = sanitizePrompt(typeof body?.custom === "string" ? body.custom : "").slice(0, 200);
  if (custom) out += ` Personal touches to weave in subtly: ${custom}.`;
  return out;
}

/**
 * POST /api/generate — the in-app studio's engine. The client sends a source
 * reference (validated against the server-side catalog) — never a raw curated
 * prompt; free-text prompts go through the same promptcraft mapping as the bot.
 */
export async function generateResponse(
  userId: number,
  body: Record<string, unknown> | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const source = body?.source;
  // Image source: an uploaded HTTPS URL, or one of the CALLER'S OWN previous
  // generations by id (reusable works: no re-upload, owner-scoped).
  let imageUrl = isHttpsUrl(body?.image_url) ? body.image_url : undefined;
  if (!imageUrl && body?.generation_id != null) {
    const src = await getGeneration(Number(body.generation_id), userId);
    if (!src || src.status !== "ok" || !src.output_url) {
      return { status: 400, body: { error: "bad_source" } };
    }
    imageUrl = src.output_url;
  }
  // A video file can't be a model's image input (e.g. Seedance needs a frame).
  if (imageUrl && /\.(mp4|webm|mov)(\?|$)/i.test(imageUrl)) {
    return { status: 400, body: { error: "bad_source" } };
  }
  let model: ModelSpec, prompt: string, crafted;

  if (source === "preset") {
    const p = PRESETS.find((x) => x.id === body?.id);
    if (!p || !imageUrl) return { status: 400, body: { error: "bad_request" } };
    [model, prompt, crafted] = [PRESET_MODEL, p.prompt, true];
  } else if (source === "campaign") {
    const [campId, presetId] = String(body?.id ?? "").split(":");
    const c = campaignById(campId);
    const p = c?.presets.find((x) => x.id === presetId);
    if (!c || !p || !imageUrl) return { status: 400, body: { error: "bad_request" } };
    // Story-builder: append the selected quiz fragments (validated ids — the
    // client never sends prompt text) + a short sanitized free-words field.
    let composed = p.prompt;
    const fragments = new Map((c.quiz ?? []).flatMap((s) => s.options.map((o) => [o.id, o.fragment])));
    for (const raw of Array.isArray(body?.options) ? (body.options as unknown[]) : []) {
      const frag = fragments.get(String(raw));
      if (!frag) return { status: 400, body: { error: "bad_option" } };
      composed += ` ${frag}`;
    }
    const custom = sanitizePrompt(typeof body?.custom === "string" ? body.custom : "").slice(0, 200);
    if (custom) composed += ` Extra details from the user: ${custom}.`;
    [model, prompt, crafted] = [PRESET_MODEL, composed, true];
  } else if (source === "campaign_video") {
    const c = campaignById(String(body?.id ?? ""));
    if (!c || !imageUrl) return { status: 400, body: { error: "bad_request" } };
    // Model: the campaign default, or a video model the user swapped to (Seedance
    // for audio/physics, etc.) — price adjusts via priceFor below.
    let vmodel = c.animateModel;
    if (body?.model != null) {
      const m = modelByKey(String(body.model));
      if (!m || !(VIDEO_MODEL_PICKER as readonly string[]).includes(m.key)) {
        return { status: 400, body: { error: "bad_request" } };
      }
      vmodel = m;
    }
    // On-theme scene (viral topical suggestion) as the base motion, else default.
    let base = c.animatePrompt;
    if (body?.scene != null) {
      const sc = (c.videoScenes ?? []).find((s) => s.id === String(body.scene));
      if (!sc) return { status: 400, body: { error: "bad_scene" } };
      base = sc.prompt;
      // Epic scenes (physics / multi-actor / audio) need a Seedance engine — the
      // cheap Hailuo default can't carry them. Upgrade unless the user already
      // swapped to a Seedance model (their explicit choice wins if it's higher).
      if (sc.tier === "epic" && !vmodel.key.startsWith("seedance")) vmodel = EPIC_VIDEO;
    }
    // Base motion + optional video-composer story/personalization.
    const composed = composeVideoStory(base, body);
    if (composed === null) return { status: 400, body: { error: "bad_option" } };
    [model, prompt, crafted] = [vmodel, composed, true];
  } else if (source === "model") {
    const m = modelByKey(String(body?.model ?? ""));
    const allowed = new Set<string>([...IMAGE_MODEL_PICKER, ...VIDEO_MODEL_PICKER, "photo_edit", "premium_edit"]);
    if (!m || !allowed.has(m.key)) return { status: 400, body: { error: "bad_request" } };
    if (m.kind !== "text_to_image" && !imageUrl) return { status: 400, body: { error: "bad_request" } };
    let raw = typeof body?.prompt === "string" ? body.prompt : "";
    // Video: fold in the composer story/personalization before craft mapping.
    if (m.kind === "image_to_video") {
      const composed = composeVideoStory(raw, body);
      if (composed === null) return { status: 400, body: { error: "bad_option" } };
      raw = composed;
    }
    [model, prompt, crafted] = [m, raw, false];
  } else {
    return { status: 400, body: { error: "bad_request" } };
  }

  // Composer options (duration/aspect ratio) — validated against the model.
  const opts = normalizeOpts(model, {
    duration: body?.duration != null ? Number(body.duration) : undefined,
    aspectRatio: typeof body?.aspect_ratio === "string" ? body.aspect_ratio : undefined,
  } as GenOpts);
  if (opts === null) return { status: 400, body: { error: "bad_opts" } };

  const r = await startWebGeneration(userId, model, prompt, imageUrl, crafted, opts);
  if (!r.ok) {
    if (r.error === "insufficient") {
      const balance = (await getUser(userId))?.credits ?? 0;
      return {
        status: 402,
        body: { error: "insufficient", need: priceFor(model, opts), balance, packs: packsPayload() },
      };
    }
    return { status: 400, body: { error: r.error } };
  }
  const balance = (await getUser(userId))?.credits ?? 0;
  return { status: 200, body: { id: r.id, credits: r.credits, balance } };
}

/**
 * POST /api/invoice — a Telegram Stars invoice link for a pack, opened with
 * WebApp.openInvoice so the purchase completes WITHOUT leaving the app. The
 * payment lands in the bot's successful_payment handler (same payload format),
 * so crediting/referrals/partner payouts share one code path.
 */
/**
 * POST /api/send — deliver one of the caller's generations into their Telegram
 * chat with the bot (native save/forward/share from there). Owner-scoped.
 */
export async function sendResponse(
  userId: number,
  body: Record<string, unknown> | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const g = await getGeneration(Number(body?.id ?? NaN), userId);
  if (!g || g.status !== "ok" || !g.output_url) return { status: 404, body: { error: "not_found" } };
  const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(g.output_url);
  const apiBase = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
  const method = isVideo ? "sendVideo" : "sendPhoto";
  const res = await fetch(`${apiBase}/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: userId,
      [isVideo ? "video" : "photo"]: g.output_url,
      caption: "✨ Из вашей студии NeuroShot",
    }),
  });
  const data = (await res.json()) as { ok: boolean };
  if (!data.ok) return { status: 502, body: { error: "send_failed" } };
  return { status: 200, body: { ok: true } };
}

export async function invoiceResponse(
  body: Record<string, unknown> | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pack = PACKS.find((p) => p.id === body?.pack);
  if (!pack) return { status: 400, body: { error: "bad_request" } };
  const apiBase = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
  const res = await fetch(`${apiBase}/bot${config.botToken}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: pack.title,
      description: `${pack.credits} патронов на генерации`,
      payload: `pack:${pack.id}`,
      currency: "XTR",
      prices: [{ label: pack.title, amount: pack.stars }],
    }),
  });
  const data = (await res.json()) as { ok: boolean; result?: string };
  if (!data.ok || !data.result) return { status: 502, body: { error: "invoice_failed" } };
  return { status: 200, body: { link: data.result } };
}

/** Static PWA assets (installable web app / iOS home-screen). Served at root so
 *  the service worker can control the whole origin. */
const STATIC: Record<string, { file: string; type: string; cache: string }> = {
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json", cache: "public, max-age=3600" },
  // no-cache: let the browser revalidate the SW every load so updates ship
  // promptly (mirrors vercel.json). The SW itself controls asset caching.
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml", cache: "public, max-age=3600" },
};

/** Build the Mini App HTTP server (exported for tests; not started here). */
export function createWebApp(): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/healthz") return json(res, 200, { ok: true });

      if (url.pathname === "/" || url.pathname === "/app") {
        return send(res, 200, APP_HTML, "text/html; charset=utf-8");
      }

      const asset = STATIC[url.pathname];
      if (asset) {
        res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": asset.cache });
        return res.end(readFileSync(join(PUBLIC_DIR, asset.file)));
      }

      // POST /api/auth — initData → session token (client-agnostic).
      if (url.pathname === "/api/auth") {
        if (!methodIs(res, req.method, "POST")) return;
        const { status, body } = authResponse(req.headers);
        return json(res, status, body);
      }

      // GET /api/me — the caller's shared state.
      if (url.pathname === "/api/me") {
        if (!methodIs(res, req.method, "GET")) return;
        const user = resolveUser(req.headers);
        if (!user) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, await meResponse(user));
      }

      // POST /api/upload — base64 image → public URL for model input.
      if (url.pathname === "/api/upload") {
        if (!methodIs(res, req.method, "POST")) return;
        const user = resolveUser(req.headers);
        if (!user) return json(res, 401, { error: "unauthorized" });
        const { status, body } = await uploadResponse(await readJsonBody(req, UPLOAD_LIMIT));
        return json(res, status, body);
      }

      // POST /api/generate — charge + start a render; returns an id to poll.
      if (url.pathname === "/api/generate") {
        if (!methodIs(res, req.method, "POST")) return;
        const user = resolveUser(req.headers);
        if (!user) return json(res, 401, { error: "unauthorized" });
        await getOrCreateUser(user.id, user.username, null, config.freeCredits);
        const { status, body } = await generateResponse(user.id, await readJsonBody(req, 64 * 1024));
        return json(res, status, body);
      }

      // GET /api/generations/:id — poll a render's status (owner-scoped).
      const genMatch = /^\/api\/generations\/(\d+)$/.exec(url.pathname);
      if (genMatch) {
        if (!methodIs(res, req.method, "GET")) return;
        const user = resolveUser(req.headers);
        if (!user) return json(res, 401, { error: "unauthorized" });
        const g = await getGeneration(Number(genMatch[1]), user.id);
        if (!g) return json(res, 404, { error: "not_found" });
        return json(res, 200, {
          id: g.id,
          status: g.status,
          output_url: g.output_url,
          model: g.model,
          credits: g.credits,
        });
      }

      // POST /api/invoice — Stars invoice link for in-app pack purchase.
      if (url.pathname === "/api/invoice") {
        if (!methodIs(res, req.method, "POST")) return;
        const user = resolveUser(req.headers);
        if (!user) return json(res, 401, { error: "unauthorized" });
        const { status, body } = await invoiceResponse(await readJsonBody(req, 4 * 1024));
        return json(res, status, body);
      }

      // POST /api/send — deliver a generation into the user's Telegram chat.
      if (url.pathname === "/api/send") {
        if (!methodIs(res, req.method, "POST")) return;
        const user = resolveUser(req.headers);
        if (!user) return json(res, 401, { error: "unauthorized" });
        const { status, body } = await sendResponse(user.id, await readJsonBody(req, 4 * 1024));
        return json(res, status, body);
      }

      return json(res, 404, { error: "not_found" });
    } catch (e) {
      console.error("webapp error:", e);
      return json(res, 500, { error: "server_error" });
    }
  });
}

/** Start the Mini App server if a public URL is configured. */
export function startWebApp(): Server | null {
  if (!config.webappUrl) return null;
  const server = createWebApp();
  server.listen(config.webappPort, () => {
    console.log(`Mini App server on :${config.webappPort} (public: ${config.webappUrl})`);
  });
  return server;
}
