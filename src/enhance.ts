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

/**
 * Director Mode variant of SEEDANCE_STYLE, used only when the request carries
 * character/location/shot context. The plain style says nothing about
 * multiple NAMED entities or about the @Image bindings the render itself adds
 * (models.ts's referencePrompt, built from image_roles) — asked to rewrite a
 * two-character scene, it could rename someone, invent a third person, or
 * fabricate its own @Image token that collides with the real one.
 */
export const SEEDANCE_DIRECTOR_STYLE =
  "Rewrite the user's idea into ONE Seedance video-generation prompt: name the subject(s) and setting in one " +
  "short clause, then describe ONE clear, continuous camera movement (dolly in/out, pan, tilt, tracking, static) " +
  "using concrete cinematic verbs, then the mood/lighting in a few words. " +
  "Every character and location given in the context MUST be named in the prompt, using the name EXACTLY as " +
  "given — no translation, no transliteration, no renaming. Invent no additional people or places beyond what " +
  "was given. Do NOT write any @Image or @Video tokens — those are added separately by the system, not by you. " +
  "English, under 50 words (a scene with named characters needs more room than a plain idea does), no scene " +
  "cuts or multiple shots — Seedance renders one continuous take. Output ONLY the prompt.";

/**
 * The system prompt for a model key — safe fallback keeps old behavior intact.
 * `hasDirectorContext` switches Seedance specifically to the stricter
 * name-exact style above; every other model, and a Seedance call with no
 * context, are byte-for-byte unaffected.
 */
export function enhanceStyleFor(modelKey?: string, hasDirectorContext = false): string {
  const base = (modelKey && ENHANCE_STYLES[modelKey]) || ENHANCE_STYLE_DEFAULT;
  if (hasDirectorContext && base === SEEDANCE_STYLE) return SEEDANCE_DIRECTOR_STYLE;
  return base;
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
  /** Optional: present whenever the client can identify the entity (Director
   *  Mode always sends one). Absent only for a hypothetical caller that never
   *  needs shot-scoping — entityLine works either way. */
  id?: string;
  label: string;
  description?: string;
}

export interface EnhanceContext {
  characters?: EnhanceContextEntity[];
  locations?: EnhanceContextEntity[];
  scenario?: string;
  shot?: {
    type: string;
    momentRu: string;
    cameraDirectionEn: string;
    /** Who/where is ACTUALLY in this shot, as a subset of `characters`/
     *  `locations` ids above — what makes shot-scoping possible at all.
     *  Absent (an older caller, or a shot picked with no cast attached) falls
     *  back to describing the whole cast, exactly as before this existed. */
    characterIds?: string[];
    locationIds?: string[];
  };
}

function entityLine(e: EnhanceContextEntity): string {
  return e.description ? `${e.label} — ${e.description}` : e.label;
}

/**
 * Serialize the user's idea + Director Mode context into ONE user message.
 * Plain labelled lines, no JSON: the LLM's job is to weave, and labelled
 * natural-language context is what these models weave best from.
 *
 * When the chosen shot names WHO is actually in it (`shot.characterIds`/
 * `locationIds`), the cast is split into "In this shot" vs "elsewhere in the
 * story" — describing the ENTIRE ticked cast for a one-person close-up is
 * what put four people in frame when only one belonged there. Without shot
 * ids (an older caller, or no shot at all) this reproduces the original
 * undifferentiated "Characters in the scene" wording byte for byte.
 */
