# NeuroShot — AI Video Translator (Kazakh dubbing) · PM spec

**Status:** Draft for review · **Owner:** —  · **Stage:** pre-dev (planning)
**One line:** Upload a video in any language → get it back **dubbed into Kazakh**,
in a voice matched to the original speaker, timed to the video.

This document is the PM brief + research + task spec + DoD + acceptance criteria.
No code is written until the **Phase 0 validation gate** (below) passes.

---

## 1. TL;DR / recommendation

- **The pipeline you described already exists as one product: the ElevenLabs
  Dubbing API.** It auto-detects speakers, clones each speaker's voice (capturing
  gender/tone), transcribes, translates, synthesizes in the mapped voice, aligns
  to the source timing, keeps the background music, and returns a **dubbed video**.
  So v1 is mostly an **integration + productization** job, not building six ML
  stages ourselves.
- **The make-or-break unknown is Kazakh quality.** Kazakh TTS exists on ElevenLabs
  only via the **v3 (alpha)** model; the Multilingual v2 model long tied to
  Dubbing's voice-cloning has **no Kazakh**. Whether Kazakh dubbing keeps the
  speaker's cloned voice (or degrades to a generic voice) is **undocumented**.
- **Therefore: do a paid manual test dub FIRST (Phase 0), judged by native Kazakh
  speakers, before writing product code.** GO/NO-GO on real output, not marketing.
- **v1 = audio dub + timing alignment only. No visual lip-sync** (separate, ~$3–5/min,
  fails on long/non-frontal footage — a v2 problem).
- **Strong strategic fit:** NeuroShot's audience is Kazakhstan/CIS. "Localize any
  video into Kazakh" is a wedge no generic global tool prioritizes, and it reuses
  our async-job + fal.storage + ffmpeg + credits infrastructure.

---

## 2. Problem & opportunity

Kazakh is a **low-resource language**: global dubbing tools treat it as an
afterthought (thin voice inventories, unproven quality), and creators/marketers in
KZ have no easy "make this video speak Kazakh" button. Meanwhile short-form video
is the dominant format and NeuroShot already sells AI media by the патрон to a
KZ/CIS audience.

**Opportunity:** own "video → Kazakh" as a first-class, one-tap product. Use cases
that pay: creators localizing content for a Kazakh audience, SMBs/marketers
localizing ads and product videos, educators/course-makers, and users who want a
foreign video (EN/RU/TR) they like in Kazakh.

**Why now / why us:** the heavy ML is buyable (ElevenLabs Dubbing); the moat is
distribution (our KZ audience + patron economy), Kazakh-specific quality tuning,
and packaging it as one tap in a product people already use.

---

## 3. Users & primary use cases (v1)

| Persona | Job-to-be-done | Source lang (typical) |
|---|---|---|
| Content creator | Re-voice my own clip into Kazakh for local reach | EN / RU → KK |
| SMB / marketer | Localize a product/ad video into Kazakh | EN / RU → KK |
| Educator / course-maker | Dub a lesson into Kazakh | EN / RU → KK |
| Casual user | Watch a foreign clip I like, in Kazakh | any → KK |

