import { createBot } from "./bot.js";

const bot = createBot();

bot.api.setMyCommands([
  { command: "start", description: "What this bot does" },
  { command: "premium", description: "💎 Premium image (GPT Image 2)" },
  { command: "buy", description: "Buy credits" },
  { command: "balance", description: "My balance" },
  { command: "ref", description: "Referral link (earn 10%)" },
]);

console.log("NeuroShot bot starting (long polling)…");
bot.start();
