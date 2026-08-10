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

### 1080p and 4K — shipped 2026-08 (owner decision)

Added to the flagship only (`SEEDANCE_FLAGSHIP_RES`, `src/models.ts`) — mini/
fast/ref stop at 720p on fal's own schema, so they never got these IDs.

Unlike every tier before it, these don't sell at straight COGS pass-through
(mechanical multiplier = mechanical price). The owner's call: cost-plus-a-
flat-service-fee instead, anchored at 15s (this family's longest duration) —
**+$2 at 1080p, +$4 at 4K** — held PROPORTIONAL to duration below that, so a
5s render pays 5/15 of the 15s fee rather than the full flat amount:

| resolution | cost ratio vs 720p (exact) | cost @ 15s | + fee | target @ 15s | `mult` |
|---|---|---|---|---|---|
| 720p (base) | 1× | $4.55 | — | $4.55 | 1 |
| 480p | 0.5× (discount, unrelated to this addition) | $2.28 | — | — | 0.5 |
| 1080p | 2.25× | $10.24 | +$2 | $12.24 | 2.69 |
| 4K | 9 × 4/7 ≈ 5.143× | $23.41 | +$4 | $27.41 | 6.02 |

The cost ratios are exact, not estimated — pixel count scales tokens 1:1, and
1080p bills at the SAME per-token rate as 720p ($0.014/1000) while 4K bills at
a lower rate ($0.008/1000) but far more pixels, netting the ~5.14× above (see
"The billing formula" above for the token math). `mult` is `target/cost_720p`
at the 15s anchor; because both the cost term and the fee term are linear in
duration, one constant `mult` reproduces "cost(d) + fee×(d/15)" at every
duration in the range, not just 15s — confirmed against the live registry:

| duration | 1080p charge (raw, no sale) | 4K charge (raw, no sale) |
|---|---|---|
| 5 s | 103🔫 ≈ $2.06 | 229🔫 ≈ $4.58 |
| 15 s | 614🔫 ≈ $12.28 | 1,373🔫 ≈ $27.46 |

**`costMult` keeps COGS accounting honest.** `mult` (2.69 / 6.02) drives the
CHARGE; a separate `costMult` (2.25 / 5.143, the real ratio with no fee)
drives `costUsdFor` — otherwise the fee would read as if it were provider
cost, inflating COGS tracking and per-user cost caps by exactly the fee
amount. See `ResTier`'s own doc comment in `src/models.ts`.

**The flagship duration cap (`flagshipCapCredits`) had to learn to skip these
two.** That curve was calibrated against 720p and applies as a flat
`Math.min` regardless of resolution — left alone, it would have clamped a
4K/15s render right back down to the SAME ~92🔫 ceiling as 720p, selling $23
of real cost for the price of $4.55 of it. `priceFor` now skips the cap
whenever the resolution tier's `mult > 1` (i.e. a premium tier, not the
existing 480p discount, which still ties with the cap exactly as before).

**Not addressed here, flagged for follow-up:** no separate duration cap for
4K specifically. The owner's ask was proportional pricing across the full
4–15s range, not a shorter ceiling — a 4K/15s render is reachable in one tap
at ~1,373🔫 (~₸34,000–55,000 at the 25–40 ₸/🔫 pack range, pre-sale). Whether
that needs its own UX guard (confirmation step, a lower max duration) is a
product call, not a pricing one, and wasn't part of this change.

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

## Seedance 2.5 (2026-08-10, registry entry only)

Not a fifth tier of the family above — a separate generation, its own fal
namespace (`bytedance/seedance-2.5/{text-to-video,image-to-video,reference-to-video}`),
live on fal as of this writing. Two real capability jumps over 2.0: native
clips up to **30s** (vs 15s) and up to **50** reference inputs (vs 9 on
`seedance_ref`). Neither is wired — `seedance25`'s `durations` array stops at
15s and reference mode isn't built for it — because both need their own
decisions (does the duration slider/`flagshipCapCredits`-style curve extend to
30s? does a 50-photo picker make sense in the composer UI?) that a pricing
pass doesn't answer. `docs/product-roadmap.md` is where those belong once
scoped.

**Pricing, derived by the identical method already verified for 2.0** (see
"The billing formula" above) — same token formula, 2.5's own real rate:

```
tokens = (output_height × output_width × duration_seconds × 24) / 1024
rate    = $0.0214 / 1000 tokens (confirmed on fal's own pricing/schema pages,
          same rate at 480p and 720p — no 4K/1080p tier to bill differently)
```

At 1280×720 (720p, matching exactly how 2.0's `perSecondUsd` is anchored):
`tokens/s = 21,600` → `21.6 × $0.0214 = $0.4622/s`. Registry's `seedance25`
uses this figure.

**Cross-check, and the one open gap.** fal's own pricing page separately
states "~$0.4730/s at 720p" — about **2.3% above** the formula figure, a
looser match than the 0.33% the 2.0 family's formula reproduces its
registry numbers to. Both numbers come from the same per-token rate and the
same resolution table (fal's own schema lists 1280×720 for 16:9/720p), so the
gap is most likely rounding in how that page's figure was quoted rather than
a different rate — but unlike the rest of the family, **no real seedance25
render has been billed yet** to settle it either way. Until one is, treat
`$0.4622/s` as the same "derived, not measured" caveat `seedance_mini` already
carries, on the conservative side (the formula figure is the LOWER of the two
— if the true rate is closer to fal's quoted $0.4730/s, current pricing is
undercharging by ~2.3%, not overcharging). One real render's invoice, same as
the standing "verify Seedance end to end" task, closes this.

480p uses the same rounding-in-our-favor convention as `SEEDANCE_RES`: real
ratio at 864×496 vs 1280×720 is 0.465× the tokens (a different pixel grid
than 2.0's 854×480, so not exactly 0.4448×, but close), charged at `mult: 0.5`
regardless — the same conservative round the rest of the family uses.

At 5s/720p (registry default): cost = $2.311 → **116🔫** (`ceil(2.311/0.02)`).
Not in `SEEDANCE_SALE_KEYS` or subject to the flagship ceiling — both are
2.0-specific mechanisms tuned against 2.0's cost curve, and applying either to
2.5's different (higher) cost basis without its own review would silently
under-price it the same way the flagship ceiling would have under-priced
1080p/4K if left unguarded (see above).

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
