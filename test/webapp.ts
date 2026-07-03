/**
 * Web-app harness: verifies Telegram initData HMAC validation and that the
 * Mini App API serves the SAME state the bot writes (shared credits + gallery).
 *
 * Run: npm run test:webapp
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

const BOT_TOKEN = "1000000:TEST_TOKEN";
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.FAL_KEY = "test-fal-key";
// Force hermetic embedded pglite (see test/e2e.ts): never touch a real Postgres.
process.env.DATABASE_URL = "";
process.env.FREE_CREDITS = "3";
process.env.WEBAPP_URL = "https://app.test"; // enable app-config paths
process.env.BOT_USERNAME = "neuroshot_test_bot";

const { verifyInitData, createWebApp } = await import("../src/webapp.js");
const { getOrCreateUser, logGeneration, spendCredits } = await import("../src/db.js");

/** Build a validly-signed initData string for a user, per Telegram spec. */
function signInitData(user: { id: number; username?: string; first_name?: string }, token = BOT_TOKEN): string {
  const params = new URLSearchParams();
  params.set("user", JSON.stringify(user));
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "AAErandom");
  const pairs: string[] = [];
  for (const [k, v] of params) pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

let passed = 0;
async function step(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    throw err;
  }
}

console.log("NeuroShot web-app — initData auth + shared state\n");

await step("verifyInitData accepts a correctly signed payload", () => {
  const u = verifyInitData(signInitData({ id: 42, username: "neo", first_name: "Neo" }), BOT_TOKEN);
  assert.ok(u);
  assert.equal(u!.id, 42);
  assert.equal(u!.username, "neo");
});

await step("verifyInitData rejects a tampered hash", () => {
  const good = signInitData({ id: 42 });
  const tampered = good.replace(/hash=[0-9a-f]+/, "hash=deadbeef");
  assert.equal(verifyInitData(tampered, BOT_TOKEN), null);
});

await step("verifyInitData rejects a payload signed with a different token", () => {
  const forged = signInitData({ id: 42 }, "9999:OTHER_TOKEN");
  assert.equal(verifyInitData(forged, BOT_TOKEN), null);
});

/** Sign an initData with a caller-chosen auth_date (or none) — for freshness tests. */
function signWithAuthDate(authDate: number | null): string {
  const params = new URLSearchParams();
  params.set("user", JSON.stringify({ id: 7 }));
  if (authDate !== null) params.set("auth_date", String(authDate));
  const pairs = [...params].map(([k, v]) => `${k}=${v}`).sort();
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(pairs.join("\n")).digest("hex"));
  return params.toString();
}

await step("verifyInitData rejects a stale auth_date", () => {
  assert.equal(verifyInitData(signWithAuthDate(Math.floor(Date.now() / 1000) - 90000), BOT_TOKEN), null);
});

await step("verifyInitData rejects a missing auth_date (no always-fresh bypass)", () => {
  assert.equal(verifyInitData(signWithAuthDate(null), BOT_TOKEN), null);
});

await step("verifyInitData rejects a future-dated auth_date (clock skew guard)", () => {
  assert.equal(verifyInitData(signWithAuthDate(Math.floor(Date.now() / 1000) + 3600), BOT_TOKEN), null);
});

// ---- API over HTTP, backed by the shared DB ----

interface MeResponse {
  user: { id: number; username?: string; first_name?: string };
  dashboard: { credits: number; okGenerations: number; creditsSpent: number; referralEarned: number };
  generations: Array<{ output_url: string | null; status: string }>;
  bot_username: string;
}

const server = createWebApp();
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function apiMe(initData: string): Promise<{ status: number; body: MeResponse }> {
  const res = await fetch(`${base}/api/me`, { headers: { Authorization: `tma ${initData}` } });
  return { status: res.status, body: (await res.json()) as MeResponse };
}

await step("GET /api/me rejects a missing/invalid initData with 401", async () => {
  const res = await fetch(`${base}/api/me`);
  assert.equal(res.status, 401);
});

await step("GET /api/me onboards a new user with free credits (shared with bot)", async () => {
  const { status, body } = await apiMe(signInitData({ id: 555, username: "sam", first_name: "Sam" }));
  assert.equal(status, 200);
  assert.equal(body.user.id, 555);
  assert.equal(body.dashboard.credits, 3); // FREE_CREDITS
  assert.equal(body.bot_username, "neuroshot_test_bot"); // from BOT_USERNAME env
  assert.deepEqual(body.generations, []);
});

await step("app reflects the SAME state the bot writes: spend + gallery", async () => {
  // Simulate what the bot does: onboard, spend a credit, log a delivered result.
  await getOrCreateUser(555, "sam", null, 3);
  assert.equal(await spendCredits(555, 1, "photo_edit"), true);
  await logGeneration(555, "photo_edit", "make it pop", 1, "ok", "https://fal.test/out/1.png");

  const { body } = await apiMe(signInitData({ id: 555 }));
  assert.equal(body.dashboard.credits, 2); // 3 − 1
  assert.equal(body.dashboard.okGenerations, 1);
  assert.equal(body.dashboard.creditsSpent, 1);
  assert.equal(body.generations.length, 1);
  assert.equal(body.generations[0].output_url, "https://fal.test/out/1.png");
});

await step("GET / serves the Mini App HTML", async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(html, /telegram-web-app\.js/);
});

await new Promise<void>((r) => server.close(() => r()));
console.log(`\nAll ${passed} web-app checks passed. ✨`);
