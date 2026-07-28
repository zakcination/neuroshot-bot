/**
 * End-to-end harness: drives the real bot (handlers, credit ledger, payments,
 * referrals, refunds) through grammY's update pipeline. Only the two network
 * edges are stubbed: outgoing Telegram Bot API calls (via an api transformer)
 * and fal.ai (via the fal singleton's `subscribe`).
 *
 * Run: npm run test:e2e
 */
import assert from "node:assert/strict";
import type { InlineKeyboard } from "grammy";

// Env must be set before the app modules load (config/db read it at import time).
process.env.BOT_TOKEN = "1000000:TEST_TOKEN";
process.env.FAL_KEY = "test-fal-key";
// Force hermetic embedded pglite: clear any DATABASE_URL from the dev's shell/.env
// so the suite never runs against (and mutates) a real Postgres.
process.env.DATABASE_URL = "";
process.env.FREE_CREDITS = "12"; // enough headroom for the multi-step journey below
// Fake provider storage host for this suite — see the same note in test/webapp.ts.
process.env.MEDIA_HOST_SUFFIXES = "fal.test";
process.env.ADMIN_IDS = "9999";
process.env.KASPI_PAY_URL = "https://pay.test/neuroshot"; // enable the Kaspi buy flow
process.env.PARTNER_WELCOME = "180"; // ≈$20 welcome bonus (spend-only)
process.env.WITHDRAW_MIN = "20"; // low so the withdrawal path is exercisable
// Cohort delivery (docs/course/README.md): only the "fast" channel is set —
// COURSE_FLAGSHIP_CHANNEL_ID stays UNSET so the same run also exercises the
// "purchase still succeeds with no channel configured" guarantee.
process.env.COURSE_FAST_CHANNEL_ID = "-100123456789";
process.env.ELEVENLABS_API_KEY = "test-eleven-key"; // enable the dubbing engine
process.env.DUB_KAZAKH_ENABLED = "true"; // exercise the KK target too (gated in prod)
process.env.DUB_MAX_SECONDS = "60";
process.env.DUB_USD_PER_SEC = "0.02";

const { fal } = await import("@fal-ai/client");
const { createBot, fastStartLessonMessages, flagshipModuleMessages } = await import("../src/bot.js");
const { drainRenders, inFlightRenders } = await import("../src/generate.js");
const { funnel, query, getUser, getOrCreateUser, addCredits, logGeneration, partnerAccount, usersToNudge, markNudged, nudgedOnUtcDay, createPendingGeneration, completeGeneration, claimFreePhone, phoneClaimedFree, setUserPhone, createOrder, getOrder, deleteUserData, getEconomyConfig, getPresetMinLevel, getActiveSeason, listSeasons } = await import("../src/db.js");
const { startDubbing, dubCredits, availableDubTargets } = await import("../src/dubbing.js");
const { buildDigest, checkAlerts, nudgeText, runReengagement, runReaper, runOrderReconciler } = await import("../src/monitor.js");
const { nUnits, nResults } = await import("../src/text.js");
const { PRESETS, presetModel, PARTNER_TIERS } = await import("../src/models.js");

// ---------- Telegram API stub (transformer: intercepts every outgoing call) ----------

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}
const apiCalls: ApiCall[] = [];
let nextMessageId = 5000;

function stubMessage(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    message_id: nextMessageId++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: (payload.chat_id as number) ?? 0, type: "private", first_name: "stub" },
    text: (payload.text as string) ?? "",
  };
}

const botInfo = {
  id: 424242,
  is_bot: true as const,
  first_name: "NeuroShot",
  username: "neuroshot_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const bot = createBot(botInfo);
bot.api.config.use(async (_prev, method, payload) => {
  apiCalls.push({ method, payload: payload as Record<string, unknown> });
  let result: unknown;
  switch (method) {
    case "getFile":
      result = { file_id: "f", file_unique_id: "fu", file_path: "photos/test.jpg" };
      break;
    case "createChatInviteLink":
      result = { invite_link: "https://t.me/+teststub" };
      break;
    case "deleteMessage":
    case "answerCallbackQuery":
    case "answerPreCheckoutQuery":
    case "setMyCommands":
      result = true;
      break;
    case "sendMediaGroup": {
      // returns an array of Messages, one per media item
      const media = (payload as { media?: unknown[] }).media ?? [];
      result = media.map(() => stubMessage(payload as Record<string, unknown>));
      break;
    }
    default:
      // sendMessage / sendPhoto / sendVideo / sendInvoice all return a Message
      result = stubMessage(payload as Record<string, unknown>);
  }
  return { ok: true, result } as Awaited<ReturnType<typeof _prev>>;
});

/** All calls of a method made since the given index. */
function calls(method: string, since = 0): ApiCall[] {
  return apiCalls.slice(since).filter((c) => c.method === method);
}
function lastText(method = "sendMessage"): string {
  const c = calls(method).at(-1);
  return (c?.payload.text as string) ?? "";
}
/** Delivered generation results are caption-less photos; hero/menu images carry a caption. */
function resultPhotos(): ApiCall[] {
  return calls("sendPhoto").filter((c) => !c.payload.caption);
}

// ---------- fal.ai stub ----------

interface FalCall {
  endpoint: string;
  input: Record<string, unknown>;
}
const falCalls: FalCall[] = [];
let falShouldFail = false;
let falDelayMs = 0; // >0 keeps a detached render tail in-flight long enough to observe

// The fal singleton is a plain object; generate.ts looks up `fal.subscribe` per call.
// Content moderation (moderation.ts): every uploaded photo is screened via
// fal-ai/imageutils/nsfw before it can be used as generation input. Tracked
// as its OWN edge (not pushed into falCalls) — dozens of existing assertions
// use falCalls.length deltas to mean "the generation MODEL ran N times", and
// this classifier call happens in addition to that on every photo-based
// generation; conflating the two would silently break every such count.
// Default SAFE (0) so existing journeys are unaffected; individual steps
// flip this to exercise the block/refund path, then must reset it to 0.
let nsfwProbability = 0;
let nsfwCheckCalls = 0;
(fal as { subscribe: unknown }).subscribe = async (
  endpoint: string,
  opts: { input: Record<string, unknown> },
) => {
  if (endpoint === "fal-ai/imageutils/nsfw") {
    nsfwCheckCalls++;
    return { data: { nsfw_probability: nsfwProbability }, requestId: "req-nsfw" };
  }
  falCalls.push({ endpoint, input: opts.input });
  if (falDelayMs > 0) await new Promise((r) => setTimeout(r, falDelayMs));
  if (falShouldFail) throw new Error("simulated provider outage");
  const data = endpoint.includes("video")
    ? { video: { url: `https://fal.test/out/${falCalls.length}.mp4` } }
    : { images: [{ url: `https://fal.test/out/${falCalls.length}.png` }] };
  return { data, requestId: `req-${falCalls.length}` };
};

// telegramFileUrl (generate.ts) now downloads the Telegram file itself and
// re-hosts it on fal storage instead of handing fal a URL with the bot's live
// token embedded — stub both network edges. Only intercepts the Telegram file
// host; anything else falls through to the real fetch (unused in this suite).
const realFetch = globalThis.fetch;
let tgFileFetches = 0;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = typeof input === "string" ? input : (input as { toString(): string }).toString();
  if (url.startsWith("https://api.telegram.org/file/")) {
    tgFileFetches++;
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 }); // fake jpeg bytes
  }
  return realFetch(input as never, init as never);
}) as typeof fetch;
let storageUploadCount = 0;
(fal.storage as unknown as { upload: unknown }).upload = async () => `https://fal.test/storage/tg-${++storageUploadCount}.jpg`;

// ---------- update factories ----------

let nextUpdateId = 1;
let nextIncomingMessageId = 100;

interface From {
  id: number;
  is_bot: false;
  first_name: string;
  username?: string;
}
const alice: From = { id: 1001, is_bot: false, first_name: "Alice", username: "alice" };
// Alice's balance is shared running state across the steps below. From the
// referral payout onward it depends on tunable commercial dials (the referral
// share), so the steps that follow track it as a running total instead of
// restating a literal each time — a retuned dial must not fail an unrelated
// step about, say, which endpoint a preset calls.
let aliceBal = 0;
const bob: From = { id: 1002, is_bot: false, first_name: "Bob", username: "bob" };
const admin: From = { id: 9999, is_bot: false, first_name: "Admin", username: "admin" };
const carol: From = { id: 1003, is_bot: false, first_name: "Carol", username: "carol" };
const dave: From = { id: 1004, is_bot: false, first_name: "Dave", username: "dave" };

function chatOf(from: From) {
  return { id: from.id, type: "private" as const, first_name: from.first_name };
}
function baseMessage(from: From) {
  return {
    message_id: nextIncomingMessageId++,
    from,
    chat: chatOf(from),
    date: Math.floor(Date.now() / 1000),
  };
}

// Generation now runs in a DETACHED tail (the handler returns fast). The harness
// settles those tails after each action so assertions see the delivered result —
// this is the same drainRenders() the graceful-shutdown path uses.
async function sendText(from: From, text: string): Promise<void> {
  const entities = text.startsWith("/")
    ? [{ offset: 0, length: text.split(/[\s@]/)[0].length, type: "bot_command" as const }]
    : undefined;
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    message: { ...baseMessage(from), text, ...(entities ? { entities } : {}) },
  });
  await drainRenders();
}

async function sendPhoto(from: From, fileId: string): Promise<void> {
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    message: {
      ...baseMessage(from),
      photo: [
        { file_id: `${fileId}-small`, file_unique_id: `${fileId}-s`, width: 90, height: 90 },
        { file_id: fileId, file_unique_id: `${fileId}-l`, width: 1280, height: 1280 },
      ],
    },
  });
  await drainRenders();
}

async function pressButton(from: From, data: string): Promise<void> {
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    callback_query: {
      id: `cbq-${nextUpdateId}`,
      from,
      chat_instance: `ci-${from.id}`,
      message: { ...baseMessage(from), text: "…" },
      data,
    },
  });
  await drainRenders();
}

/**
 * Drive a full Kaspi purchase: the buyer taps buy → a pending order is created,
 * then the admin confirms the payment (/order N ok) → grantPurchase credits the
 * pack and fires the referral/partner payouts. (The 3rd arg is the legacy Stars
 * amount, now ignored — pricing comes from the pack.)
 */
async function payForPack(from: From, packId: string, _stars?: number): Promise<void> {
  await pressButton(from, `buy:${packId}`); // creates the pending order + shows the pay link
  const m = /Заявка №(\d+)/.exec(lastText());
  if (!m) throw new Error(`no order created for ${packId}: ${lastText()}`);
  await sendText(admin, `/order ${m[1]} ok`); // admin verifies Kaspi payment → credits granted
}

// ---------- db helpers ----------

async function credits(userId: number): Promise<number> {
  return (await getUser(userId))!.credits;
}
async function ledgerCount(reason: string): Promise<number> {
  const rows = await query("SELECT COUNT(*)::int AS c FROM ledger WHERE reason = $1", [reason]);
  return Number(rows[0].c);
}

/**
 * Course-post content is delivered with `parse_mode: "HTML"` straight into a
 * real channel — a stray unclosed tag or unescaped `<`/`>`/`&` passes every
 * length/wiring assertion here but throws a Telegram 400 at real send time
 * (bot.ts's course_post catch would then report "❌ Не удалось опубликовать"
 * and the channel stays exactly as empty as before this feature). So beyond
 * "is there content", validate the markup itself: only Telegram's allowed
 * inline tags, every open tag closed (in order), and no raw `<`/`>`/bare `&`
 * outside recognized tags/entities.
 */
const TELEGRAM_HTML_TAGS = ["b", "i", "code", "pre", "s", "u", "tg-spoiler"];
function assertValidTelegramHtml(text: string, label: string): void {
  const tagRe = /<\/?([a-zA-Z-]+)(?:\s+[^<>]*)?>/g;
  const stack: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    const outside = text.slice(lastIndex, m.index);
    assert.ok(!/[<>]/.test(outside), `${label}: raw < or > outside a tag near ${JSON.stringify(outside.slice(-40))}`);
    assert.ok(
      !/&(?!lt;|gt;|amp;|quot;|#\d+;|#x[0-9a-fA-F]+;)/.test(outside),
      `${label}: bare & (not an entity) near ${JSON.stringify(outside.slice(-40))}`,
    );
    lastIndex = tagRe.lastIndex;
    const tag = m[1].toLowerCase();
    assert.ok(TELEGRAM_HTML_TAGS.includes(tag), `${label}: disallowed tag <${m[0]}>`);
    if (m[0].startsWith("</")) {
      assert.equal(stack.pop(), tag, `${label}: mismatched closing tag </${tag}>`);
    } else {
      stack.push(tag);
    }
  }
  const tail = text.slice(lastIndex);
  assert.ok(!/[<>]/.test(tail), `${label}: raw < or > in trailing text ${JSON.stringify(tail.slice(0, 40))}`);
  assert.equal(stack.length, 0, `${label}: unclosed tag(s): ${stack.join(", ")}`);
}

// ---------- scenario ----------

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

console.log("NeuroShot e2e — full user journey\n");

await step("signup: /start creates user with 12 🔫 PARKED (unclaimed) and a claim button", async () => {
  await sendText(alice, "/start");
  // Claim-gated: nothing lands in the spendable balance until the user taps
  // "🎁 Получить" — see claimWelcomeBonus in db.ts.
  assert.equal(await credits(alice.id), 0);
  assert.equal(await ledgerCount("signup"), 0);
  // Main menu ships as a hero photo carrying the welcome caption + keyboard.
  const hero = calls("sendPhoto").at(-1)!;
  assert.match(hero.payload.caption as string, /Для вас.*12.*бесплатно/s);
  const kb = hero.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  // The claim button leads, ahead of even the free-scenario hook.
  assert.equal(buttons[0], "claim:welcome");
  for (const expected of ["menu:free", "menu:photoshoot", "menu:campaigns"]) {
    assert.ok(buttons.includes(expected), `menu misses ${expected}`);
  }
  for (const removed of ["menu:product", "menu:animate", "menu:text", "menu:models", "menu:balance", "menu:ref"]) {
    assert.ok(!buttons.includes(removed), `menu should not surface ${removed} anymore`);
  }
});

await step("claim: tapping 🎁 Получить moves the parked 12 🔫 into the spendable balance, once", async () => {
  await pressButton(alice, "claim:welcome");
  assert.equal(await credits(alice.id), 12);
  assert.equal(await ledgerCount("signup"), 1);
  assert.match(lastText(), /Начислено.*12/s);
  // Double-tap (e.g. a stale button) must be a no-op, not a double credit.
  await pressButton(alice, "claim:welcome");
  assert.equal(await credits(alice.id), 12);
  assert.equal(await ledgerCount("signup"), 1);
});

await step("text→image: prompt charges 2 🔫, calls Seedream, delivers photo (menu-only keyboard)", async () => {
  await sendText(alice, "a red fox in the snow");
  assert.equal(falCalls.length, 1);
  assert.equal(falCalls[0].endpoint, "fal-ai/bytedance/seedream/v4.5/text-to-image");
  assert.ok((falCalls[0].input.prompt as string).startsWith("a red fox in the snow. "), "craft mapping missing");
  assert.match(falCalls[0].input.prompt as string, /Avoid garbled text/);
  assert.equal(resultPhotos().length, 1);
  assert.equal(await credits(alice.id), 10); // 12 − 2
  // No source photo → «Ещё стиль» must NOT appear (Copilot: it would dead-end).
  const kb = resultPhotos().at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  // A text→image result has no uploaded photo, so no "Ещё стиль" — but it IS
  // an image, and animating it is the obvious next step, so it carries the
  // same genv upsell every other still result does. Before, that button
  // existed only on campaign renders and every other image was a dead end.
  assert.deepEqual(kb.inline_keyboard.flat().map((b) => b.callback_data), ["genv:1", "menu:main"]);
});

