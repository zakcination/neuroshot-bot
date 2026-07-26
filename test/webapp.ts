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
// This suite's fake provider storage lives on fal.test. Production's allow-list
// (config.mediaHostSuffixes) is the real fal CDN, so the fake host is declared
// HERE rather than baked into the shipped default — a test hostname must never
// be an accepted origin in production.
process.env.MEDIA_HOST_SUFFIXES = "fal.test";
process.env.WEBAPP_URL = "https://app.test"; // enable app-config paths
process.env.BOT_USERNAME = "neuroshot_test_bot";
process.env.KASPI_PAY_URL = "https://pay.test/neuroshot"; // enable the Kaspi order flow
process.env.KASPI_PAY_URL_COMBO = "https://pay.test/combo"; // per-pack fixed-amount link
process.env.KASPI_API_SECRET = "test-kaspi-secret"; // enable the auto-approval callback
// Rate limiting (src/ratelimit.ts): the shared "maker" user below makes FAR
// more than the production default (30/min) worth of /api/generate calls
// across this suite's ~40 steps, all within the same wall-clock minute since
// tests run near-instantly — that's a suite-speed artifact, not something
// production traffic does. Set high here; the dedicated rate-limiting step
// primes its OWN fresh users' buckets directly rather than relying on this
// value, so it still exercises the real limit from config.
process.env.RATE_LIMIT_AUTH_PER_MIN = "100000";
process.env.RATE_LIMIT_UPLOAD_PER_MIN = "100000";
process.env.RATE_LIMIT_GENERATE_PER_MIN = "100000";
process.env.RATE_LIMIT_ENHANCE_PER_MIN = "100000";

const { fal } = await import("@fal-ai/client");
const { verifyInitData, createWebApp, kaspiCallbackResponse } = await import("../src/webapp.js");
const { issueSession, verifySession } = await import("../src/auth.js");
const { addCredits, awardXp, completeGeneration, createOrder, createPendingGeneration, createSeason, getOrCreateUser, getOrder, getLevel, getUserXp, grantedOrders, grantOrderCredits, awardPurchaseXp, staleGrantedOrders, abandonedPaidOrders, claimPush, releasePush, usersForPaywallPush, offerBonusFor, claimOfferRedemption, pushReport, achievements, certificates, issueCertificate, joinPartnerProgram, createPartnerCode, markReleaseSeen, releaseState, referralFinance, referrerLedger, logEvent, logGeneration, purchaseLedgerCount, query, resolveOrder, setEconomyConfig, setPresetGating, spendCredits } = await import("../src/db.js");
const { afterKeyboard, whatsappShareUrl } = await import("../src/generate.js");
const { kaspiVerifyOrder } = await import("../src/kaspi.js");
const { kaspiLinkFor } = await import("../src/config.js");
const { claimOrderPaid, settleApprovedOrder } = await import("../src/payments.js");
const { hit } = await import("../src/ratelimit.js");
const { config } = await import("../src/config.js");
const { Api } = await import("grammy");

// ---- fal stubs (network edge): model runs + storage uploads ----
interface FalCall {
  endpoint: string;
  input: Record<string, unknown>;
}
const falCalls: FalCall[] = [];
let anyLlmFail = false; // flip to make the enhancer's LLM call blow up (refund path)
// Flip to make every generation model reject the way a LOCKED PROVIDER ACCOUNT
// does (403 + "Exhausted balance") — the failure that masquerades as one
// broken model. Reset to false to simulate the balance being topped up.
let providerLocked = false;
// Content moderation (moderation.ts): tracked as its OWN edge, NOT pushed into
// falCalls — several assertions use falCalls.length/.at(-1) to mean "the
// generation MODEL ran", and this classifier call happens in addition to that
// on every upload. Default SAFE (0) so existing journeys are unaffected;
// individual steps flip this to exercise the block path, then reset it to 0.
let nsfwProbability = 0;
let nsfwCheckCalls = 0;
(fal as { subscribe: unknown }).subscribe = async (
  endpoint: string,
  opts: { input: Record<string, unknown> },
) => {
  if (endpoint === "fal-ai/imageutils/nsfw") {
    nsfwCheckCalls++;
    return { data: { nsfw_probability: nsfwProbability }, requestId: `req-nsfw-${nsfwCheckCalls}` };
  }
  falCalls.push({ endpoint, input: opts.input });
  if (providerLocked) {
    const e = new Error("Forbidden") as Error & { status: number; body: unknown };
    e.status = 403;
    e.body = { detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." };
    throw e;
  }
  if (endpoint === "fal-ai/any-llm") {
    if (anyLlmFail) throw new Error("llm boom");
    return { data: { output: `Cinematic, richly lit: ${String(opts.input.prompt)}` }, requestId: `req-${falCalls.length}` };
  }
  if (endpoint.includes("video")) {
    return { data: { video: { url: `https://fal.test/out/${falCalls.length}.mp4` } }, requestId: `req-${falCalls.length}` };
  }
  // num_images (P5, docs/cinema-studio-model-params.md): the real fal image
  // endpoints return one images[] entry per requested count — mirror that so
  // multi-output storage/pricing/delivery can be tested end-to-end.
  const n = typeof opts.input.num_images === "number" ? opts.input.num_images : 1;
  const images = Array.from({ length: n }, (_, i) => ({ url: `https://fal.test/out/${falCalls.length}-${i}.png` }));
  return { data: { images }, requestId: `req-${falCalls.length}` };
};
// fal.storage is a getter — patch the method on the storage client instance.
(fal.storage as unknown as { upload: unknown }).upload = async (blob: Blob) =>
  `https://fal.test/storage/u-${blob.size}.jpg`;

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
  user: { id: number; username?: string; first_name?: string; ref_code: string };
  dashboard: { credits: number; okGenerations: number; creditsSpent: number; referralEarned: number };
  generations: Array<{ output_url: string | null; status: string }>;
  bot_username: string;
  welcomeBonus: { pending: number; claimed: boolean };
  onboardingSeen: boolean;
  roadmap: { firstPhoto: boolean; ownIdea: boolean; revivePhoto: boolean; scenario: boolean; invitedFriend: boolean };
  roadmapBonus: { amount: number; claimed: boolean };
  referrals: Array<{ username: string | null; joinedAt: string; status: "inactive" | "used_free" | "paid" }>;
  packs: Array<{ id: string; title: string; credits: number; kzt: number; offer: boolean }>;
  catalog: {
    presetCredits: number;
    presets: Array<{ id: string; label: string; category: string; credits: number; previewUrl: string; usageCount: number; trending: boolean }>;
    campaigns: Array<{
      id: string;
      label: string;
      imageCredits: number;
      videoCredits: number;
      presets: Array<{ id: string; label: string }>;
    }>;
    imageModels: Array<{ key: string; label: string; credits: number }>;
    videoModels: Array<{ key: string; label: string; credits: number }>;
  };
  progress: {
    active: boolean; xp: number; level: number; levelAt: number;
    nextAt: number | null; into: number; span: number;
  };
}

const server = createWebApp();
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function apiMe(initData: string): Promise<{ status: number; body: MeResponse }> {
  const res = await fetch(`${base}/api/me`, { headers: { Authorization: `tma ${initData}` } });
  return { status: res.status, body: (await res.json()) as MeResponse };
}

async function apiClaimWelcome(
  initData: string,
): Promise<{ status: number; body: { granted: number; alreadyClaimed?: boolean } }> {
  const res = await fetch(`${base}/api/claim-welcome`, {
    method: "POST",
    headers: { Authorization: `tma ${initData}` },
  });
  return { status: res.status, body: (await res.json()) as { granted: number; alreadyClaimed?: boolean } };
}

await step("GET /api/me rejects a missing/invalid initData with 401", async () => {
  const res = await fetch(`${base}/api/me`);
  assert.equal(res.status, 401);
});

await step("GET /api/me onboards a new user with a CLAIMABLE welcome bonus (shared with bot)", async () => {
  const { status, body } = await apiMe(signInitData({ id: 555, username: "sam", first_name: "Sam" }));
  assert.equal(status, 200);
  assert.equal(body.user.id, 555);
  // Never the raw tg id — the Mini App's Друзья page builds the share link from this.
  assert.match(body.user.ref_code, /^[a-z2-9]{6}$/);
  assert.notEqual(body.user.ref_code, "555");
  // Claim-gated: nothing lands in the spendable balance until POST /api/claim-welcome.
  assert.equal(body.dashboard.credits, 0);
  assert.deepEqual(body.welcomeBonus, { pending: 3, claimed: false }); // FREE_CREDITS
  assert.equal(body.onboardingSeen, false); // slideshow hasn't been dismissed yet
  assert.equal(body.bot_username, "neuroshot_test_bot"); // from BOT_USERNAME env
  assert.deepEqual(body.generations, []);
  // Pack catalog rides along — one source of truth with the bot's /buy.
  assert.equal(body.packs.length, 5); // 4 ladder + the combo offer
  assert.ok(body.packs.every((p) => p.kzt > 0 && p.credits > 0 && p.id));
  assert.ok(body.packs.some((p) => p.id === "combo" && p.offer), "combo offer missing");
});

await step("POST /api/claim-welcome moves the parked bonus into credits, once", async () => {
  const initData = signInitData({ id: 555, username: "sam", first_name: "Sam" });
  const { status, body } = await apiClaimWelcome(initData);
  assert.equal(status, 200);
  assert.equal(body.granted, 3);

  const after = await apiMe(initData);
  assert.equal(after.body.dashboard.credits, 3);
  assert.deepEqual(after.body.welcomeBonus, { pending: 3, claimed: true }); // pending is a snapshot, stays visible

  // A second claim is a no-op, not a double credit.
  const again = await apiClaimWelcome(initData);
  assert.equal(again.body.granted, 0);
  assert.equal(again.body.alreadyClaimed, true);
  assert.equal((await apiMe(initData)).body.dashboard.credits, 3);
});

await step("POST /api/ack-onboarding: the slideshow is decoupled from welcome-bonus claim status", async () => {
  const initData = signInitData({ id: 555, username: "sam" });
  // 555 already claimed its welcome bonus above, but never dismissed the
  // slideshow — onboardingSeen must still read false so it pops once for
  // every existing account, not just new ones.
  assert.equal((await apiMe(initData)).body.onboardingSeen, false);

  const ack = await fetch(`${base}/api/ack-onboarding`, { method: "POST", headers: { Authorization: `tma ${initData}` } });
  assert.equal(ack.status, 200);
  assert.deepEqual(await ack.json(), { ok: true });

  assert.equal((await apiMe(initData)).body.onboardingSeen, true);

  // Idempotent — replaying the slideshow from the "Ещё" tab and closing it
  // again is a harmless no-op, not an error.
  const again = await fetch(`${base}/api/ack-onboarding`, { method: "POST", headers: { Authorization: `tma ${initData}` } });
  assert.equal(again.status, 200);
  assert.equal((await apiMe(initData)).body.onboardingSeen, true);
});

await step("POST /api/ack-onboarding requires auth", async () => {
  const res = await fetch(`${base}/api/ack-onboarding`, { method: "POST" });
  assert.equal(res.status, 401);
});

await step("app reflects the SAME state the bot writes: spend + gallery", async () => {
  // Simulate what the bot does: spend a credit, log a delivered result (555 already claimed above).
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

// ---- client-agnostic session tokens (PWA / iOS enabler) ----

await step("issueSession → verifySession round-trips the claims", () => {
  const { token, expiresAt } = issueSession({ sub: 77, username: "eve", first_name: "Eve" }, BOT_TOKEN);
  assert.ok(expiresAt > Math.floor(Date.now() / 1000));
  const claims = verifySession(token, BOT_TOKEN);
  assert.equal(claims!.sub, 77);
  assert.equal(claims!.username, "eve");
});

await step("verifySession rejects a token signed with a different bot token", () => {
  const { token } = issueSession({ sub: 77 }, BOT_TOKEN);
  assert.equal(verifySession(token, "9999:OTHER"), null);
});

await step("verifySession rejects a tampered payload", () => {
  const { token } = issueSession({ sub: 77 }, BOT_TOKEN);
  const [h, , s] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: 1, exp: 9999999999 }), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(verifySession(`${h}.${forged}.${s}`, BOT_TOKEN), null);
});

await step("verifySession rejects an expired token", () => {
  // Issue already-expired: ttl negative via injected now.
  const past = Math.floor(Date.now() / 1000) - 10_000;
  const { token } = issueSession({ sub: 77 }, BOT_TOKEN, 5, past);
  assert.equal(verifySession(token, BOT_TOKEN), null);
});

