# Seedance: which tier, and why the quiz says so

Grounding for `src/seedance.ts` (the in-bot chooser) and for the tier prices in
`src/models.ts`. Written 2026-07-27 from independent side-by-side testing, not
from vendor copy. **Pricing was formula-verified 2026-07-28** — see "The
billing formula" below; a real billed run is still the one thing that would
close the loop completely.

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

## The billing formula (resolved 2026-07-28)

fal bills this family **per 1000 tokens**, and the token count is a documented
formula, not something we had to infer:

```
tokens = (output_height × output_width × duration_seconds × 24) / 1024
```

Rate per 1000 tokens: **$0.007 mini · $0.0112 fast · $0.014 base (480p/720p/1080p)
· $0.008 base-at-4K**. 4K is billed at a LOWER per-token rate than the other three
tiers on the same endpoint — confirmed against the flagship's own schema
(`resolution` enum is `480p/720p/1080p/4k` on one endpoint, `generate_audio`
costs nothing extra either way — both re-probed directly against fal's OpenAPI
schema, not taken from a summary).

**This resolves the previous "prices are not measured" caveat, in our favour.**
Plugging the formula in at 1280×720 and 1920×1080 reproduces the flat $/second
figures fal quotes for those tiers to within 0.3%, and — the part that actually
matters for us — reproduces our registry's `perSecondUsd` for all four variants
to within 0.33%:

| model | registry $/s (720p) | formula $/s (720p) | diff |
|---|---|---|---|
| `seedance` (base) | 0.3034 | 0.3024 | 0.33% |
| `seedance_fast` | 0.2419 | 0.2419 | 0.01% |
| `seedance_mini` / `seedance_ref` (mini) | 0.1517 | 0.1512 | 0.33% |

The earlier worry — that published per-clip figures implied we overcharge by
roughly 2× — does not survive contact with the actual billing formula. Whatever
those per-clip figures were pricing, it was not this endpoint under this
formula. **Not yet fully closed**: this is the documented formula reproducing
our numbers, which is much stronger evidence than the ratio-comparison this
section used to rest on, but still short of watching our own account get billed
for a real render. That last step is cheap (one render, note the invoice) and
still worth doing before calling this fully verified.

`SEEDANCE_RES`'s 480p multiplier (0.5×) is now confirmed conservative rather than
guessed: 854×480 against 1280×720 works out to **0.4448×** the tokens at any
tier, so charging 0.5× keeps roughly 0.055× of extra margin at 480p on top of
the standard band, in our favour.

### If 1080p or 4K are ever added to the flagship

Not sold today, and this is why: at the current duration range (4–15s), the real
cost swings far outside the rest of the catalogue.

| resolution | 5 s | 15 s | multiplier vs 720p base (76🔫 / 5s) |
|---|---|---|---|
| 720p (sold) | $1.51 → 76🔫 | $4.54 → 227🔫 | 1× |
| 1080p | $3.40 → 171🔫 | $10.21 → 511🔫 | 2.25× |
| 4K | $7.78 → 389🔫 | $23.33 → 1,167🔫 | ~5.14× |

The multiplier no longer has to be invented (2.25× and ~5.14×, from the formula
above) — but a single 4K/15s render costing $23 of real COGS is a different
class of exposure than anything else we sell, and needs its own duration cap
(most consumer video tools cap 4K well below their 1080p/720p ceiling for exactly
this reason) and its own pricing decision before it ships, not a mechanical
multiplier applied to the existing ladder.

## The 2026-07-28 sale

Owner decision, 2026-07-28: Seedance had drifted into a profit center rather
than the acquisition hook it was meant to be. A 15-second flagship render
(base/720p) was printing **4,633–6,903 ₸ of profit** on a real cost of roughly
2,200 ₸ — well past what a "good feeder" model should keep. The call: cut the
charge, don't chase margin on Seedance specifically, and turn the cut itself
into a visible, time-boxed promotion rather than a quiet reprice.

