import { createBot } from "./bot.js";

const bot = createBot();

bot.api.setMyCommands([
  { command: "menu", description: "📋 Меню — что создаём?" },
  { command: "premium", description: "💎 Премиум-картинка из текста" },
  { command: "buy", description: "💰 Купить кредиты" },
  { command: "balance", description: "Мой баланс" },
  { command: "ref", description: "🎁 Реферальная ссылка (10%)" },
  { command: "start", description: "Перезапустить бота" },
]);

console.log("NeuroShot bot starting (long polling)…");
bot.start();
