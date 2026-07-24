/**
 * Data layer — async Postgres, one code path for two backends:
 *   • production  → Neon (`DATABASE_URL` set) via @neondatabase/serverless (HTTP,
 *     works in both a long-polling process and Vercel serverless functions);
 *   • tests / local without a DB → embedded Postgres (@electric-sql/pglite).
 *
 * Same SQL on both. All exported functions are async.
 */
import { randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { PGlite } from "@electric-sql/pglite";
import { MODELS } from "./models.js";

type Row = Record<string, unknown>;
type Driver = (text: string, params: unknown[]) => Promise<Row[]>;

const driver: Driver = (() => {
  const url = process.env.DATABASE_URL;
  if (!url && process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production");
  }
  if (url) {
    const sql = neon(url);
    // Default neon config (fullResults:false) returns the rows array directly;
    // tolerate a {rows} result too so a future fullResults flip stays correct.
    return async (text, params) => {
      const r = (await sql.query(text, params)) as unknown;
      return (Array.isArray(r) ? r : (r as { rows: Row[] }).rows) as Row[];
    };
  }
  // Embedded Postgres (in-memory) — hermetic for tests, ephemeral for local dev.
  const pg = new PGlite();
  return async (text, params) => (await pg.query(text, params)).rows as Row[];
})();

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    username TEXT,
    credits INTEGER NOT NULL DEFAULT 0,
    referrer_id BIGINT,
    pending_action TEXT,
    pending_file_id TEXT,
    ref_first_purchase_at TIMESTAMPTZ,  -- set on the invitee at their 1st purchase
    ref_milestones INTEGER NOT NULL DEFAULT 0, -- referral milestone tiers already paid
    free_result_used BOOLEAN NOT NULL DEFAULT false, -- one-time "first result on us" claimed
    free_scenario_used BOOLEAN NOT NULL DEFAULT false, -- one-time free princess/football scenario claimed
    watermark_enabled BOOLEAN NOT NULL DEFAULT true, -- brand all deliverables (user can turn off)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Forward migrations for existing databases (columns added after launch).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_first_purchase_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_milestones INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_code TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS free_result_used BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS free_scenario_used BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS watermark_enabled BOOLEAN NOT NULL DEFAULT true`,
  // 48-hour re-engagement nudge: when a dormant user was DM'd (once-only guard).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS nudged_at TIMESTAMPTZ`,
  // Identity-gate the free hook: the user's verified phone (Telegram contact).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`,
  // Opaque referral-link code (never the raw Telegram id) — minted lazily on
  // first request via ensureRefCode, stable thereafter so shared links keep
  // working. Old numeric-id links stay honored for backward compatibility
  // (see resolveReferrer in bot.ts); this only stops MINTING new leaky ones.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_code TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_code ON users(ref_code) WHERE ref_code IS NOT NULL`,
  // Welcome bonus is claim-gated (product decision: a deliberate "get your free
  // patrons" tap converts/onboards better than a silent credit): the signup
  // amount is parked here at creation, NOT added to `credits`, until claimWelcomeBonus
  // moves it over. pending_join_* mirrors the same gating for a referral/partner
  // join bonus so the whole free package lands in one claim, per spec.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_signup_credits INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_join_bonus INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_join_via TEXT`, // 'friend' | 'partner' | NULL
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_join_meta TEXT`, // referrer id or partner code, for the ledger row
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_bonus_claimed BOOLEAN NOT NULL DEFAULT false`,
  // One-time gift for completing all 5 "Ваш путь в NeuroShot" roadmap steps —
  // claim-gated the same way as the welcome bonus (see claimRoadmapBonus).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS roadmap_bonus_claimed BOOLEAN NOT NULL DEFAULT false`,
  // Whether the first-launch onboarding slideshow has been shown to this
  // account. Deliberately independent of welcome_bonus_claimed — the redesigned
  // onboarding is new content nobody has seen yet, including users who already
  // claimed (or spent) their free patrons long ago, so DEFAULT false applies to
  // every existing row too and the slideshow pops for the whole install base
  // once. It's replayable any time from the "Ещё" tab regardless of this flag.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_seen BOOLEAN NOT NULL DEFAULT false`,
  // Self-serve data deletion (Privacy Policy §4): marks when a user erased their
  // PII. The row itself is kept (soft delete) — a Telegram id can't be reissued,
  // and other users' referral/partner/ledger history legitimately points at it —
  // but username/phone/ref_code/prompts/output_urls are scrubbed and credits
  // forfeited. deleted_at is purely informational (support/audit visibility);
  // nothing in the app currently branches on it.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  // Backfill only: rows from before this column existed have pending=0 by the
  // column DEFAULT, so this can never touch a real unclaimed balance — it just
  // marks pre-existing accounts (already credited under the old immediate-grant
  // model) as "nothing left to claim" so the UI never re-prompts them. Safe to
  // run on every boot.
  `UPDATE users SET welcome_bonus_claimed = true
   WHERE welcome_bonus_claimed = false AND pending_signup_credits = 0 AND pending_join_bonus = 0`,
  // One free scenario per PHONE (not per Telegram account) — multi-account farming
  // then needs multiple real numbers. PK dedups the claim across accounts.
  `CREATE TABLE IF NOT EXISTS free_claims (
    phone TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Acquisition source (first-touch, immutable): 'ref' | 'c_<code>' | a deep-link
  // slug per creative/channel (t.me/<bot>?start=src_tiktok1) | NULL = organic.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS source TEXT`,
  // Creator/partner codes: negotiated deals with bloggers & course authors.
  // Deep link: t.me/<bot>?start=c_<code>. Each code carries its own revenue
  // share and join bonus (per-deal terms) — see docs/creator-program.md.
  `CREATE TABLE IF NOT EXISTS partner_codes (
    code TEXT PRIMARY KEY,          -- lowercase slug used in the deep link
    user_id BIGINT NOT NULL,        -- owner (the creator's Telegram id)
    title TEXT,
    percent REAL NOT NULL,          -- lifetime share of attributed purchases (0–1)
    join_bonus INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Partner program v2: self-serve codes (kind='partner', flat %) alongside the
  // admin creator deals (kind='creator', negotiated %). See docs/partner-program.md.
  `ALTER TABLE partner_codes ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'creator'`,
  `ALTER TABLE partner_codes ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true`,
  `CREATE INDEX IF NOT EXISTS idx_partner_codes_owner ON partner_codes(user_id)`,
  // Withdrawable = 🔫 earned as real cashback (funded by invitees' actual Stars
  // spend) — the ONLY balance eligible for cash-out. The welcome bonus and
  // purchased/free credits are spend-only, so cash-out can't drain the treasury.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_joined_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_withdrawable INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS withdrawals (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    amount INTEGER NOT NULL,        -- patrons requested (moved out of withdrawable)
    status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | rejected
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id)`,
  // At most ONE pending withdrawal per user — enforced at the DB, not just in
  // app logic, so concurrent requests can't create two pending rows.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawals_one_pending ON withdrawals(user_id) WHERE status = 'pending'`,
  // Kaspi purchase orders: a buyer taps buy → pending order → pays via the Kaspi
  // link → admin (or, later, a Kaspi webhook) approves → credits granted.
  `CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    pack_id TEXT NOT NULL,
    amount_kzt INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | rejected
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders(status) WHERE status = 'pending'`,
  // Tracks whether grantPurchase's credit/payout side effects actually landed,
  // SEPARATELY from status='paid' (which only means "payment confirmed"). A
  // process crash or DB hiccup between the pending→paid transition and the
  // credit grant would otherwise strand the order paid-but-uncredited forever —
  // nothing else ever revisits a row once it leaves 'pending'. granted_at lets a
  // reconciler sweep (mirroring the stale-generation reaper) find and retry
  // exactly those rows.
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_orders_ungranted ON orders(status) WHERE status = 'paid' AND granted_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    delta INTEGER NOT NULL,
    -- signup | purchase | generation | refund | referral (lifetime share)
    -- | referral_join (invitee bonus) | referral_bonus (1st-purchase) | referral_milestone
    -- | partner (creator/partner revenue share) | partner_join (creator-code welcome bonus)
    -- | partner_welcome (self-serve join bonus) | withdrawal | withdrawal_reject
    -- signup and referral_join/partner_join are now inserted by claimWelcomeBonus
    -- at CLAIM time, not at account creation (see pending_signup_credits above) —
    -- so created_at on these rows reflects when credits actually landed.
    reason TEXT NOT NULL,
    meta TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS generations (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT,
    credits INTEGER NOT NULL,
    status TEXT NOT NULL,           -- ok | error
    output_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Real provider cost (models.costUsdFor) + the fal request id, captured on
  // successful completion — the COGS accounting / per-user cost cap this data
  // layer didn't have before (only the patron CHARGE was tracked, never the
  // actual $ cost). NULL on rows from before this column existed and on 'error'
  // rows where the provider was never reached; but an 'error' row CAN carry a
  // cost when the provider call succeeded (we were billed) and only the tail —
  // watermarking / delivery — failed, so failed-delivery spend is still counted
  // (see the error-completion paths in src/generate.ts).
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS cost_usd NUMERIC`,
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS provider_request_id TEXT`,
  // Multi-output support (num_images, images only — docs/cinema-studio-model-params.md
  // P5): output_url stays the FIRST url always, so every existing single-output
  // consumer (gallery, digest, delivery, reconciliation) keeps working unchanged.
  // output_urls is a JSON-encoded array, populated ONLY when a render actually
  // produced more than one output — NULL for every ordinary single-output row.
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS output_urls TEXT`,
  `CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    session_id INTEGER NOT NULL,    -- monotonic per-user visit counter
    type TEXT NOT NULL,
    meta TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
  `CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id)`,
  // Reward-architecture P0 (docs: neuroshot-reward-architecture-v1.md, kept out of
  // this public repo — see the security note in that doc §8). These tables are the
  // ONLY place tuned economy values (XP-per-action, level thresholds, season caps,
  // per-preset level gates) may live: never as literal source constants, so a
  // public GitHub read can't hand anyone the exact farmable tuning. Both ship
  // EMPTY — no seed data, no defaults baked into code — and are populated live via
  // the /econ_set and /econ_gate admin commands (bot.ts), mirroring how KASPI_API_BASE
  // and other not-yet-configured features in this codebase ship "dark" until an
  // admin turns them on, rather than falling back to a guessable default.
  `CREATE TABLE IF NOT EXISTS economy_config (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS preset_gating (
    preset_id TEXT PRIMARY KEY,
    min_level INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Reward-architecture P1: permanent Level currency (never resets — distinct
  // from Кадры/credits and from any future seasonal XP). Starts at 0 for every
  // existing row; getLevel() derives the account Level from this against the
  // thresholds in economy_config, so Level only starts moving once an admin
  // configures level.threshold.N — until then every account reads Level 0 and
  // preset_gating (also empty by default) has nothing to enforce against.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS xp_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,  -- 'save' | 'rating' | 'new_style' | 'quest' | 'referral' | ...
    meta TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_xp_ledger_user_reason ON xp_ledger(user_id, reason, created_at)`,
  // One save-XP award per generation, ever — a claims table (not a boolean flag
  // on `generations`) so re-tapping "Скачать" a hundred times can't farm XP.
  `CREATE TABLE IF NOT EXISTS xp_save_claims (
    generation_id BIGINT PRIMARY KEY,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    try {
      for (const stmt of SCHEMA) await driver(stmt, []);
    } catch (err) {
      schemaReady = null; // allow retry on transient failures
      throw err;
    }
  })();
  return schemaReady;
}

/** Run a parameterized query (schema is ensured on first use). */
async function q(text: string, params: unknown[] = []): Promise<Row[]> {
  await ensureSchema();
  return driver(text, params);
}

/** Await schema creation explicitly (call once at startup). */
export async function initDb(): Promise<void> {
  await ensureSchema();
}

/** Raw parameterized query — for tests and ad-hoc reads. */
export const query = q;

/** Minutes of inactivity after which the next interaction counts as a new visit. */
const SESSION_GAP_MIN = 30;

export interface UserRow {
  id: number;
  username: string | null;
  credits: number;
  referrer_id: number | null;
  pending_action: string | null;
  pending_file_id: string | null;
  /** Creator code this user was acquired through (first-touch, immutable). */
  partner_code: string | null;
  /** Brand this user's deliverables with the watermark (default true; user-toggleable). */
  watermark_enabled: boolean;
  /** Verified phone (Telegram contact) — set when identity-gating the free hook. */
  phone: string | null;
  /** 🔫 parked at signup, not yet in `credits` — moved over by claimWelcomeBonus. */
  pendingSignupCredits: number;
  /** Referral/partner join bonus parked alongside pendingSignupCredits (0 if none). */
  pendingJoinBonus: number;
  /** What the pending join bonus came from — friend referral link or a creator code. */
  pendingJoinVia: "friend" | "partner" | null;
  /** True once the welcome bonus has been claimed (or there was never one to claim). */
  welcomeBonusClaimed: boolean;
  /** True once the "Ваш путь в NeuroShot" completion bonus has been claimed. */
  roadmapBonusClaimed: boolean;
  /** True once this account has been shown the first-launch onboarding slideshow. */
  onboardingSeen: boolean;
  /** Set only by getOrCreateUser on the call that actually inserted the row. */
  justCreated?: boolean;
  /** Welcome bonus granted at creation (0 unless joined via a link/code). */
  joinBonus?: number;
  /** What granted the join bonus — friend referral link or a creator code. */
  joinVia?: "friend" | "partner";
}

// Postgres returns BIGINT as string — coerce id fields (Telegram ids are < 2^53).
function mapUser(r: Row): UserRow {
  return {
    id: Number(r.id),
    username: (r.username as string | null) ?? null,
    credits: Number(r.credits),
    referrer_id: r.referrer_id == null ? null : Number(r.referrer_id),
    pending_action: (r.pending_action as string | null) ?? null,
    pending_file_id: (r.pending_file_id as string | null) ?? null,
    partner_code: (r.partner_code as string | null) ?? null,
    watermark_enabled: r.watermark_enabled !== false, // default true for legacy rows
    phone: (r.phone as string | null) ?? null,
    pendingSignupCredits: Number(r.pending_signup_credits ?? 0),
    pendingJoinBonus: Number(r.pending_join_bonus ?? 0),
    pendingJoinVia: (r.pending_join_via as "friend" | "partner" | null) ?? null,
    welcomeBonusClaimed: r.welcome_bonus_claimed !== false, // default true for legacy rows
    roadmapBonusClaimed: r.roadmap_bonus_claimed === true, // default false for legacy rows
    onboardingSeen: r.onboarding_seen === true, // default false — everyone gets the redesigned slideshow once
  };
}

/** Toggle whether the user's deliverables are watermarked. Returns the new value. */
export async function setWatermark(userId: number, enabled: boolean): Promise<boolean> {
  await q("UPDATE users SET watermark_enabled = $2 WHERE id = $1", [userId, enabled]);
  return enabled;
}

/** Store a user's verified phone (from a shared Telegram contact). */
export async function setUserPhone(userId: number, phone: string): Promise<void> {
  await q("UPDATE users SET phone = $2 WHERE id = $1", [userId, phone]);
}

/** Outcome of a self-serve deletion request — the credits forfeited feeds the confirmation message. */
export interface DeletionResult {
  forfeitedCredits: number;
}

/**
 * Self-serve account-data deletion (Privacy Policy §4 / §5). Scrubs PII in
 * place rather than deleting the row: the Telegram id can't be reissued to
 * someone else, and OTHER users' referral/partner/purchase history legitimately
 * references this id, so removing the row would orphan their records. What
 * this DOES do:
 *   - users: wipe username/phone/ref_code/pending_action/pending_file_id,
 *     zero credits (forfeited — this is not a refund; see refund policy for
 *     that separate flow), stamp deleted_at.
 *   - generations: null out prompt/output_url (the actual content + what it
 *     depicted), keeping model/credits/status/cost_usd so COGS/analytics
 *     aggregates that group by those columns stay correct.
 *   - partner_codes: deactivate any codes this user owns, so no one can join
 *     under them post-deletion.
 * Ledger/orders/withdrawals rows are deliberately left untouched — financial
 * records retained for accounting/tax purposes, referencing only the bare
 * numeric id (no PII) once this runs.
 *
 * Deliberately NOT touched — abuse safety: free_result_used, free_scenario_used,
 * welcome_bonus_claimed, pending_signup_credits/pending_join_bonus,
 * roadmap_bonus_claimed, ref_first_purchase_at/ref_milestones. A Telegram id
 * can't be reissued to a different person, so "delete, then /start again" is
 * the SAME account, not a fresh one — if this reset those flags, deletion would
 * become a free-tier farming loop (re-claim the welcome bonus, the free
 * scenario, the first-result freebie, the roadmap bonus, indefinitely). Because
 * the row survives (soft delete) and getOrCreateUser's INSERT is a no-op on an
 * existing id, none of those grants can re-fire. See the e2e "abuse safety"
 * test for the end-to-end proof.
 * Returns null if the user doesn't exist (nothing to delete).
 */
export async function deleteUserData(userId: number): Promise<DeletionResult | null> {
  const before = await q("SELECT credits FROM users WHERE id = $1 AND deleted_at IS NULL", [userId]);
  if (!before.length) return null; // unknown user, or already deleted — idempotent no-op
  const rows = await q(
    `UPDATE users SET
       username = NULL, phone = NULL, ref_code = NULL,
       pending_action = NULL, pending_file_id = NULL,
       credits = 0, deleted_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id`,
    [userId],
  );
  if (!rows.length) return null; // lost a race with a concurrent deletion request
  await q("UPDATE generations SET prompt = NULL, output_url = NULL WHERE user_id = $1", [userId]);
  await q("UPDATE partner_codes SET active = false WHERE user_id = $1", [userId]);
  return { forfeitedCredits: Number(before[0].credits) };
}

/**
 * Claim the one free scenario for a phone number. Returns true if this phone may
 * proceed — i.e. it's a fresh claim OR the existing claim already belongs to this
 * same user (so the owner can retry after a failed render). Returns false only
 * when a DIFFERENT account already claimed the gift with this number — the
 * cross-account anti-farm guard.
 */
export async function claimFreePhone(phone: string, userId: number): Promise<boolean> {
  const won = await q(
    "INSERT INTO free_claims (phone, user_id) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING RETURNING user_id",
    [phone, userId],
  );
  if (won.length > 0) return true; // fresh claim
  const existing = await q("SELECT user_id FROM free_claims WHERE phone = $1", [phone]);
  return existing.length > 0 && Number(existing[0].user_id) === userId; // same owner may retry
}

/** Peek whether a phone already claimed the free gift (UX pre-check; not the guard). */
export async function phoneClaimedFree(phone: string): Promise<boolean> {
  const rows = await q("SELECT 1 FROM free_claims WHERE phone = $1", [phone]);
  return rows.length > 0;
}

export async function getOrCreateUser(
  id: number,
  username: string | undefined,
  referrerId: number | null,
  freeCredits: number,
  joinBonus = 0,
  partner: PartnerCodeRow | null = null,
  source: string | null = null,
): Promise<UserRow> {
  const ref = referrerId && referrerId !== id ? referrerId : null;
  // Attribution is first-touch and exclusive: friend referral OR creator code.
  const via = !ref && partner && partner.user_id !== id ? partner : null;
  const bonus = ref
    ? Math.max(0, Math.floor(joinBonus))
    : via
      ? Math.max(0, Math.floor(via.join_bonus))
      : 0;
  // Acquisition source, first-touch (set only on the INSERT): referral link →
  // 'ref', creator code → 'c_<code>', ad/channel deep link → its slug.
  const src = ref ? "ref" : via ? `c_${via.code}` : source;
  const joinVia = ref ? "friend" : via ? "partner" : null;
  const joinMeta = ref ? String(ref) : via ? via.code : null;
  // credits starts at 0 — the whole free package (signup + join bonus) is parked
  // in pending_* and only lands in `credits` when claimWelcomeBonus fires.
  const inserted = await q(
    `INSERT INTO users
       (id, username, credits, referrer_id, partner_code, source,
        pending_signup_credits, pending_join_bonus, pending_join_via, pending_join_meta)
     VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [id, username ?? null, ref, via?.code ?? null, src, freeCredits, bonus, joinVia, joinMeta],
  );
  if (inserted.length) {
    const u = mapUser(inserted[0]);
    u.justCreated = true;
    u.joinBonus = bonus;
    u.joinVia = joinVia ?? undefined;
    return u;
  }
  const existing = await q("SELECT * FROM users WHERE id = $1", [id]);
  return mapUser(existing[0]);
}