await step("photo→edit: action keyboard, prompt, Nano Banana edit charges 3 🔫", async () => {
  await sendPhoto(alice, "photo-1");
  assert.match(lastText(), /Что сделать с этим фото/);
  await pressButton(alice, "act:photo_edit");
  assert.match(lastText(), /Опишите, что изменить/);
  await sendText(alice, "replace background with a Paris street");
  const edit = falCalls.at(-1)!;
  assert.equal(edit.endpoint, "fal-ai/nano-banana/edit");
  // The source photo is re-hosted on fal storage — never the raw Telegram file
  // URL, which would embed the bot's live token in every fal.ai request.
  const editUrl = (edit.input.image_urls as string[])[0];
  assert.match(editUrl, /^https:\/\/fal\.test\/storage\/tg-\d+\.jpg$/);
  assert.ok(!editUrl.includes(process.env.BOT_TOKEN!), "bot token leaked into the fal-bound URL");
  assert.equal(calls("getFile").length, 1);
  assert.equal(tgFileFetches, 1);
  assert.equal(resultPhotos().length, 2);
  assert.equal(await credits(alice.id), 7); // 10 − 3
});

await step("insufficient 🔫: animate (25) with 7 shows the sales-page paywall, nothing charged", async () => {
  await sendPhoto(alice, "photo-2");
  await pressButton(alice, "act:animate");
  assert.match(lastText(), /Опишите движение/);
  const falBefore = falCalls.length;
  await sendText(alice, "slow zoom in");
  assert.equal(falCalls.length, falBefore);
  // Paywall is a sales page: outcome headline, the tried model, the anchored entry pack.
  const wall = calls("sendMessage").at(-1)!;
  assert.match(wall.payload.text as string, /Ещё один шаг до результата/);
  assert.match(wall.payload.text as string, /Kling 2\.5 Turbo/); // the model's REAL name reaches the paywall copy
  // The once-per-account entry price is anchored while this account still has
  // it: it is the cheapest patron in the product, so quoting anything dearer to
  // a first-time buyer is quoting a worse deal than they are entitled to.
  assert.match(wall.payload.text as string, /Первый набор/);
  assert.match(wall.payload.text as string, /один раз на аккаунт/);
  assert.doesNotMatch(wall.payload.text as string, /Осталось/, "a once-pack must not carry a countdown");
  const kb = wall.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("buy:first_set"), "entry-pack CTA missing"); // one dominant CTA
  assert.ok(buttons.includes("show_packs"), "all-packs fallback missing");
  assert.equal(await credits(alice.id), 7);
});

await step("curated prompts reach the provider whole — no silent decapitation", async () => {
  // Regression: sanitizePrompt applied the UNTRUSTED-input cap (1500) to our own
  // curated prompts. Because prompts are written transformation-first with the
  // invariants LAST, the five longest lost their tail — and the tail is where the
  // identity lock lives. fashion shipped with 51% of its prompt missing. Nothing
  // failed, nothing logged; the model simply stopped being told to keep the face.
  const { PRESETS, CAMPAIGNS, FREE_SCENARIOS } = await import("../src/models.js");
  const { craftPrompt } = await import("../src/promptcraft.js");
  type Curated = { id: string; kind: "image_edit" | "text_to_image" | "image_to_video"; prompt: string };
  const all: Curated[] = [];
  for (const p of PRESETS) all.push({ id: `preset:${p.id}`, kind: "image_edit", prompt: p.prompt });
  type Scene = { id: string; prompt?: string };
  type Camp = { id: string; scenes?: Scene[]; videoScenes?: Scene[] };
  for (const c of CAMPAIGNS as unknown as Camp[]) {
    for (const s of c.scenes ?? []) if (s.prompt) all.push({ id: `camp:${c.id}/${s.id}`, kind: "image_edit", prompt: s.prompt });
    for (const v of c.videoScenes ?? []) if (v.prompt) all.push({ id: `vid:${c.id}/${v.id}`, kind: "image_to_video", prompt: v.prompt });
  }
  for (const f of FREE_SCENARIOS) {
    all.push({ id: `free:${f.id}/img`, kind: "image_edit", prompt: f.imagePrompt });
    all.push({ id: `free:${f.id}/vid`, kind: "image_to_video", prompt: f.videoPrompt });
  }
  assert.ok(all.length > 40, `expected the whole curated catalogue, saw ${all.length}`);
  // The clauses that carry the product's promise. If a prompt states one, the
  // text actually sent must still state it — that is the assertion the old
  // truncation would have failed on five presets.
  const INVARIANTS = [
    "Keep the face and identity of EVERY person",
    "Keep the SAME NUMBER of people",
    "not a real child and not a second guest",
  ];

  // A look that shows the subject more than once by design must NOT also carry
  // the headcount rule — the brief asks for repeats and the guard forbids them,
  // and a prompt that argues with itself gets resolved by the model, not by us.
  // photobooth_bw is 1800 chars, so it never actually received the rule while
  // curated prompts were truncated: un-cutting the tail is what made this live.
  const MULTIPLIES_SUBJECT = ["pixar_me", "mini_squad", "photobooth_bw"];
  for (const id of MULTIPLIES_SUBJECT) {
    const preset = PRESETS.find((p) => p.id === id);
    assert.ok(preset, `${id} is gone — update this list or the look it guards`);
    assert.doesNotMatch(
      preset.prompt,
      /Keep the SAME NUMBER of people/,
      `${id} repeats the subject on purpose and must not also demand the source headcount`,
    );
    assert.match(preset.prompt, /Keep the face and identity of EVERY person/, `${id} lost its identity lock`);
  }
  for (const c of all) {
    const flat = c.prompt.replace(/\s+/g, " ").trim();
    const sent = craftPrompt(c.kind, c.prompt, true);
    // No ceiling is asserted on purpose: a curated prompt is as long as the
    // context it must carry. What IS asserted is that none of it is dropped.
    assert.equal(sent.length, flat.length, `${c.id}: ${flat.length - sent.length} characters silently dropped`);
    for (const clause of INVARIANTS) {
      if (!flat.includes(clause)) continue;
      assert.ok(sent.includes(clause), `${c.id}: "${clause}" never reaches the provider`);
    }
  }
});

await step("the Seedance chooser lands on one model, cheapest-first, and never on Fast", async () => {
  const { SEEDANCE_QUIZ, recommendSeedance, nextSeedanceQuestion } = await import("../src/seedance.js");

  // Undecided until answered — the caller must keep asking rather than guess.
  assert.equal(recommendSeedance({}), null);
  assert.equal(nextSeedanceQuestion({})?.id, SEEDANCE_QUIZ[0].id);

  // Any YES short-circuits on that question's verdict, ignoring later questions.
  for (const q of SEEDANCE_QUIZ) {
    const answers: Record<string, boolean> = {};
    for (const earlier of SEEDANCE_QUIZ) {
      if (earlier.id === q.id) break;
      answers[earlier.id] = false;
    }
    answers[q.id] = true;
    const v = recommendSeedance(answers);
    assert.ok(v, `${q.id}=да left the quiz undecided`);
    assert.equal(v.model.key, q.verdict, `${q.id}=да must land on ${q.verdict}`);
    assert.equal(nextSeedanceQuestion(answers), null, `${q.id}=да must end the quiz`);
    assert.ok(v.because.length > 40, `${q.id} verdict must explain itself`);
  }

  // All NO → the cheap default. This is the whole point: someone with no hard
  // requirement should not be paying flagship rates.
  const allNo = Object.fromEntries(SEEDANCE_QUIZ.map((q) => [q.id, false]));
  const cheap = recommendSeedance(allNo)!;
  assert.equal(cheap.model.key, "seedance_mini");
  assert.ok(cheap.savedVsFlagship > 0, "the cheap verdict must actually save patrons");

  // Fast is a coin flip at a ~60% premium over Mini in independent testing, so
  // no path may recommend it. It stays in the picker (campaign scenes pin to it)
  // but advice never sends anyone there.
  const reachable = new Set(SEEDANCE_QUIZ.map((q) => q.verdict as string));
  reachable.add(cheap.model.key);
  assert.ok(!reachable.has("seedance_fast"), "the quiz must never recommend the Fast tier");

  // Every verdict must be a real, generable model priced above zero.
  const { MODELS } = await import("../src/models.js");
  for (const key of reachable) {
    const m = MODELS[key as keyof typeof MODELS];
    assert.ok(m, `verdict ${key} is not a registry model`);
    assert.equal(m.kind, "image_to_video");
    assert.ok(m.credits >= 1);
  }
});

await step("the video set really covers 3–5 finished videos, and the ladder stays monotonic", async () => {
  const { PACKS, MODELS, priceFor, packById } = await import("../src/models.js");

  // "One good video" = two strong frames + ten seconds of motion. These are the
  // four tiers a buyer can realistically work at; the set is sized so that the
  // promise on the title holds at EVERY one of them, not just the cheapest.
  const recipes = [
    { frame: MODELS.nb2_edit, video: MODELS.seedance_fast },
    { frame: MODELS.nbpro_edit, video: MODELS.seedance_fast },
    { frame: MODELS.nbpro_edit, video: MODELS.seedance },
    { frame: MODELS.premium_edit, video: MODELS.seedance },
  ].map((r) => 2 * priceFor(r.frame) + priceFor(r.video, { duration: 10 }));

  const videoSet = packById("video_set")!;
  const counts = recipes.map((cost) => Math.floor(videoSet.credits / cost));
  assert.ok(
    Math.min(...counts) >= 3 && Math.max(...counts) <= 5,
    `video_set (${videoSet.credits} 🔫) yields ${counts.join("/")} videos — the title promises 3–5`,
  );

  // Bigger pack ⇒ better ₸ per patron, across the whole ladder. The purpose-built
  // sets are declared out of size order, so this is a real invariant to hold.
  // `once` packs are excluded: the entry price is below every rung by design, and
  // it is the one price that does not have to obey the ladder.
  const ladder = PACKS.filter((p) => !p.offer && !p.once && !p.course && !p.retired).sort(
    (a, b) => a.credits - b.credits,
  );
  for (let i = 1; i < ladder.length; i++) {
    const prev = ladder[i - 1].kzt / ladder[i - 1].credits;
    const here = ladder[i].kzt / ladder[i].credits;
    assert.ok(here < prev, `${ladder[i].id} (${here.toFixed(1)} ₸/🔫) is not better than ${ladder[i - 1].id} (${prev.toFixed(1)})`);
  }

  // Every ladder rate sits in the 30–40 ₸/🔫 band. The floor is what protects the
  // margin (provider cost is ~9.5 ₸ per patron on EVERY model, so 30 ₸ is 3.2×
  // on the worst case); the ceiling is what keeps the entry rung sellable.
  for (const p of ladder) {
    const per = p.kzt / p.credits;
    assert.ok(per >= 30 && per <= 40, `${p.id} is ${per.toFixed(1)} ₸/🔫 — outside the 30–40 band`);
  }

  // The entry price must actually undercut the ladder, and must be `once` rather
  // than `offer`: an offer has to expire to stop being the standing rate, and a
  // countdown on a permanent price is the part buyers stop believing.
  const first = PACKS.find((p) => p.once && !p.retired)!;
  assert.ok(first, "no once-per-account entry pack");
  assert.ok(!first.offer, "the entry price must not also be a countdown offer");
  assert.ok(
    first.kzt / first.credits < ladder[0].kzt / ladder[0].credits,
    "the entry price must be below the ladder floor",
  );
  // Sized to match a real ladder pack, so "было / стало" is a comparison the
  // buyer can check on the same screen rather than a number we assert.
  assert.ok(
    ladder.some((p) => p.credits === first.credits),
    "the entry pack must mirror a ladder pack's size, or its struck-through price is invented",
  );
  assert.equal(packById("photo_set")!.offer, undefined, "photo_set is a standing tier now, not a countdown offer");
});

await step("course tiers price their patrons at ladder rates, and state their tuition honestly", async () => {
  const { PACKS, packById, ladderValueOf } = await import("../src/models.js");

  // A course tier is a bundle, so it sits outside every ladder filter in the
  // codebase. That is a listing decision, not a pricing exemption: it still
  // sells patrons, and before this step existed the reprice left both tiers at
  // 61.7 and 50 ₸/🔫 against a 30–40 band — the priciest patrons in the product
  // were the ones sold to the people we had just persuaded to learn.
  const courses = PACKS.filter((p) => p.course && !p.retired).sort((a, b) => a.credits - b.credits);
  assert.ok(courses.length >= 2, "both course tiers should be on sale");

  const first = PACKS.find((p) => p.once && !p.retired)!;
  const entryRate = first.kzt / first.credits;
  for (const p of courses) {
    const per = p.kzt / p.credits;
    assert.ok(per >= 30 && per <= 40, `${p.id} is ${per.toFixed(1)} ₸/🔫 — outside the 30–40 band`);
    // A course cheap enough to buy FOR the patrons is not a course, it is a hole
    // in the ladder with lessons attached.
    assert.ok(per > entryRate, `${p.id} (${per.toFixed(1)} ₸/🔫) undercuts the once-per-account entry price`);
  }
  for (let i = 1; i < courses.length; i++) {
    const prev = courses[i - 1].kzt / courses[i - 1].credits;
    const here = courses[i].kzt / courses[i].credits;
    assert.ok(here < prev, `${courses[i].id} (${here.toFixed(1)} ₸/🔫) is a worse rate than the smaller ${courses[i - 1].id}`);
  }

  // The tripwire's pitch is arithmetic, not copy: /course tells the buyer the
  // same patrons cost `ladderValueOf` on the pay screen and the lessons are
  // free. Pinned here so a ladder move cannot quietly turn that into a lie.
  const fast = packById("course_fast")!;
  assert.equal(
    fast.kzt,
    ladderValueOf(fast.credits),
    "course_fast must cost exactly its patron content — «уроки идут бесплатно» is a claim /course makes",
  );

  // The flagship charges real tuition. Priced at exactly its patron content it
  // would be three modules, a cohort and a certificate given away.
  const flagship = packById("course_flagship")!;
  const tuition = flagship.kzt - ladderValueOf(flagship.credits);
  assert.ok(tuition > 0, `course_flagship charges ${tuition} ₸ for the teaching — the course is being given away`);

  // `ladderValueOf` must price against a rung that actually covers the size
  // asked for, or the tuition it reports is measured off the wrong tile.
  assert.equal(ladderValueOf(100), 3800, "100 🔫 is Фото-сет's size and rate");
  assert.equal(ladderValueOf(700), 21000, "700 🔫 lands on Студия's rate — the smallest rung that covers it");
});

await step("paywall never anchors a pack that cannot cover the result it promises", async () => {
  // Regression: the anchor used to be the combo unconditionally, and the result
  // count was clamped with Math.max(1, …). The combo is 36 🔫 while the video
  // models cost 42 / 61 / 76 🔫 — so the paywall said "≈1 такой результат" for a
  // pack that buys zero of them. The buyer paid, landed back on the same paywall
  // and asked for a refund. Every campaign video scene routed through this.
  const { paywallText, paywallKeyboard } = await import("../src/payments.js");
  const { MODELS, PACKS } = await import("../src/models.js");
  const packByKzt = new Map(PACKS.map((p) => [p.kzt, p]));
  for (const model of Object.values(MODELS)) {
    for (const held of [0, 1, model.credits - 1]) {
      const text = paywallText(model, held);
      // The anchored pack is the one the dominant CTA buys.
      const kb = paywallKeyboard(model) as { inline_keyboard: Array<Array<{ callback_data?: string }>> };
      const buy = kb.inline_keyboard.flat().find((b) => b.callback_data?.startsWith("buy:"));
      const pack = PACKS.find((p) => `buy:${p.id}` === buy?.callback_data);
      assert.ok(pack, `no entry-pack CTA for ${model.key}`);
      // A course tier must never be anchored on a generation paywall.
      assert.ok(!pack.course, `${model.key} anchored the course pack ${pack.id}`);
      // THE INVARIANT: balance + pack must actually buy at least one of it.
      assert.ok(
        pack.credits >= model.credits,
        `${model.key} (${model.credits} 🔫) anchored ${pack.id} (${pack.credits} 🔫) — cannot cover one result`,
      );
      // …and the number printed in the copy has to be the true one.
      const price = Number(/за (\d+) ₸/.exec(text)?.[1]);
      const shown = Number(/<b>≈?\s*(\d+)/.exec(text)?.[1] ?? /(\d+)\s*результат/.exec(text)?.[1]);
      const anchored = packByKzt.get(price);
      assert.ok(anchored, `paywall price ${price} ₸ matches no pack for ${model.key}`);
      assert.equal(
        shown,
        Math.floor((held + anchored.credits) / model.credits),
        `${model.key} with ${held} 🔫: copy overstates what ${anchored.id} buys`,
      );
      assert.ok(shown >= 1, `${model.key} with ${held} 🔫: paywall promises ${shown} results`);
    }
  }
});

