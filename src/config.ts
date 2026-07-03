import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  falKey: required("FAL_KEY"),
  // Postgres selection is read directly from process.env.DATABASE_URL in db.ts
  // (db.ts stays importable without the bot's required env, so it doesn't depend
  // on this config). Neon in prod; unset → embedded pglite for tests/local.
  freeCredits: Number(process.env.FREE_CREDITS ?? 3),
  adminIds: (process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  // Telegram Mini App (web layer). Public HTTPS URL of the deployed app; when
  // set, the bot shows a "🌐 Приложение" button and index.ts starts the server.
  webappUrl: process.env.WEBAPP_URL ?? "",
  webappPort: Number(process.env.WEBAPP_PORT ?? 8080),
  webappBotUsername: process.env.BOT_USERNAME ?? "",
};