export interface WelcomeClaim {
  /** Total 🔫 just moved into `credits` (signup + join bonus combined). */
  granted: number;
  joinBonus: number;
  joinVia: "friend" | "partner" | null;
  /** Referrer id (as a string) or partner code — whichever joinVia implies. */
  joinMeta: string | null;
}

/**
 * Move a user's parked signup + join bonus into their spendable balance —
 * exactly once. Returns null if there was nothing to claim (already claimed,
 * or a legacy account from before claim-gating existed). The ledger rows are
 * written here, at the moment credits actually land, not at account creation.
 */
export async function claimWelcomeBonus(userId: number): Promise<WelcomeClaim | null> {
  // A single writable-CTE statement — the credit move and both ledger inserts
  // commit or fail together (one statement is one implicit transaction), so a
  // crash or transient error between them can never leave credits granted with
  // no matching ledger row.
  const rows = await q(
    `WITH claim AS (
       UPDATE users
       SET credits = credits + pending_signup_credits + pending_join_bonus,
           welcome_bonus_claimed = true
       WHERE id = $1 AND welcome_bonus_claimed = false
         AND (pending_signup_credits > 0 OR pending_join_bonus > 0)
       RETURNING id, pending_signup_credits, pending_join_bonus, pending_join_via, pending_join_meta
     ),
     ins_signup AS (
       INSERT INTO ledger (user_id, delta, reason)
       SELECT id, pending_signup_credits, 'signup' FROM claim WHERE pending_signup_credits > 0
       RETURNING 1
     ),
     ins_join AS (
       INSERT INTO ledger (user_id, delta, reason, meta)
       SELECT id, pending_join_bonus,
              CASE WHEN pending_join_via = 'partner' THEN 'partner_join' ELSE 'referral_join' END,
              pending_join_meta
       FROM claim WHERE pending_join_bonus > 0 AND pending_join_via IS NOT NULL
       RETURNING 1
     )
     SELECT * FROM claim`,
    [userId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const signup = Number(r.pending_signup_credits);
  const joinBonus = Number(r.pending_join_bonus);
  const joinVia = (r.pending_join_via as "friend" | "partner" | null) ?? null;
  return { granted: signup + joinBonus, joinBonus, joinVia, joinMeta: (r.pending_join_meta as string | null) ?? null };
}

export async function getUser(id: number): Promise<UserRow | undefined> {
  const rows = await q("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] ? mapUser(rows[0]) : undefined;
}

/**
 * The user's opaque referral-link code — minted lazily on first request (not
 * derived from the Telegram id, so the invite link never leaks it), then
 * stable forever so links already shared keep working. Reuses genCode()'s
 * unforgeable slug + collision-retry pattern (see the partner-code section).
 */
export async function ensureRefCode(userId: number): Promise<string> {
  const existing = await q("SELECT ref_code FROM users WHERE id = $1", [userId]);
  const current = existing[0]?.ref_code as string | null | undefined;
  if (current) return current;
  for (let i = 0; i < 5; i++) {
    const code = genCode();
    try {
      const ins = await q(
        "UPDATE users SET ref_code = $2 WHERE id = $1 AND ref_code IS NULL RETURNING ref_code",
        [userId, code],
      );
      if (ins.length) return code;
    } catch (e) {
      // Unique-violation on the rare slug collision with another user's ref_code
      // — retry with a freshly generated one instead of failing the request.
      if ((e as { code?: string }).code !== "23505") throw e;
    }
    // Lost the race to a concurrent call, or the collision above — re-check.
    const now = await q("SELECT ref_code FROM users WHERE id = $1", [userId]);
    if (now[0]?.ref_code) return now[0].ref_code as string;
  }
  throw new Error("could not generate a unique referral code");
}

/** Resolve an opaque referral code back to its owner's numeric id, if valid. */
export async function getUserIdByRefCode(code: string): Promise<number | null> {
  const rows = await q("SELECT id FROM users WHERE ref_code = $1", [code]);
  return rows[0] ? Number(rows[0].id) : null;
}

export interface ReferralOpts {
  percent: number; // lifetime share of the friend's purchases
  firstPurchaseBonus: number; // one-time, on the friend's first purchase
  milestones: { friends: number; bonus: number }[]; // by count of PAYING friends
}
export interface ReferralPayout {
  referrerId: number;
  lifetime: number;
  firstPurchase: number;
  milestones: { friends: number; bonus: number }[];
}

/**
 * Pay a referrer for a referred friend's purchase. Abuse-safe by construction:
 * every reward here is gated on a real, paid purchase, and the one-time and
 * milestone rewards fire only on the friend's FIRST purchase (atomic set-once on
 * ref_first_purchase_at guards against double payment / races). Returns what was
 * paid (for notifications), or null if the buyer wasn't referred.
 */
export async function rewardReferralOnPurchase(
  refereeId: number,
  packCredits: number,
  opts: ReferralOpts,
): Promise<ReferralPayout | null> {
  const referee = await getUser(refereeId);
  if (!referee?.referrer_id) return null;
  const refId = referee.referrer_id;
  const payout: ReferralPayout = { referrerId: refId, lifetime: 0, firstPurchase: 0, milestones: [] };

  // 1) Lifetime revenue share — on every purchase.
  const lifetime = Math.floor(packCredits * opts.percent);
  if (lifetime > 0) {
    await addCredits(refId, lifetime, "referral", String(refereeId));
    payout.lifetime = lifetime;
  }

  // 2) First-purchase only: atomically claim the "first purchase" flag.
  const first = await q(
    "UPDATE users SET ref_first_purchase_at = now() WHERE id = $1 AND ref_first_purchase_at IS NULL RETURNING id",
    [refereeId],
  );
  if (!first.length) return payout; // already a returning buyer → nothing more

  if (opts.firstPurchaseBonus > 0) {
    await addCredits(refId, opts.firstPurchaseBonus, "referral_bonus", String(refereeId));
    payout.firstPurchase = opts.firstPurchaseBonus;
  }

  // 3) Milestones — by count of DISTINCT paying friends; award newly-crossed tiers.
  const cnt = await q(
    "SELECT COUNT(*)::int AS c FROM users WHERE referrer_id = $1 AND ref_first_purchase_at IS NOT NULL",
    [refId],
  );
  const paying = Number(cnt[0].c);
  const mrow = await q("SELECT ref_milestones FROM users WHERE id = $1", [refId]);
  const startTier = mrow[0] ? Number(mrow[0].ref_milestones) : 0;
  let tier = startTier;
  for (let i = startTier; i < opts.milestones.length; i++) {
    if (paying < opts.milestones[i].friends) break;
    await addCredits(refId, opts.milestones[i].bonus, "referral_milestone", String(opts.milestones[i].friends));
    payout.milestones.push(opts.milestones[i]);
    tier = i + 1;
  }
  if (tier !== startTier) await q("UPDATE users SET ref_milestones = $1 WHERE id = $2", [tier, refId]);
  return payout;
}

/** Referral dashboard totals for a user: friends invited, of them paying, credits earned. */
export async function referralStats(
  userId: number,
): Promise<{ invited: number; paying: number; earned: number }> {
  const c = await q(
    `SELECT COUNT(*)::int AS invited,
            COALESCE(SUM(CASE WHEN ref_first_purchase_at IS NOT NULL THEN 1 ELSE 0 END),0)::int AS paying
     FROM users WHERE referrer_id = $1`,
    [userId],
  );
  const e = await q(
    `SELECT COALESCE(SUM(delta),0)::int AS earned FROM ledger
     WHERE user_id = $1 AND reason IN ('referral','referral_bonus','referral_milestone')`,
    [userId],
  );
  return { invited: Number(c[0].invited), paying: Number(c[0].paying), earned: Number(e[0].earned) };
}

// ---- Creator / partner program (negotiated per-deal terms) ----

export interface PartnerCodeRow {
  code: string;
  user_id: number;
  title: string | null;
  percent: number; // 0–1 lifetime share of attributed purchases
  join_bonus: number;
  kind: "creator" | "partner"; // 'creator' = admin negotiated; 'partner' = self-serve
}

function mapPartner(r: Row): PartnerCodeRow {
  return {
    code: String(r.code),
    user_id: Number(r.user_id),
    title: (r.title as string | null) ?? null,
    percent: Number(r.percent),
    join_bonus: Number(r.join_bonus),
    kind: (r.kind as "creator" | "partner") ?? "creator",
  };
}

/** Create or update a creator code (admin action — terms are per-deal). */
export async function upsertPartnerCode(
  code: string,
  userId: number,
  percent: number,
  joinBonus: number,
  title: string | null,
): Promise<void> {
  await q(
    `INSERT INTO partner_codes (code, user_id, percent, join_bonus, title) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (code) DO UPDATE SET user_id = $2, percent = $3, join_bonus = $4, title = $5`,
    [code, userId, percent, joinBonus, title],
  );
}

export async function getPartnerCode(code: string): Promise<PartnerCodeRow | undefined> {
  const rows = await q("SELECT * FROM partner_codes WHERE code = $1", [code]);
  return rows[0] ? mapPartner(rows[0]) : undefined;
}

export async function listPartnerCodes(ownerId: number): Promise<PartnerCodeRow[]> {
  const rows = await q("SELECT * FROM partner_codes WHERE user_id = $1 ORDER BY created_at", [ownerId]);
  return rows.map(mapPartner);
}

/**
 * Pay a creator for a purchase by a user acquired through their code. Like the
 * friend referral this is purchase-gated (payouts only on real Stars spend);
 * unlike it there is no first-purchase bonus or milestones — the creator's
 * entire deal is the (negotiated) lifetime percent. Returns the payout or null.
 */
export async function rewardPartnerOnPurchase(
  buyerId: number,
  packCredits: number,
): Promise<{ code: string; ownerId: number; amount: number; kind: "creator" | "partner" } | null> {
  const buyer = await getUser(buyerId);
  if (!buyer?.partner_code) return null;
  const pc = await getPartnerCode(buyer.partner_code);
  if (!pc || pc.user_id === buyerId) return null;
  const amount = Math.floor(packCredits * pc.percent);
  if (amount > 0) {
    await addCredits(pc.user_id, amount, "partner", `${pc.code}:${buyerId}`);
    // Self-serve partner cashback is WITHDRAWABLE (funded by real Stars spend);
    // creator-deal payouts are settled off-platform, so they stay spend-only.
    if (pc.kind === "partner") {
      await q("UPDATE users SET partner_withdrawable = partner_withdrawable + $1 WHERE id = $2", [
        amount,
        pc.user_id,
      ]);
    }
  }
  // Mark the buyer as paying (powers the partner dashboard's conversion stat).
  await q("UPDATE users SET ref_first_purchase_at = now() WHERE id = $1 AND ref_first_purchase_at IS NULL", [
    buyerId,
  ]);
  return { code: pc.code, ownerId: pc.user_id, amount, kind: pc.kind };
}

/** Per-code funnel for the creator dashboard: joined → paying → patrons earned. */
export async function partnerStats(
  code: string,
): Promise<{ joined: number; paying: number; earned: number }> {
  const c = await q(
    `SELECT COUNT(*)::int AS joined,
            COALESCE(SUM(CASE WHEN ref_first_purchase_at IS NOT NULL THEN 1 ELSE 0 END),0)::int AS paying
     FROM users WHERE partner_code = $1`,
    [code],
  );
  const e = await q(
    "SELECT COALESCE(SUM(delta),0)::int AS earned FROM ledger WHERE reason = 'partner' AND meta LIKE $1",
    [`${code}:%`],
  );
  return { joined: Number(c[0].joined), paying: Number(c[0].paying), earned: Number(e[0].earned) };
}

// ---- Partner program v2: self-serve codes, cashback, withdrawals ----

/** A short unforgeable code slug: 6 chars from a 32-symbol base32-style
 *  alphabet (no ambiguous 0/1/l/o) → 32^6 ≈ 1.07e9 space. */
function genCode(): string {
  return [...randomBytes(6)].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

export interface PartnerJoin {
  justJoined: boolean;
  welcome: number; // welcome bonus granted (0 if already a member)
}

/**
 * Join the self-serve partner program (idempotent). Grants the one-time welcome
 * bonus on first join — SPEND-ONLY (not added to partner_withdrawable), so a
 * farmed account can never cash it out; only real invitee-purchase cashback is
 * withdrawable. Returns whether this call did the joining + the bonus paid.
 */
export async function joinPartnerProgram(userId: number, welcome: number): Promise<PartnerJoin> {
  const rows = await q(
    "UPDATE users SET partner_joined_at = now() WHERE id = $1 AND partner_joined_at IS NULL RETURNING id",
    [userId],
  );
  if (!rows.length) return { justJoined: false, welcome: 0 };
  const bonus = Math.max(0, Math.floor(welcome));
  if (bonus > 0) await addCredits(userId, bonus, "partner_welcome", "join");
  return { justJoined: true, welcome: bonus };
}

/**
 * Mint a new self-serve partner code for a user (kind='partner', flat percent).
 * Enforces the per-account active-code cap. Returns the code, or an error tag.
 */
export async function createPartnerCode(
  userId: number,
  percent: number,
  inviteeBonus: number,
  maxActive: number,
): Promise<{ ok: true; code: string } | { ok: false; error: "limit" }> {
  const activeCount = async () =>
    Number(
      (
        await q(
          "SELECT COUNT(*)::int AS c FROM partner_codes WHERE user_id = $1 AND kind = 'partner' AND active = true",
          [userId],
        )
      )[0].c,
    );
  if ((await activeCount()) >= maxActive) return { ok: false, error: "limit" };
  // Insert only if still under the cap — the count is re-evaluated INSIDE the
  // statement, so two concurrent calls can't both slip past the limit. An empty
  // result means either the cap was hit in a race or a (rare) slug collision.
  for (let i = 0; i < 5; i++) {
    const code = genCode();
    const ins = await q(
      `INSERT INTO partner_codes (code, user_id, percent, join_bonus, kind, active)
       SELECT $1, $2, $3, $4, 'partner', true
       WHERE (SELECT COUNT(*) FROM partner_codes WHERE user_id = $2 AND kind = 'partner' AND active = true) < $5
       ON CONFLICT (code) DO NOTHING RETURNING code`,
      [code, userId, percent, Math.floor(inviteeBonus), maxActive],
    );
    if (ins.length) return { ok: true, code };
    if ((await activeCount()) >= maxActive) return { ok: false, error: "limit" }; // cap, not collision
  }
  throw new Error("could not generate a unique partner code");
}

/** Deactivate a self-serve code (frees a slot; existing attributions keep paying). */
export async function deactivatePartnerCode(userId: number, code: string): Promise<boolean> {
  const rows = await q(
    "UPDATE partner_codes SET active = false WHERE code = $1 AND user_id = $2 AND kind = 'partner' RETURNING code",
    [code, userId],
  );
  return rows.length > 0;
}

/** A user's active self-serve codes, each with its own funnel stats. */
export async function myPartnerCodes(
  userId: number,
): Promise<Array<PartnerCodeRow & { joined: number; paying: number; earned: number }>> {
  const rows = await q(
    "SELECT * FROM partner_codes WHERE user_id = $1 AND kind = 'partner' AND active = true ORDER BY created_at",
    [userId],
  );
  const out = [];
  for (const r of rows) {
    const pc = mapPartner(r);
    out.push({ ...pc, ...(await partnerStats(pc.code)) });
  }
  return out;
}

/** Partner dashboard totals across all of a user's codes. */
export async function partnerAccount(userId: number): Promise<{
  joined: boolean;
  invited: number;
  paying: number;
  earned: number; // lifetime cashback + welcome journaled
  withdrawable: number; // 🔫 eligible for cash-out
  activeCodes: number;
}> {
  const u = await q(
    "SELECT partner_joined_at IS NOT NULL AS joined, partner_withdrawable FROM users WHERE id = $1",
    [userId],
  );
  const funnel = await q(
    `SELECT COUNT(*)::int AS invited,
            COALESCE(SUM(CASE WHEN ref_first_purchase_at IS NOT NULL THEN 1 ELSE 0 END),0)::int AS paying
     FROM users WHERE partner_code IN (SELECT code FROM partner_codes WHERE user_id = $1 AND kind = 'partner')`,
    [userId],
  );
  const earned = await q(
    "SELECT COALESCE(SUM(delta),0)::int AS e FROM ledger WHERE user_id = $1 AND reason IN ('partner','partner_welcome')",
    [userId],
  );
  const active = await q(
    "SELECT COUNT(*)::int AS c FROM partner_codes WHERE user_id = $1 AND kind = 'partner' AND active = true",
    [userId],
  );
  return {
    joined: Boolean(u[0]?.joined),
    invited: Number(funnel[0].invited),
    paying: Number(funnel[0].paying),
    earned: Number(earned[0].e),
    withdrawable: u[0] ? Number(u[0].partner_withdrawable) : 0,
    activeCodes: Number(active[0].c),
  };
}

export interface WithdrawalRow {
  id: number;
  user_id: number;
  amount: number;
  status: string;
  requested_at: string;
}

/**
 * Request a cash-out. Abuse-safe by construction: `amount` is drained from BOTH
 * the withdrawable balance (earned cashback only) AND the spendable credits, in
 * one atomic guarded statement — so you can never withdraw the welcome bonus,
 * purchased, or free 🔫, and never more than once for the same balance. One
 * pending request at a time. Returns the row or an error tag.
 */
export async function requestWithdrawal(
  userId: number,
  amount: number,
  minAmount: number,
): Promise<{ ok: true; id: number } | { ok: false; error: "too_small" | "insufficient" | "pending" }> {
  const amt = Math.floor(amount);
  if (amt < Math.max(1, minAmount)) return { ok: false, error: "too_small" };
  const pend = await q("SELECT 1 FROM withdrawals WHERE user_id = $1 AND status = 'pending' LIMIT 1", [
    userId,
  ]);
  if (pend.length) return { ok: false, error: "pending" };
  // One atomic statement: drain both balances, create the request, AND journal
  // the ledger entry — so a partial failure can never leave balances without a
  // matching record. The partial-unique index makes the "one pending" invariant
  // race-proof; a concurrent double fires a unique violation (whole tx rolls back).
  let rows;
  try {
    rows = await q(
      `WITH upd AS (
         UPDATE users SET credits = credits - $1, partner_withdrawable = partner_withdrawable - $1
         WHERE id = $2 AND partner_withdrawable >= $1 AND credits >= $1 RETURNING id
       ), w AS (
         INSERT INTO withdrawals (user_id, amount) SELECT $2, $1 FROM upd RETURNING id
       ), l AS (
         INSERT INTO ledger (user_id, delta, reason, meta)
         SELECT $2, -$1, 'withdrawal', w.id::text FROM w RETURNING 1
       )
       SELECT id FROM w`,
      [amt, userId],
    );
  } catch (e) {
    if (String((e as Error).message).match(/unique|duplicate/i)) return { ok: false, error: "pending" };
    throw e;
  }
  if (!rows.length) return { ok: false, error: "insufficient" };
  return { ok: true, id: Number(rows[0].id) };
}

/** A user's withdrawal history (newest first). */
export async function myWithdrawals(userId: number, limit = 10): Promise<WithdrawalRow[]> {
  const rows = await q(
    "SELECT id, user_id, amount, status, requested_at FROM withdrawals WHERE user_id = $1 ORDER BY id DESC LIMIT $2",
    [userId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    user_id: Number(r.user_id),
    amount: Number(r.amount),
    status: String(r.status),
    requested_at: String(r.requested_at),
  }));
}

/** Admin: all pending cash-out requests to process (biweekly). */
export async function pendingWithdrawals(): Promise<WithdrawalRow[]> {
  const rows = await q(
    "SELECT id, user_id, amount, status, requested_at FROM withdrawals WHERE status = 'pending' ORDER BY id",
  );
  return rows.map((r) => ({
    id: Number(r.id),
    user_id: Number(r.user_id),
    amount: Number(r.amount),
    status: String(r.status),
    requested_at: String(r.requested_at),
  }));
}

/** Admin: mark a withdrawal paid (money sent) or rejected (refund the 🔫). */
export async function resolveWithdrawal(id: number, paid: boolean): Promise<boolean> {
  if (paid) {
    const rows = await q(
      "UPDATE withdrawals SET status = 'paid', processed_at = now() WHERE id = $1 AND status = 'pending' RETURNING id",
      [id],
    );
    return rows.length > 0;
  }
  // Rejected → resolve the row, refund BOTH balances and journal the reversal in
  // one atomic statement (no divergence between balances and the ledger).
  const rows = await q(
    `WITH upd AS (
       UPDATE withdrawals SET status = 'rejected', processed_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING user_id, amount
     ), usr AS (
       UPDATE users SET credits = credits + (SELECT amount FROM upd),
                        partner_withdrawable = partner_withdrawable + (SELECT amount FROM upd)
       WHERE id = (SELECT user_id FROM upd) RETURNING id
     ), l AS (
       INSERT INTO ledger (user_id, delta, reason, meta)
       SELECT user_id, amount, 'withdrawal_reject', $1::text FROM upd RETURNING 1
     )
     SELECT user_id FROM upd`,
    [id],
  );
  return rows.length > 0;
}

// ---- Kaspi orders ----

export interface OrderRow {
  id: number;
  user_id: number;
  pack_id: string;
  amount_kzt: number;
  status: string;
  created_at: string;
}

function mapOrder(r: Row): OrderRow {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    pack_id: String(r.pack_id),
    amount_kzt: Number(r.amount_kzt),
    status: String(r.status),
    created_at: String(r.created_at),
  };
}

const ORDER_COLS = "id, user_id, pack_id, amount_kzt, status, created_at";

/** Record a pending Kaspi purchase; returns the new order id. */
export async function createOrder(userId: number, packId: string, amountKzt: number): Promise<number> {
  const rows = await q(
    "INSERT INTO orders (user_id, pack_id, amount_kzt) VALUES ($1, $2, $3) RETURNING id",
    [userId, packId, amountKzt],
  );
  return Number(rows[0].id);
}

/** Admin: all pending orders awaiting payment confirmation. */
export async function pendingOrders(): Promise<OrderRow[]> {
  const rows = await q(`SELECT ${ORDER_COLS} FROM orders WHERE status = 'pending' ORDER BY id`);
  return rows.map(mapOrder);
}

export async function getOrder(id: number): Promise<OrderRow | undefined> {
  const rows = await q(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1`, [id]);
  return rows[0] ? mapOrder(rows[0]) : undefined;
}

/**
 * Atomically approve (paid) or reject a pending order — returns the order for the
 * one call that won the transition (so credits are granted exactly once), or null
 * if it was already resolved. Approval does NOT grant credits itself; the caller
 * runs grantPurchase so the referral/partner payouts fire too.
 */
export async function resolveOrder(id: number, approve: boolean): Promise<OrderRow | null> {
  const rows = await q(
    `UPDATE orders SET status = $2, processed_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING ${ORDER_COLS}`,
    [id, approve ? "paid" : "rejected"],
  );
  return rows[0] ? mapOrder(rows[0]) : null;
}

/**
 * Claim an order's credit grant AND perform it, atomically in one statement —
 * returns true only for the ONE call that wins. This is deliberately a single
 * CTE (like addCredits): claiming granted_at in a separate step BEFORE the
 * credit update would let a crash in between mark the order "granted" with no
 * credits ever added — worse than the gap it's meant to close, and invisible
 * to staleGrantedOrders since granted_at would already be set. Bundling them
 * means a retry (reconciler, duplicate webhook, admin re-running /order) is
 * always either a full no-op (already credited) or a full grant — never a
 * half-state.
 */
export async function grantOrderCredits(
  orderId: number,
  userId: number,
  credits: number,
  kzt: number,
): Promise<boolean> {
  const rows = await q(
    `WITH claim AS (
       UPDATE orders SET granted_at = now() WHERE id = $1 AND granted_at IS NULL RETURNING id
     ), bal AS (
       UPDATE users SET credits = credits + $3 WHERE id = $2 AND EXISTS (SELECT 1 FROM claim) RETURNING id
     )
     INSERT INTO ledger (user_id, delta, reason, meta)
     SELECT $2, $3, 'purchase', $4 FROM bal RETURNING user_id`,
    [orderId, userId, credits, String(kzt)],
  );
  return rows.length > 0;
}

/**
 * Orders confirmed paid but never successfully granted, stuck longer than
 * `minutes` — the payment-side counterpart to reapStalePending. A crash
 * between resolveOrder's pending→paid win and grantPurchase's credit/payout
 * work leaves exactly this shape: status='paid', granted_at NULL. Feeds the
 * reconciler sweep in monitor.ts, which retries grantPurchase for each.
 */
export async function staleGrantedOrders(minutes: number): Promise<OrderRow[]> {
  const rows = await q(
    `SELECT ${ORDER_COLS} FROM orders
     WHERE status = 'paid' AND granted_at IS NULL
       AND processed_at < now() - ($1 || ' minutes')::interval
     ORDER BY id`,
    [String(Math.max(1, Math.floor(minutes)))],
  );
  return rows.map(mapOrder);
}

/** Add credits and journal the movement atomically (single CTE statement). */
export async function addCredits(
  userId: number,
  delta: number,
  reason: string,
  meta?: string,
): Promise<void> {
  await q(
    `WITH upd AS (UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING id)
     INSERT INTO ledger (user_id, delta, reason, meta) SELECT $2, $1, $3, $4 FROM upd`,
    [delta, userId, reason, meta ?? null],
  );
}

/** Atomically spend credits; returns false if balance is insufficient. */
export async function spendCredits(userId: number, amount: number, meta?: string): Promise<boolean> {
  const rows = await q(
    `WITH upd AS (
       UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1 RETURNING id
     )
     INSERT INTO ledger (user_id, delta, reason, meta)
     SELECT $2, -$1, 'generation', $3 FROM upd RETURNING user_id`,
    [amount, userId, meta ?? null],
  );
  return rows.length > 0;
}

/**
 * "First result on us" — activation safety net. A brand-new user who can't
 * afford their first premium image gets ONE free render instead of a paywall
 * before they've seen any result (corpus rule: first result free, second paid).
 * Image-only and once per user; the referrer/partner economy is untouched.
 */
export async function hasFreeResult(userId: number): Promise<boolean> {
  const rows = await q("SELECT free_result_used FROM users WHERE id = $1", [userId]);
  return rows.length > 0 && rows[0].free_result_used === false;
}

/** Atomically claim the one-time free result; true only for the call that won it. */
export async function consumeFreeResult(userId: number): Promise<boolean> {
  const rows = await q(
    "UPDATE users SET free_result_used = true WHERE id = $1 AND free_result_used = false RETURNING id",
    [userId],
  );
  return rows.length > 0;
}

/** True while the user still has their one-time free scenario (princess/football). */
export async function hasFreeScenario(userId: number): Promise<boolean> {
  const rows = await q("SELECT free_scenario_used FROM users WHERE id = $1", [userId]);
  return rows.length > 0 && rows[0].free_scenario_used === false;
}

/** Atomically claim the free scenario; true only for the call that won it. */
export async function consumeFreeScenario(userId: number): Promise<boolean> {
  const rows = await q(
    "UPDATE users SET free_scenario_used = true WHERE id = $1 AND free_scenario_used = false RETURNING id",
    [userId],
  );
  return rows.length > 0;
}

/** A user eligible for the re-engagement nudge (with the fields that pick the copy). */
export interface NudgeTarget {
  id: number;
  free_scenario_used: boolean;
  credits: number;
}

/**
 * Users to re-engage: dormant (no event for >48h) but recently active (within
 * 14d, so a long-gone user is never blasted), and never nudged before. Batch-
 * capped by the caller; markNudged makes it one-shot per user. Last activity =
 * their most recent event, falling back to signup time when they have none.
 */
export async function usersToNudge(limit: number): Promise<NudgeTarget[]> {
  const rows = await q(
    `SELECT u.id, u.free_scenario_used, u.credits
     FROM users u
     LEFT JOIN (SELECT user_id, MAX(created_at) AS last_at FROM events GROUP BY user_id) e
       ON e.user_id = u.id
     WHERE u.nudged_at IS NULL
       -- half-open window: dormant strictly >48h, but active within the last 14d
       -- (avoids the boundary off-by-one an inclusive BETWEEN would allow).
       AND COALESCE(e.last_at, u.created_at) > now() - interval '14 days'
       AND COALESCE(e.last_at, u.created_at) < now() - interval '48 hours'
     ORDER BY u.id
     LIMIT $1`,
    [Math.max(0, Math.floor(limit))],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    free_scenario_used: r.free_scenario_used === true,
    credits: Number(r.credits),
  }));
}

/**
 * Stamp nudged_at so the sweep never messages the same user twice. Idempotent:
 * only sets it when NULL, so a re-run never overwrites the original nudge time
 * (which analytics/audits rely on).
 */
export async function markNudged(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const ph = ids.map((_, i) => `$${i + 1}`).join(",");
  await q(`UPDATE users SET nudged_at = now() WHERE id IN (${ph}) AND nudged_at IS NULL`, ids);
}

/**
 * Whether the re-engagement sweep already ran on this UTC day — derived from the
 * DB (nudged_at), so a process restart during/after the nudge hour can't run an
 * extra batch the same day and blow past the daily cap. `day` is 'YYYY-MM-DD' UTC.
 */
export async function nudgedOnUtcDay(day: string): Promise<boolean> {
  const rows = await q(
    `SELECT 1 FROM users
     WHERE nudged_at IS NOT NULL
       AND to_char(nudged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $1
     LIMIT 1`,
    [day],
  );
  return rows.length > 0;
}

export async function setPending(
  userId: number,
  action: string | null,
  fileId: string | null,
): Promise<void> {
  await q("UPDATE users SET pending_action = $1, pending_file_id = $2 WHERE id = $3", [
    action,
    fileId,
    userId,
  ]);
}

export async function logGeneration(
  userId: number,
  model: string,
  prompt: string,
  credits: number,
  status: "ok" | "error",
  outputUrl?: string,
  costUsd?: number,
  providerRequestId?: string,
): Promise<void> {
  await q(
    `INSERT INTO generations (user_id, model, prompt, credits, status, output_url, cost_usd, provider_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, model, prompt, credits, status, outputUrl ?? null, costUsd ?? null, providerRequestId ?? null],
  );
}

export interface GenerationRow {
  id: number;
  model: string;
  prompt: string | null;
  credits: number;
  status: string;
  output_url: string | null;
  /** All output URLs when a render produced more than one (num_images > 1); null otherwise. */
  output_urls: string[] | null;
  created_at: string;
}

function mapGeneration(r: Row): GenerationRow {
  let outputUrls: string[] | null = null;
  if (typeof r.output_urls === "string") {
    try {
      const parsed: unknown = JSON.parse(r.output_urls);
      if (Array.isArray(parsed) && parsed.every((u) => typeof u === "string")) outputUrls = parsed;
    } catch {
      outputUrls = null; // corrupt/legacy value — degrade to the single output_url
    }
  }
  return {
    id: Number(r.id),
    model: r.model as string,
    prompt: (r.prompt as string | null) ?? null,
    credits: Number(r.credits),
    status: r.status as string,
    output_url: (r.output_url as string | null) ?? null,
    output_urls: outputUrls,
    created_at: String(r.created_at),
  };
}

/**
 * Web-flow generations run async (HTTP returns immediately, the client polls):
 * insert a 'pending' row up front, complete it when the provider answers.
 */
export async function createPendingGeneration(
  userId: number,
  model: string,
  prompt: string,
  credits: number,
): Promise<number> {
  const rows = await q(
    "INSERT INTO generations (user_id, model, prompt, credits, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING id",
    [userId, model, prompt, credits],
  );
  return Number(rows[0].id);
}

/**
 * Finish a pending generation — an atomic compare-and-set on status='pending'.
 * Returns true only for the call that won the pending→terminal transition, so
 * compensation (refund / free-restore) can be gated on it: a detached render
 * tail, its own late retry, and the stale-generation reaper can never all
 * compensate the same row. Callers that don't care (web poll) ignore the bool.
 */
export async function completeGeneration(
  id: number,
  status: "ok" | "error",
  outputUrl?: string,
  costUsd?: number,
  providerRequestId?: string,
  outputUrls?: string[],
): Promise<boolean> {
  const rows = await q(
    `UPDATE generations SET status = $1, output_url = $2, cost_usd = $3, provider_request_id = $4, output_urls = $6
     WHERE id = $5 AND status = 'pending' RETURNING id`,
    [
      status,
      outputUrl ?? null,
      costUsd ?? null,
      providerRequestId ?? null,
      id,
      outputUrls && outputUrls.length > 1 ? JSON.stringify(outputUrls) : null,
    ],
  );
  return rows.length > 0;
}

/**
 * A user's real provider spend (USD) over a rolling window — the per-user COGS
 * a free/reward path (welcome bonus, referral, roadmap gift…) must be checked
 * against before it ships. Sums the actual cost_usd logged on delivery, not
 * the patron charge, so it reflects real money regardless of whether the
 * generation was paid for with purchased or free/gifted patrons.
 */
export async function userCogsUsd(userId: number, hours = 24): Promise<number> {
  const rows = await q(
    `SELECT COALESCE(SUM(cost_usd), 0) AS c FROM generations
     WHERE user_id = $1 AND status = 'ok' AND created_at > now() - make_interval(hours => $2)`,
    [userId, hours],
  );
  return Number(rows[0].c);
}

/**
 * Users whose rolling spend crossed the alert threshold — feeds the ops sweep
 * in monitor.ts (checkAlerts). Not a block: a legitimate heavy PAYER can trip
 * this harmlessly (they already cleared margin); the point is visibility on
 * abuse of a free/reward path, which is exactly the uncapped-loss risk item 0
 * exists to catch.
 */
export async function usersOverCogsThreshold(
  thresholdUsd: number,
  hours = 24,
): Promise<Array<{ userId: number; cogsUsd: number }>> {
  const rows = await q(
    `SELECT user_id, SUM(cost_usd) AS c FROM generations
     WHERE status = 'ok' AND created_at > now() - make_interval(hours => $2)
     GROUP BY user_id HAVING SUM(cost_usd) > $1
     ORDER BY c DESC`,
    [thresholdUsd, hours],
  );
  return rows.map((r) => ({ userId: Number(r.user_id), cogsUsd: Number(r.c) }));
}

/**
 * Approximate reroll rate: the share of terminal generations that are a
 * SAME-USER, SAME-MODEL repeat within `windowMinutes` of a prior one — a proxy
 * for "the user didn't keep the first take and tried again." This is a heuristic,
 * not a precise measurement (there's no explicit "regenerate" action distinct
 * from "new generation" yet) — treat it as directional, not exact, per item 0's
 * mandate to have SOME visibility into this before pricing reward economics on
 * a first-take-success assumption.
 */
export async function rerollRateApprox(
  hours = 24,
  windowMinutes = 10,
): Promise<{ total: number; rerolls: number; ratePct: number | null }> {
  const rows = await q(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM generations p
           WHERE p.user_id = g.user_id AND p.model = g.model AND p.id < g.id
             AND g.created_at - p.created_at <= make_interval(mins => $2)
         )
       )::int AS rerolls
     FROM generations g
     WHERE g.status IN ('ok', 'error') AND g.created_at > now() - make_interval(hours => $1)`,
    [hours, windowMinutes],
  );
  const total = Number(rows[0]?.total ?? 0);
  const rerolls = Number(rows[0]?.rerolls ?? 0);
  return { total, rerolls, ratePct: total > 0 ? Math.round((rerolls / total) * 100) : null };
}

/** Return a burned "first result" freebie (idempotent) — used when a free render fails. */
export async function restoreFreeResult(userId: number): Promise<void> {
  await q("UPDATE users SET free_result_used = false WHERE id = $1 AND free_result_used = true", [userId]);
}

/** Return a burned free scenario (idempotent) — used when the free chain fails. */
export async function restoreFreeScenario(userId: number): Promise<void> {
  await q("UPDATE users SET free_scenario_used = false WHERE id = $1 AND free_scenario_used = true", [userId]);
}

/** A generation the reaper failed for being stuck 'pending' too long. */
export interface StaleGeneration {
  id: number;
  user_id: number;
  model: string;
  credits: number;
}

/**
 * Reaper: atomically fail generations left in 'pending' beyond `minutes` (a
 * detached render whose process died mid-flight — the early-ack means Telegram
 * won't redeliver, so nothing else recovers them) and return them so the caller
 * refunds. The status flip is a single guarded UPDATE, so a late-recovering tail
 * (which also uses completeGeneration's CAS) and the reaper can never both
 * compensate the same row. `credits` is what was charged (0 for a free render →
 * nothing to refund).
 */
export async function reapStalePending(minutes: number): Promise<StaleGeneration[]> {
  const rows = await q(
    `UPDATE generations SET status = 'error'
     WHERE status = 'pending' AND created_at < now() - ($1 || ' minutes')::interval
     RETURNING id, user_id, model, credits`,
    [String(Math.max(1, Math.floor(minutes)))],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    user_id: Number(r.user_id),
    model: String(r.model),
    credits: Number(r.credits),
  }));
}

/** One generation, scoped to its owner — powers the web app's status polling. */
export async function getGeneration(id: number, userId: number): Promise<GenerationRow | undefined> {
  const rows = await q(
    "SELECT id, model, prompt, credits, status, output_url, output_urls, created_at FROM generations WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0] ? mapGeneration(rows[0]) : undefined;
}

/** A user's recent generations (newest first) — powers the web-app gallery. */
export async function recentGenerations(userId: number, limit = 30): Promise<GenerationRow[]> {
  const rows = await q(
    `SELECT id, model, prompt, credits, status, output_url, output_urls, created_at
     FROM generations WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map(mapGeneration);
}

/**
 * One page of a user's finished works (status='ok' with an output), newest
 * first, plus the total count — powers the paginated «Мои работы» gallery.
 * Only completed works are counted so page numbers stay stable/accurate.
 */
export async function galleryPage(
  userId: number,
  limit: number,
  offset: number,
): Promise<{ items: GenerationRow[]; total: number }> {
  const items = await q(
    `SELECT id, model, prompt, credits, status, output_url, output_urls, created_at
     FROM generations
     WHERE user_id = $1 AND status = 'ok' AND output_url IS NOT NULL
     ORDER BY id DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  const cnt = await q(
    `SELECT COUNT(*)::int AS c FROM generations
     WHERE user_id = $1 AND status = 'ok' AND output_url IS NOT NULL`,
    [userId],
  );
  return { items: items.map(mapGeneration), total: Number(cnt[0]?.c ?? 0) };
}

/**
 * Prompt Enhancer free-rule (Cinema Studio ②, decision D2): the FIRST enhance
 * after each generation start is free. Derived from the events log — free iff
 * the user's most recent 'enhance'/'gen_start' event is a gen_start (every
 * render re-arms one free enhance), or neither exists yet (a brand-new user's
 * very first enhance is free). No schema change, no extra counter to drift.
 */
export async function enhanceIsFree(userId: number): Promise<boolean> {
  const rows = await q(
    `SELECT type FROM events WHERE user_id = $1 AND type IN ('enhance','gen_start')
     ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return rows.length === 0 || rows[0].type === "gen_start";
}

/**
 * Records a behavioural event, opening a new visit (session_start) when the
 * previous event is older than SESSION_GAP_MIN (or on the first event).
 */
export async function logEvent(userId: number, type: string, meta?: string): Promise<void> {
  const last = await q(
    `SELECT session_id, EXTRACT(EPOCH FROM (now() - created_at)) AS age_sec
     FROM events WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  const prevSession = last[0] ? Number(last[0].session_id) : 0;
  const ageSec = last[0] ? Number(last[0].age_sec) : Infinity;

  let sessionId = prevSession || 1;
  if (!last[0] || ageSec >= SESSION_GAP_MIN * 60) {
    sessionId = prevSession + 1;
    await q("INSERT INTO events (user_id, session_id, type) VALUES ($1, $2, 'session_start')", [
      userId,
      sessionId,
    ]);
  }
  await q("INSERT INTO events (user_id, session_id, type, meta) VALUES ($1, $2, $3, $4)", [
    userId,
    sessionId,
    type,
    meta ?? null,
  ]);
}

/** Per-user dashboard totals for the web app. */
export async function userDashboard(userId: number): Promise<{
  credits: number;
  totalGenerations: number;
  okGenerations: number;
  creditsSpent: number;
  purchases: number;
  referralEarned: number;
  referralCount: number; // friends invited (distinct users)
  referralPaying: number; // of them, friends who have purchased
  watermarkEnabled: boolean; // brand deliverables (user setting)
  xp: number; // reward-architecture P1 — permanent, zero-COGS, never spendable
  level: number; // derived from xp; 0 until economy_config's level.threshold.* is configured
}> {
  const u = await q("SELECT credits, watermark_enabled, xp FROM users WHERE id = $1", [userId]);
  const gen = await q(
    `SELECT COUNT(*)::int AS total,
            COALESCE(SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END),0)::int AS ok
     FROM generations WHERE user_id = $1`,
    [userId],
  );
  const spent = await q(
    "SELECT COALESCE(SUM(-delta),0)::int AS s FROM ledger WHERE user_id = $1 AND reason = 'generation'",
    [userId],
  );
  const purchases = await q(
    "SELECT COUNT(*)::int AS c FROM ledger WHERE user_id = $1 AND reason = 'purchase'",
    [userId],
  );
  const earned = await q(
    `SELECT COALESCE(SUM(delta),0)::int AS earned FROM ledger
     WHERE user_id = $1 AND reason IN ('referral','referral_bonus','referral_milestone')`,
    [userId],
  );
  const friends = await q(
    `SELECT COUNT(*)::int AS invited,
            COALESCE(SUM(CASE WHEN ref_first_purchase_at IS NOT NULL THEN 1 ELSE 0 END),0)::int AS paying
     FROM users WHERE referrer_id = $1`,
    [userId],
  );
  return {
    credits: u[0] ? Number(u[0].credits) : 0,
    totalGenerations: Number(gen[0].total),
    okGenerations: Number(gen[0].ok),
    creditsSpent: Number(spent[0].s),
    purchases: Number(purchases[0].c),
    referralEarned: Number(earned[0].earned),
    referralCount: Number(friends[0].invited),
    referralPaying: Number(friends[0].paying),
    watermarkEnabled: u[0] ? u[0].watermark_enabled !== false : true,
    xp: u[0] ? Number(u[0].xp) : 0,
    level: await getLevel(userId),
  };
}

export interface ReferralEntry {
  username: string | null; // Telegram @username if known (we don't store first_name)
  joinedAt: string; // ISO — when they joined via the link
  status: "inactive" | "used_free" | "paid";
}

/**
 * Per-referral drill-down for the "Друзья" page — the inviter seeing which
 * invited friends actually did something, not just an aggregate count (the
 * aggregate lives in userDashboard). Status is derived entirely from signals
 * already in the schema — NO new columns:
 *  - paid: the friend has purchased at least once (ref_first_purchase_at is set
 *    on the invitee at their 1st purchase — the same flag that fires the
 *    inviter's first-purchase bonus), so the inviter is earning the lifetime share.
 *  - used_free: no purchase yet, but ≥1 successful generation — they've actually
 *    tried the studio on free/gifted patrons.
 *  - inactive: joined via the link but never rendered anything.
 * Newest-first and capped — this is a motivational list, not an analytics table.
 */
export async function referralList(userId: number, limit = 100): Promise<ReferralEntry[]> {
  // Correlate the "has this friend rendered anything" check to each referred
  // user rather than aggregating the whole generations table on every /api/me:
  // we only need a boolean per friend, and EXISTS short-circuits on the first ok
  // row (indexed by user_id). Cheap even as generations grows.
  const rows = await q(
    `SELECT u.username,
            u.created_at,
            u.ref_first_purchase_at,
            EXISTS (
              SELECT 1 FROM generations g WHERE g.user_id = u.id AND g.status = 'ok'
            ) AS has_generation
     FROM users u
     WHERE u.referrer_id = $1
     ORDER BY u.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r): ReferralEntry => ({
    username: r.username == null ? null : String(r.username),
    joinedAt: String(r.created_at),
    status: r.ref_first_purchase_at != null ? "paid" : r.has_generation ? "used_free" : "inactive",
  }));
}

export interface SegmentSizing {
  productPresetUsers: number; // distinct users who generated with a product-category preset
  totalGenerators: number; // distinct users with ≥1 generation of any kind
  totalUsers: number; // all registered users
  sharePct: number; // productPresetUsers / totalGenerators × 100 (0 if no generators)
}

/**
 * Ad-hoc sizing of the "marketplace seller" segment — how many users actually
 * reach for the product/маркетплейс presets, the behavioural proxy for the
 * stated B2B/SMB seller ICP (docs/web-app.md). Read-only, run on demand from
 * scripts/segment-sizing.mts; deliberately NOT a live dashboard (monitor.ts's
 * philosophy: no cohorts/dashboards before ~1,000 users).
 *
 * ⚠️ Signal completeness: usage is counted from `preset` events. The bot has
 * always logged preset taps; the web studio only started logging plain-preset
 * taps in the same change that added this function — so numbers reflect web
 * usage from that point forward (bot usage is fully historical). Treat an early
 * reading as a floor, not a census.
 */
export async function sellerSegmentSizing(productPresetIds: string[]): Promise<SegmentSizing> {
  const [seg, gens, users] = await Promise.all([
    q(
      "SELECT COUNT(DISTINCT user_id)::int AS c FROM events WHERE type = 'preset' AND meta = ANY($1::text[])",
      [productPresetIds],
    ),
    q("SELECT COUNT(DISTINCT user_id)::int AS c FROM generations", []),
    q("SELECT COUNT(*)::int AS c FROM users", []),
  ]);
  const productPresetUsers = Number(seg[0].c);
  const totalGenerators = Number(gens[0].c);
  return {
    productPresetUsers,
    totalGenerators,
    totalUsers: Number(users[0].c),
    sharePct: totalGenerators > 0 ? Math.round((productPresetUsers / totalGenerators) * 1000) / 10 : 0,
  };
}

/**
 * Real per-preset tap counts from the events log — the "usage"/"trending"
 * signal for the prompt-library gallery (docs/prompt-library.md). Reads the
 * SAME `events` rows sellerSegmentSizing does (type='preset', bare id — no
 * colon; colon-joined meta is a campaign-scenario tap, a different surface).
 * Genuine usage, never a fabricated counter: a preset with zero taps just
 * doesn't appear in the map, and the caller treats that as 0 — no "trending"
 * badge shows until a look has actually been picked.
 */
export async function presetUsageCounts(): Promise<Record<string, number>> {
  const rows = await q(
    "SELECT meta AS id, COUNT(*)::int AS c FROM events WHERE type = 'preset' AND meta NOT LIKE '%:%' GROUP BY meta",
    [],
  );
  return Object.fromEntries(rows.map((r) => [String(r.id), Number(r.c)]));
}

export interface RoadmapProgress {
  firstPhoto: boolean; // any successful generation
  ownIdea: boolean; // a text_to_image render (typed a prompt, no upload)
  revivePhoto: boolean; // an image_to_video render (animated a photo)
  scenario: boolean; // tapped into a campaign preset (сказка/кумиры/кино…)
  invitedFriend: boolean; // at least one referred friend
}

/**
 * "Ваш путь в NeuroShot" roadmap step completion — built ONLY from signals that
 * genuinely distinguish what the step describes, not a fabricated progress bar:
 *  - firstPhoto/ownIdea/revivePhoto come from generations.model, classified by
 *    the model's real `kind` (models.ts) — a text_to_image render really is
 *    "своя идея", not a guess.
 *  - scenario comes from the events log's `preset` taps: campaign preset ids are
 *    logged as "camp:preset" (colon-joined — see the cpre: middleware in bot.ts),
 *    a plain photoshoot preset has no colon, so this is genuinely "used a
 *    сценарий" and not just "used any preset".
 * This intentionally does NOT require a schema change — both signals already
 * exist for other reasons (dashboards, analytics).
 */
export async function roadmapProgress(userId: number): Promise<RoadmapProgress> {
  const [gen, scenarioTap, friend] = await Promise.all([
    q("SELECT DISTINCT model FROM generations WHERE user_id = $1 AND status = 'ok'", [userId]),
    q("SELECT 1 FROM events WHERE user_id = $1 AND type = 'preset' AND meta LIKE '%:%' LIMIT 1", [userId]),
    q("SELECT 1 FROM users WHERE referrer_id = $1 LIMIT 1", [userId]),
  ]);
  const kinds = new Set(gen.map((r) => (MODELS as Record<string, { kind: string }>)[String(r.model)]?.kind));
  return {
    firstPhoto: gen.length > 0,
    ownIdea: kinds.has("text_to_image"),
    revivePhoto: kinds.has("image_to_video"),
    scenario: scenarioTap.length > 0,
    invitedFriend: friend.length > 0,
  };
}

/**
 * Move the one-time "all 5 roadmap steps done" gift into the spendable balance
 * — exactly once. Mirrors claimWelcomeBonus's claim-gating (a deliberate tap
 * reads as a real reward) and its atomicity fix (credit move + ledger row in
 * one writable-CTE statement). Returns null if any step is still incomplete or
 * the bonus was already claimed.
 */
export async function claimRoadmapBonus(userId: number, bonus: number): Promise<{ granted: number } | null> {
  const progress = await roadmapProgress(userId);
  const allDone =
    progress.firstPhoto && progress.ownIdea && progress.revivePhoto && progress.scenario && progress.invitedFriend;
  if (!allDone || bonus <= 0) return null;
  const rows = await q(
    `WITH claim AS (
       UPDATE users SET credits = credits + $2, roadmap_bonus_claimed = true
       WHERE id = $1 AND roadmap_bonus_claimed = false
       RETURNING id
     ),
     ins AS (
       INSERT INTO ledger (user_id, delta, reason) SELECT id, $2, 'roadmap_complete' FROM claim RETURNING 1
     )
     SELECT * FROM claim`,
    [userId, bonus],
  );
  if (!rows.length) return null;
  return { granted: bonus };
}

/**
 * Record that a user has been shown the first-launch onboarding slideshow —
 * independent of the welcome-bonus claim, so a user who already claimed (or
 * spent) their free patrons long ago still gets the redesigned slideshow once.
 * Idempotent; replaying the slideshow from the "Ещё" tab calls this again
 * harmlessly.
 */
export async function markOnboardingSeen(userId: number): Promise<void> {
  await q("UPDATE users SET onboarding_seen = true WHERE id = $1", [userId]);
}

/**
 * Conversion funnel + drop-off diagnosis over the whole event log.
 */
export async function funnel(): Promise<{
  visitors: number;
  visits: number;
  uploadedPhoto: number;
  startedGen: number;
  succeededGen: number;
  hitPaywall: number;
  paid: number;
  dropoff: {
    neverGenerated: number;
    genFailedNoPaid: number;
    paywallNoPaid: number;
    triedFreeNoPaid: number;
  };
}> {
  const distinct = async (type: string) =>
    Number(
      (await q("SELECT COUNT(DISTINCT user_id)::int AS c FROM events WHERE type = $1", [type]))[0].c,
    );
  const usersWith = async (type: string) =>
    new Set(
      (await q("SELECT DISTINCT user_id FROM events WHERE type = $1", [type])).map((r) =>
        Number(r.user_id),
      ),
    );

  const visits = Number(
    (await q("SELECT COUNT(*)::int AS c FROM events WHERE type = 'session_start'"))[0].c,
  );
  const visitorSet = await usersWith("session_start");
  const starters = await usersWith("gen_start");
  const succeeders = await usersWith("gen_ok");
  const errored = await usersWith("gen_error");
  const paywalled = await usersWith("paywall");
  const paidSet = await usersWith("purchase");

  const minus = (a: Set<number>, b: Set<number>) => [...a].filter((x) => !b.has(x)).length;

  return {
    visitors: visitorSet.size,
    visits,
    uploadedPhoto: await distinct("photo"),
    startedGen: starters.size,
    succeededGen: succeeders.size,
    hitPaywall: paywalled.size,
    paid: paidSet.size,
    dropoff: {
      neverGenerated: minus(visitorSet, starters),
      genFailedNoPaid: minus(errored, paidSet),
      paywallNoPaid: minus(paywalled, paidSet),
      triedFreeNoPaid: minus(succeeders, paidSet),
    },
  };
}

export async function stats(): Promise<{
  users: number;
  paid: number;
  generations: number;
  kztRevenue: number;
}> {
  const users = Number((await q("SELECT COUNT(*)::int AS c FROM users"))[0].c);
  const paid = Number(
    (await q("SELECT COUNT(DISTINCT user_id)::int AS c FROM ledger WHERE reason = 'purchase'"))[0].c,
  );
  const generations = Number((await q("SELECT COUNT(*)::int AS c FROM generations"))[0].c);
  const kztRevenue = Number(
    (
      await q(
        "SELECT COALESCE(SUM(CAST(meta AS INTEGER)),0)::int AS s FROM ledger WHERE reason = 'purchase'",
      )
    )[0].s,
  );
  return { users, paid, generations, kztRevenue };
}

// ---- Reward-architecture economy config (P0) ----
// Deliberately no in-code defaults/fallbacks for these values: an unset key means
// the feature reading it stays inert (e.g. "no XP awarded", "no season active")
// rather than silently running on a guessable public-source number. See the
// table comment above and neuroshot-reward-architecture-v1.md §8.

/** A tuned economy scalar (XP-per-action, level threshold, season cap, …), or null if never set. */
export async function getEconomyConfig(key: string): Promise<number | null> {
  const rows = await q("SELECT value FROM economy_config WHERE key = $1", [key]);
  return rows[0] ? Number(rows[0].value) : null;
}

/** Admin-only write path (bot.ts /econ_set) — upserts a single tuned value. */
export async function setEconomyConfig(key: string, value: number): Promise<void> {
  await q(
    `INSERT INTO economy_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, value],
  );
}

/** Every tuned value currently set — powers the admin /econ listing. Never user-facing. */
export async function allEconomyConfig(): Promise<Array<{ key: string; value: number }>> {
  const rows = await q("SELECT key, value FROM economy_config ORDER BY key");
  return rows.map((r) => ({ key: String(r.key), value: Number(r.value) }));
}

/** The minimum account Level required to use a preset, or null if ungated (open to everyone). */
export async function getPresetMinLevel(presetId: string): Promise<number | null> {
  const rows = await q("SELECT min_level FROM preset_gating WHERE preset_id = $1", [presetId]);
  return rows[0] ? Number(rows[0].min_level) : null;
}

/** Admin-only write path (bot.ts /econ_gate) — upserts one preset's level gate. */
export async function setPresetGating(presetId: string, minLevel: number): Promise<void> {
  await q(
    `INSERT INTO preset_gating (preset_id, min_level) VALUES ($1, $2)
     ON CONFLICT (preset_id) DO UPDATE SET min_level = $2, updated_at = now()`,
    [presetId, minLevel],
  );
}

/** Every preset gate currently set — powers the admin /econ listing. */
export async function allPresetGating(): Promise<Array<{ preset_id: string; min_level: number }>> {
  const rows = await q("SELECT preset_id, min_level FROM preset_gating ORDER BY preset_id");
  return rows.map((r) => ({ preset_id: String(r.preset_id), min_level: Number(r.min_level) }));
}

// ---- Reward-architecture XP / Level (P1) ----
// XP is a separate, zero-COGS currency from Кадры/credits — it is NEVER
// spendable and never converts (neuroshot-reward-architecture-v1.md §2). It only
// ever moves the permanent Level, which only ever gates ACCESS (preset_gating),
// never generation volume. `action` values award whatever economy_config has
// configured for `xp.<action>` — an unconfigured action awards 0 and writes
// nothing, so this whole subsystem is inert until an admin opts pieces of it in.

/** Total permanent XP a user has accumulated (never resets, never spendable). */
export async function getUserXp(userId: number): Promise<number> {
  const rows = await q("SELECT xp FROM users WHERE id = $1", [userId]);
  return rows[0] ? Number(rows[0].xp) : 0;
}

/**
 * Award XP for a named action (only if `xp.<action>` is configured — see
 * economy_config above) and journal it. Returns the amount actually awarded
 * (0 if the action isn't configured, i.e. this feature isn't turned on yet).
 */
export async function awardXp(userId: number, action: string, meta?: string): Promise<number> {
  const amount = await getEconomyConfig(`xp.${action}`);
  if (!amount) return 0;
  await q(
    `WITH upd AS (UPDATE users SET xp = xp + $1 WHERE id = $2 RETURNING id)
     INSERT INTO xp_ledger (user_id, delta, reason, meta) SELECT $2, $1, $3, $4 FROM upd`,
    [amount, userId, action, meta ?? null],
  );
  return amount;
}

/**
 * Derive the account's permanent Level from its XP against economy_config's
 * `level.threshold.<N>` ladder (N=1,2,3,…, each value = cumulative XP required).
 * Walks upward from 1 while a threshold is configured AND met; stops at the
 * first gap (unset threshold) or the first unmet one. Level 0 means either no
 * thresholds are configured yet, or XP hasn't reached level.threshold.1 —
 * either way, preset_gating checks against Level 0 unlock only ungated presets.
 */
export async function getLevel(userId: number): Promise<number> {
  const xp = await getUserXp(userId);
  let level = 0;
  for (let n = 1; n <= 100; n++) {
    const threshold = await getEconomyConfig(`level.threshold.${n}`);
    if (threshold == null || xp < threshold) break;
    level = n;
  }
  return level;
}

/**
 * Claim the one-time "save" XP for a generation — idempotent (xp_save_claims
 * is a hard PK guard, so re-tapping "Скачать" can't re-earn it) and daily-capped
 * via economy_config's `xp.save.dailycap` (unset = uncapped once xp.save itself
 * is configured). Only the generation's OWNER can claim it, and only for a
 * completed ('ok') render. Returns the XP actually awarded (0 if already
 * claimed, not the owner, not done, capped, or xp.save isn't configured).
 */
export async function claimSaveXp(generationId: number, userId: number): Promise<number> {
  // Check whether the feature is even on FIRST, before touching the claims
  // table — otherwise a save tapped while xp.save is still unconfigured would
  // permanently burn that generation's one-time claim slot, and turning the
  // feature on later could never award it retroactively.
  const amount = await getEconomyConfig("xp.save");
  if (!amount) return 0;
  const gen = await q("SELECT id FROM generations WHERE id = $1 AND user_id = $2 AND status = 'ok'", [
    generationId,
    userId,
  ]);
  if (!gen.length) return 0;
  const won = await q(
    "INSERT INTO xp_save_claims (generation_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING generation_id",
    [generationId],
  );
  if (!won.length) return 0; // already claimed
  const cap = await getEconomyConfig("xp.save.dailycap");
  if (cap != null) {
    const today = await q(
      "SELECT COUNT(*)::int AS c FROM xp_ledger WHERE user_id = $1 AND reason = 'save' AND created_at > now() - interval '24 hours'",
      [userId],
    );
    if (Number(today[0].c) >= cap) return 0;
  }
  return awardXp(userId, "save", String(generationId));
}