await step("purchase: /buy → Kaspi order → admin confirm credits the pack", async () => {
  const { packById } = await import("../src/models.js");
  await sendText(alice, "/buy");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const packButtons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  // The once-per-account entry price leads, then the KZT ladder. `combo` is
  // retired — it stays in PACKS so orders already placed against it still
  // resolve, and must never appear for sale again.
  assert.deepEqual(packButtons, ["buy:first_set", "buy:start", "buy:popular", "buy:pro", "buy:studio", "buy:photo_set", "buy:video_set"]);
  assert.ok(!packButtons.includes("buy:combo"), "a retired pack must never be listed for sale");

  await pressButton(alice, "buy:popular"); // creates a pending Kaspi order
  assert.match(lastText(), new RegExp(`${packById("popular")!.kzt} ₸`)); // KZT price shown
  const orderId = /Заявка №(\d+)/.exec(lastText())![1];
  assert.match(lastText(), /Kaspi/);

  await sendText(admin, `/order ${orderId} ok`); // admin verifies the payment → credits
  assert.equal(await credits(alice.id), 207); // 7 + 200
  assert.equal(await ledgerCount("purchase"), 1);
});

await step("/course: overview + free guide render; course packs are hidden from the generic /buy menu", async () => {
  await sendText(alice, "/course");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ["course:guide", "buy:course_fast", "buy:course_flagship"]);

  const guideMsgsBefore = calls("sendMessage").length;
  await pressButton(alice, "course:guide");
  const guideMsgs = calls("sendMessage").slice(guideMsgsBefore);
  assert.ok(guideMsgs.length >= 2, "free guide should split into multiple messages");
  assert.ok(guideMsgs.every((m) => ((m.payload.text as string) ?? "").length <= 4096));
  assert.match(guideMsgs[0].payload.text as string, /Бизнес-портрет/);

  // course_fast/course_flagship must never appear on the generic "все пакеты" menu
  // (payments.ts packsKeyboard filters `!p.course`) — the earlier /buy assertion
  // above already covers this (packButtons has no course:* entries), re-confirm here.
  await sendText(alice, "/buy");
  const buyButtons = (
    calls("sendMessage").at(-1)!.payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    }
  ).inline_keyboard
    .flat()
    .map((b) => b.callback_data);
  assert.ok(!buyButtons.includes("buy:course_fast") && !buyButtons.includes("buy:course_flagship"));
});

await step("/course_post content: every lesson/module renders valid, non-empty Telegram-HTML under the 4096-char limit", () => {
  // COURSE_FLAGSHIP_CHANNEL_ID is deliberately unset in this run (see env setup
  // above), so /course_post never actually posts flagship content below — assert
  // the content directly instead, so all 3 modules are still exercised. Markup
  // validity matters as much as length: parse_mode:"HTML" means a stray unclosed
  // tag would 400 at real send time (see assertValidTelegramHtml above).
  for (const n of [1, 2, 3, 4, 5] as const) {
    const msgs = fastStartLessonMessages(n);
    assert.ok(msgs.length >= 1, `fast lesson ${n} must render at least one message`);
    msgs.forEach((m, i) => {
      assert.ok(m.length > 0 && m.length <= 4096, `fast lesson ${n} message ${i} out of bounds`);
      assertValidTelegramHtml(m, `fast lesson ${n} message ${i}`);
    });
  }
  for (const n of [1, 2, 3] as const) {
    const msgs = flagshipModuleMessages(n);
    assert.ok(msgs.length >= 1, `flagship module ${n} must render at least one message`);
    msgs.forEach((m, i) => {
      assert.ok(m.length > 0 && m.length <= 4096, `flagship module ${n} message ${i} out of bounds`);
      assertValidTelegramHtml(m, `flagship module ${n} message ${i}`);
    });
  }
});

await step("/course_post: admin-only, validates args, posts into the configured cohort channel, no partial send when unset", async () => {
  const FAST_CHANNEL = "-100123456789"; // process.env.COURSE_FAST_CHANNEL_ID, set at the top of this file

  // Non-admin: total silence, exactly like /grant, /stats etc. — nothing posted anywhere.
  const before = calls("sendMessage").length;
  await sendText(alice, "/course_post fast 1");
  assert.equal(calls("sendMessage").length, before, "non-admin /course_post must be a no-op");

  // Bad/missing args → a usage reply, never a crash or a silent no-op for an admin.
  await sendText(admin, "/course_post");
  assert.match(lastText(), /Формат: \/course_post/);
  await sendText(admin, "/course_post fast 9"); // out-of-range lesson number
  assert.match(lastText(), /Формат: \/course_post/);
  await sendText(admin, "/course_post flagship 4"); // out-of-range module number
  assert.match(lastText(), /Формат: \/course_post/);
  await sendText(admin, "/course_post nonsense 1"); // bad tier
  assert.match(lastText(), /Формат: \/course_post/);

  // fast: channel IS configured — posts land there, then the admin gets a DM confirmation.
  const channelBefore = calls("sendMessage").filter((c) => c.payload.chat_id === FAST_CHANNEL).length;
  await sendText(admin, "/course_post fast 1");
  const channelMsgs = calls("sendMessage")
    .filter((c) => c.payload.chat_id === FAST_CHANNEL)
    .slice(channelBefore);
  assert.ok(channelMsgs.length >= 1, "fast 1 should post at least one message to the fast channel");
  assert.match(channelMsgs[0].payload.text as string, /Урок 1/);
  assert.equal(channelMsgs[0].payload.parse_mode, "HTML");
  const dm = calls("sendMessage")
    .filter((c) => c.payload.chat_id === admin.id)
    .at(-1)!.payload.text as string;
  assert.match(dm, /✅/);
  assert.match(dm, /Урок 1/);
  assert.match(dm, /Быстрый старт/);
  assert.match(dm, /COURSE_FAST/);

  // flagship: channel is UNSET — must NOT crash, must NOT attempt any send, and
  // must tell the admin to configure it first. Exactly one new sendMessage (the
  // admin's own "not configured" reply) — no partial channel post.
  const sendCountBefore = calls("sendMessage").length;
  await sendText(admin, "/course_post flagship 1");
  assert.equal(calls("sendMessage").length, sendCountBefore + 1, "unset channel must not attempt any send");
  assert.match(lastText(), /COURSE_FLAGSHIP_CHANNEL_ID/);
  assert.match(lastText(), /не настроен/);
});

await step("pending action survives the paywall: motion prompt now renders Kling video (25 🔫)", async () => {
  await sendText(alice, "slow zoom in, hair moving in the wind");
  const anim = falCalls.at(-1)!;
  assert.equal(anim.endpoint, "fal-ai/kling-video/v2.5-turbo/standard/image-to-video");
  assert.equal(anim.input.duration, "5");
  assert.match(anim.input.image_url as string, /^https:\/\/fal\.test\/storage\/tg-\d+\.jpg$/);
  assert.equal(calls("sendVideo").length, 1);
  assert.equal(await credits(alice.id), 182); // 207 − 25
});

await step("provider failure: 🔫 auto-refunded, error logged", async () => {
  falShouldFail = true;
  await sendText(alice, "another fox");
  falShouldFail = false;
  assert.match(lastText(), /🔫 патроны автоматически возвращены/);
  assert.equal(await credits(alice.id), 182);
  assert.equal(await ledgerCount("refund"), 1);
  const gen = await query("SELECT status FROM generations ORDER BY id DESC LIMIT 1");
  assert.equal(gen[0].status, "error");
});

await step("error completion persists provider cost + request id (provider billed, delivery failed)", async () => {
  const id = await createPendingGeneration(alice.id, "photo_edit", "delivery blows up", 2);
  // The provider call succeeded (we were billed) but the tail — watermark/send —
  // failed. The 'error' row must still carry the cost/audit id so COGS isn't
  // understated. completeGeneration wins the pending→error CAS the first time.
  assert.equal(await completeGeneration(id, "error", undefined, 0.06, "req-deliv-fail"), true);
  const row = await query("SELECT status, cost_usd, provider_request_id FROM generations WHERE id = $1", [id]);
  assert.equal(row[0].status, "error");
  assert.equal(Number(row[0].cost_usd), 0.06);
  assert.equal(String(row[0].provider_request_id), "req-deliv-fail");
  // Exactly-once: a second completion loses the CAS and cannot overwrite it — the
  // guard that stops a post-'ok' logEvent blip from refunding a delivered render.
  assert.equal(await completeGeneration(id, "error", undefined, 0.99, "req-second"), false);
  const after = await query("SELECT cost_usd, provider_request_id FROM generations WHERE id = $1", [id]);
  assert.equal(Number(after[0].cost_usd), 0.06); // unchanged
  assert.equal(String(after[0].provider_request_id), "req-deliv-fail");
  // This row is a bare fixture (no credit movement) — drop it so the cumulative
  // shared-state counts later steps assert on (e.g. /stats) are unaffected.
  await query("DELETE FROM generations WHERE id = $1", [id]);
});

await step("referral: link gives friend a join bonus; first purchase pays inviter bonus + the lifetime share", async () => {
  await sendText(bob, `/start ${alice.id}`);
  assert.equal(await credits(bob.id), 0); // still parked — claim-gated same as any signup
  assert.equal(await ledgerCount("referral_join"), 0);

  await pressButton(bob, "claim:welcome"); // both signup + join bonus land in one claim
  assert.equal(await credits(bob.id), 15); // 12 free + 3 join bonus
  assert.equal(await ledgerCount("referral_join"), 1);

  await payForPack(bob, "popular", 2200);
  assert.equal(await credits(bob.id), 215); // 15 + 200
  // alice: 182 + first-purchase bonus (10) + the lifetime share of the pack.
  // Derived from config, not spelled out: the share is a commercial dial that
  // gets retuned, and a hard-coded expectation here would only ever catch the
  // retune itself — never a bug in how the share is paid.
  const { config } = await import("../src/config.js");
  const share = Math.floor(200 * config.referralPercent);
  aliceBal = 182 + config.referralFirstPurchaseBonus + share;
  assert.equal(await credits(alice.id), aliceBal);
  assert.equal(await ledgerCount("referral"), 1); // lifetime share
  assert.equal(await ledgerCount("referral_bonus"), 1); // one-time first purchase

  const notify = calls("sendMessage")
    .filter((c) => c.payload.chat_id === alice.id)
    .at(-1)!;
  assert.match(notify.payload.text as string, /первую покупку/);
  assert.match(notify.payload.text as string, new RegExp(`\\+${share} патрон`));
});

await step("/ref: dashboard shows stats + an opaque invite link (never the raw tg id)", async () => {
  await sendText(alice, "/ref");
  const text = lastText();
  // Opaque 6-char code from the unforgeable alphabet — never alice's numeric id.
  const m = text.match(new RegExp(`t\\.me/${botInfo.username}\\?start=([a-z2-9]{6})`));
  assert.ok(m, "invite link missing or not in the opaque-code format");
  assert.notEqual(m![1], String(alice.id), "invite link leaked the raw tg id");
  assert.match(text, /Приглашено: <b>1<\/b>/); // bob
  assert.match(text, /покупают: <b>1<\/b>/); // bob bought

  // The code is stable across requests (same link keeps working if re-shared).
  await sendText(alice, "/ref");
  const m2 = lastText().match(new RegExp(`t\\.me/${botInfo.username}\\?start=([a-z2-9]{6})`));
  assert.equal(m2![1], m![1], "ref code changed between requests");
});

await step("/stats: admin sees totals, non-admin gets silence", async () => {
  await sendText(admin, "/stats");
  const text = lastText();
  assert.match(text, /Users: 2/); // alice, bob (/stats does not register its caller)
  assert.match(text, /Paying: 2/);
  assert.match(text, /Generations: 4/); // 3 ok + 1 error
  // Two «Популярный» purchases (alice + bob) at whatever that pack costs today —
  // read from the registry, so a reprice does not fail an assertion about /stats.
  const popularKzt = (await import("../src/models.js")).packById("popular")!.kzt;
  assert.match(text, new RegExp(`Выручка: ${2 * popularKzt} ₸`));

  const before = calls("sendMessage").length;
  await sendText(alice, "/stats");
  assert.equal(calls("sendMessage").length, before);
});

await step("balance: /balance reflects the ledger", async () => {
  await sendText(alice, "/balance");
  // Read the ledger for the expected figure rather than pinning a literal: the
  // number here is the running total of every earlier step, so a literal turns
  // any upstream economy change into a failure in an unrelated test.
  assert.match(lastText(), new RegExp(`Баланс: 🔫 ${await credits(alice.id)} патрон`));
});

await step("photoshoot preset: photo → menu:photoshoot → one tap renders via Seedream 4.5 edit (2 🔫)", async () => {
  await sendPhoto(alice, "photo-3");
  const albumsBefore = calls("sendMediaGroup").length;
  await pressButton(alice, "pick:photo");
  // Preview album (expected results) is shown above the keyboard when assets ship.
  assert.ok(calls("sendMediaGroup").length > albumsBefore, "no preview album sent");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("preset:headshot"));
  assert.ok(!buttons.includes("preset:product_white"), "product presets leak into photo menu");
  await pressButton(alice, "preset:headshot");
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "fal-ai/bytedance/seedream/v4.5/edit"); // cheap, strong-identity preset engine
  assert.match(call.input.prompt as string, /corporate headshot/);
  assert.ok(Array.isArray(call.input.image_urls));
  assert.equal(await credits(alice.id), (aliceBal -= 2)); // Seedream edit

  // Every delivered result carries the next-step keyboard.
  const delivered = resultPhotos().at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const after = delivered.inline_keyboard.flat().map((b) => b.callback_data);
  // "Оживить" leads: a finished portrait is the single most likely thing a user
  // wants to turn into video, and until now the button appeared only on
  // campaign results — a preset result was a dead end that forced a re-upload
  // through Telegram recompression.
  assert.deepEqual(after, ["genv:6", "menu:styles", "menu:main"]);
});

await step("«Удиви меня»: random preset renders and reveals which style was picked", async () => {
  // Own user — the credit charge is random (2-11 🔫 depending on which preset
  // is picked), so this must NOT share alice's running balance with the
  // deterministic tests around it.
  const uma: From = { id: 6103, is_bot: false, first_name: "Uma", username: "uma" };
  await sendText(uma, "/start");
  await pressButton(uma, "claim:welcome");
  await sendPhoto(uma, "photo-surprise");
  await pressButton(uma, "menu:styles");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  assert.ok(
    kb.inline_keyboard.flat().some((b) => b.callback_data === "preset:surprise"),
    "surprise button missing from the style keyboard",
  );

  const before = await credits(uma.id);
  const falBefore = falCalls.length;
  const revealBefore = apiCalls.length;
  await pressButton(uma, "preset:surprise");
  assert.equal(falCalls.length, falBefore + 1, "surprise tap must render exactly one result");

  const reveal = calls("sendMessage", revealBefore).find((c) => /🎲 Выпало:/.test(c.payload.text as string));
  assert.ok(reveal, "must reveal which style was randomly picked");
  const revealedLabel = (reveal!.payload.text as string).replace("🎲 Выпало: ", "");
  const picked = PRESETS.find((p) => p.label === revealedLabel);
  assert.ok(picked, `revealed label "${revealedLabel}" must be a real preset`);

  assert.equal(await credits(uma.id), before - presetModel(picked!).credits);
});

await step("«Удиви меня» without a photo asks for one first", async () => {
  const finn2: From = { id: 6104, is_bot: false, first_name: "Finn2", username: "finn2" };
  await sendText(finn2, "/start");
  await pressButton(finn2, "preset:surprise");
  assert.match(lastText(), /Сначала пришлите фото/);
});

await step("«ещё стиль»: the photo is remembered after a generation", async () => {
  await pressButton(alice, "menu:styles");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  assert.ok(kb.inline_keyboard.flat().some((b) => b.callback_data === "preset:cinematic"));
});

await step("/premium: premium text-to-image charges 11 🔫 via GPT Image 2", async () => {
  await sendText(alice, "/premium");
  assert.match(lastText(), /напишите запрос сразу после команды/);
  assert.equal(await credits(alice.id), aliceBal); // bare command charges nothing

  await sendText(alice, "/premium a perfume bottle on wet black marble");
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "fal-ai/gpt-image-2");
  assert.equal(call.input.quality, "high");
  assert.ok((call.input.prompt as string).startsWith("a perfume bottle on wet black marble. "));
  assert.equal(await credits(alice.id), (aliceBal -= 11)); // premium edit
});

