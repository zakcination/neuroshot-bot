/**
 * Prompt Enhancer — Cinema Studio block ② (docs/cinema-studio-spec.md) plus the
 * Director Mode text brains (seedance-director-mode spec §7–§8).
 *
 * One tap turns a rough idea into a vivid, directable generation prompt via
 * fal's `fal-ai/any-llm` endpoint — the SAME fal client + FAL_KEY the renders
 * use, so there is no new provider dependency or secret.
 *
 * Director Mode adds two things on the same infrastructure:
 *   • a per-model STYLE map (ENHANCE_STYLES): Seedance gets its own system
 *     prompt (one continuous take, ONE camera movement, under 40 words); every
 *     model without an entry falls back to the pre-existing generic prompt
 *     byte-for-byte, so old clients (which send no `model` at all) see zero
 *     change;
 *   • the storyboard split (splitStoryboard): scenario + cast → 3-4 candidate
 *     single-take moments as strict JSON, validated server-side against the
 *     fixed SHOT_TYPES vocabulary.
 *
 * Pricing: a STACK of ENHANCE_STACK charges rather than a single free shot.
 * One rewrite is rarely the one you keep — you read it and want to nudge it
 * again — so charging on the second tap taxes the moment the feature starts
 * being useful. Each render refills the stack (a new idea deserves a fresh
 * one); when it runs out, 1 patron refills it in full, so the patron buys a
 * round of iteration rather than a single tap. The storyboard split consumes
 * the SAME stack (spec §9 p.7): it is the same kind of LLM assist, and one
 * pool keeps the economy legible.
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

/**
 * The pre-Director-Mode system prompt, UNCHANGED byte-for-byte — this is what
 * every request without a per-model style resolves to (including every request
 * from a client that sends no `model` at all), so the feature ships with zero
 * regression for existing callers. Exported so tests can pin that promise.
 */
export const ENHANCE_STYLE_DEFAULT =
  "You are a prompt engineer for photo and video generation models. Rewrite the user's idea into ONE vivid, " +
  "concrete, well-structured English generation prompt: subject, setting, lighting, mood, and camera/lens (for " +
  "photos) or motion (for video). Keep the user's intent, subjects and any names exactly. Output ONLY the " +
  "rewritten prompt — no commentary, no quotes, at most 120 words.";

/**
 * Seedance style (spec §8): [who/what] + [where] + [ONE camera movement] +
 * [mood/light], short, English, no cuts — Seedance renders one continuous take.
 */
const SEEDANCE_STYLE =
  "Rewrite the user's idea into ONE Seedance video-generation prompt: name the subject and setting in one short " +
  "clause, then describe ONE clear, continuous camera movement (dolly in/out, pan, tilt, tracking, static) using " +
  "concrete cinematic verbs, then the mood/lighting in a few words. Keep the user's subjects and any names " +
  "exactly. English, under 40 words, no scene cuts or multiple shots — Seedance renders one continuous take. " +
  "Output ONLY the prompt.";

/**
 * Per-model system prompts. Keyed by REGISTRY key; the client sends its picker
 * key ("seedance" umbrella), but the hidden tier keys are mapped too so a
 * direct-key caller gets the same style. Lookup miss → ENHANCE_STYLE_DEFAULT,
 * which preserves today's behavior exactly (see enhanceStyleFor).
 */
export const ENHANCE_STYLES: Record<string, string> = {
  seedance: SEEDANCE_STYLE,
  seedance_fast: SEEDANCE_STYLE,
  seedance_mini: SEEDANCE_STYLE,
  seedance_ref: SEEDANCE_STYLE,
};

/** The system prompt for a model key — safe fallback keeps old behavior intact. */
export function enhanceStyleFor(modelKey?: string): string {
  return (modelKey && ENHANCE_STYLES[modelKey]) || ENHANCE_STYLE_DEFAULT;
}

// ---------------------------------------------------------------------------
// Shot-type vocabulary (spec §7) — a dictionary FOR THE LLM, not a user-facing
// gallery of director names. Defined once here; the storyboard validator, the
// enhance-context validator and the catalog payload all read this list.
// ---------------------------------------------------------------------------

export interface ShotType {
  /** Stable id — what the API speaks and what the client sends back. */
  id: string;
  /** RU-facing label for the manual gallery / candidate chips. */
  labelRu: string;
  /** English directorial hint woven into LLM messages. Server-side vocabulary. */
  hintEn: string;
}

