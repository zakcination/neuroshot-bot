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
process.env.PARTNER_WELCOME = "180"; // ≈$20 welcome bonus (spend-only)
process.env.WITHDRAW_MIN = "20"; // low so the withdrawal path is exercisable

const { fal } = await import("@fal-ai/client");
const { createBot } = await import("../src/bot.js");
const { funnel, query, getUser, logGeneration, partnerAccount } = await import("../src/db.js");
const { buildDigest, checkAlerts } = await import("../src/monitor.js");
const { nUnits, nResults } = await import("../src/text.js");

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
  assert.ok((falCalls[0].input.prompt as string).startsWith("a red fox in the snow. "), "craft mapping missing");
  assert.match(falCalls[0].input.prompt as string, /Avoid garbled text/);
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
  assert.match(wall.payload.text as string, /🎬 Оживление фото/);
  assert.match(wall.payload.text as string, /Старт/); // entry pack anchored
  const kb = wall.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("buy:start"), "entry-pack CTA missing"); // one dominant CTA
  assert.ok(buttons.includes("show_packs"), "all-packs fallback missing");
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

await step("photoshoot preset: photo → menu:photoshoot → one tap renders via Nano Banana 2 edit (4 🔫)", async () => {
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
  assert.equal(call.endpoint, "fal-ai/nano-banana-2/edit"); // best price/quality preset engine
  assert.match(call.input.prompt as string, /corporate headshot/);
  assert.ok(Array.isArray(call.input.image_urls));
  assert.equal(await credits(alice.id), 208); // 212 - 4

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
  assert.equal(await credits(alice.id), 208); // bare command charges nothing

  await sendText(alice, "/premium a perfume bottle on wet black marble");
  const call = falCalls.at(-1)!;
  assert.equal(call.endpoint, "fal-ai/gpt-image-2");
  assert.equal(call.input.quality, "high");
  assert.ok((call.input.prompt as string).startsWith("a perfume bottle on wet black marble. "));
  assert.equal(await credits(alice.id), 197); // 208 - 11
});

