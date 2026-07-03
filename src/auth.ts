/**
 * Client-agnostic session tokens (JWT, HS256) — the layer that lets NON-Telegram
 * clients (installed PWA, a future iOS app) talk to the same API the Mini App
 * uses. Inside Telegram a client has fresh `initData` on every launch; outside
 * it, it has nothing. So the flow is: verify `initData` ONCE (see webapp.ts) →
 * mint a short-lived session token here → the client stores it and sends
 * `Authorization: Bearer <token>` on subsequent calls until it expires.
 *
 * Compact JWT implemented on node:crypto (no dependency). The signing key is
 * DERIVED from the bot token (domain-separated) so we never sign with the raw
 * token and no extra secret needs provisioning.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  sub: number; // Telegram user id
  username?: string;
  first_name?: string;
}
interface TokenPayload extends SessionClaims {
  iat: number; // issued-at (epoch seconds)
  exp: number; // expiry (epoch seconds)
}

const DEFAULT_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj), "utf8"));
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Domain-separated signing key — never sign with the raw bot token. */
function signingKey(botToken: string): Buffer {
  return createHmac("sha256", "NeuroShotSession").update(botToken).digest();
}
function sign(data: string, botToken: string): string {
  return b64url(createHmac("sha256", signingKey(botToken)).update(data).digest());
}

/** Mint a signed session token for a user. `nowSec` is injectable for tests. */
export function issueSession(
  claims: SessionClaims,
  botToken: string,
  ttlSec = DEFAULT_TTL_SEC,
  nowSec = Math.floor(Date.now() / 1000),
): { token: string; expiresAt: number } {
  const payload: TokenPayload = {
    sub: claims.sub,
    ...(claims.username ? { username: claims.username } : {}),
    ...(claims.first_name ? { first_name: claims.first_name } : {}),
    iat: nowSec,
    exp: nowSec + ttlSec,
  };
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = `${header}.${b64urlJson(payload)}`;
  return { token: `${body}.${sign(body, botToken)}`, expiresAt: payload.exp };
}

/**
 * Verify a session token; returns the claims or null (bad shape, bad signature,
 * or expired). Signature is compared in constant time.
 */
export function verifySession(
  token: string,
  botToken: string,
  nowSec = Math.floor(Date.now() / 1000),
): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;

  const expected = sign(`${header}.${payload}`, botToken);
  const a = fromB64url(sig);
  const b = fromB64url(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let claims: TokenPayload;
  try {
    claims = JSON.parse(fromB64url(payload).toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (typeof claims.sub !== "number" || typeof claims.exp !== "number") return null;
  if (nowSec >= claims.exp) return null;
  return { sub: claims.sub, username: claims.username, first_name: claims.first_name };
}
