/** Russian-language helpers for user-facing copy. */

/**
 * The in-app currency. One place to rebrand it — change the emoji/name here and
 * it updates everywhere (balance, packs, paywall, referral). "Патрон" = a round
 * of ammo you spend on a shot (NeuroShot). Swap UNIT_EMOJI to 🎯/💥 if the
 * water-pistol rendering of 🔫 ever reads wrong.
 */
export const UNIT_EMOJI = "🔫";
export const UNIT_ONE = "патрон";

/**
 * One-line photo-quality nudge shown when we ask for a photo. Blurry / dark /
 * tiny-face source photos are the silent churn driver for non-technical users
 * (a bad result reads as "продукт плохой", not "плохое фото") — see docs/strategy.
 * Kept short so it never buries the ask.
 */
export const PHOTO_TIP =
  "💡 Совет: чёткое фото, лицо крупно и при хорошем свете — так результат получается заметно лучше.";

/** Append the photo-quality tip to a "send me a photo" prompt. */
export function withPhotoTip(ask: string): string {
  return `${ask}\n\n${PHOTO_TIP}`;
}

/**
 * Correct Russian plural of the currency for any count.
 * 1 патрон · 2–4 патрона · 5–20 патронов · 21 патрон · …
 */
export function nUnits(n: number): string {
  const abs = Math.abs(n);
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  let word: string;
  if (mod100 >= 11 && mod100 <= 14) word = "патронов";
  else if (mod10 === 1) word = "патрон";
  else if (mod10 >= 2 && mod10 <= 4) word = "патрона";
  else word = "патронов";
  return `${n} ${word}`;
}

/**
 * Correct Russian plural of "результат" for any count (paywall framing).
 * 1 результат · 2–4 результата · 5–20 результатов · 21 результат · …
 */
export function nResults(n: number): string {
  const abs = Math.abs(n);
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  let word: string;
  if (mod100 >= 11 && mod100 <= 14) word = "результатов";
  else if (mod10 === 1) word = "результат";
  else if (mod10 >= 2 && mod10 <= 4) word = "результата";
  else word = "результатов";
  return `${n} ${word}`;
}
