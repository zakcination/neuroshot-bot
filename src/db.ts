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
    amount INTEGER NOT NULL,        -- 🔫 requested (moved out of withdrawable)
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
  `CREATE TABLE IF NOT EXISTS ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    delta INTEGER NOT NULL,
    -- signup | purchase | generation | refund | referral (lifetime share)
    -- | referral_join (invitee bonus) | referral_bonus (1st-purchase) | referral_milestone
    -- | partner (creator/partner revenue share) | partner_join (creator-code welcome bonus)
    -- | partner_welcome (self-serve join bonus) | withdrawal | withdrawal_reject
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
  const inserted = await q(
    `INSERT INTO users (id, username, credits, referrer_id, partner_code, source) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [id, username ?? null, freeCredits + bonus, ref, via?.code ?? null, src],
  );
  if (inserted.length) {
    await q("INSERT INTO ledger (user_id, delta, reason) VALUES ($1, $2, 'signup')", [id, freeCredits]);
    if (bonus > 0) {
      if (ref) {
        await q("INSERT INTO ledger (user_id, delta, reason, meta) VALUES ($1, $2, 'referral_join', $3)", [
          id,
          bonus,
          String(ref),
        ]);
      } else if (via) {
        await q("INSERT INTO ledger (user_id, delta, reason, meta) VALUES ($1, $2, 'partner_join', $3)", [
          id,
          bonus,
          via.code,
        ]);
      }
    }
    const u = mapUser(inserted[0]);
    u.justCreated = true;
    u.joinBonus = bonus;
    u.joinVia = ref ? "friend" : via ? "partner" : undefined;
    return u;
  }
  const existing = await q("SELECT * FROM users WHERE id = $1", [id]);
  return mapUser(existing[0]);
}

export async function getUser(id: number): Promise<UserRow | undefined> {
  const rows = await q("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] ? mapUser(rows[0]) : undefined;
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
): Promise<void> {
  await q(
    "INSERT INTO generations (user_id, model, prompt, credits, status, output_url) VALUES ($1, $2, $3, $4, $5, $6)",
    [userId, model, prompt, credits, status, outputUrl ?? null],
  );
}

export interface GenerationRow {
  id: number;
  model: string;
  prompt: string | null;
  credits: number;
  status: string;
  output_url: string | null;
  created_at: string;
}

function mapGeneration(r: Row): GenerationRow {
  return {
    id: Number(r.id),
    model: r.model as string,
    prompt: (r.prompt as string | null) ?? null,
    credits: Number(r.credits),
    status: r.status as string,
    output_url: (r.output_url as string | null) ?? null,
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
): Promise<boolean> {
  const rows = await q(
    "UPDATE generations SET status = $1, output_url = $2 WHERE id = $3 AND status = 'pending' RETURNING id",
    [status, outputUrl ?? null, id],
  );
  return rows.length > 0;
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
    "SELECT id, model, prompt, credits, status, output_url, created_at FROM generations WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0] ? mapGeneration(rows[0]) : undefined;
}

/** A user's recent generations (newest first) — powers the web-app gallery. */
export async function recentGenerations(userId: number, limit = 30): Promise<GenerationRow[]> {
  const rows = await q(
    `SELECT id, model, prompt, credits, status, output_url, created_at
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
    `SELECT id, model, prompt, credits, status, output_url, created_at
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
}> {
  const u = await q("SELECT credits, watermark_enabled FROM users WHERE id = $1", [userId]);
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
  };
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
