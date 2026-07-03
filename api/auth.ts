/**
 * Vercel serverless function: POST /api/auth
 * Exchanges Telegram initData for a client-agnostic session token. Stateless —
 * fits serverless perfectly; talks to nothing (pure crypto). Shares the exact
 * handler used by the process-based Node server (src/webapp.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { authResponse } from "../src/webapp.js";

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  const { status, body } = authResponse(req.headers);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
