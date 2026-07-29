/**
 * "Which Seedance should I use?" — a short yes/no quiz that ends on one model.
 *
 * WHY THIS EXISTS. Seedance is our priciest video family and the picker offers
 * it under names that mean nothing to a buyer: Fast, 2.0, and (once wired) Mini.
 * Someone who cannot tell them apart picks by price — either the cheapest, and
 * blames us for the result, or the dearest, and burns patrons on a shot the
 * cheap tier would have rendered identically. Both outcomes cost us money. Four
 * questions is cheaper than one wasted render.
 *
 * WHERE THE ANSWERS COME FROM. Independent side-by-side testing of the three
 * tiers (July 2026), not vendor copy:
 *
 *   • Mini matched the flagship on talking-head and product shots, and even
 *     caught scene details the flagship missed. It is the sane default.
 *   • Mini's real weakness is MOTION: subjects move less than asked, and it
 *     frames wider than requested.
 *   • Mini and Fast both cap at 720p. Resolution is the flagship's ONE
 *     unambiguous advantage — 1080p and 4K exist nowhere else in the family.
 *   • Complex motion combined with emotional speech degrades lip-sync, so a
 *     shot that depends on believable speech wants the more consistent tier.
 *   • Fast is never recommended by this quiz. At ~60% over Mini it was a coin
 *     flip in testing — it produced the single worst clip of the comparison
 *     while occasionally beating both. Paying a premium for variance is not a
 *     recommendation we are willing to make. It stays in the picker (campaign
 *     scenes are pinned to it) but no advice sends anyone there.
 *
 * The questions short-circuit: the first YES ends the quiz. That ordering is
 * deliberate — the cheapest possible answer is reachable in one tap, and the
 * escalations that follow are hard constraints rather than preferences.
 */
import { MODELS, type ModelSpec } from "./models.js";

export interface SeedanceQuestion {
  id: string;
  /** Asked as a yes/no. "Yes" ends the quiz on `verdict`. */
  question: string;
  /** The model a YES lands on. */
  verdict: keyof typeof MODELS;
  /** Shown with the verdict — why this answer decided it. */
  because: string;
}

export const SEEDANCE_QUIZ: SeedanceQuestion[] = [
  {
    id: "draft",
    question: "Это первая проба — вы ещё подбираете кадр и движение?",
    verdict: "seedance_mini",
    because:
      "Пока вы ищете кадр, дорогая модель тратит патроны на черновик. Mini рендерит то же самое " +
      "и оставляет вам патроны на несколько попыток — а переснять удачный вариант на флагмане " +
      "можно потом, уже зная, что снимаете.",
  },
  {
    id: "resolution",
    question: "Нужно качество выше 720p — 1080p или 4K?",
    verdict: "seedance",
    because:
      "Это единственное, чего у младших моделей нет вообще: они упираются в 720p. " +
      "Если ролик пойдёт на большой экран или в монтаж — только флагман.",
  },
  {
    id: "motion",
    question: "Главное в кадре — быстрое или сложное движение: бег, танец, спорт, полёт?",
    verdict: "seedance",
    because:
      "На сложном движении Mini заметно осторожничает: герой двигается меньше, чем просили, " +
      "и кадр берётся шире. Если движение и есть смысл ролика — берите флагман.",
  },
  {
    id: "speech",
    question: "В ролике важна речь с попаданием в губы?",
    verdict: "seedance",
    because:
      "Синхронность губ рассыпается первой, когда в кадре много движения и живая интонация. " +
      "Флагман держит её стабильнее.",
  },
];

/** Where the quiz lands when every answer was "нет". */
export const SEEDANCE_DEFAULT: keyof typeof MODELS = "seedance_mini";

const DEFAULT_BECAUSE =
  "Ни разрешение, ни сложное движение, ни речь тут не критичны — а на спокойных сценах, " +
  "портретах и съёмке товара Mini в тестах не уступала старшей модели. Разницу лучше потратить " +
  "на вторую попытку, чем на один дорогой дубль.";

export interface SeedanceVerdict {
  model: ModelSpec;
  because: string;
  /** How much this choice saves against the flagship, in patrons, at 10s. */
  savedVsFlagship: number;
}

/**
 * Resolve the quiz from the answers given so far.
 *
 * `answers` is keyed by question id; a missing key counts as "not answered
 * yet". Returns null while a YES is still reachable — the caller keeps asking.
 * Once every question has been answered NO, the default stands.
 */
export function recommendSeedance(answers: Record<string, boolean>): SeedanceVerdict | null {
  for (const q of SEEDANCE_QUIZ) {
    if (answers[q.id] === true) return verdictFor(q.verdict, q.because);
    if (answers[q.id] !== false) return null; // unanswered — keep asking
  }
  return verdictFor(SEEDANCE_DEFAULT, DEFAULT_BECAUSE);
}

function verdictFor(key: keyof typeof MODELS, because: string): SeedanceVerdict {
  const model = MODELS[key] as ModelSpec;
  const tenSeconds = (m: ModelSpec): number =>
    Math.max(1, Math.ceil(((m.video?.perSecondUsd ?? 0) * 10) / 0.02));
  return {
    model,
    because,
    savedVsFlagship: Math.max(0, tenSeconds(MODELS.seedance as ModelSpec) - tenSeconds(model)),
  };
}

/** The next unanswered question, or null when the quiz is decided. */
export function nextSeedanceQuestion(answers: Record<string, boolean>): SeedanceQuestion | null {
  for (const q of SEEDANCE_QUIZ) {
    if (answers[q.id] === true) return null;
    if (answers[q.id] !== false) return q;
  }
  return null;
}

/**
 * The Mini App's Studio collapses the 4 Seedance rows into one — the picker
 * exposes a single "Seedance" entry plus a 3-way Дёшево/Быстро/Качество
 * toggle, and this resolves that toggle (+ what the user actually attached)
 * to the real underlying model. Deliberately NOT the same mechanism as the
 * quiz above: the quiz is an advisor for people who don't know what they
 * want (bot-only, unchanged by this); this is a direct, no-questions dispatch
 * for people who already picked a tradeoff.
 *
 * Owner decision, 2026-07-29: the toggle is explicit, not inferred — a user
 * choosing "Быстро" should always get Fast, not a heuristic guess at Fast.
 */
export type SeedanceTier = "cheap" | "fast" | "quality";
export const SEEDANCE_TIER_DEFAULT: SeedanceTier = "fast";

/**
 * `refCount` = how many photos are attached in total (primary + extras).
 * `hasAvRef` = any audio or video reference attached.
 *
 * Reference mode wins over the toggle unconditionally: `seedance_ref` is the
 * ONLY tier with a reference-to-video endpoint, so there is no toggle
 * position for it to obey — attaching a second photo (or any audio/video)
 * is itself the choice, same as picking a duration is.
 */
export function routeSeedance(tier: SeedanceTier, refCount: number, hasAvRef: boolean): keyof typeof MODELS {
  if (refCount >= 2 || hasAvRef) return "seedance_ref";
  if (tier === "cheap") return "seedance_mini";
  if (tier === "quality") return "seedance";
  return "seedance_fast";
}