export const SHOT_TYPES: readonly ShotType[] = [
  { id: "hero_low_angle", labelRu: "Герой снизу", hintEn: "low angle on the hero, camera slowly rising" },
  { id: "tense_closeup", labelRu: "Напряжённый крупный план", hintEn: "static tense close-up, slow push-in on the eyes/face" },
  { id: "dutch_angle", labelRu: "Голландский угол", hintEn: "tilted dutch angle, unease and imbalance" },
  { id: "wide_quiet", labelRu: "Дальний план, тишина", hintEn: "static contemplative wide frame, stillness" },
  { id: "reveal_push_in", labelRu: "Наезд-разоблачение", hintEn: "slow push-in that reveals a telling detail" },
  { id: "lateral_parallax", labelRu: "Параллакс сбоку", hintEn: "lateral tracking move past foreground elements" },
  { id: "chase_dynamic", labelRu: "Погоня/динамика", hintEn: "fast dynamic panning, chase energy" },
  { id: "soft_light_portrait", labelRu: "Мягкий свет, портрет", hintEn: "near-static portrait, soft light doing the work" },
] as const;

export const SHOT_TYPE_IDS: ReadonlySet<string> = new Set(SHOT_TYPES.map((s) => s.id));

const shotTypeById = new Map(SHOT_TYPES.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Enhance context (Director Mode "Собрать Seedance-промпт", spec §8 p.4):
// characters/locations/scenario/chosen shot travel as STRUCTURED context and
// are serialized into the user message, so the LLM weaves them into one
// coherent prompt instead of us concatenating strings mechanically.
// ---------------------------------------------------------------------------

/** Caps for untrusted context fields — enforced by the route (webapp.ts). */
export const ENHANCE_CONTEXT_LIMITS = {
  characters: 6, // spec §9 p.3
  locations: 4, // spec §9 p.3
  label: 80,
  description: 300,
  scenario: 1000,
  shotText: 300,
} as const;

export interface EnhanceContextEntity {
  label: string;
  description?: string;
}

export interface EnhanceContext {
  characters?: EnhanceContextEntity[];
  locations?: EnhanceContextEntity[];
  scenario?: string;
  shot?: { type: string; momentRu: string; cameraDirectionEn: string };
}

function entityLine(e: EnhanceContextEntity): string {
  return e.description ? `${e.label} — ${e.description}` : e.label;
}

/**
 * Serialize the user's idea + Director Mode context into ONE user message.
 * Plain labelled lines, no JSON: the LLM's job is to weave, and labelled
 * natural-language context is what these models weave best from.
 */
export function composeEnhanceInput(raw: string, ctx?: EnhanceContext): string {
  if (!ctx) return raw;
  const lines: string[] = [];
  if (raw) lines.push(raw);
  if (ctx.scenario && ctx.scenario !== raw) lines.push(`Scenario: ${ctx.scenario}`);
  if (ctx.characters?.length) lines.push(`Characters in the scene: ${ctx.characters.map(entityLine).join("; ")}.`);
  if (ctx.locations?.length) lines.push(`Locations: ${ctx.locations.map(entityLine).join("; ")}.`);
  if (ctx.shot) {
    const t = shotTypeById.get(ctx.shot.type);
    const hint = t ? ` (${t.hintEn})` : "";
    lines.push(`Chosen shot: ${ctx.shot.momentRu}. Shot style${hint}. Camera: ${ctx.shot.cameraDirectionEn}.`);
  }
  return lines.join("\n");
}

/** The provider call — exported for the route, injectable in tests. */
export async function runEnhance(message: string, systemPrompt: string = ENHANCE_STYLE_DEFAULT): Promise<string> {
  const result = await fal.subscribe("fal-ai/any-llm", {
    input: { model: ENHANCE_LLM, system_prompt: systemPrompt, prompt: message },
  });
  const d = result.data as { output?: string; text?: string } | undefined;
  const out = (d?.output ?? d?.text ?? "").trim();
  if (!out) throw new Error("enhance: empty LLM output");
  return out;
}

// ---------------------------------------------------------------------------
// The shared charge stack — one pool for the enhancer AND the storyboard split.
// ---------------------------------------------------------------------------

type StackOutcome<T> =
  | { ok: true; value: T; charged: number; free: boolean; balance: number; left: number }
  | { ok: false; error: "insufficient" };

/**
 * Run one LLM assist on the enhance stack: spend a charge if the stack has
 * one, else buy a whole new stack for ENHANCE_COST; refund on failure. The
 * SAME events ('enhance_refill' / 'enhance') are logged whichever feature
 * consumed the charge, so enhanceChargesLeft's arithmetic — and everything
 * else that reads those events — just works.
 */
async function runOnEnhanceStack<T>(userId: number, run: () => Promise<T>): Promise<StackOutcome<T>> {
  const free = (await enhanceChargesLeft(userId, ENHANCE_STACK)) > 0;
  if (!free && !(await spendCredits(userId, ENHANCE_COST, "enhance"))) {
    await logEvent(userId, "paywall", "enhance");
    return { ok: false, error: "insufficient" };
  }
  try {
    const value = await run();
    // The refill event is logged BEFORE the consuming one, so the arithmetic
    // reads the same way it happened: paid → full stack → this tap spends one.
    if (!free) await logEvent(userId, "enhance_refill", "paid");
    await logEvent(userId, "enhance", free ? "free" : "paid");
    const balance = (await getUser(userId))?.credits ?? 0;
    const left = await enhanceChargesLeft(userId, ENHANCE_STACK);
    return { ok: true, value, charged: free ? 0 : ENHANCE_COST, free, balance, left };
  } catch (err) {
    // Paid + provider failed → give the patron back. Neither event is logged,
    // so the stack is exactly as it was before the tap.
    if (!free) await addCredits(userId, ENHANCE_COST, "refund", "enhance");
    throw err;
  }
}

export type EnhanceResult =
  | { ok: true; prompt: string; charged: number; free: boolean; balance: number; left: number }
  | { ok: false; error: "empty" | "insufficient" };

export interface EnhanceRequest {
  /** Registry/picker model key — selects the style; unknown/absent → default. */
  model?: string;
  /** Director Mode context, already validated + sanitized by the route. */
  context?: EnhanceContext;
}

/**
 * Enhance a prompt for `userId`: spend a charge if the stack has one, else buy
 * a whole new stack for ENHANCE_COST, run the LLM, refund on provider failure
 * (rethrown for the route to map onto 502 — the client keeps its prompt).
 *
 * `left` is what remains AFTER this call, so the caller can label the button
 * with the truth instead of a fixed string. The old label said "1-е бесплатно"
 * forever, including to someone who had already used it.
 */
export async function enhancePrompt(
  userId: number,
  raw: string,
  req: EnhanceRequest = {},
  runner: (message: string, systemPrompt: string) => Promise<string> = runEnhance,
): Promise<EnhanceResult> {
  const text = raw.trim().slice(0, 500);
  // With Director Mode context attached, an empty free-text idea is fine — the
  // context IS the idea. Without it, the pre-existing rule stands.
  const message = composeEnhanceInput(text, req.context).trim();
  if (!message) return { ok: false, error: "empty" };
  const style = enhanceStyleFor(req.model);
  const r = await runOnEnhanceStack(userId, () => runner(message, style));
  if (!r.ok) return r;
  return { ok: true, prompt: r.value, charged: r.charged, free: r.free, balance: r.balance, left: r.left };
}

// ---------------------------------------------------------------------------
// Storyboard split ("Разбить на кадры", spec §7 / §10): scenario + cast →
// 3-4 candidate single-take moments, strict JSON, validated here. Same fal
// any-llm infrastructure, same charge stack, same refund discipline.
// ---------------------------------------------------------------------------

export interface StoryboardEntity {
  id: string;
  label: string;
  description?: string;
}

export interface StoryboardCandidate {
  shotType: string;
  momentRu: string;
  characterIds: string[];
  locationIds: string[];
  cameraDirectionEn: string;
}

export type StoryboardResult =
  | { ok: true; candidates: StoryboardCandidate[]; charged: number; free: boolean; balance: number; left: number }
  | { ok: false; error: "insufficient" };

/** Max candidates returned to the client (the spec promises 3-4). */
const STORYBOARD_MAX_CANDIDATES = 4;

function storyboardSystemPrompt(): string {
  const ids = SHOT_TYPES.map((s) => s.id).join(" | ");
  const glossary = SHOT_TYPES.map((s) => `${s.id} = ${s.hintEn}`).join("; ");
  return (
    "You are a film director planning ONE continuous 4-15 second AI video clip (no cuts, no montage). " +
    "The user gives a scenario and a cast of characters and locations, each with an id. " +
    "Pick the 3-4 strongest single moments of the scenario, each shootable as ONE continuous take. " +
    "Respond with ONLY a JSON array (no prose, no markdown, no code fences) of 3-4 objects, each exactly: " +
    `{"shotType": "<one of: ${ids}>", ` +
    '"momentRu": "<one short Russian sentence naming who and where, using the given names>", ' +
    '"characterIds": ["<ids of the characters visible in this shot, from the given list only>"], ' +
    '"locationIds": ["<ids of the locations of this shot, from the given list only>"], ' +
    '"cameraDirectionEn": "<ONE continuous camera movement in English, concrete cinematic verbs, under 20 words>"}. ' +
    `Shot-type meanings: ${glossary}. Use only ids that were given; empty arrays are allowed.`
  );
}

function storyboardUserMessage(scenario: string, characters: StoryboardEntity[], locations: StoryboardEntity[]): string {
  const cast = (list: StoryboardEntity[]): string =>
    list.map((e) => `- id: ${e.id} — ${e.label}${e.description ? ` (${e.description})` : ""}`).join("\n");
  const lines = [`Scenario: ${scenario}`];
  lines.push(characters.length ? `Characters:\n${cast(characters)}` : "Characters: none listed.");
  lines.push(locations.length ? `Locations:\n${cast(locations)}` : "Locations: none listed.");
  return lines.join("\n");
}

/**
 * Parse + validate the LLM's storyboard JSON. Tolerant of fences/prose around
 * the array (the JSON contract is prompt-level only — this parse IS the actual
 * contract boundary). Per-candidate strictness: an unknown shotType or a
 * missing field drops THAT candidate; unknown character/location ids are
 * dropped from the arrays (LLM noise, not user error). Returns null when
 * nothing valid survives — the caller retries once, then fails.
 */
export function parseStoryboard(
  text: string,
  characterIds: ReadonlySet<string>,
  locationIds: ReadonlySet<string>,
): StoryboardCandidate[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const clean = (v: unknown, max: number): string =>
    typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
  const idList = (v: unknown, known: ReadonlySet<string>): string[] => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const raw of v) {
      const id = typeof raw === "string" ? raw.trim() : "";
      if (id && known.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
  };
  const candidates: StoryboardCandidate[] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const shotType = typeof o.shotType === "string" ? o.shotType.trim() : "";
    const momentRu = clean(o.momentRu, 300);
    const cameraDirectionEn = clean(o.cameraDirectionEn, 300);
    // The fixed vocabulary is the contract: a shot type we don't know is a shot
    // type the product can't explain or reuse, so the candidate is dropped.
    if (!SHOT_TYPE_IDS.has(shotType) || !momentRu || !cameraDirectionEn) continue;
    candidates.push({
      shotType,
      momentRu,
      characterIds: idList(o.characterIds, characterIds),
      locationIds: idList(o.locationIds, locationIds),
      cameraDirectionEn,
    });
    if (candidates.length >= STORYBOARD_MAX_CANDIDATES) break;
  }
  return candidates.length ? candidates : null;
}