await step("POST /api/auth exchanges initData for a Bearer token", async () => {
  const res = await fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { Authorization: `tma ${signInitData({ id: 888, username: "pwa", first_name: "Pat" })}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string; token_type: string; user: { id: number } };
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.user.id, 888);
  assert.equal(verifySession(body.token, BOT_TOKEN)!.sub, 888);
});

await step("POST /api/auth rejects invalid initData with 401", async () => {
  const res = await fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { Authorization: "tma user=%7B%22id%22%3A1%7D&hash=deadbeef" },
  });
  assert.equal(res.status, 401);
});

await step("GET /api/me accepts a Bearer session token (no initData — installed PWA)", async () => {
  const { token } = issueSession({ sub: 555, username: "sam" }, BOT_TOKEN);
  const res = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as MeResponse;
  assert.equal(body.user.id, 555);
  assert.equal(body.dashboard.credits, 2); // same shared state as the initData path above
});

await step("GET /api/me rejects a Bearer token signed with a different token", async () => {
  const { token } = issueSession({ sub: 555 }, "9999:OTHER");
  const res = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

await step("serves the PWA manifest and service worker (SW is no-cache)", async () => {
  const m = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(m.status, 200);
  assert.match(m.headers.get("content-type") ?? "", /manifest/);
  assert.equal((await m.json() as { name: string }).name.includes("NeuroShot"), true);

  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("content-type") ?? "", /javascript/);
  assert.match(sw.headers.get("cache-control") ?? "", /no-cache/); // prompt SW updates
});

await step("serves the legal pages (ToS, privacy, refund) — no auth required, no-cache, requisites present", async () => {
  const pages = [
    { path: "/legal/terms", must: [/Условия использования/, /ИП Z8 Capital/, /030722500509/] },
    { path: "/legal/privacy", must: [/Политика конфиденциальности/, /ИП Z8 Capital/, /komekforyou@gmail\.com/] },
    { path: "/legal/refund", must: [/Политика возврата средств/, /14 дней/, /komekforyou@gmail\.com/] },
  ];
  for (const { path, must } of pages) {
    const r = await fetch(`${base}${path}`); // deliberately no Authorization — a legal page must be publicly readable
    assert.equal(r.status, 200, `${path} status`);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/, `${path} content-type`);
    assert.match(r.headers.get("cache-control") ?? "", /no-cache/, `${path} cache-control`);
    const body = await r.text();
    for (const re of must) assert.match(body, re, `${path} missing ${re}`);
    // No vendor names leak into what's actually served to users.
    assert.ok(!/fal\.ai|ElevenLabs|Kaspi/i.test(body), `${path} leaks a vendor name`);
  }
});

await step("GET /img/<name>: serves decorative art, long-cached; rejects traversal/unknown", async () => {
  const ok = await fetch(`${base}/img/onboard-gift.jpg`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /image\/jpeg/);
  assert.match(ok.headers.get("cache-control") ?? "", /immutable/);

  const missing = await fetch(`${base}/img/does-not-exist.jpg`);
  assert.equal(missing.status, 404);

  // Path traversal / non-image extensions never resolve through this route.
  const traversal = await fetch(`${base}/img/..%2F..%2Fpackage.json`);
  assert.notEqual(traversal.status, 200);
  const badExt = await fetch(`${base}/img/app.html`);
  assert.notEqual(badExt.status, 200);
});

await step("method gating: /api/auth is POST-only, /api/me is GET-only (405 otherwise)", async () => {
  const getAuth = await fetch(`${base}/api/auth`); // GET
  assert.equal(getAuth.status, 405);
  assert.equal(getAuth.headers.get("allow"), "POST");

  const postMe = await fetch(`${base}/api/me`, { method: "POST" });
  assert.equal(postMe.status, 405);
  assert.equal(postMe.headers.get("allow"), "GET");
});

// ---- In-app studio API: catalog → upload → generate → poll → invoice ----

const maker = { id: 700, username: "maker", first_name: "Maker" };
const makerHeaders = () => ({ Authorization: `tma ${signInitData(maker)}` });

async function pollGen(
  id: number,
  headers: Record<string, string> = makerHeaders(),
): Promise<{ status: string; output_url: string | null; output_urls: string[] | null }> {
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`${base}/api/generations/${id}`, { headers });
    assert.equal(r.status, 200);
    const d = (await r.json()) as { status: string; output_url: string | null; output_urls: string[] | null };
    if (d.status !== "pending") return d;
    await new Promise((rr) => setTimeout(rr, 15));
  }
  throw new Error("generation stuck pending");
}

await step("catalog rides on /api/me: presets, campaigns with video prices, model pickers", async () => {
  const { body } = await apiMe(signInitData(maker));
  const c = body.catalog;
  assert.ok(c.presets.some((p) => p.id === "headshot" && p.category === "photo"));
  assert.ok(c.presets.some((p) => p.id === "product_white" && p.category === "product"));
  assert.equal(c.presetCredits, 2); // Seedream 4.5 edit preset/scenario engine
  const mini = c.campaigns.find((k) => k.id === "minifilm");
  assert.ok(mini, "minifilm campaign missing from catalog");
  assert.equal(mini!.videoCredits, 76); // flagship Seedance 2.0 (audio) story upsell
  assert.ok(mini!.presets.length >= 3);
  assert.ok(c.imageModels.some((m) => m.key === "nbpro_image"));
  assert.equal(c.videoModels[0].key, "hailuo_fast"); // cheap default video first
});

await step("POST /api/upload: base64 image → storage URL; bad mime and no auth rejected", async () => {
  const png = `data:image/png;base64,${Buffer.from("tiny-png-bytes").toString("base64")}`;
  const ok = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ data: png }),
  });
  assert.equal(ok.status, 200);
  const { url } = (await ok.json()) as { url: string };
  assert.ok(url.startsWith("https://fal.test/storage/"));

  const bad = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ data: `data:text/plain;base64,${Buffer.from("hi").toString("base64")}` }),
  });
  assert.equal(bad.status, 400);

  const noauth = await fetch(`${base}/api/upload`, { method: "POST", body: "{}" });
  assert.equal(noauth.status, 401);
});

await step("content moderation: a flagged upload is rejected and never returns a usable url", async () => {
  nsfwProbability = 0.9; // flip the classifier to "unsafe" for this step only
  const png = `data:image/png;base64,${Buffer.from("tiny-png-bytes").toString("base64")}`;
  const flagged = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ data: png }),
  });
  assert.equal(flagged.status, 400);
  assert.equal(((await flagged.json()) as { error: string }).error, "unsafe_image");
  const row = (await query("SELECT type FROM events WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [maker.id]))[0];
  assert.equal(row.type, "moderation_blocked");
  nsfwProbability = 0; // reset — every later step assumes SAFE
  // The classifier itself failing (provider outage) also blocks — fail CLOSED.
  const originalSubscribe = (fal as { subscribe: unknown }).subscribe;
  (fal as { subscribe: unknown }).subscribe = async (endpoint: string, opts: { input: Record<string, unknown> }) => {
    if (endpoint === "fal-ai/imageutils/nsfw") throw new Error("classifier outage");
    return (originalSubscribe as (e: string, o: { input: Record<string, unknown> }) => unknown)(endpoint, opts);
  };
  const outage = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ data: png }),
  });
  assert.equal(outage.status, 400);
  assert.equal(((await outage.json()) as { error: string }).error, "unsafe_image");
  (fal as { subscribe: unknown }).subscribe = originalSubscribe;
});

await step("POST /api/generate: preset charges, renders async, poll reaches ok", async () => {
  await apiClaimWelcome(signInitData(maker)); // claim-gated — lands the 3 free 🔫 first
  await addCredits(maker.id, 100, "admin_grant", "test"); // 3 free + 100
  const r = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "preset", id: "headshot", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { id: number; credits: number; balance: number };
  assert.equal(d.credits, 2);
  assert.equal(d.balance, 101); // 103 − 2
  const done = await pollGen(d.id);
  assert.equal(done.status, "ok");
  assert.match(done.output_url ?? "", /^https:\/\/fal\.test\/out\/.*\.png$/);
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "fal-ai/bytedance/seedream/v4.5/edit");
  assert.match(call.input.prompt as string, /corporate headshot/);

  // item-0 cost tracking: the real provider cost + fal request id land on the
  // row, not just the patron charge — this is what COGS accounting reads.
  const row = (await query("SELECT cost_usd, provider_request_id FROM generations WHERE id = $1", [d.id]))[0];
  assert.equal(Number(row.cost_usd), 0.04); // seedream_edit approxCostUsd
  assert.match(String(row.provider_request_id), /^req-\d+$/);
});

await step("num_images: charge scales ×N, multi-output stored/exposed, invalid counts rejected", async () => {
  // Isolated user — this step spends real credits and must not perturb the
  // shared `maker` user's running balance, which later steps assert absolutely
  // (e.g. "101 − 76 = 25").
  const cu = { id: 990088, username: "counter", first_name: "Cnt" };
  await getOrCreateUser(cu.id, cu.username, null, 0);
  await addCredits(cu.id, 100, "admin_grant", "test");
  const H = { Authorization: `tma ${signInitData(cu)}`, "Content-Type": "application/json" };

  // Catalog: text_to_image (Seedream, $0.04/img) declares maxCount 6. The
  // premium tier supports num_images too (fal-verified), but is capped at 2 on
  // purpose — at $0.21/img a 6-up tap would cost 66 🔫. The cap is a spend
  // guard, so it must stay strictly below the cheap tier's.
  const cat = (await apiMe(signInitData(cu))).body.catalog as unknown as {
    studio: { image: Array<{ key: string; image: { maxCount: number } | null }> };
  };
  const t2i = cat.studio.image.find((m) => m.key === "text_to_image")!;
  assert.equal(t2i.image!.maxCount, 6);
  const premium = cat.studio.image.find((m) => m.key === "premium_image")!;
  assert.equal(premium.image!.maxCount, 2);
  assert.ok(premium.image!.maxCount < t2i.image!.maxCount, "the expensive tier must not allow the biggest batch");

  const r = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "model", model: "text_to_image", prompt: "a cat", num_images: 3 }),
  });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { id: number; credits: number; balance: number };
  assert.equal(d.credits, 6); // 2 base × 3
  assert.equal(d.balance, 94); // 100 − 6
  const call = falCalls.at(-1)!;
  assert.equal(call.input.num_images, 3);

  const done = await pollGen(d.id, H);
  assert.equal(done.status, "ok");
  assert.equal(done.output_urls?.length, 3);
  assert.equal(done.output_url, done.output_urls?.[0]);
  const row = (await query("SELECT output_urls FROM generations WHERE id = $1", [d.id]))[0];
  assert.equal((JSON.parse(String(row.output_urls)) as string[]).length, 3);

  // The gallery exposes output_urls on the same item too.
  const gal = await fetch(`${base}/api/generations?size=5`, { headers: H });
  const galBody = (await gal.json()) as { items: Array<{ id: number; output_urls: string[] | null }> };
  const item = galBody.items.find((x) => x.id === d.id);
  assert.equal(item?.output_urls?.length, 3);

  // Out-of-range count → 400 bad_opts, nothing charged.
  const tooMany = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "model", model: "text_to_image", prompt: "x", num_images: 7 }),
  });
  assert.equal(tooMany.status, 400);
  assert.equal(((await tooMany.json()) as { error: string }).error, "bad_opts");

  // Each model is bounded by its OWN cap, not the global maximum: 3 is fine on
  // Seedream but over the premium tier's deliberate 2-image spend guard.
  const overPremium = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "model", model: "premium_image", prompt: "x", num_images: 3 }),
  });
  assert.equal(overPremium.status, 400);
  assert.equal(((await overPremium.json()) as { error: string }).error, "bad_opts");

  // A model with no count support at all (video) rejects any count request.
  const noCount = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "model", model: "animate", image_url: "https://fal.test/storage/u-1.jpg", prompt: "x", num_images: 2 }),
  });
  assert.equal(noCount.status, 400);
  assert.equal((await apiMe(signInitData(cu))).body.dashboard.credits, 94, "rejected count requests must not charge");
});

await step("POST /api/send: a multi-output generation ships as one sendMediaGroup", async () => {
  const su = { id: 990089, username: "sender", first_name: "Snd" };
  await getOrCreateUser(su.id, su.username, null, 0);
  await addCredits(su.id, 100, "admin_grant", "test");
  const H = { Authorization: `tma ${signInitData(su)}`, "Content-Type": "application/json" };

  const { createServer } = await import("node:http");
  const sends: Array<{ path: string; body: Record<string, unknown> }> = [];
  const tgStub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const buf = Buffer.concat(chunks);
        const ct = req.headers["content-type"] ?? "";
        let body: Record<string, unknown>;
        if (ct.includes("multipart/form-data")) {
          const form = await new Response(buf, { headers: { "content-type": ct } }).formData();
          body = { chat_id: form.get("chat_id"), media: JSON.parse(String(form.get("media"))) };
        } else {
          body = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
        }
        sends.push({ path: req.url ?? "", body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: [] }));
      })();
    });
  });
  await new Promise<void>((r) => tgStub.listen(0, r));
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${(tgStub.address() as AddressInfo).port}`;

  const gen = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "model", model: "text_to_image", prompt: "a dog", num_images: 2 }),
  });
  const genId = ((await gen.json()) as { id: number }).id;
  await pollGen(genId, H);

  const r = await fetch(`${base}/api/send`, {
    method: "POST", headers: H,
    body: JSON.stringify({ id: genId }),
  });
  assert.equal(r.status, 200);
  assert.match(sends[0].path, /\/sendMediaGroup$/);
  const media = sends[0].body.media as Array<{ type: string; media: string; caption?: string }>;
  assert.equal(media.length, 2);
  assert.ok(media.every((m) => m.type === "photo"));
  assert.equal(media[0].caption, "✨ Из вашей студии NeuroShot");
  assert.equal(media[1].caption, undefined);
  await new Promise<void>((r2) => tgStub.close(() => r2()));
});

await step("Studio catalog: FULL registry by mode, patron-only prices; every model generable", async () => {
  const cat = (await apiMe(signInitData(maker))).body.catalog as unknown as {
    studio: {
      image: Array<{ key: string; kind: string; credits: number; needsImage: boolean; image: unknown; video: unknown }>;
      video: Array<{ key: string; kind: string; credits: number; needsImage: boolean; video: { durations: Array<{ seconds: number; credits: number }> } | null }>;
    };
  };
  const s = cat.studio;
  // Full registry: 9 image (edit + t2i) and 5 video models — the display pickers
  // hide some of these; the Studio never does (spec G5 "ALL models").
  assert.equal(s.image.length, 9);
  assert.equal(s.video.length, 5);
  for (const m of [...s.image, ...s.video]) {
    assert.ok(m.credits >= 1, `${m.key} zero price`);
    assert.equal(m.needsImage, m.kind !== "text_to_image", `${m.key} needsImage wrong`);
    // Patrons are the ONLY price language for generations (D4-revised): no ₸
    // conversion fields may ride on a studio model entry.
    assert.ok(!("approxKzt" in m), `${m.key} carries a ₸ estimate — patron-only pricing`);
  }
  // Cheapest-first ladder, and previously picker-hidden models are present.
  assert.ok(s.image.some((m) => m.key === "seedream_edit") && s.image.some((m) => m.key === "nb2_edit"), "picker-hidden edit models missing");
  assert.deepEqual([...s.image.map((m) => m.credits)].sort((a, b) => a - b), s.image.map((m) => m.credits));
  // Every video entry prices each duration (the composer's live badge source).
  for (const v of s.video) for (const d of v.video!.durations) assert.ok(d.credits >= 1, `${v.key}@${d.seconds}s unpriced`);

  // The widened allow-list: a model the old pickers HID is now directly generable…
  await addCredits(maker.id, 6, "admin_grant", "test"); // exactly the 4+2 spent below (net-zero step)
  const edit = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "nb2_edit", image_url: "https://fal.test/storage/u-1.jpg", prompt: "улучши свет" }),
  });
  assert.equal(edit.status, 200);
  const ed = (await edit.json()) as { id: number; credits: number };
  assert.equal(ed.credits, 4);
  await pollGen(ed.id);
  assert.equal(falCalls.at(-1)!.endpoint, "fal-ai/nano-banana-2/edit");
  const seed = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "seedream_edit", image_url: "https://fal.test/storage/u-1.jpg", prompt: "сцена у моря" }),
  });
  assert.equal(seed.status, 200);
  await pollGen(((await seed.json()) as { id: number }).id);
  // …but capability rules still hold: an edit model with NO image is rejected,
  // and a garbage key is not in the registry.
  const noImg = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "nb2_edit", prompt: "x" }),
  });
  assert.equal(noImg.status, 400);
  const bogus = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "dub_ru", image_url: "https://fal.test/storage/u-1.jpg", prompt: "x" }),
  });
  assert.equal(bogus.status, 400);
});

await step("Studio preset: personalization is sanitized+appended; model override swaps engine; video override rejected", async () => {
  await addCredits(maker.id, 10, "admin_grant", "test"); // 2 + 8 spent below (net-zero)
  // Personalization (D1): sanitized free words ride on the curated prompt.
  const pers = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "preset", id: "headshot", image_url: "https://fal.test/storage/u-1.jpg", custom: "  в синем  пиджаке " }),
  });
  assert.equal(pers.status, 200);
  await pollGen(((await pers.json()) as { id: number }).id);
  assert.match(falCalls.at(-1)!.input.prompt as string, /corporate headshot/);
  assert.match(falCalls.at(-1)!.input.prompt as string, /Extra details from the user: в синем пиджаке/);
  // Model override (G2): the preset renders on the swapped engine at ITS price;
  // the catalog exposes each preset's default model key for the picker highlight.
  const cat = (await apiMe(signInitData(maker))).body.catalog;
  const hs = cat.presets.find((p: { id: string }) => p.id === "headshot") as unknown as { model: string };
  assert.equal(hs.model, "seedream_edit");
  const ovr = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "preset", id: "headshot", image_url: "https://fal.test/storage/u-1.jpg", model: "nbpro_edit" }),
  });
  assert.equal(ovr.status, 200);
  const od = (await ovr.json()) as { id: number; credits: number };
  assert.equal(od.credits, 8); // nbpro_edit price, not the preset default's 2
  await pollGen(od.id);
  assert.equal(falCalls.at(-1)!.endpoint, "fal-ai/nano-banana-pro/edit");
  // A VIDEO model can't render a styled photo — override rejected, no charge.
  const bad = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "preset", id: "headshot", image_url: "https://fal.test/storage/u-1.jpg", model: "kling3" }),
  });
  assert.equal(bad.status, 400);
});

await step("Prompt Enhancer: a stack of 2, refilled by a render or by 1 🔫; the count is always reported", async () => {
  // A FRESH user so the enhance/gen_start event history is fully controlled.
  const enh = { id: 990077, username: "enhancer", first_name: "Enh" };
  await getOrCreateUser(enh.id, enh.username, null, 0);
  const H = { Authorization: `tma ${signInitData(enh)}`, "Content-Type": "application/json" };
  const call = (prompt: string) => fetch(`${base}/api/enhance`, { method: "POST", headers: H, body: JSON.stringify({ prompt }) });
  const meLeft = async () =>
    ((await (await fetch(`${base}/api/me`, { headers: H })).json()) as { enhance: { left: number } }).enhance.left;

  // Empty prompt → 400, nothing charged and nothing consumed.
  assert.equal((await call("   ")).status, 400);
  assert.equal(await meLeft(), 2, "a rejected prompt must not eat a charge");

  // One rewrite is rarely the one you keep, so the SECOND tap is still free.
  const d1 = (await (await call("кот в очках")).json()) as { charged: number; free: boolean; balance: number; left: number; prompt: string };
  assert.equal(d1.free, true);
  assert.equal(d1.charged, 0);
  assert.equal(d1.left, 1, "the response must report what is left, not just free/paid");
  assert.match(d1.prompt, /Cinematic.*кот в очках/);
  const d2 = (await (await call("кот в очках, неон")).json()) as { free: boolean; left: number };
  assert.equal(d2.free, true, "the second tap of a fresh stack is still free");
  assert.equal(d2.left, 0);
  assert.equal(await meLeft(), 0, "/api/me must agree with the enhance response");

  // Empty stack + no patrons → paywall, not a silent failure.
  assert.equal((await call("и ещё раз")).status, 402);

  // 1 🔫 buys a WHOLE new stack, not a single tap — the patron pays for a round
  // of iteration, which is how the feature is actually used.
  await addCredits(enh.id, 1, "admin_grant", "test");
  const d3 = (await (await call("кот в очках, неон")).json()) as { charged: number; free: boolean; balance: number; left: number };
  assert.equal(d3.free, false);
  assert.equal(d3.charged, 1);
  assert.equal(d3.balance, 0);
  assert.equal(d3.left, 1, "a paid refill must leave the rest of the stack available");
  assert.equal(((await (await call("ещё вариант")).json()) as { free: boolean }).free, true);

  // Provider failure on a PAID tap → 502, the patron comes back, and the stack
  // is exactly as it was — a failed tap must cost neither money nor a charge.
  await addCredits(enh.id, 1, "admin_grant", "test");
  anyLlmFail = true;
  assert.equal((await call("ещё раз")).status, 502);
  anyLlmFail = false;
  assert.equal(Number((await query("SELECT credits FROM users WHERE id = $1", [enh.id]))[0].credits), 1);
  assert.equal(await meLeft(), 0, "a failed tap must not consume a charge");

  // A render refills the stack in full — a new idea deserves a fresh one.
  await addCredits(enh.id, 2, "admin_grant", "test"); // 1 + 2 = 3; t2i costs 2 → 1 left
  const gen = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "model", model: "text_to_image", prompt: "домик у моря" }),
  });
  assert.equal(gen.status, 200);
  assert.equal(await meLeft(), 2, "a render must refill the whole stack");
  assert.equal(((await (await call("домик у моря, но зимой")).json()) as { free: boolean }).free, true);
});

await step("/api/me exposes PENDING generations — the reload-safe resume contract", async () => {
  // The Mini App re-hydrates in-flight renders after a reload from these rows
  // (spec §4.1 resumePending) — if pending rows ever stop flowing through
  // /api/me, in-progress work silently vanishes on refresh. Pin the contract.
  const id = await createPendingGeneration(maker.id, "text_to_image", "resume contract", 2);
  const gens = (await apiMe(signInitData(maker))).body.generations as unknown as Array<{ id: number; status: string; model: string }>;
  const row = gens.find((x) => x.id === id);
  assert.ok(row, "pending row missing from /api/me generations");
  assert.equal(row!.status, "pending");
  assert.equal(row!.model, "text_to_image");
  // Clean up: terminal-state the row (no charge was made, so no refund needed).
  assert.equal(await completeGeneration(id, "error"), true);
});

await step("marketplace-spec cards: preset pins 3:4 server-side; explicit user ratio wins", async () => {
  // Exactly the 6 🔫 this step spends (3 × 2🔫 Seedream) — later steps assert
  // absolute balances, so the step must be net-zero on the wallet.
  await addCredits(maker.id, 6, "admin_grant", "test");
  // Both spec cards are in the product category of the catalog.
  const cat = (await apiMe(signInitData(maker))).body.catalog;
  for (const id of ["kaspi_card", "wb_apparel_card"]) {
    const p = cat.presets.find((x: { id: string }) => x.id === id);
    assert.ok(p, `${id} missing from catalog`);
    assert.equal(p.category, "product");
  }
  // One tap, NO ratio from the client → the preset's pinned 3:4 flows to fal
  // (Seedream named size portrait_4_3) — the "upload-ready card" guarantee.
  const r = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "preset", id: "kaspi_card", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(r.status, 200);
  await pollGen(((await r.json()) as { id: number }).id);
  const pinned = falCalls.at(-1)!;
  assert.equal(pinned.input.image_size, "portrait_4_3");
  assert.match(pinned.input.prompt as string, /seamless white/);
  // The apparel card pins the same ratio with the #f2f3f5 background.
  const r2 = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "preset", id: "wb_apparel_card", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(r2.status, 200);
  await pollGen(((await r2.json()) as { id: number }).id);
  assert.match(falCalls.at(-1)!.input.prompt as string, /#f2f3f5/);
  // An EXPLICIT user ratio overrides the pin (choice wins over default).
  const r3 = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "preset", id: "kaspi_card", image_url: "https://fal.test/storage/u-1.jpg", aspect_ratio: "1:1" }),
  });
  assert.equal(r3.status, 200);
  await pollGen(((await r3.json()) as { id: number }).id);
  assert.equal(falCalls.at(-1)!.input.image_size, "square_hd");
});

