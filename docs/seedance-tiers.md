# Seedance: which tier, and why the quiz says so

Grounding for `src/seedance.ts` (the in-bot chooser) and for the tier prices in
`src/models.ts`. Written 2026-07-27 from independent side-by-side testing, not
from vendor copy. **Every price below is still unverified against a real billed
run — see the open task at the bottom.**

## The family

fal exposes nine variants. Three axes: tier (`mini` / `fast` / base), and mode
(`image-to-video` / `reference-to-video` / `text-to-video`).

| tier | max resolution | max duration | relative price |
|---|---|---|---|
| Mini | 720p | 15 s | 0.5× |
| Fast | 720p | 15 s | 0.8× |
| 2.0 (base) | 4K | 15 s | 1× |

Ratios are stable across sources; the absolute basis is not (see below).

## What testing actually found

- **Mini matched the flagship** on talking-head and product shots, and caught
  scene details the flagship missed. Those two shot types are most of our
  catalogue.
- **Mini's weakness is motion.** Subjects move less than the prompt asks, and
  framing comes out wider than requested.
- **Resolution is the flagship's one unambiguous advantage.** Mini and Fast stop
  at 720p; 1080p and 4K exist nowhere else in the family.
- **Fast is poor value.** At ~60% over Mini it behaved like a coin flip —
  it produced the single worst clip of the comparison while occasionally beating
  both others. We keep it (campaign scenes are pinned to it) but no advice sends
  anyone there.
- **Lip-sync degrades** when heavy motion combines with emotional speech, so a
  shot that depends on believable speech wants the more consistent tier.
- **Audio is on by default** and costs the same either way. Our copy calls the
  flagship "со звуком" as if that were its differentiator. It is not.

## The quiz

Four yes/no questions, first YES wins, cheapest answer reachable in one tap:

1. Первая проба, ещё подбираете кадр? → **Mini** (don't pay flagship rates for a draft)
2. Нужно выше 720p? → **2.0** (nothing else can)
3. Главное — сложное движение? → **2.0** (Mini under-moves)
4. Важна речь в губы? → **2.0** (sync is the first thing to break)
5. Всё «нет» → **Mini**

## Reference mode

`seedance_ref` (mini endpoint) is wired: up to **9 photographs** of the same
subject, composited into one clip. Extra references do not change the price —
the model reads them all in one call. This is the "two strong frames, then
motion" recipe the Видео-сет pack is named after.

The endpoint binds attachments **by name**: its docs say to address them in the
prompt as `@Image1`, `@Image2`. Users write plain Russian, so `referencePrompt()`
writes the binding for them and adds what the list is FOR — the same subject
repeated, not extra guests, and never a collage.

Full endpoint limits: images up to 9 (JPEG/PNG/WebP, ≤30 MB each); audio up to 3
(MP3/WAV, combined ≤15 s, ≤15 MB each, and requires at least one image or video);
video up to 3 (MP4/MOV, combined 2–15 s, <50 MB total, each between ~640×640 and
~834×1112). **Total files across all modalities ≤ 12.**

### Audio and video references are NOT wired, on purpose

Our only content gate is an image classifier. Audio has no gate; video has none
either, though one is buildable by extracting a frame with the ffmpeg we already
ship. Beyond that, the schema says audio requires an accompanying image or video
— it exists to drive a person's **speech**, which is the same likeness problem
that cost us two campaigns, and a voice sample is biometric data under the KZ
personal-data law. See the open task before adding them.

- `text-to-video` is for concept discovery, before you have a frame worth
  keeping.

## Open: the prices are not measured

fal bills this family **per 1000 tokens** ($0.007 mini / $0.0112 fast / $0.014
base). Our registry prices video **per second**. The ratios agree — mini is half
of base in both — so the tiers are ordered correctly relative to each other.

The absolute basis is another matter: published per-clip figures for a 5-second
720p render come out roughly half what our per-second numbers imply, which would
mean we overcharge for the whole family. And `SEEDANCE_RES` currently gives 480p
and 720p the same multiplier, which cannot be right when cost tracks tokens.

No Seedance render has yet been observed with its real billed cost. Re-derive all
four numbers from one measured run at each tier before trusting any of them, and
re-check the Видео-сет arithmetic afterwards — that pack was sized from the
unverified figures.

## Sources

- [Seedance 2.0 vs Fast vs Mini: Is the Cheap One Enough? (2026)](https://pixo.video/blog/seedance-2-0-vs-fast-vs-mini)
- [Seedance 2.0 Mini vs Fast: Tiers Compared (2026)](https://empiriolabs.ai/blog/seedance-2-0-mini-vs-fast-video-test)
- [Seedance 2.0 Mini vs Seedance 2.0: Speed, Cost, Quality, and Which to Use](https://pexo.ai/blog/seedance-2-0-mini-vs-seedance-2-0-2705)
- [How to Use Seedance 2.0: Reference Images, Video, and Audio Without Drift](https://magichour.ai/blog/how-to-use-seedance-20)
- [Seedance 2 Reference to Video API on fal](https://fal.ai/models/bytedance/seedance-2.0/reference-to-video)
- Endpoint schemas probed directly from fal's OpenAPI (duration enum, resolution
  enum, `generate_audio` default and its cost note, `bitrate_mode`).
