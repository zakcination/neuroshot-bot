import { createBot } from "./bot.js";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { startWebApp } from "./webapp.js";

await initDb(); // create the Postgres schema before serving

const bot = createBot();

bot.api.setMyCommands([
  { command: "menu", description: "📋 Меню — что создаём?" },
  { command: "app", description: "🌐 Открыть приложение" },
  { command: "premium", description: "💎 Премиум-картинка из текста" },
  { command: "buy", description: "💰 Купить кредиты" },
  { command: "balance", description: "Мой баланс" },
  { command: "ref", description: "🎁 Реферальная ссылка (10%)" },
  { command: "start", description: "Перезапустить бота" },
]);

// Set the persistent chat menu button to launch the Mini App when configured.
if (config.webappUrl) {
  bot.api
    .setChatMenuButton({
      menu_button: { type: "web_app", text: "🌐 Приложение", web_app: { url: config.webappUrl } },
    })
    .catch((e) => console.error("setChatMenuButton failed:", e));
}

// Shared web layer (Telegram Mini App) — only runs if WEBAPP_URL is set.
startWebApp();

console.log("NeuroShot bot starting (long polling)…");
bot.start();
