#!/usr/bin/env node
// Starts ONLY the Mini App web server (src/webapp.js `startWebApp`) — never
// calls `bot.start()`. This matters: with a fake BOT_TOKEN, `bot.start()`
// calls Telegram's real getMe/deleteWebhook, gets a real 401, and — since
// index.ts never awaits or catches that call — crashes the WHOLE process
// with an unhandled rejection, taking the webapp server down with it too
// (verified by actually running `npm start` with a dummy token: it prints
// "Mini App server on :PORT" and then dies ~2s later). Importing db.js/
// webapp.js directly and skipping bot.start()/setMyCommands/
// setChatMenuButton entirely sidesteps all of that — no real Telegram
// network call happens anywhere in this script.
//
// Usage: node .claude/skills/run-neuroshot-bot/webapp-only.mjs
// Prints a ready-to-use Bearer session token for a fake user, then blocks
// serving on $WEBAPP_PORT until killed (Ctrl-C / SIGTERM).

process.env.BOT_TOKEN ??= "1000000:DRIVER-FAKE-TOKEN";
process.env.FAL_KEY ??= "driver-fake-fal-key";
process.env.DATABASE_URL ??= "";
process.env.FREE_CREDITS ??= "12";
process.env.WEBAPP_URL ??= "http://localhost:8099";
process.env.WEBAPP_PORT ??= "8099";
process.env.BOT_USERNAME ??= "neuroshot_driver_bot";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const { initDb, getOrCreateUser } = await import(join(repoRoot, "src/db.js"));
const { startWebApp } = await import(join(repoRoot, "src/webapp.js"));
const { issueSession } = await import(join(repoRoot, "src/auth.js"));
const { config } = await import(join(repoRoot, "src/config.js"));

await initDb();
const FAKE_USER_ID = 1001;
await getOrCreateUser(FAKE_USER_ID, "driver_user", null, config.freeCredits);
const { token } = issueSession({ sub: FAKE_USER_ID, first_name: "Driver" }, config.botToken);

startWebApp();
console.log(`WEBAPP_READY port=${config.webappPort} token=${token}`);

process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));