await step("product flow: menu:product → photo → product preset renders (4 🔫)", async () => {
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
  assert.equal(call.endpoint, "fal-ai/nano-banana-2/edit");
  assert.match(call.input.prompt as string, /white studio background/);
  assert.equal(await credits(alice.id), 193); // 197 - 4
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

await step("partner program: admin creates a code; c_<code> joins get the gift; purchases pay the custom %", async () => {
  const mentor: From = { id: 4001, is_bot: false, first_name: "Mentor", username: "mentor" };
  await sendText(mentor, "/start"); // 12 free
  await sendText(admin, "/partner_add mentor 4001 25 10 Курс Ментора");
  assert.match(lastText(), /c_mentor/);

  const student: From = { id: 4101, is_bot: false, first_name: "Student", username: "student" };
  await sendText(student, `/start c_mentor`);
  assert.equal(await credits(student.id), 22); // 12 free + 10 partner gift
  assert.equal(await ledgerCount("partner_join"), 1);
  const greet = calls("sendPhoto").at(-1)!;
  assert.match(greet.payload.caption as string, /подарок от Курс Ментора/);

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
  await payForPack(parent, "start", 720); // +60 → 72

  await pressButton(parent, "menu:campaigns");
  let kb = calls("sendMessage").at(-1)!.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const camps = kb.inline_keyboard.flat().map((b) => b.callback_data);
  for (const c of ["camp:skazka", "camp:cartoon", "camp:worldcup", "camp:oldphoto", "camp:poster", "camp:minifilm"]) {
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
  assert.equal(gen.endpoint, "fal-ai/nano-banana-2/edit"); // default preset engine
  assert.match(gen.input.prompt as string, /fairy tale/i);
  assert.equal(await credits(parent.id), 68); // 72 − 4
  const resultUrl = `https://fal.test/out/${falCalls.length}.png`;
  assert.match(lastText(), /оживить результат/i); // upsell offered

  await pressButton(parent, "camv:skazka");
  const anim = falCalls.at(-1)!;
  assert.equal(anim.endpoint, "fal-ai/kling-video/v3/pro/image-to-video"); // Kling 3.0 default video
  assert.equal(anim.input.start_image_url, resultUrl); // animates the RESULT, not the original photo
  assert.match(anim.input.prompt as string, /fireflies/i); // canned campaign motion prompt
  assert.equal(await credits(parent.id), 26); // 68 − 42
});

await step("мини-фильм campaign: NB2 film still → Seedance 2.0 Fast multi-shot upsell (65 🔫 flow)", async () => {
  const actor: From = { id: 5502, is_bot: false, first_name: "Actor", username: "actor" };
  await sendText(actor, "/start"); // 12 free
  await payForPack(actor, "popular", 2200); // +200 → 212

  await pressButton(actor, "camp:minifilm");
  await sendPhoto(actor, "actor-1");
  await pressButton(actor, "cpre:minifilm:drama");
  const still = falCalls.at(-1)!;
  assert.equal(still.endpoint, "fal-ai/nano-banana-2/edit");
  assert.match(still.input.prompt as string, /film still/i);
  assert.equal(await credits(actor.id), 208); // 212 − 4
  const stillUrl = `https://fal.test/out/${falCalls.length}.png`;

  await pressButton(actor, "camv:minifilm");
  const clip = falCalls.at(-1)!;
  assert.equal(clip.endpoint, "bytedance/seedance-2.0/fast/image-to-video"); // story model
  assert.equal(clip.input.image_url, stillUrl); // animates the generated still
  assert.match(clip.input.prompt as string, /multi-shot/i);
  assert.equal(await credits(actor.id), 147); // 208 − 61
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
  // Spend below a preset's 4 🔫 via text→image (which never uses the free-first path).
  for (const p of ["a cat", "a dog", "a fox", "a bee", "an owl"]) await sendText(nora, p); // 5×−2
  assert.equal(await credits(nora.id), 2);

  await sendPhoto(nora, "nora-1");
  await pressButton(nora, "menu:photoshoot");
  const falBefore = falCalls.length;
  await pressButton(nora, "preset:headshot"); // 4 > 2 → the first result is on us
  assert.equal(falCalls.length, falBefore + 1); // it DID render (no wall before the wow)
  assert.equal(await credits(nora.id), 2); // …and charged nothing
  assert.match(lastText(), /Первый результат — бесплатно/);
  assert.equal(await ledgerCount("refund"), 1); // free render ≠ a refund (still just alice's)

  // The freebie is one-time: the second preset now hits the sales-page paywall.
  const falBefore2 = falCalls.length;
  await pressButton(nora, "preset:cinematic");
  assert.equal(falCalls.length, falBefore2); // no render
  assert.match(lastText(), /Ещё один шаг до результата/);
  assert.equal(await credits(nora.id), 2); // still nothing charged
});

await step("recurring reason: a returning /start surfaces the weekly новинка + continue-with-photo", async () => {
  const { featuredCampaign } = await import("../src/models.js");
  const feat = featuredCampaign(new Date());
  // Nora is a returning user who still has a photo on file from the preset flow above.
  await sendText({ id: 6001, is_bot: false, first_name: "Nora", username: "nora" }, "/start");
  const hero = calls("sendPhoto").at(-1)!; // the returning menu ships on the hero photo
  assert.match(hero.payload.caption as string, /Новинка недели/);
  const kb = hero.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  const buttons = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes(`camp:${feat.id}`), "featured campaign button missing");
  assert.ok(buttons.includes("menu:styles"), "continue-with-photo shortcut missing");
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

await step("partner v2: join → welcome (spend-only) + code; invitee pays → 15% withdrawable cashback", async () => {
  const prt: From = { id: 8001, is_bot: false, first_name: "Prt", username: "prt" };
  await sendText(prt, "/start"); // 12 free
  await pressButton(prt, "partner:join");
  const acct0 = await partnerAccount(prt.id);
  assert.equal(acct0.joined, true);
  assert.equal(acct0.activeCodes, 1); // first code minted on join
  assert.equal(await credits(prt.id), 12 + 180); // free + welcome bonus
  assert.equal(acct0.withdrawable, 0); // welcome is NOT withdrawable

  // a second join press must NOT double-grant
  await pressButton(prt, "partner:join");
  assert.equal(await credits(prt.id), 192);
  assert.equal((await partnerAccount(prt.id)).activeCodes, 1);

  const code = String(
    (await query("SELECT code FROM partner_codes WHERE user_id=$1 AND kind='partner' LIMIT 1", [prt.id]))[0].code,
  );
  assert.match(code, /^[a-z0-9]{6}$/);

  // invitee joins via p_<code> → gets the invitee bonus, attributed first-touch
  const inv: From = { id: 8101, is_bot: false, first_name: "Inv", username: "inv" };
  await sendText(inv, `/start p_${code}`);
  assert.equal(await credits(inv.id), 12 + 5); // free + partnerInviteeBonus
  assert.equal(String((await getUser(inv.id))!.partner_code), code);

  // invitee pays → partner earns 15% cashback, added to BOTH balances
  await payForPack(inv, "popular", 2200); // 200 🔫 → floor(200*0.15)=30
  const acct1 = await partnerAccount(prt.id);
  assert.equal(acct1.paying, 1);
  assert.equal(acct1.withdrawable, 30); // withdrawable cashback
  assert.equal(await credits(prt.id), 192 + 30); // also spendable
  const notify = calls("sendMessage").filter((c) => c.payload.chat_id === prt.id).at(-1)!;
  assert.match(notify.payload.text as string, new RegExp(`кэшбэка.*p_${code}`));
});

await step("partner v2: withdrawal drains only withdrawable+credits; admin resolves; reject refunds", async () => {
  const prt = { id: 8001 };
  await pressButton({ id: 8001, is_bot: false, first_name: "Prt" }, "partner:withdraw"); // withdrawable 30 ≥ 20
  const acct = await partnerAccount(prt.id);
  assert.equal(acct.withdrawable, 0); // moved into the request
  assert.equal(await credits(prt.id), 192); // 222 − 30 drained from spendable too

  const wid = Number(
    (await query("SELECT id FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [prt.id]))[0].id,
  );
  await sendText(admin, "/payouts");
  assert.match(lastText(), /Заявки на вывод/);
  assert.match(lastText(), new RegExp(`№${wid}`));

  // reject → 🔫 refunded to both balances
  await sendText(admin, `/payout ${wid} no`);
  assert.match(lastText(), /отклонена/);
  assert.equal((await partnerAccount(prt.id)).withdrawable, 30);
  assert.equal(await credits(prt.id), 222);
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
  await pressButton(cap, "partner:join"); // 1 code
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
  assert.match(text, /Оплат: <b>\d+<\/b> на <b>⭐\d+<\/b>/);
  assert.match(text, /c_mentor: \d+/); // payers split by source
  assert.match(text, /маржа <b>\d+%<\/b>/);
  assert.match(text, /Обязательства: <b>\d+ 🔫<\/b>/);

  const digest = await buildDigest(24);
  assert.ok(digest.stars > 0, "test journey produced purchases");
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

console.log(`\nAll ${passed} steps passed. ✨  (db: ${process.env.DATABASE_URL || "embedded (pglite)"})`);
