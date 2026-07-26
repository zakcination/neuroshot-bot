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

/**
 * Length budget for UNTRUSTED user text — an abuse/cost bound on input we did
 * not write. Not a provider limit.
 */
export const USER_PROMPT_MAX = 1500;

/**
 * Curated prompts (presets, campaign scenes, free scenarios) are NOT length
 * capped. They are our own reviewed text, and a prompt is exactly as long as the
 * context it has to carry — clipping it does not save anything, it deletes
 * craft.
 *
 * This used to share the untrusted bound above, which silently decapitated the
 * five longest. Prompts are authored transformation-first with the invariants
 * LAST (§13), so what got cut was the load-bearing tail: "Keep the face and
 * identity of EVERY person in the photo exactly as they are. Keep the SAME
 * NUMBER of people…" never reached the provider for fashion, cinematic,
 * bento_birthday, retro90s or photobooth_bw. An identity-preserving photo edit
 * shipped with no identity lock. bento_birthday also lost "not a real child and
 * not a second guest at the party" — the clause written to cure a known defect,
 * so that cure was never in force.
 *
 * The cap was ours, never the provider's: the endpoints behind these presets
 * declare either a 50 000-character maximum or none at all. The e2e suite
 * asserts curated prompts survive sanitation byte-for-byte, so a truncating
 * change cannot land silently again.
 */
const NO_LIMIT = Number.POSITIVE_INFINITY;

/** Hard filter applied to every prompt: control chars out, whitespace
 *  collapsed, length capped. Pass `max` (NO_LIMIT for curated text). */
export function sanitizePrompt(raw: string, max: number = USER_PROMPT_MAX): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
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
  // A curated prompt spends the curated budget: it is our own reviewed text, and
  // cutting its tail removes the invariants rather than some trailing flourish.
  const clean = sanitizePrompt(raw, crafted ? NO_LIMIT : USER_PROMPT_MAX);
  if (crafted || !clean) return clean;
  // Don't double-punctuate: append a bare space when the text already ends in a
  // sentence terminator (".", "!", "?", "…"), a full stop otherwise.
  const sep = /[.!?…]$/.test(clean) ? " " : ". ";
  return `${clean}${sep}${CRAFT[kind]}`;
}
