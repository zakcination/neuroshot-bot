/**
 * Data layer — async Postgres, one code path for two backends:
 *   • production  → Neon (`DATABASE_URL` set) via @neondatabase/serverless (HTTP,
 *     works in both a long-polling process and Vercel serverless functions);
 *   • tests / local without a DB → embedded Postgres (@electric-sql/pglite).
 *
 * Same SQL on both. All exported functions are async.
 */
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Forward migrations for existing databases (columns added after launch).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_first_purchase_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_milestones INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_code TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS free_result_used BOOLEAN NOT NULL DEFAULT false`,
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
  `CREATE TABLE IF NOT EXISTS ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    delta INTEGER NOT NULL,
    -- signup | purchase | generation | refund | referral (lifetime share)
    -- | referral_join (invitee bonus) | referral_bonus (1st-purchase) | referral_milestone
    -- | partner (creator revenue share) | partner_join (creator-code welcome bonus)
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
  };
}

export async function getOrCreateUser(
  id: number,
  username: string | undefined,
  referrerId: number | null,
  freeCredits: number,
  joinBonus = 0,
  partner: PartnerCodeRow | null = null,
): Promise<UserRow> {
  const ref = referrerId && referrerId !== id ? referrerId : null;
  // Attribution is first-touch and exclusive: friend referral OR creator code.
  const via = !ref && partner && partner.user_id !== id ? partner : null;
  const bonus = ref
    ? Math.max(0, Math.floor(joinBonus))
    : via
      ? Math.max(0, Math.floor(via.join_bonus))
      : 0;
  const inserted = await q(
    `INSERT INTO users (id, username, credits, referrer_id, partner_code) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [id, username ?? null, freeCredits + bonus, ref, via?.code ?? null],
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
}

function mapPartner(r: Row): PartnerCodeRow {
  return {
    code: String(r.code),
    user_id: Number(r.user_id),
    title: (r.title as string | null) ?? null,
    percent: Number(r.percent),
    join_bonus: Number(r.join_bonus),
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
): Promise<{ code: string; ownerId: number; amount: number } | null> {
  const buyer = await getUser(buyerId);
  if (!buyer?.partner_code) return null;
  const pc = await getPartnerCode(buyer.partner_code);
  if (!pc || pc.user_id === buyerId) return null;
  const amount = Math.floor(packCredits * pc.percent);
  if (amount > 0) await addCredits(pc.user_id, amount, "partner", `${pc.code}:${buyerId}`);
  // Mark the buyer as paying (powers the partner dashboard's conversion stat).
  await q("UPDATE users SET ref_first_purchase_at = now() WHERE id = $1 AND ref_first_purchase_at IS NULL", [
    buyerId,
  ]);
  return { code: pc.code, ownerId: pc.user_id, amount };
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

/** Finish a pending web generation (either outcome). */
export async function completeGeneration(
  id: number,
  status: "ok" | "error",
  outputUrl?: string,
): Promise<void> {
  await q("UPDATE generations SET status = $1, output_url = $2 WHERE id = $3", [
    status,
    outputUrl ?? null,
    id,
  ]);
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
}> {
  const u = await q("SELECT credits FROM users WHERE id = $1", [userId]);
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
  starsRevenue: number;
}> {
  const users = Number((await q("SELECT COUNT(*)::int AS c FROM users"))[0].c);
  const paid = Number(
    (await q("SELECT COUNT(DISTINCT user_id)::int AS c FROM ledger WHERE reason = 'purchase'"))[0].c,
  );
  const generations = Number((await q("SELECT COUNT(*)::int AS c FROM generations"))[0].c);
  const starsRevenue = Number(
    (
      await q(
        "SELECT COALESCE(SUM(CAST(meta AS INTEGER)),0)::int AS s FROM ledger WHERE reason = 'purchase'",
      )
    )[0].s,
  );
  return { users, paid, generations, starsRevenue };
}
