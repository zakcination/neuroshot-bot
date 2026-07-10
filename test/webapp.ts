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

const { fal } = await import("@fal-ai/client");
const { verifyInitData, createWebApp } = await import("../src/webapp.js");
const { issueSession, verifySession } = await import("../src/auth.js");
const { addCredits, getOrCreateUser, logGeneration, spendCredits } = await import("../src/db.js");

// ---- fal stubs (network edge): model runs + storage uploads ----
interface FalCall {
  endpoint: string;
  input: Record<string, unknown>;
}
const falCalls: FalCall[] = [];
(fal as { subscribe: unknown }).subscribe = async (
  endpoint: string,
  opts: { input: Record<string, unknown> },
) => {
  falCalls.push({ endpoint, input: opts.input });
  const data = endpoint.includes("video")
    ? { video: { url: `https://fal.test/out/${falCalls.length}.mp4` } }
    : { images: [{ url: `https://fal.test/out/${falCalls.length}.png` }] };
  return { data, requestId: `req-${falCalls.length}` };
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
  user: { id: number; username?: string; first_name?: string };
  dashboard: { credits: number; okGenerations: number; creditsSpent: number; referralEarned: number };
  generations: Array<{ output_url: string | null; status: string }>;
  bot_username: string;
  packs: Array<{ id: string; title: string; credits: number; stars: number }>;
  catalog: {
    presetCredits: number;
    presets: Array<{ id: string; label: string; category: string }>;
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
  // Pack catalog rides along — one source of truth with the bot's /buy.
  assert.equal(body.packs.length, 4);
  assert.ok(body.packs.every((p) => p.stars > 0 && p.credits > 0 && p.id));
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

async function pollGen(id: number): Promise<{ status: string; output_url: string | null }> {
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`${base}/api/generations/${id}`, { headers: makerHeaders() });
    assert.equal(r.status, 200);
    const d = (await r.json()) as { status: string; output_url: string | null };
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
  assert.equal(c.presetCredits, 2); // Seedream 4 edit preset/scenario engine
  const mini = c.campaigns.find((k) => k.id === "minifilm");
  assert.ok(mini, "minifilm campaign missing from catalog");
  assert.equal(mini!.videoCredits, 61); // Seedance 2.0 Fast story upsell
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

await step("POST /api/generate: preset charges, renders async, poll reaches ok", async () => {
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
  assert.equal(call.endpoint, "fal-ai/bytedance/seedream/v4/edit");
  assert.match(call.input.prompt as string, /corporate headshot/);
});

await step("campaign video upsell via API: minifilm renders on Seedance 2.0 Fast (61 🔫)", async () => {
  const r = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "campaign_video", id: "minifilm", image_url: "https://fal.test/out/1.png" }),
  });
  assert.equal(r.status, 200);
  const d = (await r.json()) as { id: number; credits: number; balance: number };
  assert.equal(d.credits, 61);
  assert.equal(d.balance, 40); // 101 − 61
  const done = await pollGen(d.id);
  assert.equal(done.status, "ok");
  assert.match(done.output_url ?? "", /\.mp4$/);
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "bytedance/seedance-2.0/fast/image-to-video");
  assert.equal(call.input.image_url, "https://fal.test/out/1.png");
});

await step("insufficient 🔫 → 402 with the pack catalog (in-app paywall)", async () => {
  const broke = { id: 701, username: "broke" }; // fresh: 3 free < a scenario video's 10 🔫
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
  assert.equal(d.packs.length, 4);
});

