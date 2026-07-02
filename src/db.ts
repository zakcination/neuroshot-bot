import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.databasePath), { recursive: true });
export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,            -- telegram user id
  username TEXT,
  credits INTEGER NOT NULL DEFAULT 0,
  referrer_id INTEGER,
  pending_action TEXT,               -- model key awaiting a prompt
  pending_file_id TEXT,              -- telegram file_id awaiting a prompt
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,              -- signup | purchase | referral | generation | refund
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT,
  credits INTEGER NOT NULL,
  status TEXT NOT NULL,              -- ok | error
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,       -- monotonic per-user visit counter
  type TEXT NOT NULL,                -- session_start | menu_open | select | photo | preset | paywall | gen_start | gen_ok | gen_error | purchase
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id);
`);

// Migration: store the delivered result URL so the same content the bot
// produced is reusable in the web app (shared gallery). Guarded for old DBs.
{
  const cols = db.prepare("PRAGMA table_info(generations)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "output_url")) {
    db.exec("ALTER TABLE generations ADD COLUMN output_url TEXT");
  }
}

/** Minutes of inactivity after which the next interaction counts as a new visit. */
const SESSION_GAP_MIN = 30;

export interface UserRow {
  id: number;
  username: string | null;
  credits: number;
  referrer_id: number | null;
  pending_action: string | null;
  pending_file_id: string | null;
}

export function getOrCreateUser(
  id: number,
  username: string | undefined,
  referrerId: number | null,
  freeCredits: number,
): UserRow {
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (existing) return existing;
  const ref = referrerId && referrerId !== id ? referrerId : null;
  db.prepare("INSERT INTO users (id, username, credits, referrer_id) VALUES (?, ?, ?, ?)").run(
    id,
    username ?? null,
    freeCredits,
    ref,
  );
  db.prepare("INSERT INTO ledger (user_id, delta, reason) VALUES (?, ?, 'signup')").run(id, freeCredits);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
}

export function addCredits(userId: number, delta: number, reason: string, meta?: string): void {
  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(delta, userId);
    db.prepare("INSERT INTO ledger (user_id, delta, reason, meta) VALUES (?, ?, ?, ?)").run(
      userId,
      delta,
      reason,
      meta ?? null,
    );
  });
  tx();
}

/** Atomically spend credits; returns false if balance is insufficient. */
export function spendCredits(userId: number, amount: number, meta?: string): boolean {
  const result = db
    .prepare("UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?")
    .run(amount, userId, amount);
  if (result.changes === 0) return false;
  db.prepare("INSERT INTO ledger (user_id, delta, reason, meta) VALUES (?, ?, 'generation', ?)").run(
    userId,
    -amount,
    meta ?? null,
  );
  return true;
}

export function setPending(userId: number, action: string | null, fileId: string | null): void {
  db.prepare("UPDATE users SET pending_action = ?, pending_file_id = ? WHERE id = ?").run(
    action,
    fileId,
    userId,
  );
}

export function logGeneration(
  userId: number,
  model: string,
  prompt: string,
  credits: number,
  status: "ok" | "error",
  outputUrl?: string,
): void {
  db.prepare(
    "INSERT INTO generations (user_id, model, prompt, credits, status, output_url) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, model, prompt, credits, status, outputUrl ?? null);
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

/** A user's recent generations (newest first) — powers the web-app gallery. */
export function recentGenerations(userId: number, limit = 30): GenerationRow[] {
  return db
    .prepare(
      "SELECT id, model, prompt, credits, status, output_url, created_at FROM generations WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    )
    .all(userId, limit) as GenerationRow[];
}

/** Per-user dashboard totals for the web app (own analytics — novel for the genre). */
export function userDashboard(userId: number): {
  credits: number;
  totalGenerations: number;
  okGenerations: number;
  creditsSpent: number;
  purchases: number;
  referralEarned: number;
  referralCount: number;
} {
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;
  const u = one<{ credits: number } | undefined>("SELECT credits FROM users WHERE id = ?", userId);
  const gen = one<{ total: number; ok: number }>(
    "SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END),0) ok FROM generations WHERE user_id = ?",
    userId,
  );
  const spent = one<{ s: number }>(
    "SELECT COALESCE(SUM(-delta),0) s FROM ledger WHERE user_id = ? AND reason = 'generation'",
    userId,
  );
  const purchases = one<{ c: number }>(
    "SELECT COUNT(*) c FROM ledger WHERE user_id = ? AND reason = 'purchase'",
    userId,
  );
  const ref = one<{ earned: number; c: number }>(
    "SELECT COALESCE(SUM(delta),0) earned, COUNT(*) c FROM ledger WHERE user_id = ? AND reason = 'referral'",
    userId,
  );
  return {
    credits: u?.credits ?? 0,
    totalGenerations: gen.total,
    okGenerations: gen.ok,
    creditsSpent: spent.s,
    purchases: purchases.c,
    referralEarned: ref.earned,
    referralCount: ref.c,
  };
}

/**
 * Records a behavioural event and returns the current session id for the user.
 * A new visit (session_start) is opened when the previous event is older than
 * SESSION_GAP_MIN, or on the very first event.
 */
export function logEvent(userId: number, type: string, meta?: string): void {
  const last = db
    .prepare("SELECT session_id, created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .get(userId) as { session_id: number; created_at: string } | undefined;

  let sessionId = last?.session_id ?? 1;
  // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC): normalize to ISO for Date.
  const lastMs = last ? new Date(last.created_at.replace(" ", "T") + "Z").getTime() : 0;
  const isNewVisit = !last || (Date.now() - lastMs) / 60000 >= SESSION_GAP_MIN;

  if (isNewVisit) {
    sessionId = (last?.session_id ?? 0) + 1;
    db.prepare("INSERT INTO events (user_id, session_id, type) VALUES (?, ?, 'session_start')").run(
      userId,
      sessionId,
    );
  }
  db.prepare("INSERT INTO events (user_id, session_id, type, meta) VALUES (?, ?, ?, ?)").run(
    userId,
    sessionId,
    type,
    meta ?? null,
  );
}

/**
 * Conversion funnel + drop-off diagnosis over the whole event log.
 * Answers "why didn't they order?" by bucketing users at the stage they stalled.
 */
export function funnel(): {
  visitors: number;
  visits: number;
  uploadedPhoto: number;
  startedGen: number;
  succeededGen: number;
  hitPaywall: number;
  paid: number;
  dropoff: {
    neverGenerated: number; // visited, never even started a generation → activation gap
    genFailedNoPaid: number; // hit a provider error, never bought → reliability
    paywallNoPaid: number; // saw the paywall, didn't buy → price/value objection
    triedFreeNoPaid: number; // used free generations, didn't buy → value not proven
  };
} {
  const distinct = (type: string) =>
    (db.prepare("SELECT COUNT(DISTINCT user_id) c FROM events WHERE type = ?").get(type) as { c: number })
      .c;
  const usersWith = (type: string) =>
    new Set(
      (db.prepare("SELECT DISTINCT user_id FROM events WHERE type = ?").all(type) as { user_id: number }[]).map(
        (r) => r.user_id,
      ),
    );

  const visitors = distinct("session_start");
  const visits = (db.prepare("SELECT COUNT(*) c FROM events WHERE type = 'session_start'").get() as {
    c: number;
  }).c;
  const starters = usersWith("gen_start");
  const succeeders = usersWith("gen_ok");
  const errored = usersWith("gen_error");
  const paywalled = usersWith("paywall");
  const paidSet = usersWith("purchase");
  const visitorSet = usersWith("session_start");

  const minus = (a: Set<number>, b: Set<number>) => [...a].filter((x) => !b.has(x)).length;

  return {
    visitors,
    visits,
    uploadedPhoto: distinct("photo"),
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

export function stats(): { users: number; paid: number; generations: number; starsRevenue: number } {
  const users = (db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  const paid = (
    db.prepare("SELECT COUNT(DISTINCT user_id) c FROM ledger WHERE reason = 'purchase'").get() as {
      c: number;
    }
  ).c;
  const generations = (db.prepare("SELECT COUNT(*) c FROM generations").get() as { c: number }).c;
  const starsRevenue = (
    db
      .prepare(
        "SELECT COALESCE(SUM(CAST(meta AS INTEGER)), 0) s FROM ledger WHERE reason = 'purchase'",
      )
      .get() as { s: number }
  ).s;
  return { users, paid, generations, starsRevenue };
}
