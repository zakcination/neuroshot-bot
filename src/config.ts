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
  // --- Partner program v2 (self-serve codes, docs/partner-program.md) ---
  // 15% cashback of every pack bought by a user you invited via your code.
  partnerPercent: Number(process.env.PARTNER_PERCENT ?? 0.15),
  // One-time welcome bonus (🔫) granted when a user joins the partner program.
  // Spend-only (never withdrawable) — ~$20 worth at retail pack rates.
  partnerWelcome: Number(process.env.PARTNER_WELCOME ?? 180),
  // Bonus 🔫 the INVITED user gets on top of freeCredits when joining via a code.
  partnerInviteeBonus: Number(process.env.PARTNER_INVITEE_BONUS ?? 5),
  // Max active codes one account may hold at a time.
  partnerMaxCodes: Number(process.env.PARTNER_MAX_CODES ?? 10),
  // Minimum withdrawable 🔫 to request a cash-out (biweekly).
  withdrawMin: Number(process.env.WITHDRAW_MIN ?? 500),
  adminIds: (process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  // --- Kaspi payments (KZT) — replaces Telegram Stars ---
  // Kaspi payment link shown to buyers. Blank until the merchant link is live;
  // while blank the buy flow records the order but tells the user payment isn't
  // open yet. Set KASPI_PAY_URL to go live.
  kaspiPayUrl: process.env.KASPI_PAY_URL ?? "",
  // ₸ per USD — used ONLY for the digest's gross-margin estimate, never pricing.
  kztPerUsd: Number(process.env.KZT_PER_USD ?? 480),
  // Launch combo offer window: the "🔥 Комбо-сет" sale ends this many days after
  // COMBO_OFFER_START (ISO). Default start = the server's boot time, so the
  // countdown is ~1 month from deploy; pin COMBO_OFFER_START to fix the date.
  comboOfferDays: Number(process.env.COMBO_OFFER_DAYS ?? 30),
  comboOfferStart: process.env.COMBO_OFFER_START ?? "",
  // --- CEO monitoring (docs/monitoring.md): digest pushed, alerts interrupt ---
  // UTC hour when the daily digest is pushed to admins (6 UTC = 09:00 МСК).
  digestHourUtc: Number(process.env.DIGEST_HOUR_UTC ?? 6),
  // Telegram Mini App (web layer). Public HTTPS URL of the deployed app; when
  // set, the bot shows a "🌐 Приложение" button and index.ts starts the server.
  webappUrl: process.env.WEBAPP_URL ?? "",
  webappPort: Number(process.env.WEBAPP_PORT ?? 8080),
  webappBotUsername: process.env.BOT_USERNAME ?? "",
};
