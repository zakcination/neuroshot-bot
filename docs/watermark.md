# Free-scenario watermark (brand + CTA)

Every **free** scenario video (the princess/football onboarding gift) is branded
with two things so each share is both an ad and a conversion path: the NeuroShot
logo (recognition) **and** a call-to-action pointing at the Telegram bot handle
(so a viewer knows exactly where to make their own, free). This is the viral loop
behind the free-hook funnel (see `docs/pricing.md`).

## How it works

`src/watermark.ts` runs after the free video is rendered:

1. downloads the fal video,
2. overlays `public/watermark.png` (the logo) **top-centre**, ~300px wide, at
   **85% opacity** (`MARK_OPACITY`),
3. draws a **CTA bar bottom-centre** — `Сделай такое же бесплатно → @<bot>` —
   white text on a translucent box, using the **configured bot handle**
   (`config.webappBotUsername` / `BOT_USERNAME`), so it always points at the real
   bot, no hardcoded @handle,
4. sends the branded MP4 to the user.

It uses **ffmpeg** + **fonts-dejavu-core** (both added to the Docker image;
DejaVuSans renders the Cyrillic CTA). The whole thing is a **safe no-op**: if
ffmpeg *or* the logo file is missing, `watermarkVideo` returns null and the
un-watermarked source is sent; if only the *font* is missing it degrades to
logo-only. The free flow never breaks, and paid renders are never touched.

## Enabling it — drop in the logo

Commit the brand lockup as:

```
public/watermark.png
```

Requirements:

- **A solid background is fine** — opacity is applied at overlay time
  (`MARK_OPACITY`), so the asset does not need an alpha channel. Transparent PNGs
  work too. The current asset is the pill-shaped `NeuroShot.ai` lockup.
- It should contain the **logo + the "NeuroShot.ai" wordmark** as a single
  lockup (we overlay one image; no separate text rendering).
- Keep it wide-ish and low (a footer lockup) — it's scaled to ~300px wide on the
  video, ratio preserved.

That's it. Once `public/watermark.png` exists and the container has ffmpeg +
fonts-dejavu-core, free videos are branded automatically — no code change needed.
The CTA handle comes from the `BOT_USERNAME` env var.

Tunables (constants in `src/watermark.ts`): `EDGE_PADDING` (40px), `MARK_WIDTH`
(300px), `MARK_OPACITY` (0.85), `CTA_FONTSIZE` (30px), `FFMPEG_TIMEOUT_MS`. The
CTA copy is in `ctaText()`.