await step("product flow: menu:product → photo → product preset renders (2 🔫)", async () => {
  await pressButton(alice, "menu:product");
  assert.match(lastText(), /Пришлите фото товара/);
  await sendPhoto(alice, "product-1");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("preset:product_white"));
  assert.ok(!buttons.includes("preset:headshot"), "photo presets leak into product menu");
  await pressButton(alice, "preset:product_white");
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "fal-ai/bytedance/seedream/v4.5/edit");
  assert.match(call.input.prompt as string, /white studio background/);
  assert.equal(await credits(alice.id), (aliceBal -= 2));
});

await step("mode escape: menu:main clears a photo mode so text→image works again", async () => {
  await sendText(carol, "/start");
  await pressButton(carol, "claim:welcome"); // claim-gated — needs a spendable balance for the flow below
  await pressButton(carol, "menu:photoshoot"); // no photo yet → enters mode_photo, asks for a photo
  const falBefore = falCalls.length;
  await sendText(carol, "just text without a photo"); // blocked by the mode guard (correct)
  assert.equal(falCalls.length, falBefore);
  assert.match(lastText(), /Пришлите фото/);

  await pressButton(carol, "menu:main"); // escape the mode (Copilot fix)
  await sendText(carol, "a blue cat"); // now a normal text-to-image prompt
  assert.equal(falCalls.length, falBefore + 1);
  assert.equal(falCalls.at(-1)!.endpoint, "fal-ai/bytedance/seedream/v4.5/text-to-image");
  assert.ok((falCalls.at(-1)!.input.prompt as string).startsWith("a blue cat. "));
});

await step("🔫 pluralization: Russian declension is correct across cases", async () => {
  await sendText(carol, "/balance");
  assert.match(lastText(), /Баланс: 🔫 10 патронов/); // carol: 12 free − 2 for "a blue cat"
  assert.equal(nUnits(1), "1 патрон");
  assert.equal(nUnits(2), "2 патрона");
  assert.equal(nUnits(5), "5 патронов");
  assert.equal(nUnits(11), "11 патронов"); // 11–14 → genitive plural
  assert.equal(nUnits(21), "21 патрон");
  // Paywall "результат" declension (singular case must read correctly for n=1).
  assert.equal(nResults(1), "1 результат");
  assert.equal(nResults(2), "2 результата");
  assert.equal(nResults(5), "5 результатов");
  assert.equal(nResults(11), "11 результатов");
});

await step("analytics: events logged; /funnel shows the conversion funnel to admin only", async () => {
  const before = calls("sendMessage").length;
  await sendText(carol, "/funnel"); // non-admin → silence
  assert.equal(calls("sendMessage").length, before);

  await sendText(admin, "/funnel");
  const text = lastText();
  assert.match(text, /Воронка/);
  assert.match(text, /Купили:/);
  assert.match(text, /Почему не купили/);

  const f = await funnel();
  assert.ok(f.visitors >= 3, `visitors ${f.visitors}`); // alice, bob, carol (+admin)
  assert.ok(f.paid >= 2, `paid ${f.paid}`); // alice + bob purchased
  assert.ok(f.succeededGen >= 1, `succeededGen ${f.succeededGen}`);
  assert.ok(f.hitPaywall >= 1, `hitPaywall ${f.hitPaywall}`); // alice hit the animate paywall
  assert.ok(f.dropoff.neverGenerated >= 0);
});

await step("menu media: animate shows a video preview, text shows example images", async () => {
  const vBefore = calls("sendVideo").length;
  await pressButton(carol, "menu:animate");
  assert.ok(calls("sendVideo").length > vBefore, "no animate video preview sent");

  const aBefore = calls("sendMediaGroup").length;
  await pressButton(carol, "menu:text");
  assert.ok(calls("sendMediaGroup").length > aBefore, "no text example album sent");
});

await step("top models: image picker routes text→image to the chosen model (accurate endpoint)", async () => {
  await sendText(dave, "/start");
  await pressButton(dave, "claim:welcome"); // +12 free, claim-gated same as any signup
  await payForPack(dave, "pro", 5000); // +500 🔫 to afford premium models
  await pressButton(dave, "menu:models");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("txt:nbpro_image"), "Nano Banana Pro missing from image picker");
  assert.ok(buttons.includes("txt:nb2_image"), "Nano Banana 2 missing from image picker");

  await pressButton(dave, "txt:nbpro_image");
  await sendText(dave, "cyberpunk cat");
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "fal-ai/nano-banana-pro"); // verified fal endpoint
  assert.ok((call.input.prompt as string).startsWith("cyberpunk cat. "));
  assert.equal(call.input.resolution, "2K");
  assert.equal(await credits(dave.id), 504); // 512 − 8
});

await step("top models: video picker routes photo→video to the chosen model (Seedance 2.0)", async () => {
  await sendPhoto(dave, "dave-1");
  await pressButton(dave, "menu:videopick");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("act:kling3"), "Kling 3.0 missing from video picker");
  assert.ok(buttons.includes("act:seedance"), "Seedance 2.0 missing from video picker");

  await pressButton(dave, "act:seedance");
  await sendText(dave, "slow dolly in");
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "bytedance/seedance-2.0/image-to-video"); // verified fal endpoint
  assert.match(call.input.image_url as string, /^https:\/\/fal\.test\/storage\/tg-\d+\.jpg$/);
  assert.equal(call.input.duration, "5");
  assert.equal(call.input.resolution, "720p");
  assert.equal(await credits(dave.id), 428); // 504 − 76
});

await step("referral milestone: 3 PAYING friends trigger the tier bonus, awarded once", async () => {
  const patron: From = { id: 2001, is_bot: false, first_name: "Patron", username: "patron" };
  await sendText(patron, "/start"); // 12 free
  await pressButton(patron, "claim:welcome"); // claim-gated
  for (const fid of [2101, 2102, 2103]) {
    const f: From = { id: fid, is_bot: false, first_name: `F${fid}`, username: `f${fid}` };
    await sendText(f, `/start ${patron.id}`); // joins via patron's link (friend gets join bonus)
    await payForPack(f, "start", 720); // buys → becomes a paying friend
  }
  // Per paying friend: first-purchase bonus + the lifetime share of a 60 🔫 pack.
  // On the 3rd, the 3-friends milestone (+20) fires on top. Both the share and
  // the bonus are commercial dials, so the expectation is built from them.
  const { config: cfg } = await import("../src/config.js");
  const perFriend = cfg.referralFirstPurchaseBonus + Math.floor(60 * cfg.referralPercent);
  assert.equal(await credits(patron.id), 12 + 3 * perFriend + 20);
  assert.equal(await ledgerCount("referral_milestone"), 1);
  const row = await query("SELECT ref_milestones FROM users WHERE id = $1", [patron.id]);
  assert.equal(Number(row[0].ref_milestones), 1);

  // A 4th paying friend must NOT re-award the same tier.
  const f4: From = { id: 2104, is_bot: false, first_name: "F4", username: "f4" };
  await sendText(f4, `/start ${patron.id}`);
  await payForPack(f4, "start", 720);
  assert.equal(await ledgerCount("referral_milestone"), 1); // still exactly one
});

await step("referral is purchase-gated: a referred friend who never buys pays the inviter nothing", async () => {
  const host: From = { id: 3001, is_bot: false, first_name: "Host", username: "host" };
  await sendText(host, "/start");
  const before = await credits(host.id);
  const freeloader: From = { id: 3101, is_bot: false, first_name: "Free", username: "free" };
  await sendText(freeloader, `/start ${host.id}`); // joins…
  await pressButton(freeloader, "claim:welcome"); // …claims the free 🔫…
  await sendText(freeloader, "a lonely lighthouse"); // …generates on it, never pays
  assert.equal(await credits(host.id), before); // inviter earned nothing (no purchase)
});

await step("partner program: admin creates a code; c_<code> joins get the gift; purchases pay the custom %", async () => {
  const mentor: From = { id: 4001, is_bot: false, first_name: "Mentor", username: "mentor" };
  await sendText(mentor, "/start"); // 12 free
  await pressButton(mentor, "claim:welcome"); // claim-gated
  await sendText(admin, "/partner_add mentor 4001 25 10 Курс Ментора");
  assert.match(lastText(), /c_mentor/);

  const student: From = { id: 4101, is_bot: false, first_name: "Student", username: "student" };
  await sendText(student, `/start c_mentor`);
  assert.equal(await credits(student.id), 0); // parked — claim-gated same as any signup
  assert.equal(await ledgerCount("partner_join"), 0);
  await pressButton(student, "claim:welcome");
  assert.equal(await credits(student.id), 22); // 12 free + 10 partner gift
  assert.equal(await ledgerCount("partner_join"), 1);
  const greet = calls("sendMessage").at(-1)!;
  assert.match(greet.payload.text as string, /подарок от Курс Ментора/);

  await payForPack(student, "popular", 2200); // 200 🔫 → mentor gets floor(200*0.25)=50
  assert.equal(await credits(mentor.id), 62); // 12 + 50
  assert.equal(await ledgerCount("partner"), 1);
  const notify = calls("sendMessage").filter((c) => c.payload.chat_id === mentor.id).at(-1)!;
  assert.match(notify.payload.text as string, /c_mentor/);

  // Lifetime: a SECOND purchase pays again (no one-time cap for partners).
  await payForPack(student, "start", 720); // 60 🔫 → +15
  assert.equal(await credits(mentor.id), 77);
  assert.equal(await ledgerCount("partner"), 2);

  // Creator dashboard shows the funnel.
  await sendText(mentor, "/partner");
  assert.match(lastText(), /c_mentor/);
  assert.match(lastText(), /пришло: <b>1<\/b>/);
  assert.match(lastText(), /покупают: <b>1<\/b>/);

  // Non-admin cannot mint codes (silence, like /stats).
  const before = calls("sendMessage").length;
  await sendText(mentor, "/partner_add hack 4001 50 100");
  assert.equal(calls("sendMessage").length, before);
});

await step("campaigns: one-tap fairy-tale image → one-tap «Оживить» animates the GENERATED image", async () => {
  const parent: From = { id: 5501, is_bot: false, first_name: "Parent", username: "parent" };
  await sendText(parent, "/start"); // 12 free
  await pressButton(parent, "claim:welcome"); // claim-gated
  await payForPack(parent, "start", 720); // +60 → 72

  await pressButton(parent, "menu:campaigns");
  let kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const camps = kb.inline_keyboard.flat().map((b) => b.callback_data);
  for (const c of ["camp:skazka", "camp:oldphoto", "camp:poster", "camp:minifilm", "camp:odyssey"]) {
    assert.ok(camps.includes(c), `campaign menu misses ${c}`);
  }

  await pressButton(parent, "camp:skazka");
  assert.match(lastText(), /Пришлите фото ребёнка/);
  await sendPhoto(parent, "kid-1");
  kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  assert.ok(kb.inline_keyboard.flat().some((b) => b.callback_data === "cpre:skazka:forest"));

  await pressButton(parent, "cpre:skazka:forest");
  const gen = falCalls.at(-1)!;
  assert.equal(gen.endpoint, "fal-ai/bytedance/seedream/v4.5/edit"); // default scenario image engine
  assert.match(gen.input.prompt as string, /fairy tale/i);
  assert.equal(await credits(parent.id), 70); // 72 − 2
  const resultUrl = `https://fal.test/out/${falCalls.length}.png`;
  // The "оживить" upsell rides the RESULT's keyboard (camv:<camp>:<genId>), so it
  // references the result by id — pending_file_id stays the user's uploaded photo.
  const resultKb = resultPhotos().at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data?: string }>>;
  };
  const camvBtn = resultKb.inline_keyboard.flat().map((b) => b.callback_data).find((d) => d?.startsWith("camv:skazka:"));
  assert.ok(camvBtn, "оживить upsell button missing on the delivered result");

  await pressButton(parent, camvBtn!);
  const anim = falCalls.at(-1)!;
  assert.equal(anim.endpoint, "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video"); // Hailuo 2.3 Fast default video
  assert.equal(anim.input.image_url, resultUrl); // animates the RESULT, not the original photo
  assert.match(anim.input.prompt as string, /fireflies/i); // canned campaign motion prompt
  assert.equal(await credits(parent.id), 60); // 70 − 10
});

await step("мини-фильм campaign: Seedream film still → Seedance 2.0 (со звуком) multi-shot upsell (78 🔫 flow)", async () => {
  const actor: From = { id: 5502, is_bot: false, first_name: "Actor", username: "actor" };
  await sendText(actor, "/start"); // 12 free
  await pressButton(actor, "claim:welcome"); // claim-gated
  await payForPack(actor, "popular", 2200); // +200 → 212

  await pressButton(actor, "camp:minifilm");
  await sendPhoto(actor, "actor-1");
  await pressButton(actor, "cpre:minifilm:drama");
  const still = falCalls.at(-1)!;
  assert.equal(still.endpoint, "fal-ai/bytedance/seedream/v4.5/edit");
  assert.match(still.input.prompt as string, /film still/i);
  assert.equal(await credits(actor.id), 210); // 212 − 2
  const stillUrl = `https://fal.test/out/${falCalls.length}.png`;
  const mfKb = resultPhotos().at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data?: string }>>;
  };
  const mfCamv = mfKb.inline_keyboard.flat().map((b) => b.callback_data).find((d) => d?.startsWith("camv:minifilm:"));
  assert.ok(mfCamv, "оживить upsell button missing on the film still");

  await pressButton(actor, mfCamv!);
  const clip = falCalls.at(-1)!;
  assert.equal(clip.endpoint, "bytedance/seedance-2.0/image-to-video"); // flagship story model (audio)
  assert.equal(clip.input.image_url, stillUrl); // animates the generated still
  assert.equal(clip.input.generate_audio, true); // «со звуком» is real
  assert.match(clip.input.prompt as string, /multi-shot/i);
  assert.equal(await credits(actor.id), 134); // 210 − 76
});

await step("«Одиссея» campaign: bronze-armour still → epic scene auto-upgrades to Seedance; keeps the user's own face", async () => {
  const hero: From = { id: 5503, is_bot: false, first_name: "Hero", username: "hero" };
  await sendText(hero, "/start");
  await pressButton(hero, "claim:welcome");
  await payForPack(hero, "popular", 2200); // +200 → 212

  await pressButton(hero, "camp:odyssey");
  await sendPhoto(hero, "hero-1");
  await pressButton(hero, "cpre:odyssey:king");
  const still = falCalls.at(-1)!;
  assert.equal(still.endpoint, "fal-ai/bytedance/seedream/v4.5/edit");
  assert.match(still.input.prompt as string, /bronze/i);
  // The whole point of the scenario: the USER is the hero, so identity is pinned
  // and the prompt never reaches for a real film, its title, or its cast.
  assert.match(still.input.prompt as string, /Keep the face and identity of EVERY person in the photo/);
  // Plural on purpose: a couple sending one photo must get BOTH of them back
  // as heroes, not one of them cropped out of their own picture.
  assert.match(still.input.prompt as string, /SAME NUMBER of people/);
  const p = (still.input.prompt as string).toLowerCase();
  for (const forbidden of ["nolan", "matt damon", "movie", "2026 film"]) {
    assert.ok(!p.includes(forbidden), `odyssey prompt must not reference "${forbidden}"`);
  }
  assert.equal(await credits(hero.id), 210); // 212 − 2

  // The default animate beat stays on the cheap engine…
  const stillUrl = `https://fal.test/out/${falCalls.length}.png`;
  const kb = resultPhotos().at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data?: string }>>;
  };
  const camv = kb.inline_keyboard.flat().map((b) => b.callback_data).find((d) => d?.startsWith("camv:odyssey:"));
  assert.ok(camv, "«оживить» upsell missing on the odyssey still");
  await pressButton(hero, camv!);
  const clip = falCalls.at(-1)!;
  assert.equal(clip.endpoint, "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video");
  assert.equal(clip.input.image_url, stillUrl);
  assert.equal(await credits(hero.id), 200); // 210 − 10

  // …while a physics-heavy scene (the storm) is tiered epic and must resolve to
  // the Seedance engine, not the cheap default that can't carry it.
  const { campaignById: campById, sceneModel: resolveScene, MODELS: M } = await import("../src/models.js");
  const odyssey = campById("odyssey")!;
  const storm = odyssey.videoScenes!.find((s) => s.id === "storm")!;
  assert.equal(resolveScene(storm, odyssey.animateModel).key, "seedance_fast");
  const calm = odyssey.videoScenes!.find((s) => s.id === "turn")!;
  assert.equal(resolveScene(calm, odyssey.animateModel).key, M.hailuo_fast.key);
});