await step("prompt library: VeoSee-seeded presets are exposed in the catalog and one-tap applicable", async () => {
  const ids = (await apiMe(signInitData(maker))).body.catalog.presets.map((p) => p.id);
  for (const id of ["candid_lux", "paris_rain", "pixar_me", "figurine", "retro90s",
    "cafe_night", "yacht_lux", "photobooth_bw", "paper_doll", "low_battery", "product_editorial", "product_drama",
    "billionaire_heli", "alpine_lux", "kitten_editorial", "mini_squad", "sketch_journal",
    "product_jewelry", "product_action"]) {
    assert.ok(ids.includes(id), `catalog missing seeded preset ${id}`);
  }
  // One-tap apply: a seeded library preset renders through the same preset path.
  // Use a dedicated user (and an owner-scoped inline poll) so maker's balance —
  // which later shared-state assertions depend on — is left untouched.
  const lib = { id: 781, username: "libuser", first_name: "Lib" };
  const lh = { Authorization: `tma ${signInitData(lib)}`, "Content-Type": "application/json" };
  await apiMe(signInitData(lib)); // onboard
  await addCredits(lib.id, 10, "admin_grant", "test");
  const r = await fetch(`${base}/api/generate`, {
    method: "POST", headers: lh,
    body: JSON.stringify({ source: "preset", id: "candid_lux", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(r.status, 200);
  const gid = ((await r.json()) as { id: number }).id;
  let status = "pending";
  for (let i = 0; i < 200 && status === "pending"; i++) {
    const g = await fetch(`${base}/api/generations/${gid}`, { headers: { Authorization: lh.Authorization } });
    assert.equal(g.status, 200);
    status = ((await g.json()) as { status: string }).status;
    if (status === "pending") await new Promise((rr) => setTimeout(rr, 15));
  }
  assert.equal(status, "ok");
});

await step("preset model routing: premium looks pin a stronger engine + price; cheap looks stay Seedream", async () => {
  const presets = (await apiMe(signInitData(maker))).body.catalog.presets;
  const price = Object.fromEntries(presets.map((p) => [p.id, p.credits]));
  // Guard against a merge re-introducing duplicate presets (each id must be unique):
  const ids = presets.map((p) => p.id);
  assert.equal(ids.length, new Set(ids).size, `duplicate preset ids in catalog: ${ids.filter((v, i) => ids.indexOf(v) !== i)}`);
  assert.equal(price.headshot, 2); // Seedream default
  assert.equal(price.product_white, 2); // mechanical cutout stays cheap
  assert.equal(price.figurine, 11); // GPT Image 2 — generates blister-pack title text
  assert.equal(price.product_hero, 11); // GPT Image 2 — premium marketplace card
  assert.equal(price.product_editorial, 11); // GPT Image 2 — editorial packshot w/ label text
  assert.equal(price.product_drama, 11); // GPT Image 2 — cinematic packshot w/ label text
  assert.equal(price.cafe_night, 2); // Seedream default (portrait look)
  assert.equal(price.pixar_me, 8); // Nano Banana Pro — heavy 3D stylization
  assert.equal(price.billionaire_heli, 4); // Nano Banana 2 — matches VeoSee's recipe engine
  assert.equal(price.alpine_lux, 8); // Nano Banana Pro — matches VeoSee's recipe engine
  assert.equal(price.kitten_editorial, 4); // Nano Banana 2 — matches VeoSee's recipe engine
  assert.equal(price.mini_squad, 4); // Nano Banana 2 — matches VeoSee's recipe engine
  assert.equal(price.sketch_journal, 8); // Nano Banana Pro — matches VeoSee's recipe engine
  assert.equal(price.product_jewelry, 4); // Nano Banana 2 — matches VeoSee's recipe engine
  assert.equal(price.product_action, 11); // GPT Image 2 — matches VeoSee's recipe engine

  // A premium preset renders on its pinned engine and charges that model's price.
  // Dedicated user + owner-scoped poll so maker's shared balance is untouched.
  const pm = { id: 782, username: "premu", first_name: "Prem" };
  const ph = { Authorization: `tma ${signInitData(pm)}`, "Content-Type": "application/json" };
  await apiMe(signInitData(pm));
  await addCredits(pm.id, 20, "admin_grant", "test");
  const r = await fetch(`${base}/api/generate`, {
    method: "POST", headers: ph,
    body: JSON.stringify({ source: "preset", id: "figurine", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { id: number; credits: number; balance: number };
  assert.equal(body.credits, 11); // charged the GPT Image 2 price, not the 2🔫 default
  assert.equal(body.balance, 9); // 20 − 11
  let st = "pending";
  for (let i = 0; i < 200 && st === "pending"; i++) {
    const g = await fetch(`${base}/api/generations/${body.id}`, { headers: { Authorization: ph.Authorization } });
    st = ((await g.json()) as { status: string }).status;
    if (st === "pending") await new Promise((rr) => setTimeout(rr, 15));
  }
  assert.equal(st, "ok");
});

await step("Style Gallery: catalog presets carry preview art + real (never fabricated) usage/trending", async () => {
  const presetsBefore = (await apiMe(signInitData(maker))).body.catalog.presets;
  // Every preset — old and newly-curated alike — resolves a deterministic
  // preview URL (public/img/card-preset-<id>.jpg, see docs/prompt-library.md);
  // usageCount/trending are always present and start real, not undefined.
  for (const p of presetsBefore) {
    assert.equal(p.previewUrl, `/img/card-preset-${p.id}.jpg`);
    assert.equal(typeof p.usageCount, "number");
    assert.equal(typeof p.trending, "boolean");
  }
  // kitten_editorial is untouched by every other test in this file — a clean
  // signal to prove usageCount reflects a REAL tap (events log), not a guess.
  const before = presetsBefore.find((p) => p.id === "kitten_editorial")!;
  assert.equal(before.usageCount, 0);
  assert.equal(before.trending, false);

  const gu = { id: 783, username: "galleryuser", first_name: "Gal" };
  const gh = { Authorization: `tma ${signInitData(gu)}`, "Content-Type": "application/json" };
  await apiMe(signInitData(gu));
  await addCredits(gu.id, 10, "admin_grant", "test");
  const r = await fetch(`${base}/api/generate`, {
    method: "POST", headers: gh,
    body: JSON.stringify({ source: "preset", id: "kitten_editorial", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(r.status, 200);
  const gid = ((await r.json()) as { id: number }).id;
  // Owner-scoped polling (see "polling is owner-scoped" below) — pollGen()
  // is hardcoded to `maker`'s auth, so poll with this test's own user headers.
  let status = "pending";
  for (let i = 0; i < 200 && status === "pending"; i++) {
    const g = await fetch(`${base}/api/generations/${gid}`, { headers: { Authorization: gh.Authorization } });
    assert.equal(g.status, 200);
    status = ((await g.json()) as { status: string }).status;
    if (status === "pending") await new Promise((rr) => setTimeout(rr, 15));
  }
  assert.equal(status, "ok");

  const presetsAfter = (await apiMe(signInitData(maker))).body.catalog.presets;
  const after = presetsAfter.find((p) => p.id === "kitten_editorial")!;
  assert.equal(after.usageCount, 1); // exactly the one real tap above
});

await step("campaign video upsell via API: minifilm renders on flagship Seedance 2.0 with audio (76 🔫)", async () => {
  const r = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "campaign_video", id: "minifilm", image_url: "https://fal.test/out/1.png" }),
  });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { id: number; credits: number; balance: number };
  assert.equal(d.credits, 76);
  assert.equal(d.balance, 25); // 101 − 76
  const done = await pollGen(d.id);
  assert.equal(done.status, "ok");
  assert.match(done.output_url ?? "", /\.mp4$/);
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "bytedance/seedance-2.0/image-to-video");
  assert.equal(call.input.generate_audio, true); // «со звуком»
  assert.equal(call.input.image_url, "https://fal.test/out/1.png");
});

await step("insufficient 🔫 → 402 with the pack catalog (in-app paywall)", async () => {
  const broke = { id: 701, username: "broke" }; // fresh: 3 free < a scenario video's 10 🔫
  await apiClaimWelcome(signInitData(broke)); // claim-gated — still short of the 10 🔫 needed
  const r = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { Authorization: `tma ${signInitData(broke)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source: "campaign_video", id: "worldcup", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(r.status, 402);
  const d = (await r.json()) as { error: string; need: number; balance: number; packs: unknown[] };
  assert.equal(d.error, "insufficient");
  assert.equal(d.need, 10); // Hailuo 2.3 Fast default (6s)
  assert.equal(d.balance, 3);
  assert.equal(d.packs.length, 5); // 4 ladder + combo offer
});

await step("generate validation: unknown ids, missing photo, unknown model keys, empty prompt → 400", async () => {
  const cases = [
    { source: "preset", id: "nope", image_url: "https://fal.test/x/a.jpg" },
    { source: "preset", id: "headshot" }, // photo required
    { source: "campaign", id: "minifilm:nope", image_url: "https://fal.test/x/a.jpg" },
    // The registry IS the allow-list now (Studio: all vetted models generable),
    // so only keys outside MODELS are rejected — see the Studio-catalog step.
    { source: "model", model: "definitely_not_a_model", prompt: "hi", image_url: "https://fal.test/x/a.jpg" },
    { source: "model", model: "text_to_image", prompt: "   " }, // empty after sanitize
    { source: "hack" },
  ];
  for (const body of cases) {
    const r = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { ...makerHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

await step("polling is owner-scoped: someone else's generation id → 404", async () => {
  const r = await fetch(`${base}/api/generations/1`, {
    headers: { Authorization: `tma ${signInitData({ id: 702 })}` },
  });
  assert.equal(r.status, 404);
});

await step("POST /api/order: records a pending Kaspi order and returns the pay link", async () => {
  const r = await fetch(`${base}/api/order`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ pack: "start" }),
  });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { available: boolean; orderId: number; link: string; amount: number; title: string };
  assert.equal(d.available, true);
  assert.equal(d.link, "https://pay.test/neuroshot"); // the configured Kaspi link
  assert.equal(d.amount, 3700); // Старт — 60 🔫 in KZT
  assert.ok(Number.isInteger(d.orderId) && d.orderId > 0, "no order id");

  const bad = await fetch(`${base}/api/order`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ pack: "nope" }),
  });
  assert.equal(bad.status, 400);
});

await step("POST /api/order: a per-pack fixed-amount link overrides the fallback", async () => {
  const r = await fetch(`${base}/api/order`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ pack: "combo" }),
  });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { available: boolean; link: string; amount: number };
  assert.equal(d.link, "https://pay.test/combo"); // KASPI_PAY_URL_COMBO, not the fallback
  assert.equal(d.amount, 1000); // combo = 1000 ₸
});

await step("POST /api/order/paid: in-app 'I paid' mirrors the bot; ownership enforced", async () => {
  // Create a pending order as maker.
  const o = await fetch(`${base}/api/order`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ pack: "start" }),
  });
  const { orderId } = (await o.json()) as { orderId: number };

  // Bad order id → 400.
  const bad = await fetch(`${base}/api/order/paid`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: 0 }),
  });
  assert.equal(bad.status, 400);

  // A different user cannot confirm maker's order → 404 (no info leak, no grant).
  const other = { id: 701, username: "mallory", first_name: "Mal" };
  await apiMe(signInitData(other)); // onboard
  const steal = await fetch(`${base}/api/order/paid`, {
    method: "POST", headers: { Authorization: `tma ${signInitData(other)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  });
  assert.equal(steal.status, 404);

  // Owner confirms: no merchant API wired in test → interim admin-approval path
  // (same as the bot). The order stays pending until an admin runs /order N ok.
  const paid = await fetch(`${base}/api/order/paid`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  });
  assert.equal(paid.status, 200);
  const pd = (await paid.json()) as { result: string; balance: number };
  assert.equal(pd.result, "admin");
  assert.ok(Number.isInteger(pd.balance));
});

await step("Kaspi callback: valid signature auto-approves the order and grants patrons exactly once", async () => {
  // A pending order to approve.
  const buyer = 99001;
  await getOrCreateUser(buyer, "kaspi_buyer", null, 3);
  const orderId = await createOrder(buyer, "start", 3700);

  const granted: Array<{ userId: number; credits: number }> = [];
  const grant = async (userId: number, pack: { credits: number }) => {
    granted.push({ userId, credits: pack.credits });
  };
  const sign = (raw: Buffer) => createHmac("sha256", "test-kaspi-secret").update(raw).digest("hex");

  const raw = Buffer.from(JSON.stringify({ orderId, status: "paid", amount: 3700 }));
  const ok = await kaspiCallbackResponse(raw, sign(raw), grant);
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { granted?: number }).granted, 60); // Старт = 60 🔫
  assert.equal(granted.length, 1);
  assert.equal(granted[0]?.userId, buyer);
  assert.equal((await getOrder(orderId))?.status, "paid");

  // Idempotent: a duplicate callback must NOT grant again.
  const dup = await kaspiCallbackResponse(raw, sign(raw), grant);
  assert.equal(dup.status, 200);
  assert.equal(granted.length, 1, "duplicate callback double-granted");
});

await step("Kaspi callback: rejects a bad signature, amount mismatch, and unknown order", async () => {
  const buyer = 99002;
  await getOrCreateUser(buyer, "kaspi_buyer2", null, 3);
  const orderId = await createOrder(buyer, "start", 3700);
  const grant = async () => assert.fail("must not grant on a rejected callback");
  const sign = (raw: Buffer) => createHmac("sha256", "test-kaspi-secret").update(raw).digest("hex");

  const raw = Buffer.from(JSON.stringify({ orderId, status: "paid", amount: 3700 }));
  // Wrong signature → 401.
  assert.equal((await kaspiCallbackResponse(raw, "deadbeef", grant)).status, 401);
  // Correct signature but wrong amount → 400, order stays pending.
  const wrongAmt = Buffer.from(JSON.stringify({ orderId, status: "paid", amount: 1 }));
  assert.equal((await kaspiCallbackResponse(wrongAmt, sign(wrongAmt), grant)).status, 400);
  assert.equal((await getOrder(orderId))?.status, "pending");
  // Unknown order id → 404.
  const unknown = Buffer.from(JSON.stringify({ orderId: 987654, status: "paid" }));
  assert.equal((await kaspiCallbackResponse(unknown, sign(unknown), grant)).status, 404);
  // Non-final status → acknowledged (200) but not granted.
  const pendingCb = Buffer.from(JSON.stringify({ orderId, status: "wait" }));
  assert.equal((await kaspiCallbackResponse(pendingCb, sign(pendingCb), grant)).status, 200);
  assert.equal((await getOrder(orderId))?.status, "pending");
});

await step("kaspiLinkFor: a blank/whitespace per-pack override falls back to KASPI_PAY_URL", async () => {
  process.env.KASPI_PAY_URL_PRO = ""; // present-but-empty, exactly like .env.example ships
  assert.equal(kaspiLinkFor("pro"), "https://pay.test/neuroshot"); // must fall back, not disable
  process.env.KASPI_PAY_URL_PRO = "   ";
  assert.equal(kaspiLinkFor("pro"), "https://pay.test/neuroshot");
  assert.equal(kaspiLinkFor("combo"), "https://pay.test/combo"); // a non-blank override still wins
  delete process.env.KASPI_PAY_URL_PRO;
});

await step("settleApprovedOrder: an unknown pack id leaves the order pending (never 'paid but ungranted')", async () => {
  const buyer = 99004;
  await getOrCreateUser(buyer, "ghost_pack", null, 3);
  const id = await createOrder(buyer, "ghost", 3700); // pack id not in PACKS
  const pack = await settleApprovedOrder(new Api(BOT_TOKEN), id);
  assert.equal(pack, null);
  assert.equal((await getOrder(id))?.status, "pending"); // must NOT have been marked paid
});

await step("Kaspi verify: no merchant API configured → 'unknown' (button falls back to admin)", async () => {
  const buyer = 99003;
  await getOrCreateUser(buyer, "kaspi_verify", null, 3);
  const id = await createOrder(buyer, "start", 3700);
  const order = await getOrder(id);
  assert.ok(order);
  assert.equal(await kaspiVerifyOrder(order!), "unknown"); // KASPI_API_BASE unset
});

await step("share-to-WhatsApp: afterKeyboard carries a wa.me link with the bot deep link", async () => {
  const wa = whatsappShareUrl();
  assert.ok(wa && wa.startsWith("https://wa.me/?text="), "no wa.me share url");
  assert.match(decodeURIComponent(wa!), /t\.me\/neuroshot_test_bot\?start=src_wa/);
  const kb = afterKeyboard(true) as unknown as { inline_keyboard: Array<Array<{ url?: string; text: string }>> };
  const urls = kb.inline_keyboard.flat().filter((b) => b.url);
  assert.ok(urls.some((b) => b.url?.startsWith("https://wa.me/")), "WhatsApp button missing from result keyboard");
});

await step("method gating on studio endpoints: GET /api/generate and /api/upload → 405", async () => {
  for (const path of ["/api/generate", "/api/upload", "/api/order", "/api/send"]) {
    const r = await fetch(`${base}${path}`, { headers: makerHeaders() });
    assert.equal(r.status, 405, path);
    assert.equal(r.headers.get("allow"), "POST", path);
  }
});

// ---- Studio v2: story quiz, reusable generations, send-to-chat ----

await step("catalog exposes the story quiz (ids+labels only — fragments stay server-side)", async () => {
  const { body } = await apiMe(signInitData(maker));
  const skazka = body.catalog.campaigns.find((k) => k.id === "skazka") as unknown as {
    quiz: Array<{ id: string; question: string; options: Array<Record<string, unknown>> }>;
  };
  assert.equal(skazka.quiz.length, 3); // герой / кто рядом / финал
  assert.ok(skazka.quiz[0].options.length >= 3);
  for (const s of skazka.quiz) for (const o of s.options) {
    assert.ok(!("fragment" in o), "prompt fragment leaked to the client");
  }
});

await step("campaign generate composes quiz options + sanitized custom words server-side", async () => {
  const r = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "campaign", id: "skazka:forest", image_url: "https://fal.test/storage/u-1.jpg",
      options: ["knight", "dragon", "epic"], custom: "  с золотой   короной ",
    }),
  });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { id: number };
  await pollGen(d.id);
  const prompt = falCalls.at(-1)!.input.prompt as string;
  assert.match(prompt, /brave young knight/); // hero fragment
  assert.match(prompt, /baby dragon companion/); // friend fragment
  assert.match(prompt, /god rays/); // mood fragment
  assert.match(prompt, /Extra details from the user: с золотой короной/); // sanitized (control char + spaces)
  assert.ok(!prompt.includes(" "));

  // Unknown option ids are rejected — nothing charged.
  const bad = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "campaign", id: "skazka:forest", image_url: "https://fal.test/storage/u-1.jpg", options: ["hack"] }),
  });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, "bad_option");
});

await step("roadmap progress: real signals, not a fabricated bar (firstPhoto/revive/scenario so far)", async () => {
  // maker has by now: a plain preset render (headshot), a campaign_video render
  // (minifilm), and the campaign image render just above (skazka:forest) — but
  // no free-text prompt yet, so ownIdea should still read false.
  const { body } = await apiMe(signInitData(maker));
  assert.deepEqual(body.roadmap, {
    firstPhoto: true,
    ownIdea: false,
    revivePhoto: true,
    scenario: true, // from the "campaign" generate above — logged the same "camp:preset" shape as the bot's cpre: taps
    invitedFriend: false,
  });
});

