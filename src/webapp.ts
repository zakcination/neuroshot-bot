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
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { issueSession, verifySession } from "./auth.js";
import { getOrCreateUser, recentGenerations, userDashboard } from "./db.js";

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
  };
}

/** Static PWA assets (installable web app / iOS home-screen). Served at root so
 *  the service worker can control the whole origin. */
const STATIC: Record<string, { file: string; type: string }> = {
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
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
        // no-store would defeat installability; let the SW/browser cache these.
        res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "public, max-age=3600" });
        return res.end(readFileSync(join(PUBLIC_DIR, asset.file)));
      }

      // POST /api/auth — initData → session token (client-agnostic).
      if (url.pathname === "/api/auth") {
        const { status, body } = authResponse(req.headers);
        return json(res, status, body);
      }

      if (url.pathname === "/api/me") {
        const user = resolveUser(req.headers);
        if (!user) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, await meResponse(user));
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
