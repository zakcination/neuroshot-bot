# Cinema Studio — per-model parameter matrix (fal-grounded)

Companion to `docs/cinema-studio-spec.md` §4 block ⑥ ("Parameters — per selected model"). This deepens that block with the **real, verified fal input schemas** for every model in our registry, so the Studio shows *only the selectors each model actually supports*, with correct enums, defaults, and price effects.

**Source:** fal documentation MCP (`https://fal.ai/docs/mcp`, `query_docs_filesystem_fal` over the live OpenAPI/mdx), verified **2026-07-22**. Registry = `src/models.ts`.

The four Studio selectors and what each maps to in a fal schema:
| Studio selector | fal field(s) |
|---|---|
| **Aspect ratio** | `aspect_ratio` (Enum) or `image_size` (named preset Enum, Seedream) |
| **Resolution / quality** | `resolution` (Enum) — images & some video |
| **Duration** | `duration` (DurationEnum) — video only |
| **Count** | `num_images` (integer) — images only; **not encoded in our registry today** |

---

## 1. Image models — verified schemas

| model (our key) | fal endpoint | aspect | resolution enum (default) | **count** (`num_images`) | notes |
|---|---|---|---|---|---|
| `photo_edit` | `fal-ai/nano-banana/edit` | `aspect_ratio` Enum, default **auto** | — (none) | **1–4** | output jpeg/png/webp |
| `nb2_image` / `nb2_edit` | `fal-ai/nano-banana-2(/edit)` | `aspect_ratio` Enum, default **auto**; supports extreme 4:1,1:4,8:1,1:8 | **`0.5K,1K,2K,4K`** (default 1K) — 0.5K=0.75×, 2K=1.5×, 4K=2× | **1–4** | native multi-res |
| `nbpro_image` / `nbpro_edit` | `fal-ai/nano-banana-pro(/edit)` | `aspect_ratio` Enum, default **1:1** (t2i) / **auto** (edit) | **`1K,2K,4K`** (default **1K**) — 4K double rate | **1–4** | — |
| `text_to_image` / `seedream_edit` | `fal-ai/bytedance/seedream/v4.5(/edit)` | `image_size` Enum: `square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9, auto_2K, auto_4K` | via `image_size` presets | **1–6** (+ `max_images` 1–6, up to 15 total) | our `sizeParam()` mapping is correct |
| `premium_image` / `premium_edit` | `fal-ai/gpt-image-2`, `openai/gpt-image-2/edit` | ⚠️ **not in fal docs** (docs show `gpt-image-1.5`) | ? | ? | **confirm endpoint + params + pricing** |

**Every documented image model supports `num_images` (count)** — nano-banana family **1–4**, Seedream **1–6**. Our registry encodes **no count parameter at all** (`GenOpts` has no `numImages`). This is the single biggest gap for the "count" selector you asked for.

---

## 2. Video models — verified schemas

| model (our key) | fal endpoint | duration (default) | resolution (default) | aspect | end-frame |
|---|---|---|---|---|---|
| `animate` | `fal-ai/kling-video/v2.5-turbo/standard/i2v` | **`5,10`** (5) | — | — (none on standard) | no |
| `kling3` | `fal-ai/kling-video/v3/pro/i2v` | `5,10` (5) | — | — (i2v inherits from start frame; the 16:9/9:16/1:1 enum is the *t2v* tab only) | **yes** (`end_image_url`) |
| `seedance_fast` | `bytedance/seedance-2.0/fast/i2v` | **`4–15` or `auto`** (auto) | **`480p,720p`** (720p) | `auto,21:9,16:9,4:3,1:1,3:4,9:16` | yes |
| `seedance` | `bytedance/seedance-2.0/i2v` | **`4–15` or `auto`** (auto) | **`480p,720p`** (720p) | `auto,21:9,16:9,4:3,1:1,3:4,9:16` | yes |
| `hailuo_fast` | `fal-ai/minimax/hailuo-2.3-fast/standard/i2v` | ⚠️ **not in fal docs** (docs show `fal-ai/minimax-video`) | ? | ? | **confirm endpoint + duration + pricing** |

