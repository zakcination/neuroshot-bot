/**
 * AI Video Translator — dubbing engine (docs/video-translator-spec.md).
 *
 * A user uploads a short video; we submit it to the ElevenLabs Dubbing API, which
 * transcribes → translates → re-voices in the original speaker's cloned voice →
 * aligns to the source timing → keeps the background music, and returns a dubbed
 * VIDEO. We wrap that one external job in the SAME async, exactly-once-compensated
 * generation lifecycle the image/video renders use (spend → pending row → run →
 * complete(ok/error) → refund exactly once on failure).
 *
 * Targets (v1): any source → Russian / English / Kazakh. RU/EN run on ElevenLabs
 * Multilingual v2 (proven). Kazakh is gated behind `config.dubKazakhEnabled` until
 * the Phase-0 validation passes (Kazakh TTS is v3-alpha only — see the spec).
 *
 * Zero hard dependency: with no ELEVENLABS_API_KEY the feature is disabled and the
 * entry points return a clean "disabled" (mirrors the Kaspi-callback guard).
 */
import { config } from "./config.js";
import { addCredits, completeGeneration, createPendingGeneration, logEvent, spendCredits } from "./db.js";
import { CREDIT_COST_BASIS } from "./models.js";

export type DubTarget = "ru" | "en" | "kk";

/** Target languages offered in the UI (Kazakh flagged separately — see gating). */
export const DUB_TARGETS: { id: DubTarget; label: string }[] = [
  { id: "kk", label: "🇰🇿 Қазақша" },
  { id: "ru", label: "🇷🇺 Русский" },
  { id: "en", label: "🇬🇧 English" },
];

/** ElevenLabs dub-language codes (ISO-639-1). */
const LANG_CODE: Record<DubTarget, string> = { ru: "ru", en: "en", kk: "kk" };

/** True when dubbing is configured at all (API key present). */
export function dubbingEnabled(): boolean {
  return !!config.elevenLabsKey;
}

/** Which targets are live: RU/EN always; KK only once Phase-0-validated (flag). */
export function dubTargetEnabled(target: DubTarget): boolean {
  return target === "kk" ? config.dubKazakhEnabled : true;
}

/** The targets to actually show a user right now (KK hidden until enabled). */
export function availableDubTargets(): { id: DubTarget; label: string }[] {
  return DUB_TARGETS.filter((t) => dubTargetEnabled(t.id));
}

/**
 * Patron price for a dub of `durationSec` seconds of source. Per-second provider
 * cost (PLACEHOLDER until Phase 0 measures the real ElevenLabs rate) scaled onto
 * the credit grid so cost-per-credit stays ≤ CREDIT_COST_BASIS — same margin
 * basis every model in src/models.ts uses. Always ≥ 1.
 */
export function dubCredits(durationSec: number): number {
  const usd = Math.max(0, durationSec) * config.dubUsdPerSec;
  return Math.max(1, Math.ceil(usd / CREDIT_COST_BASIS));
}

/** Result of a completed dub: the dubbed media URL (+ optional real provider cost). */
export interface DubOutput {
  url: string;
  costUsd?: number;
}

/** The provider call, injectable so tests exercise the job without a live API. */
export type DubRunner = (sourceUrl: string, target: DubTarget, durationSec: number) => Promise<DubOutput>;

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
const POLL_INTERVAL_MS = 4_000;
const POLL_TIMEOUT_MS = 15 * 60_000; // dubs can take minutes

/**
 * Real ElevenLabs Dubbing call: submit the source (by URL) with the target
 * language, poll until `status: "dubbed"`, then fetch the dubbed media URL.
 *
 * ⚠️ Field/endpoint names follow the ElevenLabs Dubbing docs but MUST be
 * confirmed against the live API before go-live (same caution as src/kaspi.ts):
 * the exact result-retrieval shape for a VIDEO dub in particular. Throws on any
 * failure/timeout so the caller compensates (refunds) exactly once.
 */
export async function runDub(sourceUrl: string, target: DubTarget, _durationSec: number): Promise<DubOutput> {
  const key = config.elevenLabsKey;
  if (!key) throw new Error("dubbing disabled (no ELEVENLABS_API_KEY)");
  const headers = { "xi-api-key": key };

  // 1) Submit.
  const submit = await fetch(`${ELEVEN_BASE}/dubbing`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ source_url: sourceUrl, target_lang: LANG_CODE[target] }),
  });
  if (!submit.ok) throw new Error(`dubbing submit failed: ${submit.status}`);
  const { dubbing_id: dubId } = (await submit.json()) as { dubbing_id?: string };
  if (!dubId) throw new Error("dubbing submit: no dubbing_id");

  // 2) Poll to completion.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error("dubbing timed out");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const st = await fetch(`${ELEVEN_BASE}/dubbing/${dubId}`, { headers });
    if (!st.ok) throw new Error(`dubbing status failed: ${st.status}`);
    const s = (await st.json()) as { status?: string };
    if (s.status === "dubbed") break;
    if (s.status === "failed") throw new Error("dubbing failed on provider");
  }

  // 3) The dubbed media URL for the target language.
  return { url: `${ELEVEN_BASE}/dubbing/${dubId}/audio/${LANG_CODE[target]}` };
}

/** Reasons a dub can't start (before any charge). */
export type DubStartError = "disabled" | "target_disabled" | "too_long" | "insufficient";

/**
 * Start a dub job. Mirrors startWebGeneration's exactly-once compensation:
 * validate → charge (atomic) → pending row → detached run → complete(ok/error) →
 * refund EXACTLY ONCE on failure (pending→error CAS). Returns the job id +
 * charged credits, or a typed error before any charge. `runner` is injectable
 * for tests.
 */
export async function startDubbing(
  userId: number,
  sourceUrl: string,
  target: DubTarget,
  durationSec: number,
  runner: DubRunner = runDub,
): Promise<{ ok: true; id: number; credits: number } | { ok: false; error: DubStartError }> {
  if (!dubbingEnabled()) return { ok: false, error: "disabled" };
  if (!dubTargetEnabled(target)) return { ok: false, error: "target_disabled" };
  if (!(durationSec > 0) || durationSec > config.dubMaxSeconds) return { ok: false, error: "too_long" };

  const credits = dubCredits(durationSec);
  const modelKey = `dub_${target}`;
  if (!(await spendCredits(userId, credits, modelKey))) {
    await logEvent(userId, "paywall", modelKey);
    return { ok: false, error: "insufficient" };
  }
  await logEvent(userId, "dub_start", modelKey);
  const id = await createPendingGeneration(userId, modelKey, `${target}:${sourceUrl}`, credits);

  void (async () => {
    let costUsd: number | undefined;
    try {
      const r = await runner(sourceUrl, target, durationSec);
      costUsd = r.costUsd;
      await completeGeneration(id, "ok", r.url, costUsd);
      await logEvent(userId, "dub_ok", modelKey).catch(() => {});
    } catch (err) {
      console.error(`dubbing failed (${modelKey}):`, err);
      // Refund ONLY if we win the pending→error CAS — never double-refund, never
      // refund a job that already completed 'ok'. Exactly-once (same as renders).
      if (await completeGeneration(id, "error", undefined, costUsd)) {
        await addCredits(userId, credits, "refund", modelKey);
      }
      await logEvent(userId, "dub_error", modelKey).catch(() => {});
    }
  })();

  return { ok: true, id, credits };
}