/**
 * Split a scenario into 3-4 single-take candidates. Consumes one charge from
 * the SAME enhance stack (free → paid → refund discipline identical to
 * enhancePrompt). Invalid/unparseable LLM output is retried ONCE; a second
 * failure throws — the route maps it onto 502 and the catch path above has
 * already refunded a paid charge, leaving the stack untouched.
 */
export async function splitStoryboard(
  userId: number,
  scenario: string,
  characters: StoryboardEntity[],
  locations: StoryboardEntity[],
  runner: (message: string, systemPrompt: string) => Promise<string> = runEnhance,
): Promise<StoryboardResult> {
  const system = storyboardSystemPrompt();
  const message = storyboardUserMessage(scenario, characters, locations);
  const charIds: ReadonlySet<string> = new Set(characters.map((c) => c.id));
  const locIds: ReadonlySet<string> = new Set(locations.map((l) => l.id));
  const r = await runOnEnhanceStack(userId, async () => {
    const attempt = async (): Promise<StoryboardCandidate[] | null> =>
      parseStoryboard(await runner(message, system), charIds, locIds);
    const candidates = (await attempt()) ?? (await attempt()); // one retry
    if (!candidates) throw new Error("storyboard: invalid LLM output after retry");
    return candidates;
  });
  if (!r.ok) return r;
  return { ok: true, candidates: r.value, charged: r.charged, free: r.free, balance: r.balance, left: r.left };
}
