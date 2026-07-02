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
import { config } from "./config.js";
import { getOrCreateUser, recentGenerations, userDashboard } from "./db.js";

const APP_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "webapp.html"), "utf8");

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

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

/** initData from the `Authorization: tma <initData>` header (Telegram convention). */
function initDataFromReq(req: IncomingMessage): string {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("tma ")) return auth.slice(4);
  const alt = req.headers["x-telegram-init-data"];
  return typeof alt === "string" ? alt : "";
}

/** Build the Mini App HTTP server (exported for tests; not started here). */
export function createWebApp(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz") return json(res, 200, { ok: true });

    if (url.pathname === "/" || url.pathname === "/app") {
      return send(res, 200, APP_HTML, "text/html; charset=utf-8");
    }

    if (url.pathname === "/api/me") {
      const user = verifyInitData(initDataFromReq(req), config.botToken);
      if (!user) return json(res, 401, { error: "unauthorized" });
      // Opening the app also onboards (idempotent) — shared with the bot.
      getOrCreateUser(user.id, user.username, null, config.freeCredits);
      return json(res, 200, {
        user: { id: user.id, username: user.username, first_name: user.first_name },
        dashboard: userDashboard(user.id),
        generations: recentGenerations(user.id, 30),
        bot_username: config.webappBotUsername,
      });
    }

    return json(res, 404, { error: "not_found" });
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