await step("partner attribution is exclusive: no friend-referral double payout", async () => {
  // student was acquired via c_mentor → no referrer_id → referral path never fires.
  const st = await getUser(4101);
  assert.equal(st!.referrer_id, null);
  assert.equal(st!.partner_code, "mentor");
});

await step("promptcraft: every generation is filtered; raw text mapped, curated presets untouched", async () => {
  const { craftPrompt, sanitizePrompt } = await import("../src/promptcraft.js");
  // Filter: control chars stripped, whitespace collapsed, length capped.
  assert.equal(sanitizePrompt("  a  cat\n\n in   space  "), "a cat in space");
  assert.equal(sanitizePrompt("x".repeat(2000)).length, 1500);
  // Mapping per kind on raw user text.
  assert.match(craftPrompt("image_edit", "make it night"), /keep everything else — identity/);
  assert.match(craftPrompt("text_to_image", "a red fox"), /Avoid garbled text/);
  assert.match(craftPrompt("image_to_video", "slow zoom"), /no morphing, flicker/);
  // Curated prompts pass through the filter only — no double-wrapping.
  assert.equal(craftPrompt("image_edit", "curated preset prompt", true), "curated preset prompt");
  // No double punctuation when the user's text already ends in a terminator.
  assert.ok(craftPrompt("text_to_image", "make it pop!").startsWith("make it pop! Rich"));
  assert.ok(!craftPrompt("text_to_image", "make it pop!").includes("!."));
  assert.ok(craftPrompt("text_to_image", "a red fox").startsWith("a red fox. ")); // no terminator → full stop

  // And end-to-end through the bot: a free-text edit picks up the edit mapping…
  await sendPhoto(carol, "craft-1");
  await pressButton(carol, "act:photo_edit");
  await sendText(carol, "замени фон   на\nпляж");
  const edit = falCalls.at(-1)!;
  assert.ok((edit.input.prompt as string).startsWith("замени фон на пляж. ")); // sanitized + mapped
  assert.match(edit.input.prompt as string, /warped hands or faces/);
  // …while the earlier campaign render (curated) carried its prompt verbatim-crafted:
  const campaignCall = falCalls.find((c) => /fairy tale/i.test((c.input.prompt as string) ?? ""))!;
  assert.ok(!/Avoid garbled text/.test(campaignCall.input.prompt as string), "curated prompt was double-wrapped");
});

await step("first result on us: a stuck newcomer's first preset renders free, second one paywalls", async () => {
  const nora: From = { id: 6001, is_bot: false, first_name: "Nora", username: "nora" };
  await sendText(nora, "/start"); // 12 free
  await pressButton(nora, "claim:welcome"); // claim-gated
  // Drain below a preset's 2 🔫 via text→image (which never uses the free-first path).
  for (const p of ["a cat", "a dog", "a fox", "a bee", "an owl", "a ram"]) await sendText(nora, p); // 6×−2 → 0
  assert.equal(await credits(nora.id), 0);

  await sendPhoto(nora, "nora-1");
  await pressButton(nora, "pick:photo");
  const falBefore = falCalls.length;
  await pressButton(nora, "preset:headshot"); // 2 > 0 → the first result is on us
  assert.equal(falCalls.length, falBefore + 1); // it DID render (no wall before the wow)
  assert.equal(await credits(nora.id), 0); // …and charged nothing
  assert.match(lastText(), /Первый результат — бесплатно/);
  assert.equal(await ledgerCount("refund"), 1); // free render ≠ a refund (still just alice's)

  // The freebie is one-time: the second preset now hits the sales-page paywall.
  const falBefore2 = falCalls.length;
  await pressButton(nora, "preset:cinematic");
  assert.equal(falCalls.length, falBefore2); // no render
  assert.match(lastText(), /Ещё один шаг до результата/);
  assert.equal(await credits(nora.id), 0); // still nothing charged
});

await step("free scenario: princess renders the WHOLE chain free (Seedream → Hailuo), once", async () => {
  const zoe: From = { id: 6100, is_bot: false, first_name: "Zoe", username: "zoe" };
  await sendText(zoe, "/start"); // 12 free + the free-scenario gift
  const startPhoto = calls("sendPhoto").at(-1)!; // the menu ships on the hero photo
  assert.match(startPhoto.payload.caption as string, /Бесплатн/i); // the gift is announced
  // The onboarding button is present until claimed.
  const startKb = startPhoto.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const startButtons = startKb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(startButtons.includes("menu:free"), "free-scenario button missing on /start");
  assert.equal(startButtons[0], "claim:welcome", "claim button should lead, ahead of the free-scenario hook");

  await pressButton(zoe, "claim:welcome"); // claim-gated — the 12 free below need this
  await pressButton(zoe, "menu:free");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const picks = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(picks.includes("free:princess") && picks.includes("free:football"), "free picks missing");

  await pressButton(zoe, "free:princess");
  assert.match(lastText(), /Пришлите фото ребёнка/);

  const falBefore = falCalls.length;
  const videosBefore = calls("sendVideo").length;
  await sendPhoto(zoe, "zoe-kid");
  // Two provider calls: photo → Seedream scene image, then scene → Hailuo video.
  assert.equal(falCalls.length, falBefore + 2);
  assert.equal(falCalls.at(-2)!.endpoint, "fal-ai/bytedance/seedream/v4.5/edit");
  assert.equal(falCalls.at(-1)!.endpoint, "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video");
  assert.equal(falCalls.at(-1)!.input.image_url, `https://fal.test/out/${falBefore + 1}.png`); // animates the scene
  assert.equal(calls("sendVideo").length, videosBefore + 1);
  assert.equal(await credits(zoe.id), 12); // whole scenario cost the user nothing
  const flag = await query("SELECT free_scenario_used FROM users WHERE id = $1", [zoe.id]);
  assert.equal(flag[0].free_scenario_used, true);

  // Free to the USER, but item-0's cost tracking still logs what it actually
  // cost NeuroShot: both legs of the chain (Seedream $0.04 + Hailuo $0.19),
  // even though the row's patron `credits` charge is 0.
  const genRow = await query(
    "SELECT cost_usd, provider_request_id FROM generations WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
    [zoe.id],
  );
  assert.equal(Number(genRow[0].cost_usd), 0.23);
  assert.match(String(genRow[0].provider_request_id), /^req-\d+$/);

  // One-time: a second attempt is refused, no provider call.
  await pressButton(zoe, "menu:free");
  assert.match(lastText(), /уже использован/i);
  const falAfter = falCalls.length;
  await pressButton(zoe, "free:football");
  assert.equal(falCalls.length, falAfter);
});

await step("campaign-tagged slugs route like their base link and keep the full tag for attribution", async () => {
  const { entryLinkFor, ENTRY_LINKS } = await import("../src/models.js");
  // A media plan needs one link per CREATIVE to answer "which creative brought
  // the money", so the slug carries channel/wave/creative after the route. Exact
  // lookup dropped every one of those into the generic welcome.
  for (const base of Object.keys(ENTRY_LINKS)) {
    assert.deepEqual(entryLinkFor(`${base}_tg1_cr07`), ENTRY_LINKS[base], `${base} + tag lost its route`);
  }
  // The delimiter is load-bearing: a longer slug that merely STARTS with a route
  // name is a different slug, not that route.
  assert.equal(entryLinkFor("src_productx"), null);
  assert.equal(entryLinkFor("src_"), null);
  assert.equal(entryLinkFor("tiktok_jan"), null);

  // Routing on a tag must not rewrite what gets stored: first-touch attribution
  // needs the FULL slug, otherwise every creative collapses into its base route.
  const tagged: From = { id: 6201, is_bot: false, first_name: "Tagged", username: "tagged" };
  await sendText(tagged, "/start src_revive_tg1_cr07");
  assert.match(lastText(), /старое фото/i);
  const row = await query("SELECT source FROM users WHERE id = $1", [tagged.id]);
  assert.equal(row[0].source, "src_revive_tg1_cr07");
});

await step("persona entry link: /start src_football routes straight to the football free scenario", async () => {
  const finn: From = { id: 6200, is_bot: false, first_name: "Finn", username: "finn" };
  await sendText(finn, "/start src_football");
  // The routed follow-up: tailored headline + the football ask + the photo-quality tip (#8).
  const routed = lastText();
  assert.match(routed, /гол на стадионе/i); // football headline
  assert.match(routed, /Пришлите своё фото/); // the football scenario ask
  assert.match(routed, /Совет/); // photo-quality tip
  // Lands STRAIGHT on the scenario: no generic main menu is sent for the deep link.
  const routedMsg = calls("sendMessage").at(-1)!;
  assert.ok(!routedMsg.payload.reply_markup, "routed deep link must not show the generic menu");
  // Source is still recorded for first-touch attribution.
  const src = await query("SELECT source FROM users WHERE id = $1", [finn.id]);
  assert.equal(src[0].source, "src_football");
  // Sending a photo now runs the WHOLE free football chain — no extra button taps.
  const falBefore = falCalls.length;
  const videosBefore = calls("sendVideo").length;
  await sendPhoto(finn, "finn-selfie");
  assert.equal(falCalls.length, falBefore + 2); // Seedream scene → Hailuo video
  assert.equal(falCalls.at(-2)!.endpoint, "fal-ai/bytedance/seedream/v4.5/edit");
  assert.equal(falCalls.at(-1)!.endpoint, "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video");
  assert.equal(calls("sendVideo").length, videosBefore + 1);
  assert.equal(await credits(finn.id), 12); // whole scenario cost nothing
});

await step("returning /start: lean menu keeps the continue-with-photo shortcut", async () => {
  // Nora is a returning user who still has a photo on file from the preset flow above.
  await sendText({ id: 6001, is_bot: false, first_name: "Nora", username: "nora" }, "/start");
  const hero = calls("sendPhoto").at(-1)!; // the returning menu ships on the hero photo
  const kb = hero.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("menu:styles"), "continue-with-photo shortcut missing");
  assert.ok(buttons.includes("menu:photoshoot"), "core create anchor missing");
});

await step("admin /grant: target + self shorthand + negative; non-admin silent; unknown rejected", async () => {
  const grantsBefore = await ledgerCount("admin_grant"); // snapshot, not an absolute count

  // Two-arg form: credit a target user.
  const aliceBefore = await credits(alice.id);
  await sendText(admin, `/grant ${alice.id} 100`);
  assert.equal(await credits(alice.id), aliceBefore + 100);
  assert.match(lastText(), /Начислено 🔫 100 патронов/);
  assert.match(lastText(), /Баланс: 🔫/); // balance carries the currency emoji

  // Self shorthand (needs the admin's own row) + negative deduction.
  await sendText(admin, "/start"); // ensure the admin has a user row
  const adminBefore = await credits(admin.id);
  await sendText(admin, "/grant 500"); // self, positive
  assert.equal(await credits(admin.id), adminBefore + 500);
  await sendText(admin, "/grant -200"); // self, negative
  assert.equal(await credits(admin.id), adminBefore + 300);
  assert.match(lastText(), /Списано 🔫 200 патронов/);

  assert.equal(await ledgerCount("admin_grant"), grantsBefore + 3); // delta, not absolute

  // Non-admin cannot grant: silence AND no credits/ledger movement.
  const n = calls("sendMessage").length;
  const aliceMid = await credits(alice.id);
  await sendText(alice, "/grant 999999");
  assert.equal(calls("sendMessage").length, n);
  assert.equal(await credits(alice.id), aliceMid);
  assert.equal(await ledgerCount("admin_grant"), grantsBefore + 3);

  // Trailing tokens are rejected (mistyped input must not grant anything).
  await sendText(admin, `/grant ${alice.id} 100 500`);
  assert.match(lastText(), /Формат/);
  assert.equal(await credits(alice.id), aliceMid);

  // Unknown target is rejected: nothing credited, nothing journaled.
  await sendText(admin, "/grant 424243 50");
  assert.match(lastText(), /не найден/);
  assert.equal(await credits(alice.id), aliceBefore + 100);
  assert.equal(await ledgerCount("admin_grant"), grantsBefore + 3);
});

await step("reward-architecture P0: /econ_set + /econ_gate are admin-only, DB-backed, never in code", async () => {
  // Empty until an admin sets something — no seed data, no in-code fallback.
  await sendText(admin, "/econ");
  assert.match(lastText(), /пусто/);

  await sendText(admin, "/econ_set xp.save 25");
  assert.match(lastText(), /xp\.save = 25/);
  await sendText(admin, "/econ_set xp.reroll 0");
  assert.match(lastText(), /xp\.reroll = 0/);
  await sendText(admin, "/econ_gate headshot 3");
  assert.match(lastText(), /headshot → уровень 3/);

  await sendText(admin, "/econ");
  assert.match(lastText(), /xp\.save = 25/);
  assert.match(lastText(), /xp\.reroll = 0/);
  assert.match(lastText(), /headshot → уровень 3/);

  // Re-setting an existing key overwrites, doesn't duplicate.
  await sendText(admin, "/econ_set xp.save 30");
  await sendText(admin, "/econ");
  const listed = lastText();
  assert.match(listed, /xp\.save = 30/);
  assert.equal((listed.match(/xp\.save = /g) || []).length, 1);

  // Non-admin: silent, and cannot read or write.
  const before = calls("sendMessage").length;
  await sendText(alice, "/econ");
  await sendText(alice, "/econ_set xp.save 999");
  await sendText(alice, "/econ_gate headshot 0");
  assert.equal(calls("sendMessage").length, before);
  assert.equal(await getEconomyConfig("xp.save"), 30, "non-admin must not be able to overwrite economy config");
  assert.equal(await getPresetMinLevel("headshot"), 3, "non-admin must not be able to overwrite preset gating");

  // Bad input is rejected, not silently coerced.
  await sendText(admin, "/econ_set xp.share notanumber");
  assert.match(lastText(), /Формат/);
  await sendText(admin, "/econ_gate headshot -1");
  assert.match(lastText(), /Формат/);
  assert.equal(await getPresetMinLevel("headshot"), 3, "invalid gate input must not overwrite the existing value");

  // Unset keys stay null — the "ships inert, no guessable default" contract.
  assert.equal(await getEconomyConfig("xp.never_set"), null);
  assert.equal(await getPresetMinLevel("never_gated_preset"), null);
});

await step("reward-architecture P4a: /season_new + /season_list are admin-only; no active season until one is created", async () => {
  assert.equal(await getActiveSeason(), null);

  await sendText(admin, "/season_list");
  assert.match(lastText(), /пока нет/);

  // Bad input rejected, nothing created.
  await sendText(admin, "/season_new s1 0 Наурыз"); // 0 days invalid
  assert.match(lastText(), /Формат/);
  await sendText(admin, "/season_new s1 notanumber Наурыз");
  assert.match(lastText(), /Формат/);
  assert.equal(await getActiveSeason(), null);

  await sendText(admin, "/season_new s1 42 Наурыз");
  assert.match(lastText(), /Сезон «Наурыз» \(s1\) создан/);
  const active = await getActiveSeason();
  assert.equal(active?.key, "s1");
  assert.equal(active?.theme_label, "Наурыз");

  // Duplicate key rejected, doesn't clobber the existing season.
  await sendText(admin, "/season_new s1 10 Другое название");
  assert.match(lastText(), /уже существует/);
  assert.equal((await getActiveSeason())?.theme_label, "Наурыз");

  await sendText(admin, "/season_list");
  assert.match(lastText(), /🟢 активен · Наурыз \(s1\)/);

  // Non-admin: silent, no season created.
  const before = calls("sendMessage").length;
  await sendText(alice, "/season_new s2 10 Тест");
  await sendText(alice, "/season_list");
  assert.equal(calls("sendMessage").length, before);
  const seasons = await listSeasons();
  assert.equal(seasons.length, 1, "non-admin must not be able to create a season");
});

