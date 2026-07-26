/**
 * Prompt Enhancer — Cinema Studio block ② (docs/cinema-studio-spec.md).
 *
 * One tap turns a rough idea into a vivid, directable generation prompt via
 * fal's `fal-ai/any-llm` endpoint — the SAME fal client + FAL_KEY the renders
 * use, so there is no new provider dependency or secret.
 *
 * Pricing: a STACK of ENHANCE_STACK charges rather than a single free shot.
 * One rewrite is rarely the one you keep — you read it and want to nudge it
 * again — so charging on the second tap taxes the moment the feature starts
 * being useful. Each render refills the stack (a new idea deserves a fresh
 * one); when it runs out, 1 patron refills it in full, so the patron buys a
 * round of iteration rather than a single tap.
 *
 * The count is derived from the events log (no schema change, nothing to drift)
 * — see enhanceChargesLeft. A paid refill is charged atomically up front and
 * refunded if the provider fails; the call is synchronous, so the catch-path
 * refund runs exactly once, and no 'enhance' event is logged, leaving the
 * stack exactly as it was before the tap.
 */
import { fal } from "@fal-ai/client";
import { addCredits, enhanceChargesLeft, getUser, logEvent, spendCredits } from "./db.js";

/** Patrons for a refill once the stack is empty — buys ENHANCE_STACK charges. */
export const ENHANCE_COST = 1;

/** Charges per stack. Refilled by a render, or by paying ENHANCE_COST. */
export const ENHANCE_STACK = 2;

/**
 * LLM used for the rewrite — cheap + fast tier on fal's any-llm router.
 * ⚠️ Model id and the any-llm response shape must be confirmed against the
 * live API before go-live (same caution class as kaspi.ts / dubbing.ts).
 */
export const ENHANCE_LLM = "google/gemini-flash-1.5";

const SYSTEM_PROMPT =
  "You are a prompt engineer for photo and video generation models. Rewrite the user's idea into ONE vivid, " +
  "concrete, well-structured English generation prompt: subject, setting, lighting, mood, and camera/lens (for " +
  "photos) or motion (for video). Keep the user's intent, subjects and any names exactly. Output ONLY the " +
  "rewritten prompt — no commentary, no quotes, at most 120 words.";

/** The provider call — exported for the route, injectable in tests. */
export async function runEnhance(raw: string): Promise<string> {
  const result = await fal.subscribe("fal-ai/any-llm", {
    input: { model: ENHANCE_LLM, system_prompt: SYSTEM_PROMPT, prompt: raw },
  });
  const d = result.data as { output?: string; text?: string } | undefined;
  const out = (d?.output ?? d?.text ?? "").trim();
  if (!out) throw new Error("enhance: empty LLM output");
  return out;
}

export type EnhanceResult =
  | { ok: true; prompt: string; charged: number; free: boolean; balance: number; left: number }
  | { ok: false; error: "empty" | "insufficient" };

/**
 * Enhance a prompt for `userId`: spend a charge if the stack has one, else buy
 * a whole new stack for ENHANCE_COST, run the LLM, refund on provider failure
 * (rethrown for the route to map onto 502 — the client keeps its prompt).
 *
 * `left` is what remains AFTER this call, so the caller can label the button
 * with the truth instead of a fixed string. The old label said "1-е бесплатно"
 * forever, including to someone who had already used it.
 */
export async function enhancePrompt(userId: number, raw: string, runner: (raw: string) => Promise<string> = runEnhance): Promise<EnhanceResult> {
  const text = raw.trim().slice(0, 500);
  if (!text) return { ok: false, error: "empty" };
  const free = (await enhanceChargesLeft(userId, ENHANCE_STACK)) > 0;
  if (!free && !(await spendCredits(userId, ENHANCE_COST, "enhance"))) {
    await logEvent(userId, "paywall", "enhance");
    return { ok: false, error: "insufficient" };
  }
  try {
    const prompt = await runner(text);
    // The refill event is logged BEFORE the consuming one, so the arithmetic
    // reads the same way it happened: paid → full stack → this tap spends one.
    if (!free) await logEvent(userId, "enhance_refill", "paid");
    await logEvent(userId, "enhance", free ? "free" : "paid");
    const balance = (await getUser(userId))?.credits ?? 0;
    const left = await enhanceChargesLeft(userId, ENHANCE_STACK);
    return { ok: true, prompt, charged: free ? 0 : ENHANCE_COST, free, balance, left };
  } catch (err) {
    // Paid + provider failed → give the patron back. Neither event is logged,
    // so the stack is exactly as it was before the tap.
    if (!free) await addCredits(userId, ENHANCE_COST, "refund", "enhance");
    throw err;
  }
}