**Mechanism**: `SEEDANCE_SALE_MULT = 0.5` in `src/models.ts` — a flat 50% cut
applied as the LAST step inside `priceFor()`, after every duration/resolution/
count scale-up, to exactly the 4 Seedance keys (`seedance`, `seedance_fast`,
`seedance_mini`, `seedance_ref`). It runs while
`seedanceSaleActive()` (`src/offer.ts`) is true — a fixed calendar deadline,
`config.seedanceSaleUntil`, defaulting to **2026-09-10T23:59:59+05:00**
(env: `SEEDANCE_SALE_UNTIL`).

**Why multiplicative, not an additive profit-floor cut.** The first design
tried to hold a hard floor (charge = cost + 990 ₸, no less) by capping credits
directly at whatever a given duration/resolution combo actually costs. That
breaks the moment it composes with the client's own resolution multiplier: capping
at 720p's cost, then applying the existing "half price at 480p" multiplier on
top, gives a DIFFERENT number than computing the same additive cap directly
against 480p's own (lower) real cost — for base/480p/15s, direct-cap gives 66
credits (992 ₸ profit, floor holds) while cap-then-halve gives only 53 credits
(622 ₸ profit, floor **broken**). A flat multiplier has no such composition
hazard: it's just one more multiplier in the same chain every other scale-up
already goes through, so client and server mirror it exactly with zero parity
risk.

**What it does to the numbers.** The reference complaint case (base/720p/15s)
lands at **1,243–2,383 ₸ of profit**, depending on which credit pack funded the
purchase — down from 4,633–6,903 ₸, and squarely in the "don't expect big
profit from Seedance specifically" zone the owner asked for. The worst case
anywhere in the duration/resolution grid (mini/480p/4s) still clears roughly
111–160 ₸ of profit — the sale never sells a render below its real cost.

**What it does NOT touch**: `costUsdFor()` — the real provider-cost function
feeding COGS accounting, the digest's margin estimate, and per-user cost
caps — is untouched by design. Only `priceFor()` (the patron charge) is
discounted; what a render actually costs us is unaffected by how much we
charge for it.

Surfacing: `/api/me` exposes `seedanceSale: { active, endsAt }`; the Studio and
video composer show a "🔥 Акция на Seedance" banner while active, and the
Studio's model row/chip badges the 4 discounted models with "🔥 −50%". The bot's
course-lesson copy reads live prices via `priceFor()` rather than the models'
raw `credits` field, so it never quotes a stale, pre-sale number.

## The flagship ceiling (2026-07-29, permanent, revised same day)

Owner decision, 2026-07-29: reposition the flagship (`seedance`) as a
loss-leader "staple" price point, distinct from — and outliving — the
time-boxed sale above. Unlike the sale, this does not expire on 2026-09-10.

**First cut vs. shipped version.** The first design was one flat number —
`FLAGSHIP_CAP_CREDITS = 74`, so 10s and 15s cost identically once capped. The
owner replaced it same-day with a real per-second CURVE, naming three anchor
points directly: **5s → 38, 10s → 65, 15s → 92 credits**. Those three fall
exactly on one line (verified, not approximated): slope 5.4 credits/second,
intercept 11. `flagshipCapCredits(duration)` in `src/models.ts` is that line —
`round(11 + 5.4 × duration)` — so it reproduces the named numbers to the
credit and gives every other duration (4, 6, 7, 8, 9, 11, 12, 13, 14s) a
sensible, strictly-increasing value in between.

**Mechanism**: applied via `Math.min` as the step AFTER the sale multiplier
inside `priceFor()`, and only to the `seedance` key (not the other 3 Seedance
tiers). Gated on `flagshipCapActive()` (`src/offer.ts`) — a start timestamp,
`config.flagshipCapFrom`, defaulting to **2026-07-29T20:00:00+05:00**
(env: `FLAGSHIP_CAP_FROM`). Once it starts, it never turns back off — there is
no end-date config, unlike `seedanceSaleUntil`.