await step("generate validation: unknown ids, missing photo, off-catalog models, empty prompt → 400", async () => {
  const cases = [
    { source: "preset", id: "nope", image_url: "https://x.test/a.jpg" },
    { source: "preset", id: "headshot" }, // photo required
    { source: "campaign", id: "minifilm:nope", image_url: "https://x.test/a.jpg" },
    { source: "model", model: "nbpro_edit", prompt: "hi", image_url: "https://x.test/a.jpg" }, // not in pickers
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

await step("POST /api/invoice: creates a Stars invoice link via the Telegram API", async () => {
  // Stub Telegram Bot API: assert the payload and return an invoice link.
  const { createServer } = await import("node:http");
  let seen: Record<string, unknown> | null = null;
  const tgStub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: "https://t.me/invoice/test123" }));
    });
  });
  await new Promise<void>((r) => tgStub.listen(0, r));
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${(tgStub.address() as AddressInfo).port}`;

  const r = await fetch(`${base}/api/invoice`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ pack: "start" }),
  });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { link: string }).link, "https://t.me/invoice/test123");
  assert.equal(seen!.currency, "XTR");
  assert.equal(seen!.payload, "pack:start"); // same payload the bot's payment handler expects
  assert.deepEqual(seen!.prices, [{ label: "Старт — 60 🔫", amount: 720 }]);

  const bad = await fetch(`${base}/api/invoice`, {
    method: "POST",
    headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ pack: "nope" }),
  });
  assert.equal(bad.status, 400);
  await new Promise<void>((r2) => tgStub.close(() => r2()));
});

await step("method gating on studio endpoints: GET /api/generate and /api/upload → 405", async () => {
  for (const path of ["/api/generate", "/api/upload", "/api/invoice", "/api/send"]) {
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
    videoModels: Array<{ key: string; video: { durations: Array<{ seconds: number; credits: number }>; aspectRatios: string[] } | null }>;
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
  assert.ok(kling.video!.aspectRatios.includes("9:16")); // TikTok/Reels vertical
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
      duration: 10, aspect_ratio: "9:16",
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
  assert.equal(call.input.aspect_ratio, "9:16");
  assert.match(call.input.prompt as string, /cinematic reveal as the subject steps into the light/);
  assert.match(call.input.prompt as string, /film-grade color/);
  assert.match(call.input.prompt as string, /любит футбол/); // sanitized personalization
});

await step("video composer validation: bad duration/ratio → 400 bad_opts, bad story id → bad_option", async () => {
  const badDur = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "kling3", image_url: "https://x.test/a.jpg", prompt: "m", duration: 7 }),
  });
  assert.equal(badDur.status, 400);
  assert.equal(((await badDur.json()) as { error: string }).error, "bad_opts");

  const badRatio = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "kling3", image_url: "https://x.test/a.jpg", prompt: "m", aspect_ratio: "3:2" }),
  });
  assert.equal(badRatio.status, 400);
  assert.equal(((await badRatio.json()) as { error: string }).error, "bad_opts");

  const badStory = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "model", model: "kling3", image_url: "https://x.test/a.jpg", prompt: "m", options: ["nope"] }),
  });
  assert.equal(badStory.status, 400);
  assert.equal(((await badStory.json()) as { error: string }).error, "bad_option");
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
  assert.match(call.input.prompt as string, /scores a legendary winning goal/); // the scene

  // Unknown scene id / off-picker model → 400 (nothing charged).
  const badScene = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "campaign_video", id: "worldcup", image_url: "https://x.test/a.jpg", scene: "nope" }),
  });
  assert.equal(badScene.status, 400);
  assert.equal(((await badScene.json()) as { error: string }).error, "bad_scene");

  const badModel = await fetch(`${base}/api/generate`, {
    method: "POST", headers: { ...makerHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ source: "campaign_video", id: "worldcup", image_url: "https://x.test/a.jpg", model: "nb2_image" }),
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
    assert.match(p.prompt, /MAIN subject/i, `${p.id} missing kid-focus`);
    assert.match(p.prompt, /exactly (ONE|once)/i, `${p.id} missing de-dup guard`);
  }
  const wc = CAMPAIGNS.find((c) => c.id === "worldcup")!;
  for (const p of wc.presets.filter((x) => x.id !== "kit")) {
    assert.match(p.prompt, /no duplicated figures/, `${p.id} missing NO_CLONES`);
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

await new Promise<void>((r) => server.close(() => r()));
console.log(`\nAll ${passed} web-app checks passed. ✨`);
