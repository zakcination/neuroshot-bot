#!/usr/bin/env node
// Bot-logic driver: feeds fabricated Telegram Updates straight into the real
// bot (grammY's handleUpdate), with the Bot API and fal.ai calls stubbed out —
// the exact pattern test/e2e.ts uses, repackaged as an interactive/scriptable
// REPL instead of a fixed test sequence. No real network, no real BOT_TOKEN
// needed. State (credits ledger, users) lives in an in-memory pglite instance
// for the lifetime of this ONE process — restarting the driver resets it.
//
// Usage:
//   node .claude/skills/run-neuroshot-bot/driver.mjs <<'EOF'
//   msg 1001 /start
//   cb 1001 menu:photoshoot
//   photo 1001
//   cb 1001 preset:headshot
//   credits 1001
//   EOF
//
// Commands (one per line, space-separated):
//   msg <userId> <text...>     simulate a text message (first token starting
//                              with "/" is treated as a bot command)
//   photo <userId> [fileId]    simulate sending a photo
//   cb <userId> <data>         simulate a callback-query (inline button tap)
//   credits <userId>           print the user's current patron balance
//   raw                       dump every intercepted Bot API call so far, as JSON
//   quit                       exit
//
// After every msg/photo/cb command, the driver prints every Bot API call made
// in response (sendMessage text, sendPhoto, buttons) since the previous
// command, as readable lines — this IS the bot's "reply".

// Env must be set BEFORE the app modules load (config.ts/db.ts read it at
// import time) — and since static `import` declarations evaluate before any
// top-level statement in this file regardless of source order, every app
// module below is loaded via dynamic `import()` (same trick test/e2e.ts uses).
process.env.BOT_TOKEN ??= "1000000:DRIVER-FAKE-TOKEN";
process.env.FAL_KEY ??= "driver-fake-fal-key";
process.env.DATABASE_URL ??= ""; // force embedded pglite — never touch a real DB
process.env.FREE_CREDITS ??= "12";
process.env.ADMIN_IDS ??= "9999";
process.env.KASPI_PAY_URL ??= "https://pay.test/neuroshot"; // enables the buy flow
process.env.WITHDRAW_MIN ??= "20";

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const { fal } = await import("@fal-ai/client");
const { createBot } = await import(join(repoRoot, "src/bot.js"));
const { drainRenders } = await import(join(repoRoot, "src/generate.js"));
const { getUser } = await import(join(repoRoot, "src/db.js"));

// ---- fal.ai stub: every generation "succeeds" instantly with a fake asset URL ----
let falN = 0;
(fal).subscribe = async (endpoint, opts) => {
  falN++;
  const isVideo = endpoint.includes("video") || endpoint.includes("kling") || endpoint.includes("seedance") || endpoint.includes("hailuo");
  const data = isVideo
    ? { video: { url: `https://fal.test/out/${falN}.mp4` } }
    : { images: [{ url: `https://fal.test/out/${falN}.png` }] };
  return { data, requestId: `driver-req-${falN}` };
};

// ---- Bot API stub: intercept every outgoing call, never touch real Telegram ----
const botInfo = {
  id: 424242,
  is_bot: true,
  first_name: "NeuroShot",
  username: "neuroshot_driver_bot",
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
const apiCalls = [];
let nextMsgId = 5000;
function stubMessage(payload) {
  return {
    message_id: nextMsgId++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: payload.chat_id ?? 0, type: "private", first_name: "driver" },
    text: payload.text ?? "",
  };
}
bot.api.config.use(async (_prev, method, payload) => {
  apiCalls.push({ method, payload });
  let result;
  switch (method) {
    case "getFile":
      result = { file_id: "f", file_unique_id: "fu", file_path: "photos/driver-test.jpg" };
      break;
    case "deleteMessage":
    case "answerCallbackQuery":
    case "answerPreCheckoutQuery":
    case "setMyCommands":
    case "setChatMenuButton":
      result = true;
      break;
    case "sendMediaGroup": {
      const media = payload.media ?? [];
      result = media.map(() => stubMessage(payload));
      break;
    }
    default:
      result = stubMessage(payload);
  }
  return { ok: true, result };
});

let nextUpdateId = 1;
function baseMessage(userId) {
  return {
    message_id: 100 + nextUpdateId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: userId, type: "private", first_name: "Driver", username: `driver${userId}` },
    from: { id: userId, is_bot: false, first_name: "Driver", username: `driver${userId}` },
  };
}

