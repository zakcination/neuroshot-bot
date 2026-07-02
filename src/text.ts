/** Russian-language helpers for user-facing copy. */

/**
 * Correct Russian plural of "кредит" for any count.
 * 1 кредит · 2–4 кредита · 5–20 кредитов · 21 кредит · …
 */
export function nCredits(n: number): string {
  const abs = Math.abs(n);
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  let word: string;
  if (mod100 >= 11 && mod100 <= 14) word = "кредитов";
  else if (mod10 === 1) word = "кредит";
  else if (mod10 >= 2 && mod10 <= 4) word = "кредита";
  else word = "кредитов";
  return `${n} ${word}`;
}
