/**
 * Time-boxed pricing windows — one source of truth shared by the bot (a static
 * "осталось Nд Nч" snapshot at send time) and the Mini App (a live 1-second
 * ticker fed by /api/me). Both read the SAME end timestamp so the deadline a
 * user sees in chat matches the one in the app.
 *
 * Two independent windows live here:
 *  - the launch combo offer (a discounted PACK), rolling N days from boot or a
 *    pinned start — see docs/pricing.md;
 *  - the Seedance sale (a discounted CHARGE on specific models), a fixed
 *    calendar deadline the owner named directly — see docs/seedance-tiers.md.
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

/**
 * The Seedance sale's end timestamp (ms epoch) — a fixed calendar deadline
 * (config.seedanceSaleUntil), unlike the combo offer's rolling N-day window:
 * the owner named an actual date, so the countdown is anchored to it directly
 * rather than to a boot time. An unparseable config value returns a timestamp
 * of 0 (already in the past), so a broken date reads as "sale over" rather
 * than "sale on forever" — the safe direction for a pricing failure.
 */
export function seedanceSaleEndsAt(): number {
  const end = Date.parse(config.seedanceSaleUntil);
  return Number.isNaN(end) ? 0 : end;
}

/** True while the Seedance sale is still running. */
export function seedanceSaleActive(now: number = Date.now()): boolean {
  return seedanceSaleEndsAt() > now;
}

/** Human "Nд Nч" remaining for the Seedance sale — same shape as comboLeftText. */
export function seedanceSaleLeftText(now: number = Date.now()): string {
  const ms = seedanceSaleEndsAt() - now;
  if (ms <= 0) return "";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  return days > 0 ? `${days}д ${hours}ч` : `${hours}ч`;
}