await step("POST /api/claim-roadmap: only pays out once all 5 steps are real, exactly once", async () => {
  const traveler = { id: 750, username: "traveler", first_name: "Tara" };
  const initData = signInitData(traveler);
  await apiMe(initData); // onboard

  // Amount is visible from the very first load, before anything is done —
  // the incentive the user asked to see up front.
  const fresh = await apiMe(initData);
  assert.deepEqual(fresh.body.roadmapBonus, { amount: 10, claimed: false }); // ROADMAP_BONUS default

  const early = await fetch(`${base}/api/claim-roadmap`, { method: "POST", headers: { Authorization: `tma ${initData}` } });
  assert.deepEqual(await early.json(), { granted: 0 }); // steps incomplete — no payout

  // Complete all 5 real signals: a plain render, a text_to_image render (own
  // idea), an image_to_video render (revive), a colon-shaped preset tap
  // (scenario), and a referred friend.
  await logGeneration(traveler.id, "photo_edit", "portrait", 3, "ok", "https://fal.test/out/t1.png");
  await logGeneration(traveler.id, "text_to_image", "a castle at dusk", 2, "ok", "https://fal.test/out/t2.png");
  await logGeneration(traveler.id, "animate", "slow zoom", 25, "ok", "https://fal.test/out/t3.mp4");
  await logEvent(traveler.id, "preset", "skazka:forest");
  await getOrCreateUser(808, "friend", traveler.id, 3);

  const done = await apiMe(initData);
  assert.deepEqual(done.body.roadmap, {
    firstPhoto: true, ownIdea: true, revivePhoto: true, scenario: true, invitedFriend: true,
  });
  assert.deepEqual(done.body.roadmapBonus, { amount: 10, claimed: false });

  const claim = await fetch(`${base}/api/claim-roadmap`, { method: "POST", headers: { Authorization: `tma ${initData}` } });
  assert.deepEqual(await claim.json(), { granted: 10 });

  const after = await apiMe(initData);
  assert.equal(after.body.dashboard.credits, 10);
  assert.deepEqual(after.body.roadmapBonus, { amount: 10, claimed: true });

  // A second claim is a no-op, not a double credit.
  const again = await fetch(`${base}/api/claim-roadmap`, { method: "POST", headers: { Authorization: `tma ${initData}` } });
  assert.deepEqual(await again.json(), { granted: 0 });
  assert.equal((await apiMe(initData)).body.dashboard.credits, 10);
});

await step("/me referrals: per-friend drill-down with inactive/used_free/paid status", async () => {
  const { rewardReferralOnPurchase } = await import("../src/db.js");
  const inviter = { id: 760, username: "inviter", first_name: "Ivan" };
  const initData = signInitData(inviter);
  await apiMe(initData); // onboard the inviter

  // A brand-new inviter has invited nobody yet → empty list, not an error.
  assert.deepEqual((await apiMe(initData)).body.referrals, []);

  // Three friends, each in a different funnel stage:
  await getOrCreateUser(761, "idlefriend", inviter.id, 3); // joined, never rendered → inactive
  await getOrCreateUser(762, "tryerfriend", inviter.id, 3); // rendered on free patrons → used_free
  await logGeneration(762, "photo_edit", "portrait", 3, "ok", "https://fal.test/out/ref.png");
  await getOrCreateUser(763, "payerfriend", inviter.id, 3); // purchased → paid
  await rewardReferralOnPurchase(763, 60, { percent: 0.1, firstPurchaseBonus: 10, milestones: [] });

  const byId = new Map(
    (await apiMe(initData)).body.referrals.map((r) => [r.username, r.status]),
  );
  assert.equal(byId.get("idlefriend"), "inactive");
  assert.equal(byId.get("tryerfriend"), "used_free");
  assert.equal(byId.get("payerfriend"), "paid");
  assert.equal(byId.size, 3);
});

await step("/api/generate logs the preset id → seller-segment sizing counts only product presets", async () => {
  const { sellerSegmentSizing } = await import("../src/db.js");
  const productIds = ["product_hero", "product_white", "product_lifestyle"];
  const hdrs = { ...makerHeaders(), "Content-Type": "application/json" };
  await addCredits(maker.id, 50, "admin_grant", "test"); // ensure funds regardless of prior spend

  const before = await sellerSegmentSizing(productIds); // maker hasn't touched a product preset yet

  // A marketplace product shot counts toward the seller segment…
  const r = await fetch(`${base}/api/generate`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ source: "preset", id: "product_white", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(r.status, 200);
  assert.equal((await pollGen(((await r.json()) as { id: number }).id)).status, "ok");

  const after = await sellerSegmentSizing(productIds);
  assert.equal(after.productPresetUsers, before.productPresetUsers + 1);
  assert.ok(after.totalGenerators >= after.productPresetUsers);

  // …a plain portrait preset does NOT — the segment tracks seller behaviour only.
  const r2 = await fetch(`${base}/api/generate`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ source: "preset", id: "headshot", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(r2.status, 200);
  assert.equal((await pollGen(((await r2.json()) as { id: number }).id)).status, "ok");
  assert.equal((await sellerSegmentSizing(productIds)).productPresetUsers, after.productPresetUsers);
});

let videoGenId = 0; // captured for the video-as-source guard below

await step("reusable works: generation_id feeds a video render without re-upload", async () => {
  await addCredits(maker.id, 200, "admin_grant", "test");
  // Make an image first…
  const img = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "preset", id: "cinematic", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  const imgD = (await img.json()) as { id: number };
  const done = await pollGen(imgD.id);
  assert.equal(done.status, "ok");

  // …then animate it BY ID — the server resolves the stored output URL.
  const vid = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "kling3", prompt: "slow push-in", generation_id: imgD.id }),
  });
  assert.equal(vid.status, 200);
  const vidD = (await vid.json()) as { id: number; credits: number };
  assert.equal(vidD.credits, 42);
  videoGenId = vidD.id;
  const vDone = await pollGen(vidD.id);
  assert.equal(vDone.status, "ok");
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "fal-ai/kling-video/v3/pro/image-to-video");
  assert.equal(call.input.start_image_url, done.output_url); // the stored image, no re-upload

  // Someone else's generation id is NOT a valid source (owner-scoped).
  const foreign = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { Authorization: `tma ${signInitData({ id: 703 })}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "kling3", prompt: "zoom", generation_id: imgD.id }),
  });
  assert.equal(foreign.status, 400);
});

await step("a video result can't be an image source (bad_source, nothing charged)", async () => {
  const r = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "kling3", prompt: "zoom", generation_id: videoGenId }),
  });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, "bad_source");
});

await step("POST /api/send delivers a generation into the user's Telegram chat", async () => {
  const { createServer } = await import("node:http");
  const sends: Array<{ path: string; body: Record<string, unknown> }> = [];
  const tgStub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      sends.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise<void>((r) => tgStub.listen(0, r));
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${(tgStub.address() as AddressInfo).port}`;

  // Video generation → sendVideo with the file URL into the owner's chat.
  const r = await fetch(`${base}/api/send`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id: videoGenId }),
  });
  assert.equal(r.status, 200);
  assert.match(sends[0].path, /\/sendVideo$/);
  assert.equal(sends[0].body.chat_id, maker.id);
  assert.match(String(sends[0].body.video), /^https:\/\/fal\.test\/out\/.*\.mp4$/);

  // Someone else's generation → 404, nothing sent.
  const foreign = await fetch(`${base}/api/send`, {
    method: "POST",
    headers: { Authorization: `tma ${signInitData({ id: 703 })}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: videoGenId }),
  });
  assert.equal(foreign.status, 404);
  assert.equal(sends.length, 1);
  await new Promise<void>((r2) => tgStub.close(() => r2()));
});

await step("catalog: model news banner + video composer params (durations priced, ratios, story)", async () => {
  const { body } = await apiMe(signInitData(maker));
  const c = body.catalog as unknown as {
    news: Array<{ key: string; title: string; credits: number; kind: string; freeTrial: boolean }>;
    videoModels: Array<{
      key: string;
      video: {
        durations: Array<{ seconds: number; credits: number }>;
        aspectRatios: string[];
        endFrame: boolean;
        resolutions: Array<{ id: string; label: string; credits: number }>;
      } | null;
    }>;
    imageModels: Array<{
      key: string;
      image: { aspectRatios: string[]; resolutions: Array<{ id: string; credits: number }> } | null;
    }>;
    presetAspects: string[];
    videoStory: Array<{ id: string; options: Array<Record<string, unknown>> }>;
  };
  assert.ok(c.news.length >= 3, "news banner empty");
  // freeTrial is credits ≤ FREE_CREDITS (3 in this env; Seedream @2🔫 is the free-trial anchor).
  for (const n of c.news) assert.equal(n.freeTrial, n.credits <= 3, `${n.key} freeTrial wrong`);
  assert.ok(c.news.some((n) => n.key === "text_to_image" && n.credits === 2 && n.freeTrial), "Seedream free-trial entry missing from news");
  const kling = c.videoModels.find((m) => m.key === "kling3")!;
  assert.deepEqual(kling.video!.durations.map((d) => d.seconds), [5, 10]);
  assert.equal(kling.video!.durations[0].credits, 42); // 5s default
  assert.equal(kling.video!.durations[1].credits, 84); // 10s = 2× ($0.168/s)
  // Kling has NO aspect_ratio param (ratio inherited from the frame) — advertise honestly.
  assert.deepEqual(kling.video!.aspectRatios, ["auto"]);
  assert.equal(kling.video!.endFrame, true); // …but it DOES support an end frame
  // Seedance actually honors ratio + a resolution ladder.
  const seed = c.videoModels.find((m) => m.key === "seedance_fast")!;
  assert.ok(seed.video!.aspectRatios.includes("9:16"), "Seedance missing vertical ratio");
  // Seedance 2.0 resolution enum is 480p/720p (fal schema) — 1080p is NOT a real tier there.
  assert.ok(seed.video!.resolutions.some((r) => r.id === "480p"), "Seedance missing 480p tier");
  assert.ok(!seed.video!.resolutions.some((r) => r.id === "1080p"), "Seedance 1080p is not a real fal 2.0 tier — must be removed");
  // Images now expose aspect ratio (fixes square-by-default) + Nano Banana quality tiers.
  const t2i = c.imageModels.find((m) => m.key === "text_to_image")!;
  assert.ok(t2i.image!.aspectRatios.includes("9:16"), "image model missing vertical ratio");
  const nb2 = c.imageModels.find((m) => m.key === "nb2_image")!;
  assert.ok(nb2.image!.resolutions.some((r) => r.id === "4K"), "Nano Banana missing 4K tier");
  assert.ok(c.presetAspects.includes("9:16"), "preset images missing vertical ratio");
  assert.ok(c.videoStory.length >= 3);
  for (const s of c.videoStory) for (const o of s.options) assert.ok(!("fragment" in o), "video-story fragment leaked");
});

await step("video composer: duration scales the charge, ratio flows to fal, story composes server-side", async () => {
  await addCredits(maker.id, 300, "admin_grant", "test");
  const before = (await apiMe(signInitData(maker))).body.dashboard.credits;
  const r = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "model", model: "kling3", generation_id: undefined,
      image_url: "https://fal.test/storage/u-1.jpg", prompt: "base motion",
      duration: 10, end_image_url: "https://fal.test/storage/u-2.jpg", // morph target
      options: ["reveal", "cinematic"], custom: "  любит  футбол ",
    }),
  });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { id: number; credits: number; balance: number };
  assert.equal(d.credits, 84); // 10s Kling 3.0 = 2× the 5s price
  assert.equal(d.balance, before - 84);
  await pollGen(d.id);
  const call = falCalls.at(-1)!;
  assert.equal(call.input.duration, "10");
  assert.equal(call.input.end_image_url, "https://fal.test/storage/u-2.jpg"); // end frame flows through
  assert.match(call.input.prompt as string, /cinematic reveal as the subject steps into the light/);
  assert.match(call.input.prompt as string, /film-grade color/);
  assert.match(call.input.prompt as string, /любит футбол/); // sanitized personalization

  // cost_usd scales with duration exactly like the patron charge (item 0's
  // cost map is the same math, just in USD instead of rounded patrons).
  const row = (await query("SELECT cost_usd FROM generations WHERE id = $1", [d.id]))[0];
  assert.equal(Number(row.cost_usd), 1.68); // 0.168 perSecondUsd × 10s
});

await step("video composer validation: bad duration/ratio → 400 bad_opts, bad story id → bad_option", async () => {
  const badDur = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "kling3", image_url: "https://fal.test/x/a.jpg", prompt: "m", duration: 7 }),
  });
  assert.equal(badDur.status, 400);
  assert.equal(((await badDur.json()) as { error: string }).error, "bad_opts");

  const badRatio = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "kling3", image_url: "https://fal.test/x/a.jpg", prompt: "m", aspect_ratio: "3:2" }),
  });
  assert.equal(badRatio.status, 400);
  assert.equal(((await badRatio.json()) as { error: string }).error, "bad_opts");

  const badStory = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "kling3", image_url: "https://fal.test/x/a.jpg", prompt: "m", options: ["nope"] }),
  });
  assert.equal(badStory.status, 400);
  assert.equal(((await badStory.json()) as { error: string }).error, "bad_option");
});

await step("input params: image aspect ratio → image_size, quality tier prices up, Seedance ratio+res flow", async () => {
  await addCredits(maker.id, 300, "admin_grant", "test");
  // Image aspect ratio: Seedream maps "9:16" → the named portrait_16_9 size (no more square-by-default).
  const img = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "text_to_image", prompt: "рисунок кота", aspect_ratio: "9:16" }),
  });
  assert.equal(img.status, 200);
  await pollGen(((await img.json()) as { id: number }).id);
  assert.equal(falCalls.at(-1)!.input.image_size, "portrait_16_9");

  // Quality tier: Nano Banana 2 at 4K costs the 2× multiplier (fal schema) and passes resolution through.
  const hi = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "nb2_image", prompt: "рисунок кота", resolution: "4K" }),
  });
  assert.equal(hi.status, 200);
  const hid = (await hi.json()) as { id: number; credits: number };
  assert.equal(hid.credits, 8); // 4 base × 2 (4K = 2× rate)
  await pollGen(hid.id);
  assert.equal(falCalls.at(-1)!.input.resolution, "4K");

  // Seedance honors ratio + resolution (unlike Kling): both flow to fal, price scales.
  const sv = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "model", model: "seedance_fast", image_url: "https://fal.test/storage/u-1.jpg",
      prompt: "motion", aspect_ratio: "9:16", resolution: "480p",
    }),
  });
  assert.equal(sv.status, 200);
  const svd = (await sv.json()) as { id: number; credits: number };
  assert.equal(svd.credits, 61); // 61 base (5s 720p); 480p priced same as 720p (mult 1) until measured
  await pollGen(svd.id);
  const scall = falCalls.at(-1)!;
  assert.equal(scall.input.aspect_ratio, "9:16");
  assert.equal(scall.input.resolution, "480p");
});

await step("end frame is validated as strictly as the source: video url or foreign id → 400", async () => {
  // A .mp4 end frame is rejected (end frames must be images).
  const vid = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "model", model: "kling3", image_url: "https://fal.test/storage/u-1.jpg",
      prompt: "m", end_image_url: "https://fal.test/out/9.mp4",
    }),
  });
  assert.equal(vid.status, 400);
  assert.equal(((await vid.json()) as { error: string }).error, "bad_end_frame");

  // A foreign/non-existent end_generation_id fails loudly instead of silently dropping.
  const foreign = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "model", model: "kling3", image_url: "https://fal.test/storage/u-1.jpg",
      prompt: "m", end_generation_id: 999999,
    }),
  });
  assert.equal(foreign.status, 400);
  assert.equal(((await foreign.json()) as { error: string }).error, "bad_end_frame");
});

await step("scenario video scenes: on-theme scene sets the motion; model swap adjusts price", async () => {
  const { body } = await apiMe(signInitData(maker));
  const wc = body.catalog.campaigns.find((k) => k.id === "worldcup") as unknown as {
    videoScenes: Array<{ id: string; label: string }>;
  };
  assert.ok(wc.videoScenes.some((s) => s.id === "score"), "football scene missing");
  for (const s of wc.videoScenes) assert.ok(!("prompt" in s), "scene prompt leaked to client");

  await addCredits(maker.id, 200, "admin_grant", "test");
  // Scene "score" (legendary goal) + model swapped to Seedance 2.0 Fast (61 🔫).
  const r = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "campaign_video", id: "worldcup", image_url: "https://fal.test/storage/u-1.jpg",
      scene: "score", model: "seedance_fast",
    }),
  });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { id: number; credits: number };
  assert.equal(d.credits, 61); // Seedance Fast (epic scene), not the Hailuo default (10)
  await pollGen(d.id);
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "bytedance/seedance-2.0/fast/image-to-video");
  assert.match(call.input.prompt as string, /fires it into the net/); // the scene

  // Unknown scene id / off-picker model → 400 (nothing charged).
  const badScene = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "campaign_video", id: "worldcup", image_url: "https://fal.test/x/a.jpg", scene: "nope" }),
  });
  assert.equal(badScene.status, 400);
  assert.equal(((await badScene.json()) as { error: string }).error, "bad_scene");

  const badModel = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "campaign_video", id: "worldcup", image_url: "https://fal.test/x/a.jpg", model: "nb2_image" }),
  });
  assert.equal(badModel.status, 400);
});

await step("scene tiering: epic scene auto-upgrades to Seedance; simple stays on the Hailuo default", async () => {
  const { body } = await apiMe(signInitData(maker));
  const wc = body.catalog.campaigns.find((k) => k.id === "worldcup") as unknown as {
    videoScenes: Array<{ id: string; tier: string; videoModelKey: string; videoCredits: number }>;
  };
  const score = wc.videoScenes.find((s) => s.id === "score")!;
  const fan = wc.videoScenes.find((s) => s.id === "fan")!;
  assert.equal(score.tier, "epic"); // legendary goal needs physics/multi-actor
  assert.equal(score.videoModelKey, "seedance_fast");
  assert.equal(score.videoCredits, 61);
  assert.equal(fan.tier, "simple");
  assert.equal(fan.videoCredits, 10); // Hailuo default

  await addCredits(maker.id, 200, "admin_grant", "test");
  // Epic scene WITHOUT an explicit model → server upgrades to Seedance (61), not Hailuo (10).
  const epic = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "campaign_video", id: "worldcup", image_url: "https://fal.test/storage/u-1.jpg", scene: "score" }),
  });
  assert.equal(epic.status, 200);
  assert.equal(((await epic.json()) as { credits: number }).credits, 61);

  // Simple scene WITHOUT a model → the cheap Hailuo default (10).
  const simple = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "campaign_video", id: "worldcup", image_url: "https://fal.test/storage/u-1.jpg", scene: "fan" }),
  });
  assert.equal(simple.status, 200);
  assert.equal(((await simple.json()) as { credits: number }).credits, 10);
});

await step("Seedance 2.0 uses the correct bytedance/ endpoint namespace (fal drift fix)", async () => {
  const { MODELS } = await import("../src/models.js");
  assert.equal(MODELS.seedance.falEndpoint, "bytedance/seedance-2.0/image-to-video");
  assert.equal(MODELS.seedance_fast.falEndpoint, "bytedance/seedance-2.0/fast/image-to-video");
  assert.ok(!MODELS.seedance.falEndpoint.startsWith("fal-ai/"), "stale fal-ai/ prefix");
});

await step("prompt quality guards: kid-focus + no-duplicates baked into cartoon and star presets", async () => {
  const { CAMPAIGNS } = await import("../src/models.js");
  const cartoon = CAMPAIGNS.find((c) => c.id === "cartoon")!;
  for (const p of cartoon.presets) {
    assert.match(p.prompt, /clear hero/i, `${p.id} missing kid-focus`);
    assert.match(p.prompt, /one single instance|shown once/i, `${p.id} missing de-dup guard`);
  }
  const wc = CAMPAIGNS.find((c) => c.id === "worldcup")!;
  for (const p of wc.presets.filter((x) => x.id !== "kit")) {
    assert.match(p.prompt, /exactly once in the frame/, `${p.id} missing NO_CLONES`);
  }
});

await step("gallery pagination: /api/generations pages finished works, excludes errors/no-output", async () => {
  const gal = { id: 909, username: "gal" };
  await getOrCreateUser(gal.id, gal.username, null, 3);
  for (let i = 0; i < 15; i++) {
    await logGeneration(gal.id, "seedream_edit", `p${i}`, 2, "ok", `https://fal.test/out/g${i}.png`);
  }
  await logGeneration(gal.id, "seedream_edit", "err", 2, "error"); // excluded (not ok)
  await logGeneration(gal.id, "seedream_edit", "nourl", 2, "ok"); // excluded (no output_url)
  const hdr = { Authorization: `tma ${signInitData(gal)}` };

  const p1 = (await (await fetch(`${base}/api/generations?page=1&size=12`, { headers: hdr })).json()) as {
    items: Array<{ output_url: string }>; total: number; pages: number; page: number; pageSize: number;
  };
  assert.equal(p1.total, 15); // only the 15 finished works with an output
  assert.equal(p1.pages, 2);
  assert.equal(p1.page, 1);
  assert.equal(p1.pageSize, 12);
  assert.equal(p1.items.length, 12);
  assert.ok(p1.items[0].output_url.endsWith("g14.png"), "gallery not newest-first");

  const p2 = (await (await fetch(`${base}/api/generations?page=2&size=12`, { headers: hdr })).json()) as {
    items: unknown[]; page: number;
  };
  assert.equal(p2.items.length, 3); // remainder on the last page
  assert.equal(p2.page, 2);

  // Out-of-range page clamps to the last page; unauth is rejected.
  const p9 = (await (await fetch(`${base}/api/generations?page=9&size=12`, { headers: hdr })).json()) as { page: number };
  assert.equal(p9.page, 2);
  assert.equal((await fetch(`${base}/api/generations`)).status, 401);
});