await step("partner v2: join → welcome (spend-only) + code; invitee pays → base-rate withdrawable cashback", async () => {
  const { config: cfg } = await import("../src/config.js");
  const { packById } = await import("../src/models.js");
  const prt: From = { id: 8001, is_bot: false, first_name: "Prt", username: "prt" };
  await sendText(prt, "/start"); // 12 free
  await pressButton(prt, "claim:welcome"); // claim-gated
  await sendText(admin, `/partner_grant ${prt.id}`); // admin-served enrollment (no self-serve join)
  const acct0 = await partnerAccount(prt.id);
  assert.equal(acct0.joined, true);
  assert.equal(acct0.activeCodes, 1); // first code minted on join
  const joined = 12 + cfg.partnerWelcome; // free + welcome bonus
  assert.equal(await credits(prt.id), joined);
  assert.equal(acct0.withdrawable, 0); // welcome is NOT withdrawable

  // a second admin grant must NOT double-grant
  await sendText(admin, `/partner_grant ${prt.id}`);
  assert.equal(await credits(prt.id), joined);
  assert.equal((await partnerAccount(prt.id)).activeCodes, 1);

  const code = String(
    (await query("SELECT code FROM partner_codes WHERE user_id=$1 AND kind='partner' LIMIT 1", [prt.id]))[0].code,
  );
  assert.match(code, /^[a-z0-9]{6}$/);

  // invitee joins via p_<code> → gets the invitee bonus, attributed first-touch
  const inv: From = { id: 8101, is_bot: false, first_name: "Inv", username: "inv" };
  await sendText(inv, `/start p_${code}`);
  await pressButton(inv, "claim:welcome"); // claim-gated
  assert.equal(await credits(inv.id), 12 + cfg.partnerInviteeBonus);
  assert.equal(String((await getUser(inv.id))!.partner_code), code);

  // invitee pays → partner earns cashback at the BASE rung (11 000 ₸ of volume
  // is nowhere near the first threshold), added to BOTH balances.
  await payForPack(inv, "popular", 2200);
  const cashback = Math.floor(200 * cfg.partnerPercent);
  const acct1 = await partnerAccount(prt.id, { basePercent: cfg.partnerPercent, tiers: PARTNER_TIERS });
  assert.equal(acct1.paying, 1);
  assert.equal(acct1.withdrawable, cashback); // withdrawable cashback
  assert.equal(await credits(prt.id), joined + cashback); // also spendable
  assert.equal(acct1.rate!.percent, cfg.partnerPercent); // still on the base rung
  assert.equal(acct1.rate!.volumeKzt, packById("popular")!.kzt); // one granted order, at its ₸
  assert.equal(acct1.rate!.nextAt, PARTNER_TIERS[0].kzt);
  const notify = calls("sendMessage").filter((c) => c.payload.chat_id === prt.id).at(-1)!;
  assert.match(notify.payload.text as string, new RegExp(`кэшбэка.*p_${code}`));
});

await step("partner: a vanity code is still kind='partner' — laddered and withdrawable", async () => {
  const { config: cfg } = await import("../src/config.js");
  const vanity = "shambaiqyzy31";
  const cre: From = { id: 8901, is_bot: false, first_name: "Cre", username: "cre" };
  await sendText(cre, "/start");
  await pressButton(cre, "claim:welcome");
  await sendText(admin, `/partner_grant ${cre.id} ${vanity}`);

  // the requested slug is what was minted, not a random one
  const row = (await query("SELECT code, kind FROM partner_codes WHERE user_id=$1", [cre.id]))[0];
  assert.equal(String(row.code), vanity);
  // THE point of this test: /partner_add would have made this 'creator', which
  // is a flat rate settled off-platform and NOT withdrawable — different
  // commercial terms from the ones a partner is promised.
  assert.equal(String(row.kind), "partner");

  // an invitee through the vanity link pays → cashback lands in the WITHDRAWABLE
  // balance, which only ever happens for kind='partner'
  const inv: From = { id: 8902, is_bot: false, first_name: "Inv2", username: "inv2" };
  await sendText(inv, `/start p_${vanity}`);
  await pressButton(inv, "claim:welcome");
  assert.equal(String((await getUser(inv.id))!.partner_code), vanity);
  await payForPack(inv, "popular", 2300);
  const acct = await partnerAccount(cre.id, { basePercent: cfg.partnerPercent, tiers: PARTNER_TIERS });
  assert.equal(acct.withdrawable, Math.floor(200 * cfg.partnerPercent));
  assert.equal(acct.rate!.percent, cfg.partnerPercent); // on the ladder, base rung

  // a taken slug is refused rather than silently swapped for a random one
  const other: From = { id: 8903, is_bot: false, first_name: "Oth", username: "oth" };
  await sendText(other, "/start");
  await sendText(admin, `/partner_grant ${other.id} ${vanity}`);
  assert.equal((await query("SELECT code FROM partner_codes WHERE user_id=$1", [other.id])).length, 0);
  assert.match(calls("sendMessage").at(-1)!.payload.text as string, /уже занят/);

  // ...and the refusal is not a dead end: the first attempt already enrolled
  // the partner, so the retry with a fresh slug must mint it for the EXISTING
  // partner — without re-granting the welcome bonus.
  const balBefore = await credits(other.id);
  await sendText(admin, `/partner_grant ${other.id} oth31`);
  const retry = (await query("SELECT code, kind FROM partner_codes WHERE user_id=$1", [other.id]))[0];
  assert.equal(String(retry.code), "oth31");
  assert.equal(String(retry.kind), "partner");
  assert.equal(await credits(other.id), balBefore, "the retry must not pay the welcome bonus twice");
  assert.match(calls("sendMessage").at(-1)!.payload.text as string, /p_oth31/);
});

await step("partner: /partner_grant @username enrols with just the handle — no /id round-trip", async () => {
  // The scalable onboarding path: the creator taps /start (the only thing we
  // ever ask of them), the admin enrols by the @handle they are already talking
  // to. Case-insensitive, because Telegram handles are.
  const cre: From = { id: 8904, is_bot: false, first_name: "Handled", username: "Handled_Creator" };
  await sendText(cre, "/start");
  await sendText(admin, "/partner_grant @handled_creator handled31");
  const row = (await query("SELECT code, kind FROM partner_codes WHERE user_id=$1", [cre.id]))[0];
  assert.ok(row, "the @username path must actually enrol");
  assert.equal(String(row.code), "handled31");
  assert.equal(String(row.kind), "partner");
  // the confirmation names the finished link, so the admin can forward it as-is
  const confirm = calls("sendMessage").filter((c) => c.payload.chat_id === admin.id).at(-1)!;
  assert.match(confirm.payload.text as string, /p_handled31/);

  // the contract-tranche flow runs on the same handle: /grant @handle <n>
  const balBefore = await credits(cre.id);
  await sendText(admin, "/grant @handled_creator 400");
  assert.equal(await credits(cre.id), balBefore + 400);

  // an unknown handle fails with the fallback instruction, enrolling nobody
  const before = (await query("SELECT COUNT(*) AS n FROM partner_codes"))[0].n;
  await sendText(admin, "/partner_grant @nobody_here nope31");
  assert.equal((await query("SELECT COUNT(*) AS n FROM partner_codes"))[0].n, before);
  assert.match(calls("sendMessage").at(-1)!.payload.text as string, /Не знаю @nobody_here/);
});

await step("a changed @username is refreshed on the next interaction, so handle-lookup stays current", async () => {
  // getOrCreateUser used to write username once at INSERT and never again —
  // a handle recorded a year ago may belong to a STRANGER today (Telegram
  // recycles freed usernames), and an admin command resolving by handle would
  // enrol whoever holds the stale row. Any interaction now refreshes it.
  const { findUserIdByUsername } = await import("../src/db.js");
  const ren: From = { id: 8905, is_bot: false, first_name: "Ren", username: "old_handle" };
  await sendText(ren, "/start");
  assert.deepEqual(await findUserIdByUsername("@old_handle"), { ok: true, id: 8905 });

  await sendText({ ...ren, username: "new_handle" }, "/menu");
  assert.deepEqual(await findUserIdByUsername("@new_handle"), { ok: true, id: 8905 });
  assert.equal((await findUserIdByUsername("@old_handle")).ok, false, "the stale handle must stop resolving");
});

await step("partner ladder: volume raises the rate; a grandfathered rate is never cut", async () => {
  const { config: cfg } = await import("../src/config.js");
  const { partnerRateFor } = await import("../src/db.js");
  const top = PARTNER_TIERS[PARTNER_TIERS.length - 1];

  // A partner whose invitees have paid past the first threshold moves up. The
  // volume is faked at the ORDERS level (not the ledger), because that is what
  // the rate reads — anything else would be testing the test.
  const climb: From = { id: 8201, is_bot: false, first_name: "Climb", username: "climb" };
  await sendText(climb, "/start");
  await sendText(admin, `/partner_grant ${climb.id}`);
  const code = String(
    (await query("SELECT code FROM partner_codes WHERE user_id=$1 AND kind='partner' LIMIT 1", [climb.id]))[0].code,
  );
  const buyer: From = { id: 8301, is_bot: false, first_name: "Buyer", username: "buyer" };
  await sendText(buyer, `/start p_${code}`);

  const base = await partnerRateFor(climb.id, cfg.partnerPercent, PARTNER_TIERS);
  assert.equal(base.percent, cfg.partnerPercent, "a partner with no volume starts on the base rung");
  assert.equal(base.nextAt, PARTNER_TIERS[0].kzt);

  await query(
    "INSERT INTO orders (user_id, pack_id, amount_kzt, status, granted_at) VALUES ($1, 'pro', $2, 'paid', now())",
    [buyer.id, PARTNER_TIERS[0].kzt],
  );
  const climbed = await partnerRateFor(climb.id, cfg.partnerPercent, PARTNER_TIERS);
  assert.equal(climbed.percent, PARTNER_TIERS[0].percent, "reaching a threshold must raise the rate");
  assert.equal(climbed.volumeKzt, PARTNER_TIERS[0].kzt);
  assert.equal(climbed.nextPercent, PARTNER_TIERS[1].percent, "the next raise is the next BETTER rung");

  // An order that was never granted is not volume — a partner cannot climb on
  // top-ups that failed or are still waiting for payment.
  await query(
    "INSERT INTO orders (user_id, pack_id, amount_kzt, status) VALUES ($1, 'pro', $2, 'pending')",
    [buyer.id, top.kzt],
  );
  assert.equal((await partnerRateFor(climb.id, cfg.partnerPercent, PARTNER_TIERS)).percent, PARTNER_TIERS[0].percent);

  // Grandfathering: a partner enrolled on richer terms than today's base keeps
  // them at zero volume. Lowering PARTNER_PERCENT must never reach backwards.
  const legacy: From = { id: 8202, is_bot: false, first_name: "Legacy", username: "legacy" };
  await sendText(legacy, "/start");
  await sendText(admin, `/partner_grant ${legacy.id}`);
  await query("UPDATE partner_codes SET percent = 0.15 WHERE user_id = $1", [legacy.id]);
  const kept = await partnerRateFor(legacy.id, cfg.partnerPercent, PARTNER_TIERS);
  assert.equal(kept.percent, 0.15, "an existing partner must keep the rate they were promised");
  assert.equal(kept.nextPercent, top.percent, "and is shown the next rung that actually beats it");
});

await step("partner: self-serve join is disabled — only admin /partner_grant enrolls", async () => {
  const rando: From = { id: 8009, is_bot: false, first_name: "Rando", username: "rando" };
  await sendText(rando, "/start");
  const before = await credits(rando.id);
  // a stale/self-serve "Стать партнёром" button must NOT enroll or grant the bonus
  await pressButton(rando, "partner:join");
  assert.equal((await partnerAccount(rando.id)).joined, false);
  assert.equal(await credits(rando.id), before);
  // a non-admin cannot enroll anyone (including themselves)
  await sendText(rando, `/partner_grant ${rando.id}`);
  assert.equal((await partnerAccount(rando.id)).joined, false);
  // admin enrollment is the only path in
  await sendText(admin, `/partner_grant ${rando.id}`);
  assert.equal((await partnerAccount(rando.id)).joined, true);
});

