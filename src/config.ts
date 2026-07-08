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
  // Sized so a newcomer affords exactly ONE Nano Banana 2 render (4 🔫) — the
  // best price/quality trial in the catalog (~$0.08 of provider cost).
  freeCredits: Number(process.env.FREE_CREDITS ?? 4),
  // --- Referral program (abuse-safe: referrer rewards are purchase-gated) ---
  // Extra credits the invited friend gets on top of freeCredits when they join
  // via a referral link (the only farmable surface — kept small on purpose).
  referralJoinBonus: Number(process.env.REFERRAL_JOIN_BONUS ?? 3),
  // One-time credits to the referrer when their friend makes their FIRST purchase.
  referralFirstPurchaseBonus: Number(process.env.REFERRAL_FIRST_PURCHASE_BONUS ?? 10),
  // Lifetime share of every pack a referred friend buys, paid to the referrer.
  referralPercent: Number(process.env.REFERRAL_PERCENT ?? 0.1),
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