await step("watermark setting: default on, /api/settings toggles it, /me reflects it", async () => {
  const wu = { id: 808, username: "wm" };
  const hdr = { Authorization: `tma ${signInitData(wu)}`, "Content-Type": "application/json" };
  const read = async () =>
    ((await apiMe(signInitData(wu))).body as unknown as { dashboard: { watermarkEnabled: boolean } }).dashboard.watermarkEnabled;

  assert.equal(await read(), true); // default on

  const off = await fetch(`${base}/api/settings`, { method: "POST", headers: hdr, body: JSON.stringify({ watermark: false }) });
  assert.equal(off.status, 200);
  assert.equal(((await off.json()) as { watermark: boolean }).watermark, false);
  assert.equal(await read(), false); // persisted + shared with the bot

  const bad = await fetch(`${base}/api/settings`, { method: "POST", headers: hdr, body: JSON.stringify({ watermark: "nope" }) });
  assert.equal(bad.status, 400);
});

await step("POST /api/account/delete: self-serve deletion scrubs PII, zeroes credits, requires auth, idempotent 404 on retry", async () => {
  const du = { id: 809, username: "deleteme" };
  await getOrCreateUser(du.id, du.username, null, 0);
  await addCredits(du.id, 40, "admin_grant", "test");
  const hdr = { Authorization: `tma ${signInitData(du)}` };

  const unauth = await fetch(`${base}/api/account/delete`, { method: "POST" });
  assert.equal(unauth.status, 401);

  const ok = await fetch(`${base}/api/account/delete`, { method: "POST", headers: hdr });
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as { deleted: boolean; forfeitedCredits: number };
  assert.equal(okBody.deleted, true);
  assert.equal(okBody.forfeitedCredits, 40);

  const row = (await query("SELECT username, credits, deleted_at FROM users WHERE id = $1", [du.id]))[0];
  assert.equal(row.username, null);
  assert.equal(Number(row.credits), 0);
  assert.ok(row.deleted_at);

  // Already deleted → 404, not a re-grant of anything.
  const again = await fetch(`${base}/api/account/delete`, { method: "POST", headers: hdr });
  assert.equal(again.status, 404);
});

