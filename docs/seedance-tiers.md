# Seedance: which tier, and why the quiz says so

Grounding for `src/seedance.ts` (the in-bot chooser) and for the tier prices in
`src/models.ts`. Written 2026-07-27 from independent side-by-side testing, not
from vendor copy. **Every price below is still unverified against a real billed
run — see the open task at the bottom.**

## The family

fal exposes nine variants. Three axes: tier (`mini` / `fast` / base), and mode
(`image-to-video` / `reference-to-video` / `text-to-video`).

**Duration**: every variant accepts any whole second from **4 to 15** (schema
enum, probed 2026-07-28). We advertised only 5 and 10 until then — twelve lengths
collapsed into two, with the middle of the range (6–8 s, the length most short-form
video actually wants) unreachable. Kling 3.0 is the same story at 3–15 s. Kling 2.5
and Hailuo 2.3 Fast really do accept only two values each, which is why the
duration control indexes each model's own list instead of assuming a range.

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

### Subject: person vs object (2026-07-28)

`referencePrompt()` was written entirely in the language of faces — "the same
people repeated", "get the faces right". That was a real defect: several
sources researching this endpoint independently agree that multi-angle input
genuinely helps **products and objects**, and this mode is the obvious way a
marketplace seller shoots nine angles of an item for a listing video. Every one
of those requests got an instruction about people, because the wording never
considered anything else could be uploaded here.

`GenOpts.subject: "person" | "object"` picks the framing. Client-settable —
unlike the URL fields on this same interface, it only changes wording, never
what gets fetched, so there is no reason to hide it behind a server-only
assignment. `normalizeOpts` rejects it outright on a model that doesn't declare
`reference`; the field means nothing anywhere else, and silently ignoring it
there would hide a caller's mistake instead of naming it.

Default is `"person"`, reproducing the original wording byte for byte — every
caller before this field existed was a face. The Studio shows a plain two-chip
toggle (🙂 Человек / 📦 Товар) next to the "ещё ракурсов" affordance, visible
only for models that declare `reference` — it is meaningless (and hidden)
everywhere else, including the ordinary multi-angle-for-editing path on
`photo_edit`/`premium_edit`/etc., which only ever means a face and keeps its
fixed copy.

**Left open, on purpose:** whether a multi-angle *character turnaround* (front /
side / three-quarter / back) actually helps or hurts identity lock on the
`person` path is contested — some sources claim it causes the model to read one
face as several different people (the "twins" bug), and recommend a single
clean headshot instead. That claim did not survive verification: the two pages
it was sourced to on a first pass did not actually contain it. Nothing about the
`person` wording changed here pending a measured test on our own endpoint
(task #92) — an unverified prompt-engineering claim is not something to act on
when each wrong render costs a user real patrons.

Full endpoint limits: images up to 9 (JPEG/PNG/WebP, ≤30 MB each); audio up to 3
(MP3/WAV, combined ≤15 s, ≤15 MB each, and requires at least one image or video);
video up to 3 (MP4/MOV, combined 2–15 s, <50 MB total, each between ~640×640 and
~834×1112). **Total files across all modalities ≤ 12.**

### Audio and video references — what is screened, and what is not

Both are wired (owner's decision, 2026-07-27). Be exact about the difference:

| attachment | screening |
|---|---|
| images | the classifier, same as any upload, fail-closed |
| video | one frame extracted with ffmpeg and put through the same classifier |
| **audio** | **none — no classifier for it exists here** |

Duration and format are checked locally with `ffprobe` BEFORE upload, because the
provider would reject an over-length reference anyway and finding out remotely
costs a paid render. An unprobeable file is rejected rather than waved through:
if ffprobe were missing, treating "unknown" as "fine" would silently disable
every limit.

Audio therefore rests on an explicit rights notice the uploader accepts, recorded
per upload (not once per account — it is a claim about THAT file). §5.1 of the
Terms states it: responsibility for uploaded material lies with the uploader, and
that audio is not automatically checked. Note what this does and does not buy —
it settles responsibility BETWEEN us and the uploader; it does not remove our own
duties as the operator processing the file, and a voice sample is biometric data
under the KZ personal-data law.

- `text-to-video` is for concept discovery, before you have a frame worth
  keeping.

## Open: the prices are not measured

fal bills this family **per 1000 tokens** ($0.007 mini / $0.0112 fast / $0.014
base). Our registry prices video **per second**. The ratios agree — mini is half
of base in both — so the tiers are ordered correctly relative to each other.

The absolute basis is another matter: published per-clip figures for a 5-second
720p render come out roughly half what our per-second numbers imply, which would
mean we overcharge for the whole family.

`SEEDANCE_RES` gave 480p and 720p the same multiplier, which could not be right
when cost tracks tokens and tokens track pixels. 480p is now charged at 0.5×
(854×480 against 1280×720 is ~0.44× the work; the extra 0.06 is margin we keep
until the basis is measured). The flagship endpoint also lists **1080p and 4K**,
which we do not sell — their multipliers would have to be invented on top of a
cost basis that is already unverified.

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
