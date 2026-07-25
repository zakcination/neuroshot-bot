import { createBot } from "./bot.js";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { drainRenders } from "./generate.js";
import { startMonitor } from "./monitor.js";
import { setLivenessProbe, startWebApp } from "./webapp.js";
import { UNIT_EMOJI } from "./text.js";

await initDb(); // create the Postgres schema before serving

const bot = createBot();

// CEO monitoring: daily digest to admins + exception alerts (docs/monitoring.md).
startMonitor((chatId, text) => bot.api.sendMessage(chatId, text, { parse_mode: "HTML" }), bot.api);

// Fire-and-forget, but NEVER unhandled: a rejected promise with no catch is
// an unhandled rejection, which terminates the process on modern Node.
// Failing to set the command list is cosmetic and must not take the bot down.
void bot.api.setMyCommands([
  { command: "menu", description: "📋 Меню — что создаём?" },
  { command: "app", description: "🌐 Открыть приложение" },
  { command: "premium", description: "💎 Премиум-картинка из текста" },
  { command: "buy", description: `💰 Купить патроны ${UNIT_EMOJI}` },
  { command: "balance", description: "Мой баланс" },
  { command: "ref", description: "🎁 Реферальная ссылка (10%)" },
  { command: "partner", description: "🤝 Партнёрам и авторам" },
  { command: "delete_me", description: "🗑 Удалить мои данные" },
  { command: "start", description: "Перезапустить бота" },
]).catch((e) => console.error("setMyCommands failed:", e));

// Set the persistent chat menu button to launch the Mini App when configured.
if (config.webappUrl) {
  bot.api
    .setChatMenuButton({
      menu_button: { type: "web_app", text: "🌐 Приложение", web_app: { url: config.webappUrl } },
    })
    .catch((e) => console.error("setChatMenuButton failed:", e));
}

// Shared web layer (Telegram Mini App) — only runs if WEBAPP_URL is set.
// The health check must reflect the BOT, not just the socket: both live in this
// one process, so an HTTP 200 while polling is dead is a green light over an
// outage. Reporting unhealthy is what gets the machine restarted.
// A deliberate shutdown also stops polling, and that is not a fault — the
// machine is on its way out anyway. Only report unhealthy when polling died
// while we still intended to be serving.
setLivenessProbe(() => shuttingDown || bot.isRunning());
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
// If polling ever fails to start or dies, EXIT so the platform restarts us.
// bot.catch() does not cover this: it handles errors raised inside update
// handlers, not a failure of the fetch loop itself. Without this the promise
// rejects unobserved, the HTTP server keeps the process alive, and the bot is
// silently down while every external signal still reads healthy.
bot.start().catch((e) => {
  console.error("long polling stopped — exiting so the platform restarts:", e);
  process.exit(1);
});