**v1 target direction:** **→ Kazakh** only (one target). Source auto-detected.
Best quality expected for **EN/RU source** (well-supported ASR + translation);
Kazakh-source and rarer languages are lower-confidence (flag, don't block).

---

## 4. The pipeline — and how ElevenLabs Dubbing maps to it

Your described flow ↔ what the Dubbing API does internally:

| Your step | Canonical stage | Handled by |
|---|---|---|
| identify language + metadata (gender, tone, speed) | ASR + language-ID + **speaker diarization** + **voice cloning** (captures gender/tone) | ElevenLabs Dubbing (internal) |
| transcribe | ASR + word timestamps | ElevenLabs Dubbing (internal); or Scribe v2 (component) |
| translate to Kazakh | length-aware MT | ElevenLabs Dubbing (internal); or our LLM (component) |
| TTS + map voice features | TTS in the **cloned** voice | ElevenLabs Dubbing (internal) |
| match audio to the video | time-align + time-stretch + **remix over kept background music** | ElevenLabs Dubbing (internal) |

**Key point:** "identify metadata + map voice features" is not a stage we build —
it is the Dubbing API's automatic voice-clone. We *surface* the detected source
language to the user; the rest is internal.

### 4a. Architecture decision — buy (Dubbing API) vs build (components)

**Recommendation: v1 uses the ElevenLabs Dubbing API as the engine.** Rationale:
it collapses six stages into one call, solves the hardest parts (timing alignment,
background-music preservation, voice-clone), and returns a dubbed video (input up
to 2 GB / 180 min).

Keep the **component pipeline as the documented fallback** (only if Dubbing's
Kazakh quality fails Phase 0, or we later need per-segment control):

| Stage | Component option | Note |
|---|---|---|
| ASR + diarization + timestamps + lang-ID | **ElevenLabs Scribe v2** (Kazakh incl., ~5–10% WER, up to 32 speakers) | strongest Kazakh ASR found |
| translate → Kazakh | **LLM** (GPT-4o/Claude), length-budgeted | **DeepL has no Kazakh** — ruled out |
| TTS (Kazakh) | ElevenLabs **v3** (only ElevenLabs model with Kazakh); fallback **Azure kk-KZ**, Google, or **CAMB.AI** (Kazakh specialist) | thin voice inventories everywhere |
| align + remix | **ffmpeg** (already in our stack) + optional source-separation (Demucs) | our own code |

We do **not** commit to the component build now — it multiplies integration work
and hits the same Kazakh TTS ceiling. It is the escape hatch, not the plan.

---

## 5. Phased scope

### Phase 0 — Validation spike (BLOCKING, no product code)
Manually dub 3–5 representative clips (EN→KK and RU→KK, 1 and ~2 speakers, ~30–90s)
via the ElevenLabs Dubbing dashboard/API. Native-Kazakh listening test scoring:
translation accuracy, TTS naturalness, **voice-clone fidelity into Kazakh**, timing.
Record the real per-minute price. **Output: GO / NO-GO + cost number.**

### Phase 1 — MVP (the build, only if Phase 0 = GO)
One flow, both surfaces (bot + Mini App): **upload video → confirm (detected
source lang + duration + price) → dub to Kazakh → deliver dubbed video.**
- Audio dub + timing alignment; background music kept. **No lip-sync.**
- Length cap (e.g. ≤ 2–3 min v1) to bound cost/latency.
- Async job on our existing pending→ok/error model.
- Per-minute pricing in патроны; charge on submit, refund on failure.
- Consent attestation at upload + AI-generated disclosure on output.

### Phase 2+ (later, out of scope here)
Visual lip-sync (sync.so / fal); more target languages (KK↔RU↔EN); multi-speaker
tuning; component pipeline for per-segment control; subtitle export; editing/re-take.

---

## 6. Key decisions needed (from you, before/at Phase 1)

1. **Target languages v1:** → Kazakh only? (recommended) or also RU/EN targets?
2. **Length cap v1:** ≤ 2 min? ≤ 3 min? (bounds cost, latency, abuse). Recommend ≤ 2 min.
3. **Voice cloning of the original speaker:** allow (best result, higher ToS risk)
   vs. use a **stock Kazakh voice matched by gender** (safer, lower fidelity)?
   Recommend: clone **with an explicit consent attestation** (see §8).
4. **Background music:** keep (default) vs. offer a "clean speech only" toggle.
5. **Source scope:** any language (auto-detect) vs. restrict to EN/RU/KK where
   quality is proven? Recommend: allow any, but **warn** on low-confidence source.
6. **Surface:** Mini App only first, or bot + Mini App together?
7. **Pricing:** per-minute patron rate (set after Phase 0 cost is known).

---

## 7. Risks & gaps (from research — see `docs/` research notes)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Kazakh TTS quality unproven; only on v3 (alpha).** Multilingual v2 (Dubbing's clone model) has no Kazakh. | **Critical** | Phase 0 gate. Azure/CAMB.AI fallback. |
| R2 | Voice-clone fidelity may **degrade into Kazakh** (generic voice). | **Critical** | Phase 0 listening test. |
| R3 | No DeepL Kazakh → MT via LLM/Google; names/idioms weak. | High | LLM length-aware translation + optional review. |
| R4 | **Timing overrun** (Kazakh agglutinative, longer than EN) → audible speed-up or lost meaning. | High | Dubbing handles internally; cap length; accept minor stretch. |
| R5 | **Voice-clone consent/ToS** — cloning arbitrary uploaded people = impersonation risk; ElevenLabs pro-clone is self-only. | **Critical (legal)** | Consent attestation + ToS clause + AI disclosure (§8). |
| R6 | **Cost & latency** — minutes-long, per-minute paid jobs. | High | Length cap; charge on submit; async + progress; refund on fail. |
| R7 | Kazakh **ASR errors** propagate (esp. Kazakh source). | Med | Prefer EN/RU source; warn on low-confidence. |
| R8 | **Video ingest** — current upload is ~6.5 MB base64 images; video is far bigger. | Med (build) | New upload path (Telegram file id / resumable) — see §10. |
| R9 | New external dependency + key (`ELEVENLABS_API_KEY`), not on fal today. | Low | Config + client module. |
| R10 | Lip-sync expectation gap — users may expect mouths to match. | Med | Set expectation in copy ("голос переозвучен"), lip-sync = v2. |

---

## 8. Compliance (non-negotiable for v1)

- **Consent attestation at upload:** the user must affirm they have the rights /
  consent to dub the video and its voice(s). Store the attestation with the job.
- **ToS clause:** rights/impersonation responsibility sits with the user; prohibit
  unauthorized impersonation, per ElevenLabs ToS (mirrors our existing
  `docs/payment-compliance.md` accepted-risk pattern).
- **AI-generated disclosure on output:** reuse the existing mandatory
  AI-disclosure path (`docs/compliance.md`, `src/watermark.ts`) — the dubbed video
  is synthetic media and must carry the badge + metadata, same as every render.
- **Abuse guard:** consider blocking obviously non-consensual targets later; v1 =
  attestation + disclosure + ToS.

---

## 9. Cost & pricing model

- COGS per job ≈ ElevenLabs Dubbing per-minute rate (measured in Phase 0) + our
  compute (ffmpeg/storage). All materially higher than an image render.
- **Price per source-minute in патроны**, `ceil` to the credit grid, keeping the
  ≥3.5× margin basis (`CREDIT_COST_BASIS`), same as every model in `src/models.ts`.
- **Charge on submit; refund on failure** — reuse the exactly-once compensation
  (`completeGeneration` CAS + reaper) so a failed dub always refunds, once.
- Length cap enforces a predictable max cost per job.

---

## 10. Integration with existing infrastructure

Reused as-is:
- **Async job** — `createPendingGeneration` → detached work → `completeGeneration(ok/error, output_url)`; refund + reaper. (`docs/async-generation.md`.)
- **Media hosting** — `fal.storage.upload` returns public URLs for input/output.
- **ffmpeg** (prod Dockerfile) — audio extract / remux / (optional) source-separation.
- **Credits/pricing** — `CREDIT_COST_BASIS`, patron charge/refund.
- **AI disclosure** — `brandForDelivery` in `src/watermark.ts`.
- **Surfaces** — bot handlers + Mini App `/api/*`.

New build required:
- **Video ingest path** — the current `/api/upload` is ~6.5 MB base64 *images*.
  Video needs: (a) accept a **Telegram video/file id** (bot side) and/or (b) a
  larger/resumable upload (Mini App), then push bytes to `fal.storage` (or feed a
  URL straight to Dubbing, which accepts URLs). **Design task in Phase 1.**
- **Multi-stage/long job state** — a dub is one long external job (submit →
  poll → download); model it as a single generation whose "render" is the Dubbing
  job lifecycle (submit id, poll status, fetch result), on top of the existing
  pending row. No new job engine — extend the render function.
- **ElevenLabs client + `ELEVENLABS_API_KEY`** — new config + a thin module
  (submit dub, poll, fetch dubbed video). Mirror the `kaspi.ts` external-client style.

---

## 11. Task specification (Phase 1 / MVP)

> Only start after Phase 0 = GO. Epics → tasks; each task ships behind tests + typecheck.

**E0. Validation spike (Phase 0, do first)**
- T0.1 Manual test dubs (EN→KK, RU→KK; 1 & 2 speakers) via ElevenLabs.
- T0.2 Native-Kazakh listening test + scorecard; record per-minute price. → GO/NO-GO.

**E1. ElevenLabs Dubbing integration (backend)**
- T1.1 `ELEVENLABS_API_KEY` config + `.env.example`; a `src/dubbing.ts` client
  (submit dub, poll status, fetch dubbed video url). No secrets committed.
- T1.2 Map a "dub job" onto the generation model: pending row → submit → poll →
  on done fetch + store output_url via `completeGeneration`; refund on failure.
- T1.3 Per-minute pricing helper (source duration → патроны on the credit grid).

**E2. Video ingest**
- T2.1 Bot: accept an uploaded **video/document**; resolve a usable URL/bytes → `fal.storage`.
- T2.2 Mini App: video upload (size-capped, progress) → storage URL. (Larger than the image path.)
- T2.3 Probe duration + reject over the length cap + unsupported formats, with clear errors.

**E3. Product flow (both surfaces)**
- T3.1 Bot command/flow: send video → confirm screen (detected source lang, duration, price, consent) → dub → deliver.
- T3.2 Mini App: a "Перевести видео на казахский" entry → upload → confirm → progress → result in gallery.
- T3.3 Progress/latency UX (job is minutes): pending state, "готовим озвучку…", notify on done (reuse async delivery).

**E4. Compliance**
- T4.1 Consent attestation UI + stored flag on the job.
- T4.2 AI-disclosure on the dubbed video (reuse `brandForDelivery`).
- T4.3 ToS clause (docs + user-facing copy), per §8.

**E5. Cost/ops**
- T5.1 Charge-on-submit + refund-on-failure wired through exactly-once compensation.
- T5.2 Monitoring: dub success/failure rate + COGS into the CEO digest (`src/monitor.ts`).

**E6. Docs & tests**
- T6.1 e2e (bot dub flow: submit → mocked-provider done → delivered; failure → refund) + webapp API tests.
- T6.2 `docs/video-translator.md` (how it works, config, limits) + update `.env.example`.

---

## 12. Definition of Done (Phase 1)

- [ ] Phase 0 passed (documented GO + measured per-minute cost).
- [ ] A user can, from **bot and Mini App**, upload a ≤ cap video and receive it
      **dubbed into Kazakh** with the speaker's voice mapped and background music kept.
- [ ] Job is async: charged on submit, **refunded exactly once** on failure, delivered on success.
- [ ] Detected source language + duration + price shown **before** charging.
- [ ] Consent attestation captured; **AI-disclosure** on every output; ToS clause shipped.
- [ ] Per-minute patron pricing on the credit grid preserving the margin basis.
- [ ] Length cap + format/duration validation with clear user errors.
- [ ] `typecheck` + `lint` + `check:patron` clean; e2e + webapp suites green (incl. new dub tests); CI green.
- [ ] `docs/video-translator.md` + `.env.example` updated; no secrets committed.

## 13. Acceptance criteria (behavioral)

- **AC1 — happy path:** EN (or RU) 60–90s single-speaker video → Kazakh dub;
  output is a playable video, Kazakh audio, timing plausibly aligned, background
  music present, voice recognizably matched. Native reviewer rates ≥ "usable".
- **AC2 — pre-charge transparency:** the confirm screen shows detected source
  language, duration, and exact patron price; no charge happens before confirm.
- **AC3 — failure refund:** a forced provider failure leaves the user **fully
  refunded exactly once** (no double refund, no stranded charge) — asserted in e2e.
- **AC4 — over-cap:** a video over the length cap (or wrong format) is rejected
  **before** charging, with a clear message.
- **AC5 — disclosure:** the delivered dub carries the AI-generated badge + metadata.
- **AC6 — consent:** submitting without accepting the consent attestation is blocked.
- **AC7 — multi-speaker (soft):** a 2-speaker clip produces distinct voices per
  speaker (diarization), or degrades gracefully — documented, not silently wrong.
- **AC8 — idempotency:** double-submitting / double-confirm does not double-charge
  or create two jobs for one intent.

## 14. Explicitly OUT of scope for v1

Visual lip-sync; targets other than Kazakh; subtitle/caption export; in-app
transcript editing or re-takes; speaker-by-speaker voice selection; videos beyond
the length cap; real-time/live dubbing.

---

## 15. Immediate next step

**Run Phase 0.** Everything else is gated on a native-Kazakh GO and a real
per-minute cost number. Once those two facts exist, Phase 1 is a well-bounded
integration on top of infrastructure we already have.