async function send(userId, text) {
  const entities = text.startsWith("/")
    ? [{ offset: 0, length: text.split(/[\s@]/)[0].length, type: "bot_command" }]
    : undefined;
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    message: { ...baseMessage(userId), text, ...(entities ? { entities } : {}) },
  });
  await drainRenders();
}

async function sendPhoto(userId, fileId) {
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    message: {
      ...baseMessage(userId),
      photo: [
        { file_id: `${fileId}-small`, file_unique_id: `${fileId}-s`, width: 90, height: 90 },
        { file_id: fileId, file_unique_id: `${fileId}-l`, width: 1280, height: 1280 },
      ],
    },
  });
  await drainRenders();
}

async function pressButton(userId, data) {
  await bot.handleUpdate({
    update_id: nextUpdateId++,
    callback_query: {
      id: `cbq-${nextUpdateId}`,
      from: { id: userId, is_bot: false, first_name: "Driver" },
      chat_instance: `ci-${userId}`,
      message: { ...baseMessage(userId), text: "…" },
      data,
    },
  });
  await drainRenders();
}

function printReplies(since) {
  const replies = apiCalls.slice(since);
  if (!replies.length) {
    console.log("  (no bot API calls — no reply)");
    return;
  }
  for (const c of replies) {
    if (c.method === "sendMessage" || c.method === "sendPhoto" || c.method === "sendVideo") {
      const label = c.method === "sendMessage" ? "text" : c.method.replace("send", "").toLowerCase();
      const text = c.payload.text ?? c.payload.caption ?? "";
      const kb = c.payload.reply_markup?.inline_keyboard
        ?.flat()
        .map((b) => `[${b.text}${b.callback_data ? " -> " + b.callback_data : ""}]`)
        .join(" ");
      console.log(`  <- ${c.method} (${label}): ${text.slice(0, 300).replace(/\n/g, " ⏎ ")}`);
      if (kb) console.log(`     buttons: ${kb}`);
    } else if (c.method === "sendMediaGroup") {
      // payload.media items carry InputFile instances for local assets —
      // grammY's InputFile.toJSON() deliberately throws on JSON.stringify
      // (it's meant to go out as multipart, not JSON), so describe it instead.
      const n = c.payload.media?.length ?? 0;
      console.log(`  <- sendMediaGroup: album of ${n} item(s)`);
    } else {
      // Defensive: any other method might also carry an InputFile — never let
      // a formatting bug here crash the driver mid-script.
      try {
        console.log(`  <- ${c.method}: ${JSON.stringify(c.payload).slice(0, 200)}`);
      } catch {
        console.log(`  <- ${c.method}: (payload contains a non-serializable InputFile — keys: ${Object.keys(c.payload).join(", ")})`);
      }
    }
  }
}

console.log("neuroshot-bot driver ready — commands: msg/photo/cb/credits/raw/quit");
const rl = createInterface({ input: process.stdin, terminal: false });

// `for await` pulls one line at a time from readline's async iterator, so each
// command's awaits (drainRenders etc.) fully resolve before the next line is
// even read — a plain `rl.on("line", async ...)` does NOT wait for the async
// handler, so piped multi-line input (the whole point of this driver) would
// race every command concurrently and "quit" could exit before earlier
// commands finished. Learned this the hard way running it the first time.
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const [cmd, ...rest] = trimmed.split(" ");
  const before = apiCalls.length;
  try {
    if (cmd === "msg") {
      const userId = Number(rest[0]);
      const text = rest.slice(1).join(" ");
      console.log(`> msg ${userId}: ${text}`);
      await send(userId, text);
      printReplies(before);
    } else if (cmd === "photo") {
      const userId = Number(rest[0]);
      const fileId = rest[1] ?? "driver-photo-1";
      console.log(`> photo ${userId} (${fileId})`);
      await sendPhoto(userId, fileId);
      printReplies(before);
    } else if (cmd === "cb") {
      const userId = Number(rest[0]);
      const data = rest[1];
      console.log(`> cb ${userId}: ${data}`);
      await pressButton(userId, data);
      printReplies(before);
    } else if (cmd === "credits") {
      const userId = Number(rest[0]);
      const u = await getUser(userId);
      console.log(`  credits(${userId}) = ${u ? u.credits : "(no such user — send /start first)"}`);
    } else if (cmd === "raw") {
      console.log(JSON.stringify(apiCalls, null, 2));
    } else if (cmd === "quit" || cmd === "exit") {
      break;
    } else {
      console.log(`  unknown command: ${cmd}`);
    }
  } catch (e) {
    console.error(`  ERROR: ${e?.stack ?? e}`);
  }
}
process.exit(0);
