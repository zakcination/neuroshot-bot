/**
 * The launch combo offer's countdown — one source of truth shared by the bot
 * (a static "осталось Nд Nч" snapshot in the paywall/buy message) and the Mini
 * App (a live 1-second ticker fed by /api/me). Both read the SAME end timestamp
 * so the deadline a user sees in chat matches the one in the app.
 *
 * The window is COMBO_OFFER_DAYS long, anchored at COMBO_OFFER_START (ISO) if
 * set, else at process boot — so a fresh deploy runs the sale for ~a month
 * unless a fixed date is pinned. The deadline is real and never resets: honesty
 * is structural, not a copywriting promise (see docs/pricing.md).
 */
import { config } from "./config.js";

// Process boot — the default anchor when COMBO_OFFER_START isn't pinned.
const BOOT_MS = Date.now();

/** The combo offer's end timestamp (ms epoch). */
export function comboEndsAt(): number {
  const start = config.comboOfferStart ? Date.parse(config.comboOfferStart) : NaN;
  const base = Number.isNaN(start) ? BOOT_MS : start;
  return base + config.comboOfferDays * 86_400_000;
}

/** True while the combo sale is still running. */
export function comboActive(now: number = Date.now()): boolean {
  return comboEndsAt() > now;
}

/**
 * Human "Nд Nч" remaining for the bot's static countdown snapshot (the chat
 * message can't tick, so it shows the time left at send). Empty when expired.
 */
export function comboLeftText(now: number = Date.now()): string {
  const ms = comboEndsAt() - now;
  if (ms <= 0) return "";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  return days > 0 ? `${days}д ${hours}ч` : `${hours}ч`;
}
