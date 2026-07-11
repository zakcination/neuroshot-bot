# Watermark (CTA badge + corner mark)

A pre-designed **CTA badge** — `Хочешь так же? Бесплатно: ✈️ @neuroshot_ai_bot`
— is overlaid at the bottom of deliverables. Each shared clip/photo is both an ad
and a conversion path: a viewer sees exactly where to make their own, for free.

## Two styles (`WatermarkStyle`)

`watermarkVideo` / `watermarkImage` take a `style` argument (`"cta"` default):

- **`cta`** — the full-width bottom banner above, 640px, 95% opacity. Loud on
  purpose: the free-scenario gift is where an explicit call-to-action belongs.
  Always used for free deliverables and the default per-user toggle.
- **`corner`** — a small (150px), low-opacity (70%) mark in the bottom-right, from
  `public/corner_watermark.png` — logo/@handle only, no CTA sentence. For content
  a creator posts to their **own** feed (the UGC bounty): attributable without
  reading like a third-party ad, which would suppress the organic reach the bounty
  pays for. **Note:** a *visible* mark is croppable, so it's for attribution — the
  actual bounty payout proof is the generation-id, not the badge (see the strategy
  doc). Until `public/corner_watermark.png` is added, the corner style is a safe
  no-op (returns null → source sent unbranded).

## Scope

- **Every generation** (bot images + videos via `runGeneration`, and web
  share-to-Telegram via `/api/send`) is branded **by default**.
- **Per-user toggle:** `users.watermark_enabled` (default `true`), flipped from
  the app's «Настройки» via `POST /api/settings` (`watermarkVideo`/`watermarkImage`
  are simply skipped when off).
- **Free scenarios are always branded** (the princess/football onboarding gift) —
  the badge is the price of "free", so the toggle doesn't apply there.

Both `watermarkVideo` and `watermarkImage` are safe no-ops (return null → the
source URL is sent) when ffmpeg or the badge file is missing.

## How it works

`src/watermark.ts` runs after the free video is rendered:

1. downloads the fal video,
2. overlays `public/watermark.png` (the CTA badge) **bottom-centre**, ~640px
   wide, at **95% opacity** (`MARK_OPACITY`), `32px` from the bottom edge,
3. sends the branded MP4 to the user.

The copy, the Telegram glyph, and the `@handle` are **baked into the badge
artwork**, so there is no text rendering here — hence no font dependency. It uses
**ffmpeg** (added to the Docker image). The whole thing is a **safe no-op**: if
ffmpeg *or* the badge file is missing, `watermarkVideo` returns null and the
un-watermarked source video is sent instead. The free flow never breaks, and paid
renders are never touched.

## Changing the watermark

Replace the artwork at:

```
public/watermark.png
```

- **RGBA PNG**, wide and low (a bottom banner). Transparent corners stay
  transparent through the overlay. The current asset is 2620×400.
- Everything the viewer reads — the CTA line, the Telegram glyph, the `@handle`
  — must be **in the image** (we overlay one picture; no text is drawn on top).
  So to change the copy or the handle, export a new badge and drop it here.

That's it. Once `public/watermark.png` exists and the container has ffmpeg, free
videos are branded automatically — no code change needed.

Tunables (constants in `src/watermark.ts`): `BOTTOM_PADDING` (32px), `MARK_WIDTH`
(640px), `MARK_OPACITY` (0.95), `FFMPEG_TIMEOUT_MS`.
