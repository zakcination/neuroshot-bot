/**
 * Prompt Enhancer — Cinema Studio block ② (docs/cinema-studio-spec.md).
 *
 * One tap turns a rough idea into a vivid, directable generation prompt via
 * fal's `fal-ai/any-llm` endpoint — the SAME fal client + FAL_KEY the renders
 * use, so there is no new provider dependency or secret.
 *
 * Pricing (decision D2): the FIRST enhance after each generation start is
 * FREE; every further enhance costs 1 patron. "Free" is derived from the
 * events log (no schema change): free iff the user's most recent
 * 'enhance'/'gen_start' event is a gen_start — i.e. every render re-arms one
 * free enhance. A paid enhance is charged atomically up front and refunded
 * if the provider fails (the call is synchronous, so the catch-path refund
 * runs exactly once).
 */
import { fal } from "@fal-ai/client";
import { addCredits, enhanceIsFree, getUser, logEvent, spendCredits } from "./db.js";

/** Patrons per PAID enhance (the first one after a render is free). */
export const ENHANCE_COST = 1;

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
  | { ok: true; prompt: string; charged: number; free: boolean; balance: number }
  | { ok: false; error: "empty" | "insufficient" };

/**
 * Enhance a prompt for `userId`: decide free-vs-paid, charge atomically when
 * paid, run the LLM, refund on provider failure (rethrown for the route to
 * map onto 502 — the client keeps the original prompt).
 */
export async function enhancePrompt(userId: number, raw: string, runner: (raw: string) => Promise<string> = runEnhance): Promise<EnhanceResult> {
  const text = raw.trim().slice(0, 500);
  if (!text) return { ok: false, error: "empty" };
  const free = await enhanceIsFree(userId);
  if (!free && !(await spendCredits(userId, ENHANCE_COST, "enhance"))) {
    await logEvent(userId, "paywall", "enhance");
    return { ok: false, error: "insufficient" };
  }
  try {
    const prompt = await runner(text);
    await logEvent(userId, "enhance", free ? "free" : "paid");
    const balance = (await getUser(userId))?.credits ?? 0;
    return { ok: true, prompt, charged: free ? 0 : ENHANCE_COST, free, balance };
  } catch (err) {
    // Paid + provider failed → give the patron back. No 'enhance' event is
    // logged, so the user's free/paid state is exactly as before the tap.
    if (!free) await addCredits(userId, ENHANCE_COST, "refund", "enhance");
    throw err;
  }
}