await step("partner v2: withdrawal drains only withdrawable+credits; admin resolves; reject refunds", async () => {
  const { config: cfg } = await import("../src/config.js");
  const prt = { id: 8001 };
  const owed = (await partnerAccount(prt.id)).withdrawable;
  const spendable = await credits(prt.id);
  await pressButton({ id: 8001, is_bot: false, first_name: "Prt" }, "partner:withdraw");
  const acct = await partnerAccount(prt.id);
  assert.ok(owed >= cfg.withdrawMin, "fixture must have accrued enough to withdraw");
  assert.equal(acct.withdrawable, 0); // moved into the request
  assert.equal(await credits(prt.id), spendable - owed); // drained from spendable too

  const wid = Number(
    (await query("SELECT id FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [prt.id]))[0].id,
  );
  await sendText(admin, "/payouts");
  assert.match(lastText(), /Заявки на вывод/);
  assert.match(lastText(), new RegExp(`№${wid}`));

  // reject → 🔫 refunded to both balances
  await sendText(admin, `/payout ${wid} no`);
  assert.match(lastText(), /отклонена/);
  assert.equal((await partnerAccount(prt.id)).withdrawable, owed); // back where it was
  assert.equal(await credits(prt.id), spendable);
  const st = await query("SELECT status FROM withdrawals WHERE id=$1", [wid]);
  assert.equal(st[0].status, "rejected");

  // non-admin cannot resolve payouts
  const before = calls("sendMessage").length;
  await sendText({ id: 8001, is_bot: false, first_name: "Prt" }, "/payout 999 ok");
  assert.equal(calls("sendMessage").length, before);
});

await step("partner v2: 10-code cap enforced; deactivation frees a slot", async () => {
  const cap: From = { id: 8002, is_bot: false, first_name: "Cap", username: "cap" };
  await sendText(cap, "/start");
  await sendText(admin, `/partner_grant ${cap.id}`); // admin-served: 1 code minted
  for (let i = 0; i < 9; i++) await pressButton(cap, "partner:newcode"); // → 10
  assert.equal((await partnerAccount(cap.id)).activeCodes, 10);
  await pressButton(cap, "partner:newcode"); // 11th blocked
  assert.match(lastText(), /лимит/i);
  assert.equal((await partnerAccount(cap.id)).activeCodes, 10);

  const some = String(
    (await query("SELECT code FROM partner_codes WHERE user_id=$1 AND kind='partner' AND active LIMIT 1", [cap.id]))[0].code,
  );
  await pressButton(cap, `partner:deact:${some}`);
  assert.equal((await partnerAccount(cap.id)).activeCodes, 9); // slot freed
});

await step("source tracking: deep-link slugs, referral и partner become first-touch sources", async () => {
  const ad: From = { id: 7001, is_bot: false, first_name: "Ad", username: "ad" };
  await sendText(ad, "/start src_TikTok!"); // slug is lowercased and sanitized
  const src = await query("SELECT source FROM users WHERE id = $1", [ad.id]);
  assert.equal(src[0].source, "src_tiktok");

  const viaRef = await query("SELECT source FROM users WHERE id = $1", [bob.id]);
  assert.equal(viaRef[0].source, "ref"); // bob joined via alice's referral link
  const viaPartner = await query("SELECT source FROM users WHERE id = $1", [4101]);
  assert.equal(viaPartner[0].source, "c_mentor"); // student joined via creator code

  // First-touch is immutable: a repeat /start with a different slug won't move it.
  await sendText(ad, "/start src_vk");
  const still = await query("SELECT source FROM users WHERE id = $1", [ad.id]);
  assert.equal(still[0].source, "src_tiktok");
});

await step("/dash: admin gets the 6-number digest split by source; non-admin gets silence", async () => {
  await sendText(admin, "/dash");
  const text = lastText();
  assert.match(text, /сводка за 24 ч/);
  assert.match(text, /Новых: <b>\d+<\/b>/);
  assert.match(text, /src_tiktok 1/); // per-source split
  assert.match(text, /Оплат: <b>\d+<\/b> на <b>\d+ ₸<\/b>/);
  assert.match(text, /c_mentor: \d+/); // payers split by source
  assert.match(text, /маржа <b>\d+%<\/b>/);
  assert.match(text, /Обязательства: <b>\d+ 🔫<\/b>/);

  const digest = await buildDigest(24);
  assert.ok(digest.kzt > 0, "test journey produced purchases");
  assert.ok(digest.marginPct != null && digest.marginPct > 50, `margin ${digest.marginPct}`);
  assert.ok(digest.creditLiability > 0);

  const before = calls("sendMessage").length;
  await sendText(alice, "/dash"); // non-admin → silence, like /stats
  assert.equal(calls("sendMessage").length, before);
});

await step("alerts: >5% model error rate trips the fal-drift interrupt; healthy checks stay quiet", async () => {
  const clean = await checkAlerts();
  assert.ok(!clean.some((a) => a.key === "margin"), "margin healthy in the test journey");
  assert.ok(!clean.some((a) => a.key === "deadfunnel"), "payments exist in the window");

  // Simulate provider drift: a burst of kling3 failures within the hour.
  for (let i = 0; i < 6; i++) await logGeneration(9999, "kling3", "drift probe", 42, "error");
  const alerts = await checkAlerts();
  const drift = alerts.find((a) => a.key === "err:kling3");
  assert.ok(drift, "kling3 error-rate alert missing");
  assert.match(drift!.text, /kling3/);
  assert.match(drift!.text, /fal\.ai/);
});

await step("alerts: a buyer who said they paid and got nothing pulls an admin in", async () => {
  const { stalePaidClaims } = await import("../src/db.js");
  const waiting = 7401;
  await getOrCreateUser(waiting, "waiting", null, 0);
  const photoSetKzt = (await import("../src/models.js")).packById("photo_set")!.kzt;
  const orderId = await createOrder(waiting, "photo_set", photoSetKzt);

  // Fresh claim: inside the grace window, so nothing fires yet — a buyer still
  // finishing in the Kaspi app is not an incident.
  await query("UPDATE orders SET paid_claimed_at = now() WHERE id = $1", [orderId]);
  assert.equal((await stalePaidClaims(15)).length, 0, "a fresh claim is not stuck");
  assert.ok(!(await checkAlerts()).some((a) => a.key.startsWith("order_waiting:")), "quiet inside the grace window");

  // Aged past the window: the money is sitting somewhere and nobody has been told.
  await query("UPDATE orders SET paid_claimed_at = now() - interval '40 minutes' WHERE id = $1", [orderId]);
  const alert = (await checkAlerts()).find((a) => a.key.startsWith(`order_waiting:${orderId}:`));
  assert.ok(alert, "a stuck paid claim must alert");
  assert.match(alert!.text, new RegExp(`/order ${orderId} ok`)); // the exact command to run
  assert.match(alert!.text, new RegExp(`${photoSetKzt} ₸`));

  // Age-bounded at the far end too: an ancient claim is history, not work. This
  // is the shape that produced the phantom-payment incident.
  await query("UPDATE orders SET paid_claimed_at = now() - interval '30 days' WHERE id = $1", [orderId]);
  assert.equal((await stalePaidClaims(15)).length, 0, "an ancient claim must not resurface as work");

  // Granting it clears the alert, because the row leaves 'pending'.
  await query("UPDATE orders SET paid_claimed_at = now() - interval '40 minutes' WHERE id = $1", [orderId]);
  assert.equal((await stalePaidClaims(15)).length, 1);
  await query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);
  assert.equal((await stalePaidClaims(15)).length, 0, "a granted order must stop nagging");
});

await step("re-engagement nudge: sweeps dormant-but-recent users once, with a tailored hook", async () => {
  // Backdated synthetic users (every other test user is 'active now' → ineligible).
  await query(
    `INSERT INTO users (id, credits, free_scenario_used, created_at) VALUES
       (8891, 0, false, now() - interval '3 days'),   -- eligible, never used the gift
       (8892, 5, true,  now()),                        -- active now → skip
       (8893, 0, false, now() - interval '30 days')`,  // dormant too long → skip
  );
  const targets = await usersToNudge(50);
  const ids = targets.map((t) => t.id);
  assert.ok(ids.includes(8891), "dormant-but-recent user not selected");
  assert.ok(!ids.includes(8892) && !ids.includes(8893), "an ineligible user was selected");
  // The unclaimed-gift hook leads for a user who never used the free scenario.
  assert.match(nudgeText(targets.find((t) => t.id === 8891)!), /бесплатн/i);

  // The sweep sends to the eligible user and marks them.
  const sent: number[] = [];
  const n = await runReengagement((id) => {
    sent.push(id);
    return Promise.resolve();
  });
  assert.ok(n >= 1 && sent.includes(8891), "sweep did not nudge the eligible user");

  // Once-only: a second sweep never re-nudges 8891.
  const sent2: number[] = [];
  await runReengagement((id) => {
    sent2.push(id);
    return Promise.resolve();
  });
  assert.ok(!sent2.includes(8891), "already-nudged user was nudged again");

  // markNudged is the once-only guard usersToNudge respects.
  assert.ok(!(await usersToNudge(50)).map((t) => t.id).includes(8891), "nudged user still eligible");
  // Idempotent: a second markNudged never overwrites the original nudge timestamp.
  const t0 = (await query("SELECT nudged_at FROM users WHERE id = 8891"))[0].nudged_at;
  await markNudged([8891]);
  const t1 = (await query("SELECT nudged_at FROM users WHERE id = 8891"))[0].nudged_at;
  assert.equal(String(t1), String(t0), "markNudged overwrote an existing nudge timestamp");
  // Restart-safe daily guard: the DB reflects that a nudge happened today (UTC).
  assert.equal(await nudgedOnUtcDay(new Date().toISOString().slice(0, 10)), true, "daily guard misses today's nudge");
});

// ---- Async generation + concurrency correctness (workflow-verified design) ----

await step("async: the render runs detached — the handler returns before it completes (bug #2)", async () => {
  const ada: From = { id: 5601, is_bot: false, first_name: "Ada", username: "ada" };
  await sendText(ada, "/start");
  await pressButton(ada, "claim:welcome"); // claim-gated — needs a spendable balance to render below
  // Hold the provider call open so the detach is observable (in prod it's 1–3 min).
  falDelayMs = 50;
  // Fire a render WITHOUT draining: the handler must return while the tail is still in flight.
  await bot.handleUpdate({ update_id: nextUpdateId++, message: { ...baseMessage(ada), text: "a blue whale" } });
  assert.ok(inFlightRenders() >= 1, "render did not detach — the handler blocked on the provider");
  await drainRenders();
  falDelayMs = 0;
  assert.equal(inFlightRenders(), 0);
});

await step("fresh photo: a generated output is never left in pending_file_id; a new request asks fresh (bug #1)", async () => {
  const ben: From = { id: 5602, is_bot: false, first_name: "Ben", username: "ben" };
  await sendText(ben, "/start");
  await payForPack(ben, "start", 720);
  await pressButton(ben, "camp:skazka");
  await sendPhoto(ben, "ben-1");
  await pressButton(ben, "cpre:skazka:royal"); // renders the campaign image
  // Invariant: pending_file_id is the UPLOAD (ben-1), never the generated URL.
  const pend = (await query("SELECT pending_file_id FROM users WHERE id = $1", [ben.id]))[0].pending_file_id as string;
  assert.ok(pend && !/^https?:\/\//.test(pend), `pending_file_id holds a generated URL: ${pend}`);
  // A new top-level request asks for a fresh photo — it does NOT reuse silently.
  await pressButton(ben, "menu:photoshoot");
  assert.match(lastText(), /Пришлите своё фото/);
});

await step("exactly-once free: a FAILED free render restores the freebie for a retry (critique 2)", async () => {
  const cid: From = { id: 5603, is_bot: false, first_name: "Cid", username: "cid" };
  await sendText(cid, "/start");
  await pressButton(cid, "claim:welcome"); // claim-gated
  for (const p of ["a", "b", "c", "d", "e", "f"]) await sendText(cid, p); // drain 12 → 0 via text→image
  assert.equal(await credits(cid.id), 0);
  await sendPhoto(cid, "cid-1");
  await pressButton(cid, "pick:photo");
  falShouldFail = true;
  await pressButton(cid, "preset:headshot"); // free claimed, then the provider fails
  falShouldFail = false;
  assert.equal(await credits(cid.id), 0); // nothing was charged
  const flag = (await query("SELECT free_result_used FROM users WHERE id = $1", [cid.id]))[0].free_result_used;
  assert.equal(flag, false, "a failed free render burned the freebie");
  await pressButton(cid, "preset:headshot"); // retry now succeeds on the restored freebie
  assert.match(lastText(), /Первый результат — бесплатно/);
});

await step("reaper: a render stuck 'pending' is failed and refunded, idempotently (critique 3)", async () => {
  const dan = 5604;
  await query("INSERT INTO users (id, credits) VALUES ($1, 0)", [dan]);
  // Simulate a detached render whose process died: a charged, stale 'pending' row.
  await query(
    `INSERT INTO generations (user_id, model, prompt, credits, status, created_at)
     VALUES ($1, 'hailuo_fast', 'x', 10, 'pending', now() - interval '30 minutes')`,
    [dan],
  );
  const reaped = await runReaper(() => Promise.resolve());
  assert.ok(reaped >= 1, "reaper did not sweep the stale render");
  assert.equal((await query("SELECT credits FROM users WHERE id = $1", [dan]))[0].credits, 10); // refunded
  assert.equal((await query("SELECT status FROM generations WHERE user_id = $1", [dan]))[0].status, "error");
  // Idempotent: a second sweep does not double-refund (the row is already terminal).
  await runReaper(() => Promise.resolve());
  assert.equal((await query("SELECT credits FROM users WHERE id = $1", [dan]))[0].credits, 10);

  // completeGeneration is an atomic CAS: a second completion of a terminal row loses.
  const gid = await createPendingGeneration(dan, "hailuo_fast", "p", 5);
  assert.equal(await completeGeneration(gid, "ok", "u"), true);
  assert.equal(await completeGeneration(gid, "error"), false);
});

await step("reconciler: an order confirmed 'paid' but never granted (crashed mid-grant) is retried, idempotently", async () => {
  const eve = 5605;
  await getOrCreateUser(eve, "eve", null, 0);
  const orderId = await createOrder(eve, "start", (await import("../src/models.js")).packById("start")!.kzt);
  // Simulate exactly the crash window this fix closes: resolveOrder already won
  // the pending→paid transition, but grantPurchase never ran (or crashed before
  // its atomic credit step) — so granted_at is still NULL, old enough to sweep.
  await query(
    `UPDATE orders SET status = 'paid', processed_at = now() - interval '10 minutes' WHERE id = $1`,
    [orderId],
  );
  assert.equal(await credits(eve), 0);

  const purchasesBefore = await ledgerCount("purchase");
  const granted = await runOrderReconciler(bot.api);
  assert.ok(granted >= 1, "reconciler did not retry the stuck paid order");
  assert.equal(await credits(eve), 60); // Старт = 60 🔫
  assert.equal((await getOrder(orderId))?.status, "paid");
  assert.equal(await ledgerCount("purchase"), purchasesBefore + 1);

  // Idempotent: a second sweep must not double-credit (granted_at is now set,
  // so the order no longer matches staleGrantedOrders — and even if it did,
  // grantOrderCredits' atomic claim would no-op).
  await runOrderReconciler(bot.api);
  assert.equal(await credits(eve), 60);
  assert.equal(await ledgerCount("purchase"), purchasesBefore + 1);

  // A stuck order whose pack no longer exists is skipped, not crashed on.
  const ghostId = await createOrder(eve, "ghost", 3700);
  await query(
    `UPDATE orders SET status = 'paid', processed_at = now() - interval '10 minutes' WHERE id = $1`,
    [ghostId],
  );
  await runOrderReconciler(bot.api); // must not throw
  assert.equal((await getOrder(ghostId))?.status, "paid");
  assert.equal(await credits(eve), 60, "unknown pack must not grant anything");
});

await step("/delete_me: confirm scrubs PII + zeroes credits + nulls generation content + deactivates partner codes; cancel is a no-op", async () => {
  const dora: From = { id: 5606, is_bot: false, first_name: "Dora" };
  await getOrCreateUser(dora.id, "dora_handle", null, 0);
  await addCredits(dora.id, 5, "admin_grant", "test");
  await setUserPhone(dora.id, "+77010000099");
  const gid = await createPendingGeneration(dora.id, "seedream", "a secret prompt", 2);
  await completeGeneration(gid, "ok", "https://fal.test/secret.jpg");
  await query("INSERT INTO partner_codes (code, user_id, percent) VALUES ($1, $2, 0.1)", ["doracode", dora.id]);

  await sendText(dora, "/delete_me");
  assert.match(lastText(), /Удаление данных/);
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  assert.deepEqual(kb.inline_keyboard.flat().map((b) => b.callback_data), ["del:confirm", "del:cancel"]);

  // Cancel leaves everything untouched.
  await pressButton(dora, "del:cancel");
  assert.equal((await getUser(dora.id))!.username, "dora_handle");

  await pressButton(dora, "del:confirm");
  assert.match(lastText(), /Готово/);
  const u = await getUser(dora.id);
  assert.equal(u!.username, null);
  assert.equal(u!.credits, 0);
  const row = (await query("SELECT phone, ref_code, deleted_at FROM users WHERE id = $1", [dora.id]))[0];
  assert.equal(row.phone, null);
  assert.equal(row.ref_code, null);
  assert.ok(row.deleted_at, "deleted_at was not stamped");
  const gen = (await query("SELECT prompt, output_url FROM generations WHERE id = $1", [gid]))[0];
  assert.equal(gen.prompt, null);
  assert.equal(gen.output_url, null);
  assert.equal((await query("SELECT active FROM partner_codes WHERE code = $1", ["doracode"]))[0].active, false);

  // Idempotent: a second confirm on an already-deleted account is a graceful no-op.
  await pressButton(dora, "del:confirm");
  assert.match(lastText(), /не найден|уже был удалён/);
});

await step("abuse safety: deleting an account can't be used to re-farm free-tier bonuses on the same id", async () => {
  const farmer: From = { id: 5607, is_bot: false, first_name: "Farmer" };
  await getOrCreateUser(farmer.id, "farmer", null, 12); // parks 12 signup credits like a real /start
  // Simulate having already spent every one-time free grant this account can get.
  await query(
    `UPDATE users SET
       welcome_bonus_claimed = true, pending_signup_credits = 0, pending_join_bonus = 0,
       free_result_used = true, free_scenario_used = true, roadmap_bonus_claimed = true
     WHERE id = $1`,
    [farmer.id],
  );
  await addCredits(farmer.id, 3, "admin_grant", "test"); // some real spendable balance too

  await deleteUserData(farmer.id);

  // The one-time flags must survive the deletion untouched — that's what stops
  // "delete, then /start again" from being a free-tier farming loop.
  const flags = (await query(
    `SELECT welcome_bonus_claimed, pending_signup_credits, pending_join_bonus,
            free_result_used, free_scenario_used, roadmap_bonus_claimed, credits
     FROM users WHERE id = $1`,
    [farmer.id],
  ))[0];
  assert.equal(flags.welcome_bonus_claimed, true);
  assert.equal(Number(flags.pending_signup_credits), 0);
  assert.equal(Number(flags.pending_join_bonus), 0);
  assert.equal(flags.free_result_used, true);
  assert.equal(flags.free_scenario_used, true);
  assert.equal(flags.roadmap_bonus_claimed, true);
  assert.equal(Number(flags.credits), 0); // the spendable balance WAS forfeited

  // Hitting /start again on the same Telegram id must not re-park a fresh
  // signup bonus (ON CONFLICT DO NOTHING — the row already exists) and must
  // show the RETURNING menu, never the newcomer claim button.
  await sendText(farmer, "/start");
  const lastKb = (calls("sendPhoto").at(-1) ?? calls("sendMessage").at(-1))?.payload.reply_markup as
    | { inline_keyboard: Array<Array<{ callback_data: string }>> }
    | undefined;
  const buttons = lastKb?.inline_keyboard.flat().map((b) => b.callback_data) ?? [];
  assert.ok(!buttons.includes("claim:welcome"), "a deleted-then-restarted account got a fresh claimable bonus");
  const after = (await query("SELECT pending_signup_credits, credits FROM users WHERE id = $1", [farmer.id]))[0];
  assert.equal(Number(after.pending_signup_credits), 0);
  assert.equal(Number(after.credits), 0);
});

await step("identity gate: one free gift per PHONE — cross-account farming blocked, owner may retry", async () => {
  const phone = "+77010000001";
  assert.equal(await phoneClaimedFree(phone), false);
  assert.equal(await claimFreePhone(phone, 8811), true); // fresh claim wins
  assert.equal(await phoneClaimedFree(phone), true);
  assert.equal(await claimFreePhone(phone, 8811), true); // SAME account may retry (failed render)
  assert.equal(await claimFreePhone(phone, 8812), false); // DIFFERENT account with the same number → blocked

  // setUserPhone records a verified number on the user row.
  await query("INSERT INTO users (id, credits) VALUES (8813, 0)");
  await setUserPhone(8813, "+77010000002");
  assert.equal((await query("SELECT phone FROM users WHERE id = 8813"))[0].phone, "+77010000002");
});

await step("ref code round-trip: a new user joining via the opaque code attributes correctly", async () => {
  // Placed last — introduces a fresh user, which would shift earlier /stats counts.
  const owner: From = { id: 9701, is_bot: false, first_name: "Owner" };
  await sendText(owner, "/ref");
  const code = lastText().match(/\?start=([a-z2-9]{6})/)![1];

  const viaCode: From = { id: 9702, is_bot: false, first_name: "ViaCode" };
  await sendText(viaCode, `/start ${code}`);
  const row = await query("SELECT referrer_id, source FROM users WHERE id = $1", [viaCode.id]);
  assert.equal(Number(row[0].referrer_id), owner.id); // attributed via the code, same as the legacy numeric path
  assert.equal(row[0].source, "ref");
});

// Course purchases (docs/course/README.md) — placed last, same reason as the
// ref-code step above: fresh users + purchases would shift earlier /stats,
// /dash and /funnel absolute counts otherwise.

await step("course purchase: buying course_fast credits patrons AND DMs a one-time cohort invite link", async () => {
  const finn: From = { id: 6101, is_bot: false, first_name: "Finn", username: "finn" };
  await sendText(finn, "/start");
  assert.equal(await credits(finn.id), 0); // parked, unclaimed — buying a pack doesn't require any balance

  const invitesBefore = calls("createChatInviteLink").length;
  const purchasesBefore = await ledgerCount("purchase");
  await payForPack(finn, "course_fast");
  // Read the size off the pack — this asserted a literal 60 and broke on the
  // reprice, which is a test failing at the one thing it was never about.
  const { packById: packOf } = await import("../src/models.js");
  assert.equal(await credits(finn.id), packOf("course_fast")!.credits);
  assert.equal(await ledgerCount("purchase"), purchasesBefore + 1);

  const invites = calls("createChatInviteLink").slice(invitesBefore);
  assert.equal(invites.length, 1, "course_fast (channel configured) must create exactly one invite link");
  assert.equal(invites[0].payload.chat_id, "-100123456789");
  assert.equal(invites[0].payload.member_limit, 1);
  assert.equal(invites[0].payload.name, `course:fast:${finn.id}`);

  // grantPurchase DMs the buyer directly (not the admin who ran /order N ok),
  // so filter sendMessage by the buyer's own chat id rather than take the last
  // overall message (that would be the admin's own "Заявка подтверждена" reply).
  const dm = calls("sendMessage")
    .filter((c) => c.payload.chat_id === finn.id)
    .at(-1)!.payload.text as string;
  assert.match(dm, /Быстрый старт/);
  assert.match(dm, /t\.me\/\+teststub/); // the stubbed invite_link
});

await step("course purchase guarantee: buying course_flagship with NO channel configured still succeeds", async () => {
  // COURSE_FLAGSHIP_CHANNEL_ID is deliberately left unset in this test run — the
  // purchase (credits + confirmation) must NOT fail, roll back, or throw; it
  // just skips the invite attempt (payments.ts inviteToCourseCohort logs and
  // falls back to a user-facing "we're still setting this up" DM instead of
  // going silent — a buyer must never see NOTHING beyond the credit grant).
  const gia: From = { id: 6102, is_bot: false, first_name: "Gia", username: "gia" };
  await sendText(gia, "/start");
  const invitesBefore = calls("createChatInviteLink").length;
  const purchasesBefore = await ledgerCount("purchase");

  await payForPack(gia, "course_flagship");
  const { packById: packOf } = await import("../src/models.js");
  assert.equal(await credits(gia.id), packOf("course_flagship")!.credits); // credits still granted
  assert.equal(await ledgerCount("purchase"), purchasesBefore + 1); // purchase still journaled normally
  assert.equal(calls("createChatInviteLink").length, invitesBefore); // no invite attempt — channel unset

  // gia gets TWO DMs: the credit confirmation, then the graceful fallback
  // (channel not configured yet) — never left with only the credit grant.
  const dms = calls("sendMessage").filter((c) => c.payload.chat_id === gia.id);
  assert.match(dms.at(-2)!.payload.text as string, /Начислено/, "credits confirmation");
  assert.match(dms.at(-1)!.payload.text as string, /AI-контент под ключ.*куплен/, "fallback DM — never silent");
});

await step("dubbing engine: charge → dub job → deliver; failure refunds exactly once; guards", async () => {
  const poll = async (id: number): Promise<{ status: string; output_url: string | null }> => {
    for (let i = 0; i < 300; i++) {
      const r = await query("SELECT status, output_url FROM generations WHERE id = $1", [id]);
      if (r[0] && r[0].status !== "pending") return r[0] as { status: string; output_url: string | null };
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error(`dub gen ${id} still pending`);
  };

  const u = { id: 7201 };
  await getOrCreateUser(u.id, "dubber", null, 0);
  await addCredits(u.id, 100, "admin_grant", "test");

  // Pricing: durationSec × $0.02/s ÷ $0.02 basis = durationSec credits here.
  assert.equal(dubCredits(15), 15);
  assert.equal(dubCredits(60), 60);
  assert.equal(dubCredits(0), 1); // floor of 1
  // KK flag is ON in this test env → all three targets offered.
  assert.deepEqual(availableDubTargets().map((t) => t.id), ["kk", "ru", "en"]);

  // Happy path: a mock runner returns a dubbed url; job completes 'ok', charged.
  const ok = await startDubbing(u.id, "https://fal.test/in/a.mp4", "ru", 15, async () => ({
    url: "https://dub.test/out-ru.mp4",
    costUsd: 0.3,
  }));
  assert.ok(ok.ok && ok.credits === 15);
  assert.equal(await credits(u.id), 85); // 100 − 15
  const okGen = await poll((ok as { id: number }).id);
  assert.equal(okGen.status, "ok");
  assert.equal(okGen.output_url, "https://dub.test/out-ru.mp4");

  // Failure path: runner throws → refunded EXACTLY once (net-zero for this job).
  const before = await credits(u.id);
  const fail = await startDubbing(u.id, "https://fal.test/in/b.mp4", "kk", 30, async () => {
    throw new Error("provider boom");
  });
  assert.ok(fail.ok);
  const failGen = await poll((fail as { id: number }).id);
  assert.equal(failGen.status, "error");
  assert.equal(await credits(u.id), before); // charged 30, refunded 30

  // Guard: over the length cap is rejected BEFORE any charge.
  const balBefore = await credits(u.id);
  assert.deepEqual(await startDubbing(u.id, "x", "ru", 999), { ok: false, error: "too_long" });
  assert.equal(await credits(u.id), balBefore); // untouched

  // Guard: insufficient balance is rejected before charge.
  const poor = { id: 7202 };
  await getOrCreateUser(poor.id, "poor", null, 0);
  await addCredits(poor.id, 5, "admin_grant", "test");
  assert.deepEqual(await startDubbing(poor.id, "x", "en", 60), { ok: false, error: "insufficient" });
  assert.equal(await credits(poor.id), 5); // not charged
});

await step("a payment complaint reaches a human and costs nothing", async () => {
  // The message most likely to arrive from an unhappy buyer used to be answered
  // by charging 2 🔫 and returning a picture of their own complaint, with nobody
  // notified. This is the single most expensive text a bot can mishandle.
  const upset: From = { id: 7301, is_bot: false, first_name: "Upset", username: "upset" };
  await getOrCreateUser(upset.id, upset.first_name, null, 0);
  await addCredits(upset.id, 10, "admin_grant", "test");
  const falBefore = falCalls.length;
  const adminBefore = calls("sendMessage").filter((c) => c.payload.chat_id === 9999).length;

  await sendText(upset, "оплатил, а патроны не пришли");

  assert.equal(falCalls.length, falBefore, "a support message must never reach the provider");
  assert.equal(await credits(upset.id), 10, "a support message must never be charged");
  assert.match(lastText(), /номер заявки/i);
  const relayed = calls("sendMessage").filter((c) => c.payload.chat_id === 9999).length;
  assert.ok(relayed > adminBefore, "a payment complaint must reach an admin");
  const evt = await query("SELECT type, meta FROM events WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [upset.id]);
  assert.equal(evt[0].type, "support");
  assert.equal(evt[0].meta, "payment");
});

await step("the router stays out of the way of real prompts, and misroutes cost one tap", async () => {
  const { classifySupport } = await import("../src/support.js");
  // Scene descriptions must pass straight through, including ones that happen to
  // contain a cue word. A false positive steals a paid request.
  for (const prompt of [
    "мужчина у которого не работает телефон, ночная улица",
    "сколько стоит этот товар — надпись на витрине магазина в стиле неон",
    "портрет девушки в красном платье",
  ]) {
    assert.equal(classifySupport(prompt), null, `intercepted a real prompt: ${prompt}`);
  }
  // Long text is a brief, not a complaint, whatever words are in it.
  assert.equal(classifySupport("не работает ".repeat(20)), null);
  // Money cues stand alone; softer intents need question shape.
  assert.equal(classifySupport("оплатил, где патроны"), "payment");
  assert.equal(classifySupport("как это работает?"), "howto");
  assert.equal(classifySupport("как это работает"), null);

  // And when it IS wrong, the held text runs on one tap rather than being lost.
  const artist: From = { id: 7302, is_bot: false, first_name: "Artist", username: "artist" };
  await getOrCreateUser(artist.id, artist.first_name, null, 0);
  await addCredits(artist.id, 10, "admin_grant", "test");
  await sendText(artist, "верните деньги"); // intercepted, held
  const falBefore = falCalls.length;
  await pressButton(artist, "support:generate");
  assert.equal(falCalls.length, falBefore + 1, "the escape hatch must run the original text");
});

await step("the Seedance chooser walks in the chat and ends on a button that renders", async () => {
  // Near the END of the suite on purpose: this step renders, and earlier steps
  // assert on CUMULATIVE counts like calls("sendVideo").length.
  const lost: From = { id: 7601, is_bot: false, first_name: "Lost", username: "lost" };
  await getOrCreateUser(lost.id, lost.first_name, null, 0);
  await addCredits(lost.id, 200, "admin_grant", "test");
  await sendPhoto(lost, "lost-1"); // videopick needs a photo on file
  await pressButton(lost, "menu:videopick");
  assert.match(lastText(), /Выберите видео-модель/);

  await pressButton(lost, "sdq:start");
  assert.match(lastText(), /первая проба/i); // question 1

  // Answer "нет" all the way down. Each tap carries the whole state in its own
  // callback data, so this also proves the encoding round-trips.
  const noTo = (id: string): string => {
    const kb = calls("sendMessage").at(-1)!.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    const no = kb.inline_keyboard.flat().find((b) => b.text === "Нет");
    assert.ok(no, `no "Нет" button on the ${id} question`);
    assert.ok(no.callback_data.includes(`-${id}`), `the "Нет" button must record ${id} as answered`);
    return no.callback_data;
  };
  await pressButton(lost, noTo("draft"));
  await pressButton(lost, noTo("resolution"));
  await pressButton(lost, noTo("motion"));
  await pressButton(lost, noTo("speech"));

  // Verdict: the cheap tier, with a reason and a button that actually renders.
  assert.match(lastText(), /Seedance 2\.0 Mini/);
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  assert.ok(kb.inline_keyboard.flat().some((b) => b.callback_data === "act:seedance_mini"), "verdict must offer the render button");

  const falBefore = falCalls.length;
  await pressButton(lost, "act:seedance_mini");
  await sendText(lost, "медленный наезд, герой оборачивается");
  assert.equal(falCalls.length, falBefore + 1, "the recommended model must be generable");
  assert.equal(falCalls.at(-1)!.endpoint, "bytedance/seedance-2.0/mini/image-to-video");
});

await step("content moderation: a flagged photo is blocked BEFORE generation, refunded, distinct message", async () => {
  // A fresh, isolated user (0 free credits + an exact grant) so this step's
  // charge/refund can't perturb any earlier step's cumulative counts —
  // deliberately placed at the very end of the suite for the same reason.
  const mod: From = { id: 8801, is_bot: false, first_name: "Mod" };
  await getOrCreateUser(mod.id, mod.first_name, null, 0);
  await addCredits(mod.id, 3, "admin_grant", "test"); // exactly one photo_edit render
  const genCallsBefore = falCalls.length;
  const nsfwCallsBefore = nsfwCheckCalls;
  nsfwProbability = 0.9; // flip the classifier to "unsafe" for this step only
  await sendPhoto(mod, "photo-unsafe");
  await pressButton(mod, "act:photo_edit");
  await sendText(mod, "replace background with a Paris street");
  nsfwProbability = 0; // reset — nothing else in the suite runs after this step
  // The classifier WAS consulted, but the actual generation model never ran
  // (charge, then refund) — blocked strictly before that call.
  assert.equal(nsfwCheckCalls, nsfwCallsBefore + 1);
  assert.equal(falCalls.length, genCallsBefore, "generation model must not run on a blocked photo");
  assert.match(lastText(), /не подходит/); // distinct from the generic "попробуйте ещё раз" retry message
  assert.equal(await credits(mod.id), 3); // charged then refunded — net zero
  const evt = await query("SELECT type FROM events WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [mod.id]);
  assert.equal(evt[0].type, "moderation_blocked");
});

console.log(`\nAll ${passed} steps passed. ✨  (db: ${process.env.DATABASE_URL || "embedded (pglite)"})`);

await step("entry price: one per account — anchored until taken, then gone from every surface", async () => {
  const { PACKS } = await import("../src/models.js");
  const { paywallText, packsKeyboard, onceTaken } = await import("../src/payments.js");
  const { MODELS } = await import("../src/models.js");
  const first = PACKS.find((p) => p.once)!;
  const buyer: From = { id: 9401, is_bot: false, first_name: "Once", username: "once" };
  await sendText(buyer, "/start");
  await pressButton(buyer, "claim:welcome");

  // Before: offered in the buy menu and anchored on the paywall.
  assert.equal(await onceTaken(buyer.id), false);
  const shown = (kb: InlineKeyboard): string[] =>
    kb.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : ""));
  assert.ok(shown(packsKeyboard(false)).includes(`buy:${first.id}`));
  assert.match(paywallText(MODELS.kling3, 0, false), new RegExp(first.kzt.toString()));

  // Taking it is what closes it — a rejected or abandoned order must not, or a
  // buyer who backs out of the Kaspi screen loses the entry price forever.
  const abandoned = await createOrder(buyer.id, first.id, first.kzt);
  assert.equal(await onceTaken(buyer.id), false, "an unpaid order must not burn the entry price");
  await sendText(admin, `/order ${abandoned} no`);
  assert.equal(await onceTaken(buyer.id), false, "a rejected order must not burn the entry price");

  await payForPack(buyer, first.id, first.kzt);
  assert.equal(await credits(buyer.id), 12 + first.credits);
  assert.equal(await onceTaken(buyer.id), true);

  // After: gone from the menu, and the paywall falls back to the ladder.
  assert.ok(!shown(packsKeyboard(true)).includes(`buy:${first.id}`));
  assert.doesNotMatch(paywallText(MODELS.kling3, 0, true), /Первый набор/);

  // A stale button in an old chat explains itself instead of selling a second one.
  const ordersBefore = (await query("SELECT COUNT(*)::int AS c FROM orders WHERE user_id = $1", [buyer.id]))[0].c;
  await pressButton(buyer, `buy:${first.id}`);
  assert.match(lastText(), /один раз на аккаунт/);
  assert.equal(
    (await query("SELECT COUNT(*)::int AS c FROM orders WHERE user_id = $1", [buyer.id]))[0].c,
    ordersBefore,
    "a repeat tap must not open a second order",
  );
});
