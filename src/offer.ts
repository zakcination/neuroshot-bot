/**
 * The launch combo offer's countdown — one source of truth shared by the bot
 * (a static "осталось Nд Nч" snapshot in the paywall/buy message) and the Mini
 * App (a live 1-second ticker fed by /api/me). Both read the SAME end timestamp
 * so the deadline a user sees in chat matches the one in the app.
 *
 * The window is COMBO_OFFER_DAYS long, anchored at COMBO_OFFER_START (ISO) if
 * set, else at process boot — so a fresh deploy runs the sale for ~a month
 * unless a fixed date is pinned. The deadline is a single real countdown, not a
 * fake per-user timer that silently resets on every visit. Pin COMBO_OFFER_START
 * to fix an exact end date; leaving it unset re-anchors to boot on each redeploy
 * (fine for a rolling launch window). See docs/pricing.md.
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

// --- Seedance 2.0 launch promo — same anchor/window shape as the combo offer
// above, kept as separate functions rather than a generalized "any offer"
// abstraction: the two sales differ in what they discount (a pack's ₸ price
// vs a model's patron charge) and in where they're read from (payments.ts/
// app.html vs priceFor), so sharing one function would need a branch on kind
// at every call site instead of two small, obviously-correct ones.

/** The Seedance promo's end timestamp (ms epoch). */
export function seedancePromoEndsAt(): number {
  const start = config.seedancePromoStart ? Date.parse(config.seedancePromoStart) : NaN;
  const base = Number.isNaN(start) ? BOOT_MS : start;
  return base + config.seedancePromoDays * 86_400_000;
}

/** True while the Seedance promo is still running. */
export function seedancePromoActive(now: number = Date.now()): boolean {
  return config.seedancePromoPct > 0 && seedancePromoEndsAt() > now;
}

/**
 * The multiplier priceFor applies to a Seedance model's charge while the promo
 * is live — e.g. 0.7 at a 30% discount. 1 (no-op) once the window closes, so
 * an expired promo silently reverts to full price rather than needing a
 * separate "did it end" check at every call site.
 */
export function seedancePromoMult(now: number = Date.now()): number {
  return seedancePromoActive(now) ? 1 - config.seedancePromoPct : 1;
}

/** "Nд Nч" remaining for the Seedance promo's static countdown snapshot. */
export function seedancePromoLeftText(now: number = Date.now()): string {
  const ms = seedancePromoEndsAt() - now;
  if (ms <= 0) return "";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  return days > 0 ? `${days}д ${hours}ч` : `${hours}ч`;
}
