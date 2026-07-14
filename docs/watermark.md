# Watermark (mandatory AI disclosure + promo CTA badge)

`src/watermark.ts` composites overlays onto every delivered image/video in ONE
ffmpeg pass. Two independent concerns live here:

1. **The mandatory AI-disclosure mark** (`"ai"` style) — Kazakhstan's Law
   No. 230-VIII "On Artificial Intelligence" (Art. 21, in force 2026-01-18)
   requires every distributed AI-generated ("synthetic") output to carry both
   a machine-readable marking **and** a human-perceptible warning. This is now
   the module's primary purpose: it is applied to **every single delivery**,
   independent of the user's promo-watermark setting — see
   [`docs/compliance.md`](./compliance.md) for the full legal framing.
2. **The promo CTA badge** (`"cta"` style) — the original purpose of this
   module: `Хочешь так же? Бесплатно: ✈️ @neuroshot_ai_bot` overlaid at the
   bottom of free/shared deliverables, turning a shared clip into an ad.

## Styles (`WatermarkStyle`)

Three styles are defined; only two are actually selected by `deliveryStyles()`:

- **`ai`** — the mandatory legal disclosure badge (`public/ai_generated.png`),
  top-left, 400px wide (`AI_WIDTH`), 95% opacity (`AI_OPACITY`). **Always**
  included — non-optional, independent of any user setting.
- **`cta`** — the full-width bottom promo banner (`public/watermark.png`),
  centered, 640px wide (`CTA_WIDTH`), 95% opacity (`CTA_OPACITY`). Included
  only when the caller asks for it (free scenarios always; paid renders when
  the user's watermark toggle is on).
- **`corner`** — a small (150px, `CORNER_WIDTH`), low-opacity (70%,
  `CORNER_OPACITY`) logo/@handle mark for bottom-right placement, from
  `public/corner_watermark.png` (the asset **exists** in the repo today). This
  style is defined and has a working `styleSpec`/asset, but **`deliveryStyles()`
  never selects it** — nothing in the codebase currently calls `brand()` with
  `"corner"` in its style list. It's an unwired/backlog style (intended for
  UGC-bounty content a creator posts to their own feed), not a shipped one.

`deliveryStyles(promo: boolean)` returns `["ai"]` normally, or `["ai", "cta"]`
when `promo` is true — so the AI disclosure is always first/non-optional and
the CTA is the only style toggled by caller intent.

## Scope

- **Every generation** (bot images + videos via `runGeneration`, and web
  share-to-Telegram via `/api/send`) gets the mandatory `"ai"` disclosure —
  no exceptions, no per-user toggle.
- **Per-user toggle:** `users.watermark_enabled` (default `true`), flipped from
  the app's «Настройки» via `POST /api/settings`, controls only whether the
  `"cta"` promo banner is added on top — it never turns off the `"ai"` mark.
- **Free scenarios are always branded with both** `"ai"` and `"cta"` (the
  princess/football onboarding gift) — the promo badge is the price of "free".

## How it works

`brandForDelivery(url, kind, { promo })` → `brand()` in `src/watermark.ts`:

1. downloads the source image/video from its fal URL,
2. builds one `filter_complex` (`buildOverlayFilter`) chaining every style's
   badge over the base media in a single ffmpeg pass,
3. embeds a machine-readable AI-generated marker via `-metadata` (`comment` +
   `ai_generated=true`) — the container comment on video, best-effort PNG
   text-chunk metadata on images,
4. returns the branded bytes, or `null` if branding is unavailable/failed —
   the caller then sends the raw source unchanged.

**The `"ai"` disclosure is a hard requirement, not a soft one**: if its asset
is missing, `brand()` bails entirely (returns `null`) rather than shipping a
promo-only, undisclosed output. `disclosureAvailable()` reports whether ffmpeg
+ the `ai` asset are both present, for anything that wants to check this
up-front. In production ffmpeg and all badge assets are always present (see
`Dockerfile`), so the disclosure ships on every real delivery.

## Changing the artwork

- **AI disclosure** — `public/ai_generated.png` (the legal warning badge). Do
  not remove or disable this without a compliance review (see
  `docs/compliance.md`).
- **Promo CTA** — `public/watermark.png`. RGBA PNG, wide and low (a bottom
  banner; the current asset is 2620×400). Everything the viewer reads — the
  CTA line, the Telegram glyph, the `@handle` — is baked into the image (no
  text is drawn on top), so change the copy/handle by exporting a new badge.
- **Corner mark** — `public/corner_watermark.png` exists in the repo, but
  since nothing wires the `"corner"` style into `deliveryStyles()` yet,
  replacing this file has no visible effect until that wiring is added.

## Tunables (constants in `src/watermark.ts`)

- `PADDING` (32px) — edge padding shared by all styles.
- `AI_WIDTH` (400px), `CTA_WIDTH` (640px), `CORNER_WIDTH` (150px) — rendered
  badge widths (fixed-px, not proportional to the source resolution).
- `AI_OPACITY` (0.95), `CTA_OPACITY` (0.95), `CORNER_OPACITY` (0.7).
- `FFMPEG_TIMEOUT_MS` (60s) — hard cap so a stuck ffmpeg can't wedge a request.

The whole thing is a **safe no-op on failure**: if ffmpeg or a required badge
file is missing, the affected overlay is skipped (or, for the mandatory `ai`
style, the whole branding pass is skipped) and the caller sends the
un-branded source URL instead — a branding hiccup never blocks a result.
