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
  // One-time gift for completing all 5 "Ваш путь в NeuroShot" roadmap steps —
  // claim-gated like the welcome bonus (see claimRoadmapBonus in db.ts).
  roadmapBonus: Number(process.env.ROADMAP_BONUS ?? 10),
  adminIds: (process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  // --- Kaspi payments (KZT) — replaces Telegram Stars ---
  // Kaspi payment link shown to buyers. BLANK by default → the buy flow records the
  // order but tells the user payments aren't open yet; set KASPI_PAY_URL per-env to
  // go live. A real merchant pay link is deployment config, not a committed default —
  // it must never live in a public repo. Per-pack fixed-amount links can still
  // override via KASPI_PAY_URL_<PACK> (kaspiLinkFor).
  kaspiPayUrl: process.env.KASPI_PAY_URL ?? "",
  // Auto-approval (merchant API): shared secret used to verify Kaspi's payment
  // callback (HMAC-SHA256 over the raw request body). BLANK → the callback route
  // is disabled (404) and purchases stay on the admin `/order N ok` path. Set
  // KASPI_API_SECRET only once you have a real Kaspi Pay merchant integration and
  // have confirmed the callback's field names + signature scheme — see docs/kaspi.md.
  kaspiApiSecret: process.env.KASPI_API_SECRET ?? "",
  // Header carrying the callback signature (Kaspi's exact header — confirm on integration).
  kaspiSignatureHeader: (process.env.KASPI_SIGNATURE_HEADER ?? "x-kaspi-signature").toLowerCase(),
  // On-demand server-side verification of «Я оплатил»: when the Kaspi merchant
  // REST API base + token are set, the bot QUERIES the order's real status from
  // Kaspi and auto-grants if paid — no admin, no trust-the-button. BLANK → the
  // button falls back to pinging an admin (the interim). Confirm the exact status
  // endpoint + response shape against Kaspi's merchant docs — see docs/kaspi.md.
  kaspiApiBase: (process.env.KASPI_API_BASE ?? "").replace(/\/+$/, ""),
  kaspiApiToken: process.env.KASPI_API_TOKEN ?? "",
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
  // --- 48-hour re-engagement nudge (docs/growth-product.md) ---
  // A once-daily sweep DMs users who went dormant (no activity >48h) but were
  // recently active (≤14d), at most once each. Outbound messaging → env off-switch.
  reengageEnabled: (process.env.REENGAGE_ENABLED ?? "true") !== "false",
  // UTC hour to run the nudge sweep (7 UTC = 10:00 МСК — a good time to reach users).
  reengageHourUtc: Number(process.env.REENGAGE_HOUR_UTC ?? 7),
  // Max users nudged per daily sweep (keeps the send gentle + rate-limit-safe).
  reengageBatch: Number(process.env.REENGAGE_BATCH ?? 50),
  // Reaper: a generation still 'pending' beyond this many minutes is treated as a
  // render whose process died (renders take 1–3 min); it's failed and refunded.
  genStaleMinutes: Number(process.env.GEN_STALE_MINUTES ?? 15),
  // Identity-gate the free hook (docs/growth-product.md): require a verified phone
  // before the free scenario and tie the gift to the PHONE, so multi-account
  // farming needs multiple real numbers (Higgsfield banned 40k farmed accounts).
  // Default OFF — it adds onboarding friction, so enable only when scaling PAID
  // acquisition into the free scenario.
  freeGateEnabled: (process.env.FREE_GATE_ENABLED ?? "false") === "true",
  // Telegram Mini App (web layer). Public HTTPS URL of the deployed app; when
  // set, the bot shows a "🌐 Приложение" button and index.ts starts the server.
  webappUrl: process.env.WEBAPP_URL ?? "",
  webappPort: Number(process.env.WEBAPP_PORT ?? 8080),
  webappBotUsername: process.env.BOT_USERNAME ?? "",
  // --- GenAI course cohort delivery (docs/course/README.md) ---
  // Telegram chat id (e.g. "-100xxxxxxxxxx") of the pre-made PRIVATE channel/group
  // for each course tier's cohort. The bot canNOT create these itself (not a Bot
  // API capability) — the owner must manually: 1) create a private Telegram
  // group/channel, 2) add this bot as admin with "invite users via link"
  // permission, 3) paste the numeric chat id here. BLANK by default (until that
  // manual setup happens) — a purchase still grants credits either way; with a
  // blank id it just logs an error and skips the invite instead of failing the
  // purchase (payments.ts inviteToCourseCohort).
  courseFastChannelId: process.env.COURSE_FAST_CHANNEL_ID ?? "",
  courseFlagshipChannelId: process.env.COURSE_FLAGSHIP_CHANNEL_ID ?? "",

  // --- AI Video Translator / dubbing (docs/video-translator-spec.md) ---
  // ElevenLabs Dubbing API key. BLANK → the dubbing feature is disabled entirely
  // (the entry points return "disabled"), same guard style as KASPI_API_SECRET.
  elevenLabsKey: process.env.ELEVENLABS_API_KEY ?? "",
  // Kazakh target is gated behind Phase-0 validation (Kazakh TTS is v3-alpha only;
  // see the spec). RU/EN targets ship without this flag. Flip to true once a
  // native-speaker test dub passes.
  dubKazakhEnabled: (process.env.DUB_KAZAKH_ENABLED ?? "false") === "true",
  // Max source length (seconds) accepted for a dub. v1 = 60s (15s demo).
  dubMaxSeconds: Number(process.env.DUB_MAX_SECONDS ?? 60),
  // Provider cost per source-SECOND (USD) — PLACEHOLDER until the real ElevenLabs
  // per-minute price is measured in Phase 0. Drives per-second patron pricing.
  dubUsdPerSec: Number(process.env.DUB_USD_PER_SEC ?? 0.02),
};

/**
 * The Kaspi pay link for a specific pack. A plain Kaspi link can't be reliably
 * amount-parameterized via a query string, so the way to "pre-fill the amount"
 * is one FIXED-AMOUNT link per pack: create them in Kaspi Pay and set e.g.
 * KASPI_PAY_URL_COMBO / KASPI_PAY_URL_START. Any pack without its own link falls
 * back to the single KASPI_PAY_URL (the buyer then enters/confirms the amount).
 */
export function kaspiLinkFor(packId: string): string {
  const key = `KASPI_PAY_URL_${packId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  // Treat a blank/whitespace override as UNSET (not "payments off"): `.env.example`
  // ships these keys empty, so a plain `??` would resolve them to "" and disable
  // the pack. Only a non-blank override wins; otherwise fall back to KASPI_PAY_URL.
  const override = process.env[key]?.trim();
  return override ? override : config.kaspiPayUrl;
}
