import { createBot } from "./bot.js";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { drainRenders } from "./generate.js";
import { startMonitor } from "./monitor.js";
import { startWebApp } from "./webapp.js";
import { UNIT_EMOJI } from "./text.js";

await initDb(); // create the Postgres schema before serving

const bot = createBot();

// CEO monitoring: daily digest to admins + exception alerts (docs/monitoring.md).
startMonitor((chatId, text) => bot.api.sendMessage(chatId, text, { parse_mode: "HTML" }), bot.api);

bot.api.setMyCommands([
  { command: "menu", description: "📋 Меню — что создаём?" },
  { command: "app", description: "🌐 Открыть приложение" },
  { command: "premium", description: "💎 Премиум-картинка из текста" },
  { command: "buy", description: `💰 Купить патроны ${UNIT_EMOJI}` },
  { command: "balance", description: "Мой баланс" },
  { command: "ref", description: "🎁 Реферальная ссылка (10%)" },
  { command: "partner", description: "🤝 Партнёрам и авторам" },
  { command: "delete_me", description: "🗑 Удалить мои данные" },
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

// Graceful shutdown: stop polling, then let detached render tails finish (deliver
// or refund) before exit, so a routine deploy/recycle doesn't strand in-flight
// renders. The reaper is the backstop for anything a hard kill still drops.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — stopping bot and draining renders…`);
  try {
    await bot.stop();
    // Renders take 1–3 min, so wait comfortably past that for in-flight tails to
    // deliver/refund (the platform's kill_timeout must be ≥ this — see fly.toml —
    // and the reaper is the backstop if a hard kill still cuts it short).
    await drainRenders(180_000);
  } finally {
    process.exit(0);
  }
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

console.log("NeuroShot bot starting (long polling)…");
bot.start();
