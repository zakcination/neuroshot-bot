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
`);

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
): void {
  db.prepare(
    "INSERT INTO generations (user_id, model, prompt, credits, status) VALUES (?, ?, ?, ?, ?)",
  ).run(userId, model, prompt, credits, status);
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
