/**
 * Vercel serverless function: GET /api/me
 * Returns the caller's shared state (credits, dashboard, gallery) from Neon —
 * the SAME data the bot writes. Authenticates by initData OR a Bearer session
 * token, so it serves both the in-Telegram Mini App and an installed PWA / app.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { meResponse, resolveUser } from "../src/webapp.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  try {
    const user = resolveUser(req.headers);
    if (!user) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(await meResponse(user)));
  } catch (e) {
    console.error("api/me error:", e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "server_error" }));
  }
}
