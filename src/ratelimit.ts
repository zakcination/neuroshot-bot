/**
 * Minimal in-memory, per-process rate limiter for the cost/abuse-sensitive
 * write endpoints (audit finding: zero rate limiting existed anywhere in the
 * HTTP API, including /api/upload).
 *
 * Single-process fixed-window counter — no shared store (Redis etc.) needed:
 * the app runs as ONE Fly.io process by architectural necessity (grammY long
 * polling forbids >1 replica, see docs/deploy.md), so in-memory state is
 * already the durability model the whole app relies on elsewhere. A redeploy
 * resets everyone's window, which is an acceptable cold-start for a rate
 * limiter (unlike credits/orders, nothing here is money).
 *
 * Read-only polling (/api/me, /api/generations*) is deliberately NOT limited
 * here — the Studio polls those every ~2.5s during a render.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Bound memory: sweep expired buckets periodically rather than growing
// forever across many distinct IPs over a long-running process. unref() so
// this timer never keeps the process (or a test run) alive on its own.
setInterval(
  () => {
    const now = Date.now();
    for (const [key, b] of buckets) if (now >= b.resetAt) buckets.delete(key);
  },
  5 * 60_000,
).unref();

/**
 * Record a hit for `key` (route + client identity) and report whether it
 * exceeds `limit` requests within the current fixed `windowMs` window.
 */
export function hit(key: string, limit: number, windowMs: number): { limited: boolean; retryAfterMs: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, retryAfterMs: 0 };
  }
  b.count++;
  return { limited: b.count > limit, retryAfterMs: b.resetAt - now };
}
