# Free-scenario watermark

Every **free** scenario video (the princess/football onboarding gift) is branded
with the NeuroShot logo so each share markets us. This is the viral loop behind
the free-hook funnel (see `docs/pricing.md`).

## How it works

`src/watermark.ts` runs after the free video is rendered:

1. downloads the fal video,
2. overlays `public/watermark.png` at the **bottom-centre**, `45px` from the
   bottom edge (the 40–50px spec), scaled to ~320px wide,
3. sends the branded MP4 to the user.

It uses **ffmpeg** (added to the Docker image). The whole thing is a **safe
no-op**: if ffmpeg *or* the logo file is missing, `watermarkVideo` returns null
and the un-watermarked source video is sent instead — so the free flow keeps
working before branding is enabled, and paid renders are never touched.

## Enabling it — drop in the logo

Commit the brand lockup as:

```
public/watermark.png
```

Requirements:

- **Transparent PNG** (alpha channel) — it's composited straight over the video.
- It should already contain the **logo + the "NeuroShot.ai" wordmark** as a
  single lockup (we overlay one image; no separate text rendering). Put the
  wordmark under/beside the logo with a bit of internal padding.
- Keep it wide-ish and low (a footer lockup), e.g. ~1000×250px — it's scaled to
  320px wide on the video, ratio preserved.

That's it. Once `public/watermark.png` exists and the container has ffmpeg, free
videos are branded automatically — no code or env change needed.

Tunables (constants in `src/watermark.ts`): `BOTTOM_PADDING` (45px), `MARK_WIDTH`
(320px), `FFMPEG_TIMEOUT_MS`.
