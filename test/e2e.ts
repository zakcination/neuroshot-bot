/**
 * End-to-end harness: drives the real bot (handlers, credit ledger, payments,
 * referrals, refunds) through grammY's update pipeline. Only the two network
 * edges are stubbed: outgoing Telegram Bot API calls (via an api transformer)
 * and fal.ai (via the fal singleton's `subscribe`).
 *
 * Run: npm run test:e2e
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env must be set before the app modules load (config/db read it at import time).
const tmp = mkdtempSync(join(tmpdir(), "neuroshot-e2e-"));
process.env.BOT_TOKEN = "1000000:TEST_TOKEN";
process.env.FAL_KEY = "test-fal-key";
process.env.DATABASE_PATH = join(tmp, "e2e.db");
process.env.FREE_CREDITS = "3";
process.env.ADMIN_IDS = "9999";

const { fal } = await import("@fal-ai/client");
const { createBot } = await import("../src/bot.js");
const { db } = await import("../src/db.js");

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
    case "deleteMessage":
    case "answerCallbackQuery":
    case "answerPreCheckoutQuery":
    case "setMyCommands":
      result = true;
      break;
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

// ---------- fal.ai stub ----------

interface FalCall {
  endpoint: string;
  input: Record<string, unknown>;
}
const falCalls: FalCall[] = [];
let falShouldFail = false;

// The fal singleton is a plain object; generate.ts looks up `fal.subscribe` per call.
(fal as { subscribe: unknown }).subscribe = async (
  endpoint: string,
  opts: { input: Record<string, unknown> },
) => {
  falCalls.push({ endpoint, input: opts.input });
  if (falShouldFail) throw new Error("simulated provider outage");
  const data = endpoint.includes("video")
    ? { video: { url: `https://fal.test/out/${falCalls.length}.mp4` } }
    : { images: [{ url: `https://fal.test/out/${falCalls.length}.png` }] };
  return { data, requestId: `req-${falCalls.length}` };
};

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
const bob: From = { id: 1002, is_bot: false, first_name: "Bob", username: "bob" };
const admin: From = { id: 9999, is_bot: false, first_name: "Admin", username: "admin" };

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

async function sendText(from: From, text: string): Promise<void> {
  const entities = text.startsWith("/")
    ? [{ offset: 0, length: text.split(/[\s@]/)[0].length, type: "bot_command" as const }]
    : undefined;
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    message: { ...baseMessage(from), text, ...(entities ? { entities } : {}) },
  });
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
}

async function payForPack(from: From, packId: string, stars: number): Promise<void> {
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    pre_checkout_query: {
      id: `pcq-${nextUpdateId}`,
      from,
      currency: "XTR",
      total_amount: stars,
      invoice_payload: `pack:${packId}`,
    },
  });
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    message: {
      ...baseMessage(from),
      successful_payment: {
        currency: "XTR",
        total_amount: stars,
        invoice_payload: `pack:${packId}`,
        telegram_payment_charge_id: `tpc-${nextUpdateId}`,
        provider_payment_charge_id: `ppc-${nextUpdateId}`,
      },
    },
  });
}

// ---------- db helpers ----------

function credits(userId: number): number {
  return (db.prepare("SELECT credits FROM users WHERE id = ?").get(userId) as { credits: number }).credits;
}
function ledgerCount(reason: string): number {
  return (db.prepare("SELECT COUNT(*) c FROM ledger WHERE reason = ?").get(reason) as { c: number }).c;
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

await step("signup: /start creates user with 3 free credits and shows the use-case menu", async () => {
  await sendText(alice, "/start");
  assert.equal(credits(alice.id), 3);
  assert.equal(ledgerCount("signup"), 1);
  assert.match(lastText(), /3 бесплатных кредита/);
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  for (const expected of ["menu:photoshoot", "menu:product", "menu:animate", "menu:text", "menu:balance", "menu:ref"]) {
    assert.ok(buttons.includes(expected), `menu misses ${expected}`);
  }
});

await step("text→image: prompt charges 1 credit, calls Seedream, delivers photo", async () => {
  await sendText(alice, "a red fox in the snow");
  assert.equal(falCalls.length, 1);
  assert.equal(falCalls[0].endpoint, "fal-ai/bytedance/seedream/v4/text-to-image");
  assert.equal(falCalls[0].input.prompt, "a red fox in the snow");
  assert.equal(calls("sendPhoto").length, 1);
  assert.equal(credits(alice.id), 2);
});

await step("photo→edit: action keyboard, prompt, Nano Banana edit charges 1 credit", async () => {
  await sendPhoto(alice, "photo-1");
  assert.match(lastText(), /Что сделать с этим фото/);
  await pressButton(alice, "act:photo_edit");
  assert.match(lastText(), /Опишите, что изменить/);
  await sendText(alice, "replace background with a Paris street");
  const edit = falCalls.at(-1)!;
  assert.equal(edit.endpoint, "fal-ai/nano-banana/edit");
  assert.deepEqual(edit.input.image_urls, [
    `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/photos/test.jpg`,
  ]);
  assert.equal(calls("getFile").length, 1);
  assert.equal(calls("sendPhoto").length, 2);
  assert.equal(credits(alice.id), 1);
});

await step("insufficient credits: animate (8 cr) with 1 cr is rejected, nothing charged", async () => {
  await sendPhoto(alice, "photo-2");
  await pressButton(alice, "act:animate");
  assert.match(lastText(), /Опишите движение/);
  const falBefore = falCalls.length;
  await sendText(alice, "slow zoom in");
  assert.equal(falCalls.length, falBefore);
  assert.match(lastText(), /Не хватает кредитов: «🎬 Оживление фото» стоит 8, у вас 1/);
  assert.equal(credits(alice.id), 1);
});

await step("purchase: /buy → invoice → pre-checkout → payment credits the pack", async () => {
  await sendText(alice, "/buy");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const packButtons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(packButtons, ["buy:mini", "buy:standard", "buy:pro"]);

  await pressButton(alice, "buy:mini");
  const invoice = calls("sendInvoice").at(-1)!.payload;
  assert.equal(invoice.currency, "XTR");
  assert.deepEqual(invoice.prices, [{ label: "Мини — 15 кредитов", amount: 150 }]);

  await payForPack(alice, "mini", 150);
  assert.equal(calls("answerPreCheckoutQuery").at(-1)!.payload.ok, true);
  assert.match(lastText(), /Начислено 15 кредитов/);
  assert.equal(credits(alice.id), 16);
  assert.equal(ledgerCount("purchase"), 1);
});

await step("pending action survives the paywall: motion prompt now renders Kling video (8 cr)", async () => {
  await sendText(alice, "slow zoom in, hair moving in the wind");
  const anim = falCalls.at(-1)!;
  assert.equal(anim.endpoint, "fal-ai/kling-video/v2.5-turbo/standard/image-to-video");
  assert.equal(anim.input.duration, "5");
  assert.ok((anim.input.image_url as string).startsWith("https://api.telegram.org/file/bot"));
  assert.equal(calls("sendVideo").length, 1);
  assert.equal(credits(alice.id), 8);
});

await step("provider failure: credits auto-refunded, error logged", async () => {
  falShouldFail = true;
  await sendText(alice, "another fox");
  falShouldFail = false;
  assert.match(lastText(), /кредиты автоматически возвращены/);
  assert.equal(credits(alice.id), 8);
  assert.equal(ledgerCount("refund"), 1);
  const gen = db
    .prepare("SELECT status FROM generations ORDER BY id DESC LIMIT 1")
    .get() as { status: string };
  assert.equal(gen.status, "error");
});

await step("referral: /start with payload links referrer; purchase pays 10% bonus", async () => {
  await sendText(bob, `/start ${alice.id}`);
  assert.equal(credits(bob.id), 3);
  await payForPack(bob, "standard", 450);
  assert.equal(credits(bob.id), 53);
  assert.equal(credits(alice.id), 13); // 8 + floor(50 * 0.10)
  assert.equal(ledgerCount("referral"), 1);
  const notify = calls("sendMessage")
    .filter((c) => c.payload.chat_id === alice.id)
    .at(-1)!;
  assert.match(notify.payload.text as string, /\+5 кредитов — ваш реферал купил пакет/);
});

await step("/ref: link carries the user id as start payload", async () => {
  await sendText(alice, "/ref");
  assert.match(lastText(), new RegExp(`t\\.me/${botInfo.username}\\?start=${alice.id}`));
});

await step("/stats: admin sees totals, non-admin gets silence", async () => {
  await sendText(admin, "/stats");
  const text = lastText();
  assert.match(text, /Users: 2/); // alice, bob (/stats does not register its caller)
  assert.match(text, /Paying: 2/);
  assert.match(text, /Generations: 4/); // 3 ok + 1 error
  assert.match(text, /Stars revenue: 600/);

  const before = calls("sendMessage").length;
  await sendText(alice, "/stats");
  assert.equal(calls("sendMessage").length, before);
});

await step("balance: /balance reflects the ledger", async () => {
  await sendText(alice, "/balance");
  assert.match(lastText(), /Баланс: 13 кредитов/);
});

await step("photoshoot preset: photo → menu:photoshoot → one tap renders via GPT Image 2 edit (4 cr)", async () => {
  await sendPhoto(alice, "photo-3");
  await pressButton(alice, "menu:photoshoot");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("preset:headshot"));
  assert.ok(!buttons.includes("preset:product_white"), "product presets leak into photo menu");
  await pressButton(alice, "preset:headshot");
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "openai/gpt-image-2/edit");
  assert.equal(call.input.quality, "high");
  assert.match(call.input.prompt as string, /corporate headshot/);
  assert.ok(Array.isArray(call.input.image_urls));
  assert.equal(credits(alice.id), 9); // 13 - 4

  // Every delivered result carries the next-step keyboard.
  const delivered = calls("sendPhoto").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const after = delivered.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(after, ["menu:styles", "menu:main"]);
});

await step("«ещё стиль»: the photo is remembered after a generation", async () => {
  await pressButton(alice, "menu:styles");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  assert.ok(kb.inline_keyboard.flat().some((b) => b.callback_data === "preset:cinematic"));
});

await step("/premium: premium text-to-image charges 4 credits via GPT Image 2", async () => {
  await sendText(alice, "/premium");
  assert.match(lastText(), /напишите запрос сразу после команды/);
  assert.equal(credits(alice.id), 9); // bare command charges nothing

  await sendText(alice, "/premium a perfume bottle on wet black marble");
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "fal-ai/gpt-image-2");
  assert.equal(call.input.quality, "high");
  assert.equal(call.input.prompt, "a perfume bottle on wet black marble");
  assert.equal(credits(alice.id), 5); // 9 - 4
});

await step("product flow: menu:product → photo → product preset renders (4 cr)", async () => {
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
  assert.equal(call.endpoint, "openai/gpt-image-2/edit");
  assert.match(call.input.prompt as string, /white studio background/);
  assert.equal(credits(alice.id), 1); // 5 - 4
});

console.log(`\nAll ${passed} steps passed. ✨  (db: ${process.env.DATABASE_PATH})`);