await step("reward-architecture P1: XP is inert until configured, then Level gates presets and save-XP is idempotent+capped", async () => {
  const ru = { id: 990090, username: "rewarduser", first_name: "Rew" };
  await getOrCreateUser(ru.id, ru.username, null, 0);
  await addCredits(ru.id, 100, "admin_grant", "test"); // headroom for the gating checks near the end
  const H = { Authorization: `tma ${signInitData(ru)}`, "Content-Type": "application/json" };

  // Nothing configured yet: Level is 0, /api/me exposes xp/level, and the
  // (still-empty) preset_gating table blocks nothing.
  const me0 = (await apiMe(signInitData(ru))).body as unknown as { dashboard: { xp: number; level: number } };
  assert.equal(me0.dashboard.xp, 0);
  assert.equal(me0.dashboard.level, 0);

  // Seed a completed generation to "save."
  await logGeneration(ru.id, "text_to_image", "p", 2, "ok", "https://fal.test/out/rew.png");
  const genId = Number((await query("SELECT id FROM generations WHERE user_id = $1", [ru.id]))[0].id);

  // xp.save unconfigured → the save endpoint is a harmless no-op (0 awarded).
  const noop = await fetch(`${base}/api/xp/save`, { method: "POST", headers: H, body: JSON.stringify({ id: genId }) });
  assert.equal(noop.status, 200);
  assert.equal(((await noop.json()) as { awarded: number }).awarded, 0);
  assert.equal(await getUserXp(ru.id), 0);

  // Now configure it — save-XP awards, exactly once, and is capped daily.
  await setEconomyConfig("xp.save", 25);
  await setEconomyConfig("xp.save.dailycap", 2);
  const first = await fetch(`${base}/api/xp/save`, { method: "POST", headers: H, body: JSON.stringify({ id: genId }) });
  assert.equal(((await first.json()) as { awarded: number }).awarded, 25);
  assert.equal(await getUserXp(ru.id), 25);

  // Re-tapping "Скачать" on the SAME generation must not re-award (idempotent claim).
  const again = await fetch(`${base}/api/xp/save`, { method: "POST", headers: H, body: JSON.stringify({ id: genId }) });
  assert.equal(((await again.json()) as { awarded: number }).awarded, 0);
  assert.equal(await getUserXp(ru.id), 25);

  // A second DIFFERENT generation still earns, up to the daily cap (2/day).
  await logGeneration(ru.id, "text_to_image", "p", 2, "ok", "https://fal.test/out/rew2.png");
  const gen2 = Number(
    (await query("SELECT id FROM generations WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [ru.id]))[0].id,
  );
  await fetch(`${base}/api/xp/save`, { method: "POST", headers: H, body: JSON.stringify({ id: gen2 }) });
  assert.equal(await getUserXp(ru.id), 50);

  // A third would exceed the daily cap of 2 saves → capped at 0 additional XP.
  await logGeneration(ru.id, "text_to_image", "p", 2, "ok", "https://fal.test/out/rew3.png");
  const gen3 = Number(
    (await query("SELECT id FROM generations WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [ru.id]))[0].id,
  );
  await fetch(`${base}/api/xp/save`, { method: "POST", headers: H, body: JSON.stringify({ id: gen3 }) });
  assert.equal(await getUserXp(ru.id), 50, "the daily save cap must hold");

  // Someone else's generation can't be claimed for XP.
  const stranger = { id: 990091, username: "stranger" };
  await getOrCreateUser(stranger.id, stranger.username, null, 0);
  const stolen = await fetch(`${base}/api/xp/save`, {
    method: "POST",
    headers: { Authorization: `tma ${signInitData(stranger)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: genId }),
  });
  assert.equal(((await stolen.json()) as { awarded: number }).awarded, 0);

  // Unauthenticated: 401.
  assert.equal((await fetch(`${base}/api/xp/save`, { method: "POST", body: JSON.stringify({ id: genId }) })).status, 401);

  // Preset gating: gate "headshot" at Level 5 — this user is Level 0 (thresholds
  // still unconfigured), so the preset must now be blocked; an ungated preset
  // must be unaffected.
  await setPresetGating("headshot", 5);
  assert.equal(await getLevel(ru.id), 0);
  const gated = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "preset", id: "headshot", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(gated.status, 403);
  const gatedBody = (await gated.json()) as { error: string; requiredLevel: number; level: number };
  assert.equal(gatedBody.error, "level_locked");
  assert.equal(gatedBody.requiredLevel, 5);
  assert.equal(gatedBody.level, 0);

  const ungated = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "preset", id: "product_white", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(ungated.status, 200, "an ungated preset must not be affected by another preset's gate");

  // The catalog must carry the gate so the CARD can show a lock up front —
  // otherwise the user only discovers it after configuring and tapping "Создать".
  const cat = (await apiMe(signInitData(ru))).body.catalog as unknown as {
    presets: Array<{ id: string; minLevel: number }>;
  };
  assert.equal(cat.presets.find((p) => p.id === "headshot")?.minLevel, 5);
  assert.equal(cat.presets.find((p) => p.id === "product_white")?.minLevel, 0, "an ungated preset must report 0");

  // Levelling up: configure a level-1 threshold at 40 XP (this user already has 50) — unlocks it.
  await setEconomyConfig("level.threshold.1", 40);
  assert.equal(await getLevel(ru.id), 1);
});

await step("reward-architecture P4a: /api/me exposes the active season, null by default", async () => {
  const su = { id: 990092, username: "seasonuser" };
  const before = (await apiMe(signInitData(su))).body as unknown as { season: unknown };
  assert.equal(before.season, null);

  const created = await createSeason("s-webapp-test", "Тестовый сезон", 30);
  assert.ok(!("error" in created));
  const after = (await apiMe(signInitData(su))).body as unknown as {
    season: { key: string; themeLabel: string; startsAt: string; endsAt: string } | null;
  };
  assert.equal(after.season?.key, "s-webapp-test");
  assert.equal(after.season?.themeLabel, "Тестовый сезон");
  assert.ok(after.season?.startsAt);
  assert.ok(after.season?.endsAt);
});

await step("style reference: a preset's curated ref rides in image_urls; a client-supplied one cannot", async () => {
  const su = { id: 990093, username: "styleref" };
  await getOrCreateUser(su.id, su.username, null, 0);
  await addCredits(su.id, 60, "admin_grant", "test");
  const H = { Authorization: `tma ${signInitData(su)}`, "Content-Type": "application/json" };

  // A campaign preset that ships a curated reference → two entries in
  // image_urls, the USER's photo first (it is the identity anchor).
  const withRef = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "campaign", id: "odyssey:king", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(withRef.status, 200);
  const refCall = falCalls.at(-1)!;
  const urls = refCall.input.image_urls as string[];
  assert.equal(urls.length, 2);
  assert.equal(urls[0], "https://fal.test/storage/u-1.jpg", "the user's photo must stay first");
  assert.match(urls[1], /\/img\/card-odyssey\.jpg$/);
  // …and the model is told the second image is style-only, or it may blend faces.
  assert.match(refCall.input.prompt as string, /STYLE REFERENCE ONLY/);
  assert.match(refCall.input.prompt as string, /Do not copy any person, face or body/);

  // A preset WITHOUT a styleRef stays single-image — refs are opt-in per look.
  const noRef = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "campaign", id: "odyssey:penelope", image_url: "https://fal.test/storage/u-1.jpg" }),
  });
  assert.equal(noRef.status, 200);
  assert.equal((falCalls.at(-1)!.input.image_urls as string[]).length, 1);
  assert.ok(!(falCalls.at(-1)!.input.prompt as string).includes("STYLE REFERENCE"));

  // SECURITY: a caller naming their own reference must not reach the provider —
  // otherwise /api/generate is a "fetch any URL I name" primitive.
  const injected = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      source: "campaign", id: "odyssey:penelope", image_url: "https://fal.test/storage/u-1.jpg",
      styleRefUrl: "https://evil.test/internal.jpg", style_ref: "https://evil.test/internal.jpg",
    }),
  });
  assert.equal(injected.status, 200);
  const injCall = falCalls.at(-1)!;
  assert.equal((injCall.input.image_urls as string[]).length, 1, "client-named reference must be ignored");
  assert.ok(!JSON.stringify(injCall.input).includes("evil.test"), "a caller-supplied URL must never reach fal");
});

await step("provider down: the breaker refuses WITHOUT charging, and clears itself on recovery", async () => {
  const { resetProviderBlock, providerBlocked } = await import("../src/generate.js");
  const du = { id: 990098, username: "downtime" };
  await getOrCreateUser(du.id, du.username, null, 0);
  await addCredits(du.id, 50, "admin_grant", "test");
  const H = { Authorization: `tma ${signInitData(du)}`, "Content-Type": "application/json" };
  const gen = () => fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "model", model: "text_to_image", prompt: "a cat" }),
  });
  const balance = async () => (await apiMe(signInitData(du))).body.dashboard.credits;

  resetProviderBlock();
  assert.equal(providerBlocked(), false);

  // First render meets the locked account. It charges and refunds as before —
  // this one we cannot avoid, it is how we LEARN the provider is down.
  providerLocked = true;
  const first = await gen();
  assert.equal(first.status, 200, "we only find out mid-render, so the request itself succeeds");
  const firstDone = await pollGen(((await first.json()) as { id: number }).id, H);
  assert.equal(firstDone.status, "error");
  assert.equal(await balance(), 50, "charged then refunded — net zero");
  assert.equal(providerBlocked(), true, "one unambiguous block trips the breaker");

  // Every render after that is refused up front. The user waits zero seconds
  // and, critically, is never charged for a render that cannot happen.
  const before = await balance();
  const second = await gen();
  assert.equal(second.status, 503);
  assert.equal(((await second.json()) as { error: string }).error, "provider_down");
  assert.equal(await balance(), before, "a refused render must not touch the balance");
  // No pending row either — nothing to reap, nothing in «Мои работы».
  const pend = await query("SELECT COUNT(*)::int AS c FROM generations WHERE user_id = $1 AND status = 'pending'", [du.id]);
  assert.equal(Number(pend[0].c), 0);

  // Recovery must be automatic: topping the balance up is done at the provider,
  // not here, so nothing in our system would ever know to un-break itself.
  providerLocked = false;
  resetProviderBlock();
  const third = await gen();
  assert.equal(third.status, 200);
  assert.equal((await pollGen(((await third.json()) as { id: number }).id, H)).status, "ok");
  assert.equal(providerBlocked(), false, "a successful run proves the account works again");
});

await step("XP earning: breadth pays once per new thing, free actions cannot be farmed", async () => {
  const { awardXpOnce, awardXpCapped } = await import("../src/db.js");
  const xu = { id: 990099, username: "xpearner" };
  await getOrCreateUser(xu.id, xu.username, null, 0);
  await addCredits(xu.id, 300, "admin_grant", "test");
  const H = { Authorization: `tma ${signInitData(xu)}`, "Content-Type": "application/json" };
  await query("DELETE FROM economy_config WHERE key LIKE 'xp.%'");
  // An earlier step gates a style behind a Level; this one is about earning,
  // not gating, so start from an ungated catalogue.
  await query("DELETE FROM preset_gating");

  // Inert until configured — the shipped default, and the rule the whole
  // economy_config design exists for.
  assert.equal(await awardXpOnce(xu.id, "model:seedream_edit", "model"), 0);
  assert.equal(await awardXpCapped(xu.id, "generate"), 0);
  assert.equal(await getUserXp(xu.id), 0, "nothing may accrue while unconfigured");

  await setEconomyConfig("xp.generate", 5);
  await setEconomyConfig("xp.model", 20);
  await setEconomyConfig("xp.image", 15);
  await setEconomyConfig("xp.preset", 10);
  await setEconomyConfig("xp.upload", 30);
  await setEconomyConfig("xp.share", 8);

  // A completed render pays the repeatable award PLUS the one-time breadth
  // awards for a first-seen engine, mode and style.
  const gen = async (preset: string) => {
    const r = await fetch(`${base}/api/generate`, {
      method: "POST", headers: H,
      body: JSON.stringify({ source: "preset", id: preset, image_url: "https://fal.test/storage/u-1.jpg" }),
    });
    assert.equal(r.status, 200);
    return pollGen(((await r.json()) as { id: number }).id, H);
  };
  await gen("fashion");
  const afterFirst = await getUserXp(xu.id);
  assert.equal(afterFirst, 5 + 20 + 15 + 10, "generate + first model + first mode + first preset");

  // Same engine, same mode, SAME style again: only the repeatable part pays.
  await gen("fashion");
  assert.equal(await getUserXp(xu.id) - afterFirst, 5, "breadth must not pay twice for the same thing");

  // A DIFFERENT style pays its own one-time award — this is the exploration
  // incentive, and it is self-limiting: the catalogue is finite.
  const beforeNew = await getUserXp(xu.id);
  await gen("headshot");
  assert.equal(await getUserXp(xu.id) - beforeNew, 5 + 10, "a new style pays once");

  // FREE actions are the real abuse surface: uploading and sharing cost the
  // user nothing, so an un-guarded award would be an infinite XP farm.
  const beforeUpload = await getUserXp(xu.id);
  const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/api/upload`, { method: "POST", headers: H, body: JSON.stringify({ data: px }) });
    assert.equal(r.status, 200);
  }
  assert.equal(await getUserXp(xu.id) - beforeUpload, 30, "three uploads, one award");

  await query("DELETE FROM economy_config WHERE key LIKE 'xp.%'");
});

await step("/healthz reports the BOT, not just the socket — a dead poller must fail the check", async () => {
  const { setLivenessProbe } = await import("../src/webapp.js");
  const hz = async () => {
    const r = await fetch(`${base}/healthz`);
    return { status: r.status, body: (await r.json()) as { ok: boolean; polling: boolean } };
  };

  // Default: healthy. Callers that serve the web layer alone (Vercel, tests)
  // have no bot to report on and must not be marked down.
  const fresh = await hz();
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.ok, true);

  // The real failure this exists for: the process is alive and answering HTTP,
  // but Telegram is no longer being polled. Before this, /healthz returned a
  // flat 200 here — so the platform health check stayed green over a total bot
  // outage and nothing ever restarted it.
  setLivenessProbe(() => false);
  const dead = await hz();
  assert.equal(dead.status, 503, "a dead poller must fail the health check");
  assert.equal(dead.body.polling, false);

  setLivenessProbe(() => true);
  assert.equal((await hz()).status, 200, "recovery must clear the check");
});

await step("bento birthday: pins the typography engine and holds two ages of one face", async () => {
  const { PRESETS, presetModel } = await import("../src/models.js");
  const { existsSync } = await import("node:fs");
  const p = PRESETS.find((x) => x.id === "bento_birthday")!;

  // The look is worthless if the icing text comes out garbled, and the registry
  // comment is explicit that Seedream garbles text — so this preset must stay
  // on the typography engine even though it costs more than the default.
  const m = presetModel(p);
  assert.equal(m.key, "premium_edit");
  // The pin is a deliberate cost trade-off, so state it: this look bills more
  // than a default-engine look, and that is accepted for legible icing.
  const { PRESET_MODEL } = await import("../src/models.js");
  assert.ok(m.credits > PRESET_MODEL.credits, "the typography engine is the pricier tier, on purpose");
  assert.match(p.prompt, /HAPPY BIRTHDAY/);
  assert.match(p.prompt, /correctly spelled and fully readable/);

  // Two likenesses of ONE person share the frame: the birthday person behind
  // the cake and a printed younger cutout on it. The prompt must keep them
  // apart, or the model adds a real child as a guest.
  //
  // The subject keeps THEIR OWN age. The previous wording — "as an ADULT with
  // their real grown-up face" — was the defect: a seven-year-old who used this
  // look came back as a teenager, because the prompt was ordering the model to
  // replace the hero rather than celebrate them.
  assert.match(p.prompt, /AT THEIR OWN AGE/);
  assert.match(p.prompt, /must NOT be aged up/);
  assert.doesNotMatch(p.prompt, /as an ADULT with their real grown-up face/);
  // And the cutout must be named a PROP, so it is never read as the subject.
  assert.match(p.prompt, /this cutout is a PROP/);
  assert.match(p.prompt, /FLAT PRINTED PHOTO CUTOUT/);
  assert.match(p.prompt, /not a real child and not a second guest/);
  // NO_CLONES ("show each person exactly once") would forbid exactly the
  // composition this look is built on — it must not be present.
  assert.ok(!p.prompt.includes("Show each person exactly once"), "the clone guard would break this look");

  // Card art is derived from the id, so a missing file 404s in the catalog.
  assert.ok(existsSync(new URL("../public/img/card-preset-bento_birthday.jpg", import.meta.url)));
});

await step("prompt library: a group photo keeps everyone — no silent crop to one person", async () => {
  const { PRESETS, CAMPAIGNS } = await import("../src/models.js");
  // A couple or family photo used to come back with one of them deleted: the
  // shared identity clause was written in the singular ("the person's face"),
  // which reads as "the answer contains one human". Every curated prompt ends
  // with that clause, so the headcount rule has to live there — and it has to
  // survive, since the singular phrasing inside individual prompts ("the
  // person as a Bronze Age king") pulls the other way.
  const everyone = [
    ...PRESETS.map((p) => [`preset:${p.id}`, p.prompt] as const),
    ...CAMPAIGNS.flatMap((c) => c.presets.map((p) => [`campaign:${c.id}:${p.id}`, p.prompt] as const)),
  ];
  let checked = 0;
  for (const [where, text] of everyone) {
    // Kid-focused looks are deliberately single-subject (KEEP_KID + KID_FOCUS)
    // and are exempt by design, not by oversight.
    if (!text.includes("Keep the face and identity of EVERY person")) continue;
    assert.match(text, /SAME NUMBER of people/, `${where} lost the headcount rule`);
    checked++;
  }
  assert.ok(checked > 20, `expected the group rule on most looks, saw ${checked}`);

  // The three looks the user named specifically must ALSO handle a group in
  // their own body, not just in the trailing clause — each describes framing
  // that a second person has to fit into.
  const byId = (id: string) => PRESETS.find((p) => p.id === id)!.prompt;
  assert.match(byId("photobooth_bw"), /EVERY person from the source photo appears in EVERY one of the three frames/);
  assert.match(byId("retro90s"), /style them ALL and pose them together as one group/);
  assert.match(byId("fashion"), /ALL the people, if the photo shows more than one/);
});

await step("prompt library: no third-party brand or magazine names reach the provider", async () => {
  const { PRESETS, CAMPAIGNS, VIDEO_STORY } = await import("../src/models.js");
  // Naming a real fashion house or magazine does two bad things at once: it
  // puts someone else's trademark (often a monogram print) onto a paying user's
  // chest, and it is worse styling than describing the silhouette we actually
  // want. Concept and props carry an editorial; a logo does not.
  const BANNED = /\b(gucci|louis\s*vuitton|prada|chanel|balenciaga|dior|versace|rolex|herm[eè]s|nike|adidas|vogue|elle|harper'?s bazaar|cosmopolitan)\b/i;
  const texts: Array<[string, string]> = [];
  for (const p of PRESETS) texts.push([`preset:${p.id}`, p.prompt]);
  for (const c of CAMPAIGNS) {
    for (const p of c.presets) texts.push([`campaign:${c.id}:${p.id}`, p.prompt]);
    for (const s of c.videoScenes ?? []) texts.push([`scene:${c.id}:${s.id}`, s.prompt]);
    texts.push([`animate:${c.id}`, c.animatePrompt]);
  }
  for (const s of VIDEO_STORY) for (const o of s.options) texts.push([`story:${s.id}:${o.id}`, o.fragment]);
  for (const [where, text] of texts) {
    const hit = text.match(BANNED);
    assert.ok(!hit, `${where} names a third-party brand: "${hit?.[0]}"`);
  }
  // The fashion look must say so out loud, not merely omit brands — the model
  // reaches for logo-shaped clothing on "high fashion" unless told not to.
  const fashion = PRESETS.find((p) => p.id === "fashion")!;
  assert.match(fashion.prompt, /NO brand names, NO logos/);
  // And the retro look must actually restage the person, which is the whole
  // difference between a photoshoot and a colour filter.
  const retro = PRESETS.find((p) => p.id === "retro90s")!;
  assert.match(retro.prompt, /do not keep the pose from the source photo/);
  for (const cue of [/polka-dot/i, /oversized double-breasted suit/i, /headscarf/i, /retro car/i]) {
    assert.match(retro.prompt, cue);
  }
});

await step("provider block: an account-level rejection is classified and alerts on the FIRST one", async () => {
  const { isProviderBlocked } = await import("../src/generate.js");
  const { checkAlerts } = await import("../src/monitor.js");

  // What fal actually returns when the account runs dry — the exact shape that
  // sent us hunting for a bug in one model.
  assert.equal(isProviderBlocked({ status: 403, body: { detail: "User is locked. Reason: Exhausted balance." } }), true);
  assert.equal(isProviderBlocked({ status: 401, body: {} }), true, "a bad key is the same class of outage");
  assert.equal(isProviderBlocked({ body: { detail: "insufficient balance" } }), true, "detail alone is enough");
  // A model failing on its own is NOT an account outage — misclassifying it
  // would cry wolf on every ordinary provider hiccup.
  assert.equal(isProviderBlocked({ status: 500, body: { detail: "internal error" } }), false);
  assert.equal(isProviderBlocked(new Error("No output URL in fal response")), false);
  assert.equal(isProviderBlocked(null), false);

  const bu = { id: 990097, username: "blocked" };
  await getOrCreateUser(bu.id, bu.username, null, 0);
  await query("DELETE FROM events WHERE type = 'provider_blocked'");
  assert.ok(!(await checkAlerts()).some((a) => a.key === "provider_blocked"), "quiet while nothing is blocked");

  // ONE event is enough. The per-model drift alert needs 5 runs of the same
  // model within an hour, which an expensive, rarely-run video model never
  // reaches — so without this rule an account outage stays invisible exactly
  // where it hurts most.
  await logEvent(bu.id, "provider_blocked", "seedance");
  const alerts = await checkAlerts();
  const hit = alerts.find((a) => a.key === "provider_blocked");
  assert.ok(hit, "a single provider block must alert immediately");
  assert.match(hit!.text, /seedance/);
  await query("DELETE FROM events WHERE type = 'provider_blocked'");
});

await step("/api/me progress: inert by default, then a real position on the private XP ladder", async () => {
  const pu = { id: 990096, username: "progress" };
  await getOrCreateUser(pu.id, pu.username, null, 0);
  type Prog = { active: boolean; xp: number; level: number; levelAt: number; nextAt: number | null; into: number; span: number };
  // The P1 step earlier in this suite leaves a ladder configured, so start from
  // a known-empty one — this step is about the ladder's own edge cases.
  await query("DELETE FROM economy_config WHERE key LIKE 'level.threshold.%'");
  const read = async () => (await apiMe(signInitData(pu))).body.progress as unknown as Prog;

  // Shipped default: no level.threshold.* configured at all → inert. The UI
  // shows "уровни скоро" rather than an empty Level 0 bar.
  const off = await read();
  assert.equal(off.active, false);
  assert.equal(off.level, 0);

  // A three-rung ladder. These numbers live in economy_config (private tuning),
  // never in the repo — the client only ever receives a POSITION on them.
  await setEconomyConfig("level.threshold.1", 100);
  await setEconomyConfig("level.threshold.2", 300);
  await setEconomyConfig("level.threshold.3", 600);

  const zero = await read();
  assert.equal(zero.active, true);
  assert.equal(zero.level, 0);
  assert.equal(zero.nextAt, 100);
  assert.equal(zero.into, 0);
  assert.equal(zero.span, 100, "the level-0 band runs from 0 to the first threshold");

  // Mid-band: the bar must measure progress INSIDE the band, not from zero —
  // 150 XP at level 1 is a fifth of the way to level 2, not half of 300.
  await setEconomyConfig("xp.probe", 150);
  await awardXp(pu.id, "probe", "mid");
  const mid = await read();
  assert.equal(mid.level, 1);
  assert.equal(mid.xp, 150);
  assert.equal(mid.levelAt, 100);
  assert.equal(mid.nextAt, 300);
  assert.equal(mid.into, 50);
  assert.equal(mid.span, 200);

  // Top of the configured ladder: no phantom "next", and a full bar rather
  // than a division by zero.
  await setEconomyConfig("xp.probe", 500);
  await awardXp(pu.id, "probe", "max");
  const top = await read();
  assert.equal(top.level, 3);
  assert.equal(top.nextAt, null);
  assert.equal(top.into, top.span, "a maxed ladder renders as a complete bar");

  // The private ladder itself must NOT be shipped to the client anywhere in the
  // payload — only the user's position on it.
  const body = JSON.stringify((await apiMe(signInitData(pu))).body);
  assert.ok(!body.includes("level.threshold"), "the XP table must never reach the client");

  await query("DELETE FROM economy_config WHERE key LIKE 'level.threshold.%' OR key = 'xp.probe'");
});

await step("multi-image input: extra angles ride along, are capped per model, and the host is enforced", async () => {
  const mu = { id: 990095, username: "manyangles" };
  await getOrCreateUser(mu.id, mu.username, null, 0);
  await addCredits(mu.id, 200, "admin_grant", "test");
  const H = { Authorization: `tma ${signInitData(mu)}`, "Content-Type": "application/json" };
  const P = "https://fal.test/storage/primary.jpg";

  // Three angles of one face → four entries, the PRIMARY first (it is the
  // identity anchor), and the model told in words that this is one person.
  const ok = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      source: "model", model: "seedream_edit", prompt: "portrait", image_url: P,
      image_urls: ["https://fal.test/storage/a2.jpg", "https://fal.test/storage/a3.jpg"],
    }),
  });
  assert.equal(ok.status, 200);
  const call = falCalls.at(-1)!;
  const urls = call.input.image_urls as string[];
  assert.deepEqual(urls, [P, "https://fal.test/storage/a2.jpg", "https://fal.test/storage/a3.jpg"]);
  assert.match(call.input.prompt as string, /first 3 images are reference photographs of the SAME subject/);
  // Phrased around IDENTITY, never headcount: a couple or family photo must
  // survive extra angles, so the clause may not assert "exactly one person".
  assert.match(call.input.prompt as string, /no one added and no one dropped/);
  assert.ok(!/exactly ONE person/i.test(call.input.prompt as string), "must not force a single subject");
  // Extra angles are free — the charge is the model's base price, unchanged.
  assert.equal(((await ok.json()) as { credits: number }).credits, 2);

  // A duplicate of the primary is dropped rather than billed as context twice.
  const dup = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "model", model: "seedream_edit", prompt: "p", image_url: P, image_urls: [P, P] }),
  });
  assert.equal(dup.status, 200);
  assert.deepEqual(falCalls.at(-1)!.input.image_urls as string[], [P]);
  assert.ok(!(falCalls.at(-1)!.input.prompt as string).includes("reference photographs of the SAME subject"));

  // Over the model's own cap → 400 with the cap echoed back, nothing charged.
  const before = (await apiMe(signInitData(mu))).body.dashboard.credits;
  const tooMany = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      source: "model", model: "premium_edit", prompt: "p", image_url: P, // premium reads 2 total
      image_urls: ["https://fal.test/storage/a2.jpg", "https://fal.test/storage/a3.jpg"],
    }),
  });
  assert.equal(tooMany.status, 400);
  assert.equal(((await tooMany.json()) as { error: string; maxInputs: number }).maxInputs, 2);

  // SECURITY: an off-host URL is refused even when it is perfectly valid HTTPS.
  // Otherwise a caller could host the photo anywhere and skip the upload
  // moderation gate entirely — and hand our provider any address they like.
  for (const bad of [
    "https://evil.test/x.jpg",
    "https://fal.test.evil.test/x.jpg", // suffix must match on a host boundary
    "https://notfal.test/x.jpg", // …and not merely end with the allowed string
  ]) {
    const r = await fetch(`${base}/api/generate`, {
      method: "POST", headers: H,
      body: JSON.stringify({ source: "model", model: "seedream_edit", prompt: "p", image_url: P, image_urls: [bad] }),
    });
    assert.equal(r.status, 400, `${bad} must be refused`);
    assert.equal(((await r.json()) as { error: string }).error, "bad_source");
  }
  // The same rule covers the PRIMARY photo, not just the extras.
  const badPrimary = await fetch(`${base}/api/generate`, {
    method: "POST", headers: H,
    body: JSON.stringify({ source: "model", model: "seedream_edit", prompt: "p", image_url: "https://evil.test/x.jpg" }),
  });
  assert.equal(badPrimary.status, 400);
  assert.equal((await apiMe(signInitData(mu))).body.dashboard.credits, before, "refused requests must not charge");

  // The catalog tells the client the per-model cap, so the UI can stop earlier.
  const cat = (await apiMe(signInitData(mu))).body.catalog as unknown as {
    studio: { image: Array<{ key: string; image: { maxInputs: number } | null }> };
  };
  assert.equal(cat.studio.image.find((m) => m.key === "seedream_edit")!.image!.maxInputs, 4);
  assert.equal(cat.studio.image.find((m) => m.key === "premium_edit")!.image!.maxInputs, 2);
  // A text-to-image model reads no photo at all — 1, so no "add angle" affordance.
  assert.equal(cat.studio.image.find((m) => m.key === "text_to_image")!.image!.maxInputs, 1);
});

await step("registry invariant: every declared styleRef points at art that actually exists", async () => {
  const { CAMPAIGNS, PRESETS } = await import("../src/models.js");
  const { existsSync } = await import("node:fs");
  // A styleRef resolves to /img/<file> on our own origin. If the art is missing
  // the provider silently gets a 404 for the reference and the look degrades to
  // "no reference at all" — invisible in tests, visible only in the output. So
  // the filename is checked against disk here rather than trusted.
  const refs: string[] = [];
  for (const c of CAMPAIGNS) for (const p of c.presets) if (p.styleRef) refs.push(p.styleRef);
  for (const p of PRESETS) if (p.styleRef) refs.push(p.styleRef);
  assert.ok(refs.length > 0, "the invariant is only meaningful while some preset uses a styleRef");
  for (const f of refs) {
    assert.ok(existsSync(new URL(`../public/img/${f}`, import.meta.url)), `styleRef art missing: public/img/${f}`);
  }
  // Agamemnon carries its OWN plate — the campaign's default cover is a warm
  // amber key and would fight the cold blue-steel look this role is built on.
  const ody = CAMPAIGNS.find((c) => c.id === "odyssey")!;
  const aga = ody.presets.find((p) => p.id === "agamemnon")!;
  assert.equal(aga.styleRef, "card-agamemnon.jpg");
  assert.notEqual(aga.styleRef, ody.presets.find((p) => p.id === "king")!.styleRef);
});

await step("registry invariant: every declared maxCount is actually wired to num_images", async () => {
  const { MODELS } = await import("../src/models.js");
  // A model can advertise "до N шт" in the picker only if its input builder
  // really emits num_images — otherwise the user is charged N× for one image.
  // (Endpoint IDs and their num_images support were verified against the live
  // fal queue OpenAPI schemas; this guards the wiring on OUR side.)
  for (const m of Object.values(MODELS) as Array<Record<string, unknown>>) {
    const img = m.image as { maxCount?: number } | undefined;
    if (!img?.maxCount || img.maxCount < 2) continue;
    const build = m.input as (p: string, i: string, o: unknown) => Record<string, unknown>;
    const one = build("p", "https://fal.test/storage/a.jpg", { numImages: 1 });
    const many = build("p", "https://fal.test/storage/a.jpg", { numImages: img.maxCount });
    assert.equal(one.num_images, undefined, `${String(m.key)}: a single image must not send num_images`);
    assert.equal(many.num_images, img.maxCount, `${String(m.key)}: maxCount is advertised but never sent`);
    // …and the cap is a real cap: asking for more than we allow is clamped.
    const over = build("p", "https://fal.test/storage/a.jpg", { numImages: img.maxCount + 50 });
    assert.equal(over.num_images, img.maxCount, `${String(m.key)}: count is not clamped to maxCount`);
  }
});