export function composeEnhanceInput(raw: string, ctx?: EnhanceContext): string {
  if (!ctx) return raw;
  const lines: string[] = [];
  if (raw) lines.push(raw);
  if (ctx.scenario && ctx.scenario !== raw) lines.push(`Scenario: ${ctx.scenario}`);

  const chars = ctx.characters ?? [];
  const locs = ctx.locations ?? [];
  const shotCharIds = ctx.shot?.characterIds;
  const shotLocIds = ctx.shot?.locationIds;
  if (shotCharIds || shotLocIds) {
    const inShot = chars.filter((c) => c.id && shotCharIds?.includes(c.id));
    const shotPlaces = locs.filter((l) => l.id && shotLocIds?.includes(l.id));
    const elsewhere = [
      ...chars.filter((c) => !c.id || !shotCharIds?.includes(c.id)),
      ...locs.filter((l) => !l.id || !shotLocIds?.includes(l.id)),
    ];
    if (inShot.length) lines.push(`In this shot: ${inShot.map(entityLine).join("; ")}.`);
    if (shotPlaces.length) lines.push(`Location: ${shotPlaces.map(entityLine).join("; ")}.`);
    if (elsewhere.length) {
      lines.push(`Elsewhere in the story (do NOT put these on screen in this shot): ${elsewhere.map(entityLine).join("; ")}.`);
    }
  } else {
    if (chars.length) lines.push(`Characters in the scene: ${chars.map(entityLine).join("; ")}.`);
    if (locs.length) lines.push(`Locations: ${locs.map(entityLine).join("; ")}.`);
  }

  if (ctx.shot) {
    const t = shotTypeById.get(ctx.shot.type);
    const hint = t ? ` (${t.hintEn})` : "";
    // cameraDirectionEn is the LLM's own generated move for THIS exact shot —
    // authoritative. hintEn is background framing only, so it must never read
    // as competing with the move that was actually chosen.
    lines.push(
      `Chosen shot: ${ctx.shot.momentRu}. Shot framing${hint}. ` +
        `Camera movement (authoritative — follow this exactly): ${ctx.shot.cameraDirectionEn}.`,
    );
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
  const hasDirectorContext = !!(req.context?.characters?.length || req.context?.locations?.length || req.context?.shot);
  const style = enhanceStyleFor(req.model, hasDirectorContext);
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
    '"cameraDirectionEn": "<ONE continuous camera movement in English, concrete cinematic verbs, under 20 words, ' +
    "and consistent with the chosen shotType's own meaning below — a hero_low_angle shot rising, not panning; " +
    'a wide_quiet shot staying still, not tracking fast>"}. ' +
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

// ---------------------------------------------------------------------------
// Screenwriter pipeline (docs/seedance-screenwriter-spec.md, gated behind
// config.screenwriterPipelineEnabled): a short vision → an expanded plot +
// the cast/locations it needs, feeding the EXISTING Director Mode sheet/
// storyboard/assemble flow unchanged below this point. Same fal any-llm
// infrastructure, same charge stack, same parse-validate-retry-once
// discipline as splitStoryboard — this is deliberately NOT a new pattern.
//
// Purpose-classification (the spec's own flagged research item — "which of
// emotional/selling/documentary/capability-demo") is NOT implemented here:
// one generic system prompt, exactly the pragmatic starting point the spec
// proposed while that research is still pending.
// ---------------------------------------------------------------------------

export interface ScreenwriterEntity {
  id: string;
  kind: "character" | "location";
  label: string;
  /**
   * One English sentence visually describing the entity — precise enough
   * that an image model could draw a representative frame from it alone.
   * This is what makes the "no photo for this location" path possible: it
   * originates a text-to-image frame from `hint`, then feeds that frame into
   * the SAME sheet-generation flow a real upload would use (see the client).
   */
  hint: string;
}

export type ScreenwriterResult =
  | { ok: true; plot: string; entities: ScreenwriterEntity[]; charged: number; free: boolean; balance: number; left: number }
  | { ok: false; error: "insufficient" };

/** At most this many entities come back — a plot with more than this needs a
 *  human trimming it, not an ever-growing cast the rest of the flow assumes
 *  fits in one composer screen (Director Mode itself caps at 6 characters,
 *  4 locations — ENHANCE_CONTEXT_LIMITS). */
const SCREENWRITER_MAX_ENTITIES = 6;

function screenwriterSystemPrompt(): string {
  return (
    "You are a screenwriter helping plan ONE short AI-generated video (a Seedance clip — a later step " +
    "shoots a single continuous 4-15 second take from whatever plot you write here, so the plot itself can " +
    "imply more around that one moment). The user gives a short vision, possibly with visual/VFX notes. " +
    "Expand it into a vivid scene-by-scene plot in RUSSIAN — a few sentences, what happens and in what order. " +
    "Then identify every distinct named person, creature, or object, and every distinct location the plot " +
    "actually needs on screen — nothing incidental, only what a director would need a reference photo for. " +
    "Respond with ONLY a JSON object (no prose, no markdown, no code fences), exactly: " +
    '{"plot": "<the Russian plot, a few sentences>", "entities": [{"id": "<short stable slug, lowercase ' +
    'a-z0-9_ only, unique>", "kind": "<character or location>", "label": "<short Russian name a person would ' +
    'recognize, e.g. Аня or Кухня на рассвете>", "hint": "<ONE English sentence visually describing this ' +
    "entity, precise enough that an image model could draw a representative frame of it from this sentence " +
    `alone>"}]}. At most ${SCREENWRITER_MAX_ENTITIES} entities total, characters and locations combined.`
  );
}

function screenwriterUserMessage(vision: string, vfxNotes: string): string {
  const lines = [`Vision: ${vision}`];
  if (vfxNotes) lines.push(`Visual/VFX notes: ${vfxNotes}`);
  return lines.join("\n");
}

/**
 * Parse + validate the LLM's plot+entities JSON. Same tolerance-then-strict
 * shape as parseStoryboard: fences/prose around the object are fine (the
 * contract is prompt-level, this parse IS the real boundary); a malformed
 * entity is dropped rather than failing the whole response; a duplicate id
 * is dropped (second occurrence loses); returns null only when there's no
 * usable plot at all, or zero entities survive — the caller retries once.
 */
export function parseScreenwriterExpansion(text: string): { plot: string; entities: ScreenwriterEntity[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const clean = (v: unknown, max: number): string =>
    typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
  const plot = clean(o.plot, 1500);
  if (!plot || !Array.isArray(o.entities)) return null;
  const seen = new Set<string>();
  const entities: ScreenwriterEntity[] = [];
  for (const item of o.entities) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const kind = e.kind === "character" || e.kind === "location" ? e.kind : null;
    const id = typeof e.id === "string" ? e.id.trim().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40) : "";
    const label = clean(e.label, 80);
    const hint = clean(e.hint, 300);
    if (!kind || !id || !label || !hint || seen.has(id)) continue;
    seen.add(id);
    entities.push({ id, kind, label, hint });
    if (entities.length >= SCREENWRITER_MAX_ENTITIES) break;
  }
  return entities.length ? { plot, entities } : null;
}

/**
 * Expand a vision into a plot + cast on the SAME enhance stack as
 * enhancePrompt/splitStoryboard (free → paid → refund discipline identical).
 * Invalid/unparseable LLM output is retried ONCE; a second failure throws —
 * the route maps it onto 502, and the catch path above has already refunded
 * a paid charge, leaving the stack untouched.
 */
export async function expandVision(
  userId: number,
  vision: string,
  vfxNotes: string,
  runner: (message: string, systemPrompt: string) => Promise<string> = runEnhance,
): Promise<ScreenwriterResult> {
  const system = screenwriterSystemPrompt();
  const message = screenwriterUserMessage(vision, vfxNotes);
  const r = await runOnEnhanceStack(userId, async () => {
    const attempt = async () => parseScreenwriterExpansion(await runner(message, system));
    const result = (await attempt()) ?? (await attempt()); // one retry
    if (!result) throw new Error("screenwriter: invalid LLM output after retry");
    return result;
  });
  if (!r.ok) return r;
  return { ok: true, plot: r.value.plot, entities: r.value.entities, charged: r.charged, free: r.free, balance: r.balance, left: r.left };
}