---

## 3. Drift: our registry vs fal's live schemas

These are places where `src/models.ts` disagrees with the current fal schema. Several affect **price/COGS**, so they matter beyond UX.

| # | Model | Registry says | fal says | Severity | Recommendation |
|---|---|---|---|---|---|
| **P1** | `seedance_fast` / `seedance` | `SEEDANCE_RES = 720p, 1080p` | resolution enum is **`480p, 720p`** (no 1080p) | **HIGH — pricing** | Replace 1080p with 480p (cheaper tier); re-derive `perSecondUsd`. A 1080p charge for a tier that doesn't exist = failed renders or wrong price. |
| **P2** | `seedance_fast` / `seedance` | `durations = [5,10]` | **4–15s or `auto`** | MED | Offer wider duration (e.g. 5/8/10/15); pricing already scales via `perSecondUsd`. |
| **P3** | `nbpro_image` / `nbpro_edit` | `NBPRO_RES = 2K, 4K` (floored at 2K) | **`1K, 2K, 4K`**, default **1K** | MED — pricing | Add the **1K** tier (cheaper, and it's the model default) so we're not overcharging/over-defaulting to 2K. |
| ~~P4~~ | `kling3` | `aspectRatios = ["auto"]` | ~~16:9/9:16/1:1~~ **WITHDRAWN** — that enum belongs to Kling v3's *text-to-video* tab; the **image-to-video** variant (ours) has no `aspect_ratio` (ratio inherits from the start frame). Registry is correct. | — | No change. |
| **P5** | all image models | no `num_images` | **1–4** (nano) / **1–6** (Seedream) | **HIGH — feature** | Add a `count` param + linear price multiplier (below). |
| **P6** | `nb2_image` / `nb2_edit` | `NB_RES = 1K,2K,4K` | also **`0.5K`** (0.75× rate) | LOW | Optional cheaper 0.5K tier for price-sensitive users. |
| **P7** | `premium_*`, `hailuo_fast` | endpoints assumed live | **absent from fal docs** | **HIGH — reliability** | Verify endpoints still resolve + confirm pricing; the docs now show `gpt-image-1.5` and `minimax-video`. Possible model retirement/rename. |

---

## 4. Pricing implication of "count"

`num_images = N` runs ~N generations → provider cost scales ~linearly. So the Studio's count selector multiplies the render price:

```
credits(model, opts) = base_priceFor(model, opts) × max(1, count)
```

This slots cleanly into the existing `priceFor(model, opts)` (`models.ts:351`) — add `count` to `GenOpts`, multiply at the end, clamp to each model's max (nano 4, Seedream 6). COGS mirror in `costUsdFor`. Server stays authoritative; the client's live total mirrors it (as it already does for duration/resolution).

---

## 5. What the Studio renders per model (block ⑥ concrete spec)

Driven entirely by the (corrected) capability blocks — no per-model `if` ladder:

- **Aspect** — chips from `image.aspectRatios` / `video.aspectRatios` (Seedream: the named `image_size` set, labeled friendly: "Квадрат / Портрет / Пейзаж / 4K-авто").
- **Resolution** — chips from `image.resolutions` / `video.resolutions`, each labeled with its price effect (e.g. "2K ·1.5×", "4K ·2×").
- **Duration** — chips from `video.durations` (video only); live per-duration price.
- **Count** — a stepper/chips `1…max` (images only); live ×N price. Hidden for video (single output).
- **End-frame** — upload, only when `video.endFrame` (kling3, seedance*).

Unsupported selectors simply don't render.

---

## 6. Registry changes — status after the drift-fix pass (2026-07-22)

**Applied (in `src/models.ts` + tests updated):**
- ✅ **P1** `SEEDANCE_RES → [720p(1×, default), 480p(1×, "faster")]` — the phantom 1080p tier removed (it doesn't exist on the 2.0 endpoint; a request for it would fail). 480p priced same as 720p until its real per-second rate is measured, then it can be discounted.
- ✅ **NB 4K price fix** — `NB_RES` 4K multiplier corrected 2.5→**2×** (fal charges double rate, we were overcharging beyond the standard margin).
- ✅ ~~P4~~ **withdrawn** — kling3 (i2v) genuinely has no aspect param; the 16:9/9:16/1:1 enum is Kling v3's *t2v* variant. Registry was already correct.

**Deliberately deferred (bigger than a drift fix):**
- **P5 count (`num_images`)** — NOT just pricing: `falRun` keeps only `images[0]` (`generate.ts:96`) and a generation row stores a single `output_url`, so N>1 needs multi-output handling (result storage, gallery, delivery). Own task, do with/before the Studio composer.
- **P2 Seedance 4–15s durations** — the widening is trivial but the current 5/10 chips are fine for v1; widen alongside the composer's duration UI.
- **P3 nbpro 1K tier** — 1K/2K cost the SAME on fal (only 4K is double), so exposing 1K would be a strictly-worse-quality same-price option; keeping the 2K floor is a better default. Revisit only if a "faster" tier is wanted.
- **P6 nb2 0.5K tier** — optional cheap tier; low value while credits floor at 1.
- **P7 endpoint verification** (`premium_*`, `hailuo_fast`) — needs a live `FAL_KEY` probe (one $0.19–0.22 render each) or fal support confirmation; docs-only checking can't prove a legacy endpoint is dead. Flagged confirm-on-integration.

---

## 6a. Input materials — modalities each model ingests (fal-grounded)

Verified from the same schemas (2026-07-22). This drives block ③ (Inputs).

| Modality | Available on fal? | In our registry today? | Models | Studio implication |
|---|---|---|---|---|
| **Image — single** | yes | ✅ yes | all edit + all i2v (start frame) | current behaviour |
| **Image — multiple (compositing)** | yes | ⚠️ **capable but unused** | `image_urls` list on nano-banana/nb2/nbpro **/edit**; Seedream `images` list (**up to 15** total incl. outputs) | **unlock**: let ③ add 2–N reference images ("me + friend + product"). Our `input()` already emits the list form (`image_urls:[imageUrl]`) — just hardcoded to one. |
| **Image — start + end frame (video)** | yes | ✅ yes (kling3, seedance*) | `image_url` + `end_image_url` | already spec'd in ⑥ |
| **Audio input** | yes | ❌ no | Seedance `reference-to-video` (`audio_urls`), Kling lipsync / ai-avatar, Bytedance OmniHuman | **new feature track** (talking-avatar / lipsync / music-driven). Not Studio v1. NB: our *dubbing* feature already ingests audio via ElevenLabs — a separate pipeline. |
| **Video input** | yes | ❌ no | Seedance `reference-to-video` (`video_urls`), Kling o1/o3 **video-to-video**, Bytedance video-stylize, SeedVR/Topaz upscale | **new feature track** (v2v restyle / upscale). Not Studio v1. NB: *dubbing* already ingests video via ElevenLabs. |

**Takeaways for the Studio:**
1. **Multi-image input is a low-cost, high-value unlock** for ③ (schema + our payload already support the list) — strong candidate for a fast-follow after Studio v1. Pricing note: Seedream counts input images toward its 15-item cap; nano-banana composites references into one output (no per-input surcharge beyond `num_images`).
2. **Audio/video *input* are genuinely new capabilities**, not parameters of existing models — they open distinct products (talking-avatar, lip-sync, video-to-video, upscale). Worth a separate spec if you want them; they should not expand Studio v1's scope. The dubbing feature already covers the "video-in → video-out" translation use-case via ElevenLabs.

---

## 7. Confirm-on-integration flags
- `premium_image` (`fal-ai/gpt-image-2`) and `premium_edit` (`openai/gpt-image-2/edit`) — not in current fal docs.
- `hailuo_fast` (`fal-ai/minimax/hailuo-2.3-fast/...`) — not in current fal docs.
These may still resolve (fal keeps old endpoints alive) but should be checked before we lean on them in the new picker, and their prices re-confirmed. Same caution class as the Kaspi/ElevenLabs "confirm on integration" notes.