await step("model catalog: real provider names, and ETA only once we have MEASURED runs", async () => {
  const eu = { id: 990094, username: "etauser" };
  const cat0 = (await apiMe(signInitData(eu))).body.catalog as unknown as {
    studio: { image: Array<{ key: string; label: string; note: string; etaSeconds: number }> };
  };
  // Real provider names, shown as-is — users search for exactly these strings.
  const byKey = (k: string) => cat0.studio.image.find((m) => m.key === k)!;
  assert.equal(byKey("nbpro_image").label, "Nano Banana Pro");
  assert.equal(byKey("nb2_image").label, "Nano Banana 2");
  assert.equal(byKey("premium_image").label, "GPT Image 2");
  assert.equal(byKey("text_to_image").label, "Seedream 4.5");
  assert.ok(byKey("nbpro_image").note.length > 0, "a real name still needs a line saying what it's for");

  // No finished runs for this model yet → 0, and the client must fall back to
  // its coarse copy rather than print a number we invented.
  assert.equal(byKey("nb2_edit").etaSeconds, 0);

  // Seed finished runs with a known spread; the median (not the mean) wins, so
  // one pathological outlier can't inflate everyone's ETA.
  for (const sec of [20, 22, 24, 26, 600]) {
    await query(
      `INSERT INTO generations (user_id, model, prompt, credits, status, output_url, created_at, finished_at)
       VALUES ($1, 'nb2_edit', 'p', 4, 'ok', 'https://fal.test/o.png', now() - ($2 || ' seconds')::interval, now())`,
      [eu.id, String(sec)],
    );
  }
  const cat1 = (await apiMe(signInitData(eu))).body.catalog as unknown as {
    studio: { image: Array<{ key: string; etaSeconds: number }> };
  };
  const eta = cat1.studio.image.find((m) => m.key === "nb2_edit")!.etaSeconds;
  // Not pinned to an exact value: earlier steps in this suite also render on
  // nb2_edit and their near-instant runs land in the same sample. What must
  // hold is the property — the 600s outlier does NOT drag the estimate up
  // (its mean would be ~138s), because we take the median.
  assert.ok(eta > 0, "an ETA must appear once there are enough finished runs");
  assert.ok(eta < 100, `median must resist the 600s outlier, got ${eta}`);
});

await step("AI disclosure: mandatory badge is always applied; promo CTA only when watermark on", async () => {
  const { deliveryStyles, buildOverlayFilter, brandForDelivery } = await import("../src/watermark.js");
  // The legal disclosure ("ai") is ALWAYS present and always first; the promo
  // CTA is appended only when requested — independent of one another.
  assert.deepEqual(deliveryStyles(false), ["ai"]);
  assert.deepEqual(deliveryStyles(true), ["ai", "cta"]);

  // One badge → one scale + one terminal overlay (no intermediate [b] label).
  const one = buildOverlayFilter([{ path: "a.png", width: 460, opacity: 0.95, x: "32", y: "32" }]);
  assert.match(one, /\[1:v\]scale=460:-1,format=rgba,colorchannelmixer=aa=0\.95\[wm0\]/);
  assert.match(one, /\[0:v\]\[wm0\]overlay=x=32:y=32$/);

  // Two badges → chained: base→[b0]→final, second badge is input [2:v].
  const two = buildOverlayFilter([
    { path: "a.png", width: 460, opacity: 0.95, x: "32", y: "32" },
    { path: "b.png", width: 640, opacity: 0.9, x: "(W-w)/2", y: "H-h-32" },
  ]);
  assert.match(two, /\[0:v\]\[wm0\]overlay=x=32:y=32\[b0\]/);
  assert.match(two, /\[2:v\]scale=640/);
  assert.match(two, /\[b0\]\[wm1\]overlay=x=\(W-w\)\/2:y=H-h-32$/);

  // Branding degrades gracefully to null (caller then sends the raw source) when
  // the source can't be fetched/encoded — this holds whether or not the runner
  // has ffmpeg (no ffmpeg → null early; ffmpeg present → the dead URL fails →
  // null), so the assertion isn't tied to the CI host's toolchain.
  assert.equal(await brandForDelivery(`${base}/nope.png`, "image", { promo: false }), null);
});

