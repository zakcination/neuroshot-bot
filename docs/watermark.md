# Free-scenario watermark (CTA badge)

Every **free** scenario video (the princess/football onboarding gift) is branded
with a pre-designed **CTA badge** — `Хочешь так же? Бесплатно: ✈️ @neuroshot_ai_bot`
— overlaid at the bottom. Each shared clip is both an ad and a conversion path: a
viewer sees exactly where to make their own, for free. This is the viral loop
behind the free-hook funnel (see `docs/pricing.md`).

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
