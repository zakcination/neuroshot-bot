/**
 * Prompt filter & mapping — EVERY generation passes through here (enforced in
 * runGeneration). Distilled from the gpt-image-2 prompt-craft skill
 * (github.com/wuyoscar/gpt_image_2_skill, installed as a Claude plugin for
 * asset work):
 *   §9  scene density & no empty adjectives — we don't inject nouns into the
 *       user's idea, but we anchor materials/lighting/style coherence;
 *   §12 materials / lighting / palette as separate controls;
 *   §13 edit prompts: transformation first, then explicit invariants;
 *   §14 short, targeted avoid-lines for the model's known bad defaults.
 *
 * Curated preset/campaign prompts are already written to this checklist, so
 * they skip the mapping (crafted=true) but still pass the sanitation filter.
 */
import type { ModelKind } from "./models.js";

/** Hard filter applied to every prompt: control chars out, whitespace
 *  collapsed, length capped (provider prompt limits). */
export function sanitizePrompt(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
}

/** Craft mapping per model kind (applied to raw user text only). */
const CRAFT: Record<ModelKind, string> = {
  image_edit:
    "Change only what the instruction requires; keep everything else — identity, faces, pose, composition — " +
    "exactly the same. Natural realistic result with coherent lighting and materials. " +
    "Avoid plastic AI-polish, warped hands or faces, added text, watermarks or logos.",
  text_to_image:
    "Rich concrete scene detail with coherent materials, lighting and palette; one consistent style and one " +
    "dominant camera framing. Avoid garbled text, watermarks, fake logos, extra limbs and distorted faces.",
  image_to_video:
    "Smooth natural motion with a single dominant camera move; keep the subject's identity and appearance " +
    "absolutely consistent throughout; no morphing, flicker or added objects.",
};

/**
 * The pipeline stage: sanitize always; append the kind-specific craft mapping
 * unless the prompt is already a curated (crafted) one.
 */
export function craftPrompt(kind: ModelKind, raw: string, crafted = false): string {
  const clean = sanitizePrompt(raw);
  if (crafted || !clean) return clean;
  return `${clean}. ${CRAFT[kind]}`;
}