await step("rate limiting: cost-sensitive routes 429 past their limit; polling and other users are unaffected", async () => {
  // Prime a FRESH user's bucket directly (same key format the route uses) so
  // this step is self-contained — it doesn't depend on, or perturb, any
  // other step's call counts, and doesn't need to actually fire N real
  // requests just to reach the limit.
  const limited = { id: 990088, username: "ratelimited" };
  await getOrCreateUser(limited.id, limited.username, null, 0);
  await addCredits(limited.id, 10, "admin_grant", "test"); // spendable, so a 429 is the ONLY reason to reject
  for (let i = 0; i < config.rateLimitGeneratePerMin; i++) {
    hit(`generate:${limited.id}`, config.rateLimitGeneratePerMin, 60_000);
  }
  const limitedHeaders = { Authorization: `tma ${signInitData(limited)}`, "Content-Type": "application/json" };
  const blocked = await fetch(`${base}/api/generate`, {
    method: "POST", headers: limitedHeaders,
    body: JSON.stringify({ source: "model", model: "text_to_image", prompt: "x" }),
  });
  assert.equal(blocked.status, 429);
  assert.equal(((await blocked.json()) as { error: string }).error, "rate_limited");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0, "missing/invalid Retry-After header");

  // Each ROUTE has its OWN bucket per user — /api/upload for the SAME user is
  // unaffected by /api/generate's limit being tripped.
  const png = `data:image/png;base64,${Buffer.from("tiny-png-bytes").toString("base64")}`;
  const stillOk = await fetch(`${base}/api/upload`, {
    method: "POST", headers: limitedHeaders, body: JSON.stringify({ data: png }),
  });
  assert.equal(stillOk.status, 200);

  // A DIFFERENT user's /api/generate bucket is untouched — the limit is per
  // user, not a global gate that would take down the whole app.
  const freeUser = { id: 990089, username: "unaffected" };
  await getOrCreateUser(freeUser.id, freeUser.username, null, 0);
  await addCredits(freeUser.id, 10, "admin_grant", "test");
  const freeResp = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { Authorization: `tma ${signInitData(freeUser)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "text_to_image", prompt: "unaffected user" }),
  });
  assert.equal(freeResp.status, 200);

  // Read-only polling is never subject to any limit, even for the blocked user.
  const me = await fetch(`${base}/api/me`, { headers: { Authorization: `tma ${signInitData(limited)}` } });
  assert.equal(me.status, 200);
});

await step("payment audit: every granted order names the path that confirmed it", async () => {
  // The bug this closes: the daily digest counts LEDGER rows, so "N оплат" can
  // appear with nothing on the order saying who believed the payment. Approval
  // provenance must be written in the SAME statement as the pending→paid flip.
  await query("DELETE FROM orders");
  await query("DELETE FROM ledger WHERE reason = 'purchase'");

  const buyer = 990300;
  await getOrCreateUser(buyer, "audit_buyer", null, 0);

  // 1) The webhook path stamps itself, and the stamp survives to the audit view.
  const viaHook = await createOrder(buyer, "start", 3700);
  const rawHook = Buffer.from(JSON.stringify({ orderId: viaHook, status: "paid", amount: 3700 }));
  const sigHook = createHmac("sha256", "test-kaspi-secret").update(rawHook).digest("hex");
  await kaspiCallbackResponse(rawHook, sigHook, async (uid, pack, oid) => {
    await grantOrderCredits(oid, uid, pack.credits, pack.kzt);
  });
  assert.equal((await getOrder(viaHook))?.approved_via, "webhook");

  // 2) The admin path stamps a DIFFERENT value — the two are distinguishable,
  //    which is the whole point: "was this a human or a machine?"
  const viaAdmin = await createOrder(buyer, "start", 3700);
  await resolveOrder(viaAdmin, true, "admin");
  assert.equal((await getOrder(viaAdmin))?.approved_via, "admin");

  // 3) A REJECTED order is stamped too, and never shows up as a payment.
  const rejected = await createOrder(buyer, "start", 3700);
  await resolveOrder(rejected, false, "admin");
  assert.equal((await getOrder(rejected))?.status, "rejected");

  // Only orders that actually MOVED CREDITS (granted_at set) are audited; the
  // admin-approved one above was resolved without grantPurchase, so it is
  // deliberately absent — resolving is not the same as crediting.
  const audited = await grantedOrders(24);
  assert.equal(audited.length, 1, "audit must list exactly the orders that moved credits");
  assert.equal(audited[0]?.order_id, viaHook);
  assert.equal(audited[0]?.approved_via, "webhook");
  assert.equal(audited[0]?.kzt, 3700);

  // And the independent ledger read (what the digest counts) agrees here. A
  // DISAGREEMENT is the phantom-payment signal, so it must be a real second
  // read of a different table, not a derived copy of the same number.
  const ledger = await purchaseLedgerCount(24);
  assert.equal(ledger.rows, 1);
  assert.equal(ledger.kzt, 3700);
});

await step("Kaspi verify: a paid-looking status with no amount is NOT auto-granted", async () => {
  // A misconfigured KASPI_API_BASE pointed at any REST service that answers
  // {"status":"success"} would otherwise turn every «Я оплатил» tap — a button
  // the BUYER controls — into free patrons. A settled amount that matches the
  // order is required before we grant with no human in the loop.
  const buyer = 990301;
  await getOrCreateUser(buyer, "kaspi_envelope", null, 0);
  const id = await createOrder(buyer, "start", 3700);
  const order = await getOrder(id);
  assert.ok(order);

  const realFetch = globalThis.fetch;
  const reply = (body: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  };
  process.env.KASPI_API_BASE = "https://merchant.test";
  process.env.KASPI_API_TOKEN = "t";
  const { config: liveConfig } = await import("../src/config.js");
  const prevBase = liveConfig.kaspiApiBase;
  const prevToken = liveConfig.kaspiApiToken;
  (liveConfig as { kaspiApiBase: string }).kaspiApiBase = "https://merchant.test";
  (liveConfig as { kaspiApiToken: string }).kaspiApiToken = "t";
  try {
    reply({ status: "success" }); // generic envelope — says nothing about money
    assert.equal(await kaspiVerifyOrder(order!), "pending");

    reply({ status: "paid", amount: 1 }); // real answer, wrong sum
    assert.equal(await kaspiVerifyOrder(order!), "failed");

    reply({ status: "paid", amount: 3700 }); // real answer, right sum
    assert.equal(await kaspiVerifyOrder(order!), "paid");
  } finally {
    globalThis.fetch = realFetch;
    (liveConfig as { kaspiApiBase: string }).kaspiApiBase = prevBase;
    (liveConfig as { kaspiApiToken: string }).kaspiApiToken = prevToken;
    delete process.env.KASPI_API_BASE;
    delete process.env.KASPI_API_TOKEN;
  }
});

await step("referral finance: revenue brought in is read from orders, not from the payout", async () => {
  // What makes this auditable is that the two sides come from different places:
  // brought-in ₸ from granted ORDERS, cashback from the LEDGER. If the payout
  // were the only number, nobody could check the program — including the owner.
  await query("DELETE FROM orders");
  await query("DELETE FROM ledger WHERE reason = 'purchase'");

  const inviter = 990400;
  const friend = 990401;
  const stranger = 990402;
  await getOrCreateUser(inviter, "inviter", null, 0);
  await getOrCreateUser(friend, "friend", null, 0);
  await getOrCreateUser(stranger, "stranger", null, 0);
  await query("UPDATE users SET referrer_id = $1 WHERE id = $2", [inviter, friend]);

  // The friend buys; a stranger with no inviter also buys.
  for (const buyer of [friend, stranger]) {
    const id = await createOrder(buyer, "start", 3700);
    await resolveOrder(id, true, "admin");
    await grantOrderCredits(id, buyer, 60, 3700);
  }

  const f = await referralFinance(inviter);
  assert.equal(f.invited, 1);
  assert.equal(f.broughtPayments, 1, "the stranger's purchase must not be attributed to anyone");
  assert.equal(f.broughtKzt, 3700);
  // Cashback here is 0 — grantOrderCredits alone doesn't pay referrers (that's
  // grantPurchase). The point stands: revenue is visible even when the payout
  // side is empty, which is exactly the case a payout-only view would hide.
  assert.equal(f.earned, 0);

  // An order that was never GRANTED is not revenue, however it was resolved.
  const ungranted = await createOrder(friend, "start", 3700);
  await resolveOrder(ungranted, true, "admin");
  assert.equal((await referralFinance(inviter)).broughtKzt, 3700, "an ungranted order counted as revenue");

  // The owner-wide ledger ranks by money brought and includes the inviter.
  const led = await referrerLedger(10);
  const mine = led.find((r) => r.userId === inviter);
  assert.ok(mine, "inviter missing from the referral ledger");
  assert.equal(mine!.broughtKzt, 3700);
  assert.ok(!led.some((r) => r.userId === stranger), "a buyer with no inviter is not a referrer");
});

await step("purchase XP: scales with money spent, pays the inviter, and never twice per order", async () => {
  await query("DELETE FROM orders");
  await query("DELETE FROM ledger WHERE reason = 'purchase'");
  await query("DELETE FROM economy_config WHERE key LIKE 'xp.%'");
  await query("DELETE FROM xp_claims");

  const inviter = 990500;
  const buyer = 990501;
  const loner = 990502;
  for (const [id, name] of [[inviter, "xp_inviter"], [buyer, "xp_buyer"], [loner, "xp_loner"]] as const) {
    await getOrCreateUser(id as number, name as string, null, 0);
    await query("UPDATE users SET xp = 0 WHERE id = $1", [id]);
  }
  await query("UPDATE users SET referrer_id = $1 WHERE id = $2", [inviter, buyer]);

  // Unconfigured is inert — the shipped default must award nothing.
  const o0 = await createOrder(buyer, "start", 3700);
  assert.equal(await awardPurchaseXp(buyer, o0, 3700), 0);
  assert.equal(await getUserXp(buyer), 0);

  // A step with no rate is a HALF-config: still nothing, no silent guessing.
  await setEconomyConfig("xp.purchase.step", 25);
  const o1 = await createOrder(buyer, "start", 3700);
  assert.equal(await awardPurchaseXp(buyer, o1, 3700), 0);

  await setEconomyConfig("xp.purchase", 10);
  await setEconomyConfig("xp.refpurchase", 5);

  // 3700 ₸ / 25 = 148 units → buyer 1480, inviter 740.
  const o2 = await createOrder(buyer, "start", 3700);
  await awardPurchaseXp(buyer, o2, 3700);
  assert.equal(await getUserXp(buyer), 1480);
  assert.equal(await getUserXp(inviter), 740);

  // Re-running the same order (reconciler, duplicate webhook, /order N ok twice)
  // must be a full no-op on BOTH sides.
  await awardPurchaseXp(buyer, o2, 3700);
  assert.equal(await getUserXp(buyer), 1480, "purchase XP awarded twice for one order");
  assert.equal(await getUserXp(inviter), 740, "referral XP awarded twice for one order");

  // A second, larger order pays again and scales with the amount.
  const o3 = await createOrder(buyer, "pro", 7500);
  await awardPurchaseXp(buyer, o3, 7500);
  assert.equal(await getUserXp(buyer), 1480 + 300 * 10);

  // The cap is what keeps Levels a record of USE rather than of spend: a big
  // top-up must not buy the ladder outright.
  await setEconomyConfig("xp.purchase.max", 500);
  await setEconomyConfig("xp.refpurchase.max", 250);
  const before = await getUserXp(buyer);
  const big = await createOrder(buyer, "pro", 20000); // 800 units → 8000 XP uncapped
  await awardPurchaseXp(buyer, big, 20000);
  assert.equal((await getUserXp(buyer)) - before, 500, "a large purchase blew past the per-order cap");
  await query("DELETE FROM economy_config WHERE key LIKE 'xp.%.max'");

  // A buyer with no inviter pays XP to nobody — and a purchase under one step
  // rounds down to zero rather than paying for a rounding error.
  const o4 = await createOrder(loner, "start", 3700);
  await awardPurchaseXp(loner, o4, 3700);
  assert.equal(await getUserXp(loner), 1480);
  const o5 = await createOrder(loner, "start", 10);
  assert.equal(await awardPurchaseXp(loner, o5, 10), 0);

  await query("DELETE FROM economy_config WHERE key LIKE 'xp.%'");
});

await step("auto-grant is OFF by default: «Я оплатил» always reaches a human", async () => {
  // The failure this prevents: «Я оплатил» is pressed by the BUYER, so granting
  // on the merchant API's word alone trusts one external endpoint completely.
  // Even when it says "paid", an unconfigured auto-grant must ping an admin
  // instead of moving credits.
  const buyer = 990600;
  await getOrCreateUser(buyer, "autogrant", null, 0);
  const id = await createOrder(buyer, "start", 3700);

  const realFetch = globalThis.fetch;
  const { config: live } = await import("../src/config.js");
  const prev = { base: live.kaspiApiBase, token: live.kaspiApiToken, auto: live.kaspiAutoGrant };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: "paid", amount: 3700 }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
  (live as { kaspiApiBase: string }).kaspiApiBase = "https://merchant.test";
  (live as { kaspiApiToken: string }).kaspiApiToken = "t";
  const pinged: number[] = [];
  const api = { sendMessage: async (chatId: number) => { pinged.push(chatId); return {}; } } as unknown as InstanceType<typeof Api>;
  // CI has no ADMIN_IDS, so the ping loop would have nobody to send to and the
  // assertion below would pass or fail on the environment rather than the code.
  const prevAdmins = [...live.adminIds];
  (live as { adminIds: number[] }).adminIds = [424242];
  try {
    (live as { kaspiAutoGrant: boolean }).kaspiAutoGrant = false;
    const off = await claimOrderPaid(api, id, "tester");
    assert.equal(off.kind, "admin", "a paid verdict must still go to a human while auto-grant is off");
    assert.ok(pinged.length > 0, "admins were not pinged");
    assert.equal((await getOrder(id))?.status, "pending", "credits moved with no human in the loop");

    // Explicitly switched on, the same verdict grants — the switch is real, not
    // a permanent disable dressed up as a flag.
    (live as { kaspiAutoGrant: boolean }).kaspiAutoGrant = true;
    const on = await claimOrderPaid(api, id, "tester");
    assert.equal(on.kind, "granted");
    assert.equal((await getOrder(id))?.approved_via, "kaspi_api");
  } finally {
    globalThis.fetch = realFetch;
    (live as { kaspiApiBase: string }).kaspiApiBase = prev.base;
    (live as { kaspiApiToken: string }).kaspiApiToken = prev.token;
    (live as { kaspiAutoGrant: boolean }).kaspiAutoGrant = prev.auto;
    (live as { adminIds: number[] }).adminIds = prevAdmins;
  }
});

await step("reconciler: recovers a fresh interrupted grant, never re-grants history", async () => {
  // The bug this closes. granted_at was added to an existing `orders` table with
  // NO backfill, so every order already marked 'paid' reads as "paid but never
  // granted" forever. An unbounded reconciler sweep re-credits all of them at
  // once — fresh 'purchase' ledger rows the digest reports as today's revenue,
  // duplicate referral payouts, and a second course-cohort invite to somebody
  // who bought months ago. Recovery has to have an upper bound in time.
  await query("DELETE FROM orders");
  const buyer = 990700;
  await getOrCreateUser(buyer, "reconcile", null, 0);

  const fresh = await createOrder(buyer, "start", 3700);
  await resolveOrder(fresh, true, "admin"); // paid, grant never ran
  await query("UPDATE orders SET processed_at = now() - interval '30 minutes' WHERE id = $1", [fresh]);

  const ancient = await createOrder(buyer, "start", 3700);
  await resolveOrder(ancient, true, "admin");
  await query("UPDATE orders SET processed_at = now() - interval '90 days' WHERE id = $1", [ancient]);

  const due = await staleGrantedOrders(5, 48);
  assert.deepEqual(due.map((o) => o.id), [fresh], "the sweep must reach the fresh order and ONLY the fresh one");

  // The old one isn't lost — it's surfaced for a human instead of credited on a
  // guess, because at that age "stuck" and "granted before we tracked it" look
  // identical from the database.
  const old = await abandonedPaidOrders(48);
  assert.deepEqual(old.map((o) => o.id), [ancient]);

  // A grant that already landed is never swept again, at any age.
  await grantOrderCredits(fresh, buyer, 60, 3700);
  assert.equal((await staleGrantedOrders(5, 48)).length, 0);
});

await step("granted_at backfill: stamps orders the ledger proves were credited, leaves the rest alone", async () => {
  // Re-runs the shipped repair statement verbatim against rows shaped like the
  // ones it exists for. Two orders, identical except for one fact: whether the
  // ledger says the buyer was ever credited.
  await query("DELETE FROM orders");
  await query("DELETE FROM ledger WHERE reason = 'purchase'");
  const paid = 990800;
  const stuck = 990801;
  await getOrCreateUser(paid, "was_credited", null, 0);
  await getOrCreateUser(stuck, "never_credited", null, 0);

  const credited = await createOrder(paid, "start", 3700);
  const uncredited = await createOrder(stuck, "start", 3700);
  for (const id of [credited, uncredited]) {
    await resolveOrder(id, true, "admin");
    await query(
      "UPDATE orders SET granted_at = NULL, processed_at = TIMESTAMPTZ '2026-05-01 12:00:00+00' WHERE id = $1",
      [id],
    );
  }
  // Only the first buyer has proof of credit — exactly what a pre-migration
  // order that WAS granted looks like.
  await query("INSERT INTO ledger (user_id, delta, reason, meta) VALUES ($1, 60, 'purchase', '3700')", [paid]);

  const REPAIR = `UPDATE orders o SET granted_at = o.processed_at
     WHERE o.status = 'paid' AND o.granted_at IS NULL
       AND o.processed_at IS NOT NULL
       AND o.processed_at < TIMESTAMPTZ '2026-07-26 08:00:00+00'
       AND EXISTS (
         SELECT 1 FROM ledger l
         WHERE l.user_id = o.user_id AND l.reason = 'purchase'
           AND l.meta = o.amount_kzt::text
       )`;
  await query(REPAIR);

  const after = await getOrder(credited);
  assert.ok(after?.granted_at, "an order the ledger proves was credited must be stamped");
  assert.equal(
    new Date(after!.granted_at!).toISOString(),
    new Date(after!.processed_at!).toISOString(),
    "stamped with the confirmation time, not now()",
  );
  assert.equal((await getOrder(uncredited))?.granted_at, null, "an unproven order must NOT be written off");

  // Stamped rows drop out of the reconciler's sight — which is the whole point.
  assert.ok(!(await staleGrantedOrders(1, 24 * 365)).some((o) => o.id === credited));
  // The unproven one is still visible to a human.
  assert.ok((await abandonedPaidOrders(1)).some((o) => o.id === uncredited));

  // Idempotent: running it again changes nothing.
  const before = (await getOrder(credited))!.granted_at;
  await query(REPAIR);
  assert.equal((await getOrder(credited))!.granted_at, before);
});

await step("registered bot commands: every advertised command actually has a handler", async () => {
  // The command menu and the handlers are two separate lists in two files, so
  // they drift silently — an advertised command with no handler just does
  // nothing when tapped, which reads as a broken bot rather than a missing
  // feature. Cheap to check, and it catches the drift at the only moment it is
  // still free to fix.
  const fs = await import("node:fs/promises");
  const index = await fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const bot = await fs.readFile(new URL("../src/bot.ts", import.meta.url), "utf8");
  const payments = await fs.readFile(new URL("../src/payments.ts", import.meta.url), "utf8");
  const advertised = [...index.matchAll(/\{\s*command:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(advertised.includes("whoami"), "whoami must be in the public command menu");
  const handled = new Set(
    [...(bot + payments).matchAll(/bot\.command\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
  );
  const missing = advertised.filter((c) => !handled.has(c));
  assert.deepEqual(missing, [], `advertised with no handler: ${missing.join(", ")}`);
});

await step("conversion push: one weekly budget for all campaigns, and only real intent is targeted", async () => {
  await query("DELETE FROM pushes");
  await query("DELETE FROM events WHERE type IN ('paywall','push')");

  const hot = 990900;    // saw the paywall, rendered before, never bought
  const buyer = 990901;  // saw the paywall but is already a customer
  const cold = 990902;   // saw the paywall having never produced anything
  for (const [id, name] of [[hot, "hot"], [buyer, "already_paid"], [cold, "cold"]] as const) {
    await getOrCreateUser(id as number, name as string, null, 0);
    await logEvent(id as number, "paywall", "test");
  }
  await logGeneration(hot, "text_to_image", "x", 2, "ok", "https://fal.media/a.jpg");
  await logGeneration(buyer, "text_to_image", "x", 2, "ok", "https://fal.media/b.jpg");
  await query("INSERT INTO ledger (user_id, delta, reason, meta) VALUES ($1, 60, 'purchase', '3700')", [buyer]);

  const targets = await usersForPaywallPush(50);
  assert.ok(targets.includes(hot), "someone who hit the paywall and never bought must be targeted");
  assert.ok(!targets.includes(buyer), "an existing customer must not get a first-purchase push");
  assert.ok(!targets.includes(cold), "someone who never saw a result has no reason to trust the price");

  // The budget is GLOBAL: a second campaign competes for the same slots, it
  // does not get its own allowance. With a cap of 1, campaign B is refused.
  assert.equal(await claimPush(hot, "paywall", 1), true);
  assert.equal(await claimPush(hot, "other_campaign", 1), false, "a second track must not exceed the shared cap");
  // …and being refused must NOT burn that campaign — it is still available
  // once the budget frees up.
  assert.equal(await claimPush(hot, "other_campaign", 2), true);
  // Same campaign twice is always refused, budget or not.
  assert.equal(await claimPush(hot, "paywall", 9), false);
  // A cap of 0 disables proactive messaging entirely.
  assert.equal(await claimPush(cold, "paywall", 0), false);

  // A failed send releases the slot, so a blocked user doesn't permanently
  // consume the one push this campaign will ever give them.
  await releasePush(hot, "other_campaign");
  assert.equal(await claimPush(hot, "other_campaign", 5), true);

  // Targeting is idempotent: an already-pushed user drops out of the list.
  assert.ok(!(await usersForPaywallPush(50)).includes(hot));
});

await step("push offer: live only inside its window, redeemable once, and off by default", async () => {
  await query("DELETE FROM pushes");
  const u = 990910;
  await getOrCreateUser(u, "offeree", null, 0);

  assert.equal(await offerBonusFor(u, 48), false, "no push → no offer");
  await claimPush(u, "paywall", 2);
  assert.equal(await offerBonusFor(u, 48), true);

  // The window is measured from the push itself, so it can never disagree with
  // what the user was told.
  await query("UPDATE pushes SET sent_at = now() - interval '72 hours' WHERE user_id = $1 AND campaign = 'paywall'", [u]);
  assert.equal(await offerBonusFor(u, 48), false, "an expired offer must not pay out");
  await query("UPDATE pushes SET sent_at = now() WHERE user_id = $1 AND campaign = 'paywall'", [u]);

  // Redeemable exactly once, whatever retries the payment path performs.
  assert.equal(await claimOfferRedemption(u), true);
  assert.equal(await claimOfferRedemption(u), false, "the bonus was granted twice");
  assert.equal(await offerBonusFor(u, 48), false, "a redeemed offer must stop being live");

  // The mechanism ships inert — the number is a pricing decision, not a default.
  const { config: live } = await import("../src/config.js");
  assert.equal(live.pushOfferBonus, 0, "a bonus must not ship switched on");

  // Reporting never credits a purchase that predates the push.
  const rep = (await pushReport()).find((r) => r.campaign === "paywall");
  assert.ok(rep);
  assert.equal(rep!.converted, 0);
});

await step("achievements: derived from real history, so they are correct retroactively", async () => {
  // The point of deriving from generations/events/ledger rather than xp_claims:
  // xp_claims is only written while the XP economy is CONFIGURED, so a wall
  // built on it would be empty today and could never backfill — a user's real
  // history would be permanently missing from their own profile.
  await query("DELETE FROM economy_config WHERE key LIKE 'xp.%'"); // XP stays OFF for this whole step
  const u = 991000;
  await getOrCreateUser(u, "achiever", null, 0);

  const before = await achievements(u);
  assert.ok(before.length > 0, "locked badges must still be listed — the holes are the map");
  assert.equal(before.every((a) => !a.earned), true, "a fresh account has earned nothing");
  const firstRender = before.find((a) => a.id === "first_render");
  assert.ok(firstRender && firstRender.need === 1 && firstRender.at === 0);

  // Real history, recorded the ordinary way.
  await logGeneration(u, "text_to_image", "x", 2, "ok", "https://fal.media/a.jpg");
  await logEvent(u, "upload", "1");
  await logEvent(u, "share", "1");

  const after = await achievements(u);
  const by = (id: string) => after.find((a) => a.id === id)!;
  assert.equal(by("first_render").earned, true, "a completed render must earn the first badge");
  assert.equal(by("first_text").earned, true, "a text-to-image render must be recognised by model kind");
  assert.equal(by("uploader").earned, true);
  assert.equal(by("sharer").earned, true, "sharing must count even with the XP economy switched off");
  assert.equal(by("ten_renders").earned, false);
  assert.equal(by("ten_renders").at, 1, "locked badges must carry real progress, not zero");

  // Progress never overstates itself past the requirement.
  assert.ok(after.every((a) => a.at <= a.need));

  // A FAILED render is not an achievement.
  await logGeneration(u, "text_to_image", "x", 2, "error");
  assert.equal((await achievements(u)).find((a) => a.id === "ten_renders")!.at, 1);
});

await step("prompt library: Кино-портрет asks for a SCENE, not a colour grade", async () => {
  // The defect this locks out: the preset used to specify only a lens and a
  // grade, giving the model no film to be a still from — so it recoloured the
  // input and changed nothing else, on every subject type.
  const { PRESETS } = await import("../src/models.js");
  const cine = PRESETS.find((p) => p.id === "cinematic");
  assert.ok(cine, "cinematic preset missing");
  const p = cine!.prompt;
  // The four things that actually make a frame read as cinema.
  for (const required of ["DEPTH", "MOMENT", "BLOCKING", "MOTIVATED"]) {
    assert.ok(p.includes(required), `Кино-портрет lost its ${required} instruction`);
  }
  // A named place is the minimum: no location, no film.
  assert.ok(/street|kitchen|lobby|corridor|field/i.test(p), "no concrete location — this is a grade again");
  // One genre chosen and committed to, as with the other restaging looks: a
  // stacked list averages into the same murky frame every time.
  assert.match(p, /choose ONE and commit/);
  // A child must not be staged into neo-noir.
  assert.ok(/CHILD/.test(p), "no child register — noir is wrong for a kid");
  // And restaging must never quietly drop people from a group photo.
  assert.ok(p.includes("ALL the people"), "group photos must keep everyone");
});

await step("certificates: payment buys the course, a human issues the certificate", async () => {
  await query("DELETE FROM certificates");
  await query("DELETE FROM orders");
  const u = 991100;
  await getOrCreateUser(u, "student", null, 0);

  const before = await certificates(u);
  assert.equal(before.length, 2, "both course certificates must be listed even when unearned");
  assert.equal(before.every((c) => !c.owned && !c.earned), true);

  // Buying the course marks it OWNED and nothing else. A certificate handed
  // out for paying is worth nothing, and that is the whole point of the wall.
  const order = await createOrder(u, "course_fast", 4500);
  await resolveOrder(order, true, "admin");
  await grantOrderCredits(order, u, 60, 4500);
  const owned = await certificates(u);
  const fast = () => owned.find((c) => c.course === "fast")!;
  assert.equal(fast().owned, true, "a granted course order must show as owned");
  assert.equal(fast().earned, false, "payment must NEVER earn the certificate");

  // Issuance is a deliberate act, and idempotent.
  assert.equal(await issueCertificate(u, "fast"), true);
  assert.equal(await issueCertificate(u, "fast"), false, "re-issuing must be a no-op");
  const after = (await certificates(u)).find((c) => c.course === "fast")!;
  assert.equal(after.earned, true);
  assert.ok(after.issuedAt, "an issued certificate must carry its date");
  // The other course is untouched by either action.
  assert.equal((await certificates(u)).find((c) => c.course === "flagship")!.earned, false);
});

await step("partner cabinet in the app: same guards as the bot, and the server names the amount", async () => {
  const u = 991200;
  await getOrCreateUser(u, "partner_app", null, 0);
  const H = { Authorization: `tma ${signInitData({ id: u, username: "partner_app", first_name: "P" })}` };
  const post = (p: string) => fetch(`${base}${p}`, { method: "POST", headers: H });

  // Not enrolled: the app must not offer a self-serve door the programme does
  // not have — it is invitation-only, and the bot says so.
  const before = (await (await fetch(`${base}/api/partner`, { headers: H })).json()) as { joined: boolean; codes: unknown[] };
  assert.equal(before.joined, false);
  assert.deepEqual(before.codes, []);
  assert.equal((await post("/api/partner/withdraw")).status, 403, "a non-partner must not be able to request a payout");

  await joinPartnerProgram(u, 0);
  await createPartnerCode(u, 0.15, 5, 10);
  const acct = (await (await fetch(`${base}/api/partner`, { headers: H })).json()) as {
    joined: boolean; codes: Array<{ code: string; percent: number }>;
  };
  assert.equal(acct.joined, true);
  assert.equal(acct.codes.length, 1);
  assert.equal(acct.codes[0].percent, 15);

  // Below the minimum → refused, and the response says what is missing rather
  // than failing blankly.
  const small = await post("/api/partner/withdraw");
  assert.equal(small.status, 400);
  const sd = (await small.json()) as { error: string; min: number; withdrawable: number };
  assert.equal(sd.error, "too_small");
  assert.equal(sd.withdrawable, 0);
  assert.ok(sd.min > 0);

  // With a real cashback balance the payout is created — and the AMOUNT comes
  // from the server, never from the request, so a client cannot name a figure
  // the guarded statement would disagree with.
  await query("UPDATE users SET partner_withdrawable = 900, credits = 900 WHERE id = $1", [u]);
  const ok = await post("/api/partner/withdraw");
  assert.equal(ok.status, 200);
  const od = (await ok.json()) as { id: number; amount: number };
  assert.equal(od.amount, 900);
  assert.equal(Number((await query("SELECT partner_withdrawable FROM users WHERE id = $1", [u]))[0].partner_withdrawable), 0);

  // One pending request at a time — the same DB-level guard the bot relies on.
  await query("UPDATE users SET partner_withdrawable = 900, credits = 900 WHERE id = $1", [u]);
  assert.equal((await post("/api/partner/withdraw")).status, 409, "a second pending payout must be refused");

  // History is visible to the partner.
  const hist = (await (await fetch(`${base}/api/partner`, { headers: H })).json()) as {
    withdrawals: Array<{ id: number; amount: number; status: string }>;
  };
  assert.equal(hist.withdrawals.length, 1);
  assert.equal(hist.withdrawals[0].amount, 900);
  assert.equal(hist.withdrawals[0].status, "pending");
});

await step("release notes: shown once, never to a newcomer, and only ever moving forward", async () => {
  const { RELEASES, unseenReleases, latestReleaseId } = await import("../src/changelog.js");
  assert.ok(RELEASES.length > 0, "at least one release note must exist");
  // Ids are what "seen" is stored against, so they must sort and be unique —
  // renumbering would re-show old notes to everybody.
  const ids = RELEASES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate release id");
  assert.deepEqual([...ids].sort(), ids.slice().sort(), "ids must be sortable strings");

  const newest = latestReleaseId()!;
  assert.equal(unseenReleases(null).length, RELEASES.length, "an unread user sees everything");
  assert.equal(unseenReleases(newest).length, 0, "a caught-up user sees nothing");

  // An EXISTING user gets the note; a user created after it does not — being
  // greeted by a history you were not present for is noise, not a welcome.
  const old = 991300;
  const fresh = 991301;
  await getOrCreateUser(old, "old_user", null, 0);
  await getOrCreateUser(fresh, "new_user", null, 0);
  await query("UPDATE users SET created_at = TIMESTAMPTZ '2026-01-01' WHERE id = $1", [old]);
  // Pin the newcomer to the newest note's own DATE rather than leaning on "now":
  // that is the case which actually bites, because a same-day id may carry a
  // "-2" suffix and "2026-07-26" sorts BELOW "2026-07-26-2". Left as "now" this
  // assertion only exercises the boundary on the day a note ships.
  await query("UPDATE users SET created_at = $2::timestamptz WHERE id = $1", [fresh, newest.slice(0, 10)]);

  const oldMe = (await (await fetch(`${base}/api/me`, {
    headers: { Authorization: `tma ${signInitData({ id: old, username: "old_user", first_name: "O" })}` },
  })).json()) as { whatsNew: unknown[] };
  assert.ok(oldMe.whatsNew.length > 0, "an account older than the note must see it");

  const freshMe = (await (await fetch(`${base}/api/me`, {
    headers: { Authorization: `tma ${signInitData({ id: fresh, username: "new_user", first_name: "N" })}` },
  })).json()) as { whatsNew: unknown[] };
  assert.deepEqual(freshMe.whatsNew, [], "a brand-new account must not be shown the backlog");

  // Marking seen sticks, and never moves backwards.
  await markReleaseSeen(old, newest);
  assert.equal((await releaseState(old)).seen, newest);
  await markReleaseSeen(old, "2000-01-01");
  assert.equal((await releaseState(old)).seen, newest, "an out-of-order call must not un-see a newer note");

  const after = (await (await fetch(`${base}/api/me`, {
    headers: { Authorization: `tma ${signInitData({ id: old, username: "old_user", first_name: "O" })}` },
  })).json()) as { whatsNew: unknown[] };
  assert.deepEqual(after.whatsNew, [], "a read note must not come back");
});

await new Promise<void>((r) => server.close(() => r()));
console.log(`\nAll ${passed} web-app checks passed. ✨`);
