# AI-content disclosure (Kazakhstan Law No. 230-VIII)

Kazakhstan's Law No. 230-VIII **"On Artificial Intelligence"** (Article 21, in
force **2026-01-18**) requires that the distribution of AI-generated
("synthetic") output carry **two** marks, cumulatively (the statute's connector
is *«и»* / AND):

1. a **machine-readable** marking, **and**
2. a **human-perceptible warning** (visual / textual / audio) that a person can
   plainly perceive, "without methods that hinder such perception."

Metadata alone is **not** sufficient; a visible label alone is **not**
sufficient. The duty falls on the **owner/operator of the AI system** — that is
**NeuroShot**, not the end user who shares the output (Art. 21 §3). New
administrative penalties attach (КоАП Art. 641-1; reportedly Art. 456-2 for
distributing unmarked content).

The law does **not** prescribe an exact format, size, placement, or wording —
any clear, non-obfuscated indicator that plainly signals AI creation qualifies.
(This is *less* prescriptive than China's GB 45438-2025, which fixes a ≥5%
text-height rule, and *more* than the EU AI Act Art. 50(2), which mandates only
the machine-readable prong at the provider level.)

## How NeuroShot complies

Both prongs are applied to **every delivered image and video**, on a **mandatory
pass independent of the user's promo-watermark setting** (that toggle governs
marketing branding only, never this legal mark). See `src/watermark.ts`
(`brandForDelivery`) and the delivery paths in `src/generate.ts` /
`src/webapp.ts`.

- **Human-perceptible warning** — the `public/ai_generated.png` badge (the
  NeuroShot lens glyph + the words **"AI Generated"**) is overlaid in the
  top-left corner, clearly legible. Explicit wording (not a bare icon/asterisk)
  is the low-risk choice: the research on Art. 21 found icon-only marking
  "untested," and a ToS-only disclosure a "weaker fit" because the statute ties
  the warning to the distributed output itself.
- **Machine-readable marking** — an AI-generated marker is embedded in the output
  container via ffmpeg `-metadata` (`comment` + `ai_generated=true`).
  - **Video (mp4):** the container comment is written reliably.
  - **Image (png):** ffmpeg text-chunk metadata is **best-effort** and may not
    persist across all encoders/platforms. The visible badge (the primary
    compliance mechanism) is unaffected; a robust EXIF/XMP or **C2PA** provenance
    writer for images is a tracked follow-up hardening, not shipped here.

The mark is applied best-effort: if ffmpeg or the badge asset is missing the raw
source is sent (a branding hiccup never blocks a result). In production ffmpeg
and the asset are always present (see `Dockerfile`), so the disclosure ships on
every real delivery.

## Still required (not code)

- **Terms of Service / privacy-policy clause.** The user agreement should state
  that generated outputs are AI-generated and are marked as such (the
  "AI Generated" badge + embedded metadata). This reinforces the on-asset marking
  and documents NeuroShot's compliance posture; it does **not** replace the
  on-asset warning. Tracked with the Kaspi/Telegram-ToS risk write-up.

## Open items / caveats

- **Scope is unsettled.** Verification could not firmly establish whether Art. 21
  reaches *all* AI-generated media or is enforced toward deepfakes / synthetic
  media of real persons (the broad-scope readings were refuted 0-3 / 1-2). The
  statute covers "synthetic results," which on its face includes generic
  AI images/video, so we mark everything as the safe posture.
- **No implementing decree** fixing format/size/wording had been issued as of the
  research date; a future decree could tighten toward a China-style prescriptive
  regime, at which point the badge spec may need revisiting.
- **Image machine-readable prong** is best-effort pending a dedicated
  EXIF/XMP/C2PA writer (see above).
- Badge sizing is a fixed pixel width (`AI_WIDTH` in `src/watermark.ts`) to reuse
  the prod-validated overlay filter; a proportional (`scale2ref`) refinement is a
  possible follow-up once validated against real ffmpeg.
