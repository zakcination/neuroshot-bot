import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  falKey: required("FAL_KEY"),
  databasePath: process.env.DATABASE_PATH ?? "./data/bot.db",
  freeCredits: Number(process.env.FREE_CREDITS ?? 3),
  adminIds: (process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
};