**This is NOT a strict "never above N ₸" ceiling**, unlike the first design.
At the priciest recurring pack (40 ₸/credit), 15s reaches 92 × 40 = **3,680 ₸**
— above the ~3,000 ₸ figure discussed when this was scoped. It stays under
~3,000 ₸ at the cheaper/typical packs (30–34 ₸/credit → 2,760–3,128 ₸ at 15s).
If a strict cross-pack ceiling is wanted again, the curve itself needs an
upper clamp (e.g. `min(round(11 + 5.4×duration), 75)` for a hard 3,000 ₸ cap
at the 40 ₸ pack) — not done here because the owner's anchor points were given
without one. The in-app banner deliberately makes no specific ₸ claim for this
reason (see `saleBanner()` in `public/app.html`).

**Margin, full grid (720p, KZT_PER_USD=480), worst case per pack rate:**

| duration | real cost | credits | value @25₸ (one-time) | @30₸ | @40₸ | margin @25₸ |
|---|---|---|---|---|---|---|
| 4s | 583 ₸ | 33 | 825 ₸ | 990 ₸ | 1,320 ₸ | +242 ₸ |
| 5s | 730 ₸ | 38 | 950 ₸ | 1,140 ₸ | 1,520 ₸ | +220 ₸ |
| 10s | 1,456 ₸ | 65 | 1,625 ₸ | 1,950 ₸ | 2,600 ₸ | +169 ₸ |
| 15s | 2,184 ₸ | 92 | 2,300 ₸ | 2,760 ₸ | 3,680 ₸ | +116 ₸ |

Margin is positive everywhere in the grid — including, unlike the first flat-74
design, at the one-time 25 ₸/credit entry pack (worst case +116 ₸ at 15s,
never negative). The curve binds (produces a lower price than the plain -50%
sale) from 6s onward; at 4–5s the sale price alone is already cheaper, so
nothing changes there.

**Why this interacts safely with the sale expiring.** The cap is a pure
`Math.min(credits, flagshipCapCredits(duration))` regardless of how `credits`
got computed — whether the sale is on (today) or has expired (after
2026-09-10, when steady-state per-second pricing resumes and pushes the
uncapped price further above the curve at every duration), the final capped
price and its margin against real cost are identical. The two mechanisms
don't need to know about each other.

Surfacing: `/api/me` exposes `flagshipCeiling: { active, modelKey }` (no
`maxKzt` — there's no single number to show; no `endsAt` — it's permanent).
The shared "🔥 Seedance" banner in the Studio and video composer appends a
ceiling sentence (duration-neutral, no specific ₸ figure) once active,
independent of whether the sale sentence is still showing. The real
per-duration prices are visible where they always were — the composer's
duration slider, which reads `priceFor()` directly.

## Sources

- [Seedance 2.0 vs Fast vs Mini: Is the Cheap One Enough? (2026)](https://pixo.video/blog/seedance-2-0-vs-fast-vs-mini)
- [Seedance 2.0 Mini vs Fast: Tiers Compared (2026)](https://empiriolabs.ai/blog/seedance-2-0-mini-vs-fast-video-test)
- [Seedance 2.0 Mini vs Seedance 2.0: Speed, Cost, Quality, and Which to Use](https://pexo.ai/blog/seedance-2-0-mini-vs-seedance-2-0-2705)
- [How to Use Seedance 2.0: Reference Images, Video, and Audio Without Drift](https://magichour.ai/blog/how-to-use-seedance-20)
- [Seedance 2 Reference to Video API on fal](https://fal.ai/models/bytedance/seedance-2.0/reference-to-video)
- Endpoint schemas probed directly from fal's OpenAPI (duration enum, resolution
  enum, `generate_audio` default and its cost note, `bitrate_mode`).
- Token-billing formula and per-1000-token rates (owner-supplied, 2026-07-28),
  cross-checked against the flagship's own OpenAPI schema and against our
  registry's `perSecondUsd` (all four variants agree to within 0.33%).
