/**
 * End-to-end harness: drives the real bot (handlers, credit ledger, payments,
 * referrals, refunds) through grammY's update pipeline. Only the two network
 * edges are stubbed: outgoing Telegram Bot API calls (via an api transformer)
 * and fal.ai (via the fal singleton's `subscribe`).
 *
 * Run: npm run test:e2e
 */
import assert from "node:assert/strict";

// Env must be set before the app modules load (config/db read it at import time).
process.env.BOT_TOKEN = "1000000:TEST_TOKEN";
process.env.FAL_KEY = "test-fal-key";
// Force hermetic embedded pglite: clear any DATABASE_URL from the dev's shell/.env
// so the suite never runs against (and mutates) a real Postgres.
process.env.DATABASE_URL = "";
process.env.FREE_CREDITS = "12"; // enough headroom for the multi-step journey below
process.env.ADMIN_IDS = "9999";

const { fal } = await import("@fal-ai/client");
const { createBot } = await import("../src/bot.js");
const { funnel, query, getUser } = await import("../src/db.js");
const { nUnits } = await import("../src/text.js");

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

async function credits(userId: number): Promise<number> {
  return (await getUser(userId))!.credits;
}
async function ledgerCount(reason: string): Promise<number> {
  const rows = await query("SELECT COUNT(*)::int AS c FROM ledger WHERE reason = $1", [reason]);
  return Number(rows[0].c);
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

await step("signup: /start creates user with 12 free 🔫 and shows the use-case menu", async () => {
  await sendText(alice, "/start");
  assert.equal(await credits(alice.id), 12);
  assert.equal(await ledgerCount("signup"), 1);
  // Main menu ships as a hero photo carrying the welcome caption + keyboard.
  const hero = calls("sendPhoto").at(-1)!;
  assert.match(hero.payload.caption as string, /начислено.*12 патронов/);
  const kb = hero.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  for (const expected of ["menu:photoshoot", "menu:product", "menu:animate", "menu:text", "menu:balance", "menu:ref"]) {
    assert.ok(buttons.includes(expected), `menu misses ${expected}`);
  }
});

await step("text→image: prompt charges 2 🔫, calls Seedream, delivers photo (menu-only keyboard)", async () => {
  await sendText(alice, "a red fox in the snow");
  assert.equal(falCalls.length, 1);
  assert.equal(falCalls[0].endpoint, "fal-ai/bytedance/seedream/v4/text-to-image");
  assert.equal(falCalls[0].input.prompt, "a red fox in the snow");
  assert.equal(resultPhotos().length, 1);
  assert.equal(await credits(alice.id), 10); // 12 − 2
  // No source photo → «Ещё стиль» must NOT appear (Copilot: it would dead-end).
  const kb = resultPhotos().at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  assert.deepEqual(kb.inline_keyboard.flat().map((b) => b.callback_data), ["menu:main"]);
});

await step("photo→edit: action keyboard, prompt, Nano Banana edit charges 3 🔫", async () => {
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
  assert.equal(resultPhotos().length, 2);
  assert.equal(await credits(alice.id), 7); // 10 − 3
});

await step("insufficient 🔫: animate (25) with 7 is rejected, nothing charged", async () => {
  await sendPhoto(alice, "photo-2");
  await pressButton(alice, "act:animate");
  assert.match(lastText(), /Опишите движение/);
  const falBefore = falCalls.length;
  await sendText(alice, "slow zoom in");
  assert.equal(falCalls.length, falBefore);
  assert.match(lastText(), /Не хватает 🔫: «🎬 Оживление фото» стоит 25 патронов, у вас 7 патронов/);
  assert.equal(await credits(alice.id), 7);
});

await step("purchase: /buy → invoice → pre-checkout → payment credits the pack", async () => {
  await sendText(alice, "/buy");
  const kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const packButtons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(packButtons, ["buy:start", "buy:popular", "buy:pro", "buy:studio"]);

  await pressButton(alice, "buy:popular");
  const invoice = calls("sendInvoice").at(-1)!.payload;
  assert.equal(invoice.currency, "XTR");
  assert.deepEqual(invoice.prices, [{ label: "Популярный — 200 🔫", amount: 2200 }]);

  await payForPack(alice, "popular", 2200);
  assert.equal(calls("answerPreCheckoutQuery").at(-1)!.payload.ok, true);
  assert.match(lastText(), /Начислено 🔫 200 патронов/);
  assert.equal(await credits(alice.id), 207); // 7 + 200
  assert.equal(await ledgerCount("purchase"), 1);
});

await step("pending action survives the paywall: motion prompt now renders Kling video (25 🔫)", async () => {
  await sendText(alice, "slow zoom in, hair moving in the wind");
  const anim = falCalls.at(-1)!;
  assert.equal(anim.endpoint, "fal-ai/kling-video/v2.5-turbo/standard/image-to-video");
  assert.equal(anim.input.duration, "5");
  assert.ok((anim.input.image_url as string).startsWith("https://api.telegram.org/file/bot"));
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

await step("referral: link gives friend a join bonus; first purchase pays inviter bonus + 10%", async () => {
  await sendText(bob, `/start ${alice.id}`);
  assert.equal(await credits(bob.id), 15); // 12 free + 3 join bonus
  assert.equal(await ledgerCount("referral_join"), 1);

  await payForPack(bob, "popular", 2200);
  assert.equal(await credits(bob.id), 215); // 15 + 200
  // alice: 182 + first-purchase bonus (10) + lifetime floor(200 * 0.10) = 20
  assert.equal(await credits(alice.id), 212);
  assert.equal(await ledgerCount("referral"), 1); // lifetime share
  assert.equal(await ledgerCount("referral_bonus"), 1); // one-time first purchase

  const notify = calls("sendMessage")
    .filter((c) => c.payload.chat_id === alice.id)
    .at(-1)!;
  assert.match(notify.payload.text as string, /первую покупку/);
  assert.match(notify.payload.text as string, /\+20 патронов/);
});

await step("/ref: dashboard shows stats + the invite link with the user id", async () => {
  await sendText(alice, "/ref");
  assert.match(lastText(), new RegExp(`t\\.me/${botInfo.username}\\?start=${alice.id}`));
  assert.match(lastText(), /Приглашено: <b>1<\/b>/); // bob
  assert.match(lastText(), /покупают: <b>1<\/b>/); // bob bought
});

await step("/stats: admin sees totals, non-admin gets silence", async () => {
  await sendText(admin, "/stats");
  const text = lastText();
  assert.match(text, /Users: 2/); // alice, bob (/stats does not register its caller)
  assert.match(text, /Paying: 2/);
  assert.match(text, /Generations: 4/); // 3 ok + 1 error
  assert.match(text, /Stars revenue: 4400/); // alice popular 2200 + bob popular 2200

  const before = calls("sendMessage").length;
  await sendText(alice, "/stats");
  assert.equal(calls("sendMessage").length, before);
});

await step("balance: /balance reflects the ledger", async () => {
  await sendText(alice, "/balance");
  assert.match(lastText(), /Баланс: 🔫 212 патронов/);
});

await step("photoshoot preset: photo → menu:photoshoot → one tap renders via GPT Image 2 edit (11 🔫)", async () => {
  await sendPhoto(alice, "photo-3");
  const albumsBefore = calls("sendMediaGroup").length;
  await pressButton(alice, "menu:photoshoot");
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
  assert.equal(call.endpoint, "openai/gpt-image-2/edit");
  assert.equal(call.input.quality, "high");
  assert.match(call.input.prompt as string, /corporate headshot/);
  assert.ok(Array.isArray(call.input.image_urls));
  assert.equal(await credits(alice.id), 201); // 212 - 11

  // Every delivered result carries the next-step keyboard.
  const delivered = resultPhotos().at(-1)!.payload.reply_markup as {
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

await step("/premium: premium text-to-image charges 11 🔫 via GPT Image 2", async () => {
  await sendText(alice, "/premium");
  assert.match(lastText(), /напишите запрос сразу после команды/);
  assert.equal(await credits(alice.id), 201); // bare command charges nothing

  await sendText(alice, "/premium a perfume bottle on wet black marble");
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "fal-ai/gpt-image-2");
  assert.equal(call.input.quality, "high");
  assert.equal(call.input.prompt, "a perfume bottle on wet black marble");
  assert.equal(await credits(alice.id), 190); // 201 - 11
});

await step("product flow: menu:product → photo → product preset renders (11 🔫)", async () => {
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
  assert.equal(await credits(alice.id), 179); // 190 - 11
});

await step("mode escape: menu:main clears a photo mode so text→image works again", async () => {
  await sendText(carol, "/start");
  await pressButton(carol, "menu:photoshoot"); // no photo yet → enters mode_photo, asks for a photo
  const falBefore = falCalls.length;
  await sendText(carol, "just text without a photo"); // blocked by the mode guard (correct)
  assert.equal(falCalls.length, falBefore);
  assert.match(lastText(), /Пришлите фото/);

  await pressButton(carol, "menu:main"); // escape the mode (Copilot fix)
  await sendText(carol, "a blue cat"); // now a normal text-to-image prompt
  assert.equal(falCalls.length, falBefore + 1);
  assert.equal(falCalls.at(-1)!.endpoint, "fal-ai/bytedance/seedream/v4/text-to-image");
  assert.equal(falCalls.at(-1)!.input.prompt, "a blue cat");
});

await step("🔫 pluralization: Russian declension is correct across cases", async () => {
  await sendText(carol, "/balance");
  assert.match(lastText(), /Баланс: 🔫 10 патронов/); // carol: 12 free − 2 for "a blue cat"
  assert.equal(nUnits(1), "1 патрон");
  assert.equal(nUnits(2), "2 патрона");
  assert.equal(nUnits(5), "5 патронов");
  assert.equal(nUnits(11), "11 патронов"); // 11–14 → genitive plural
  assert.equal(nUnits(21), "21 патрон");
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
  assert.equal(call.input.prompt, "cyberpunk cat");
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
  assert.equal(call.endpoint, "fal-ai/bytedance/seedance-2.0/image-to-video"); // verified fal endpoint
  assert.ok((call.input.image_url as string).startsWith("https://api.telegram.org/file/bot"));
  assert.equal(call.input.duration, "5");
  assert.equal(call.input.resolution, "720p");
  assert.equal(await credits(dave.id), 428); // 504 − 76
});

await step("referral milestone: 3 PAYING friends trigger the tier bonus, awarded once", async () => {
  const patron: From = { id: 2001, is_bot: false, first_name: "Patron", username: "patron" };
  await sendText(patron, "/start"); // 12 free
  for (const fid of [2101, 2102, 2103]) {
    const f: From = { id: fid, is_bot: false, first_name: `F${fid}`, username: `f${fid}` };
    await sendText(f, `/start ${patron.id}`); // joins via patron's link (friend gets join bonus)
    await payForPack(f, "start", 720); // buys → becomes a paying friend
  }
  // Per paying friend patron earns first-purchase(10) + lifetime floor(60*0.10)=6 = 16.
  // On the 3rd, the 3-friends milestone (+20) fires. 12 + 3*16 + 20 = 80.
  assert.equal(await credits(patron.id), 80);
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
  await sendText(freeloader, "a lonely lighthouse"); // …generates on free 🔫, never pays
  assert.equal(await credits(host.id), before); // inviter earned nothing (no purchase)
});

console.log(`\nAll ${passed} steps passed. ✨  (db: ${process.env.DATABASE_URL || "embedded (pglite)"})`);
