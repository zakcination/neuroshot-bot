# Prompt library — curated one-tap looks ("Style Gallery")

NeuroShot's core wedge is **"pick a result, not a prompt."** The prompt library is
the menu of one-tap looks a user applies to their own photo — they never write a
prompt. Data lives in `PRESETS` (`src/models.ts`); the Mini App surfaces it as
**Style Gallery** — a marketplace-style grid of preview cards (`viewPick` in
`public/app.html`, "Фотосессия"/"Товар" tabs of the studio sheet) — and
`/api/generate` with `source: "preset"` applies the picked look to the uploaded
photo through the preset's resolved model (`presetModel()`, default `PRESET_MODEL`
— Seedream edit).

Each preset is `{ id, label, category: "photo" | "product", prompt }`. Every prompt
ends with the `KEEP_ID` identity-lock guard so the person's face is preserved —
the single most important line for consumer face products. The catalog API adds
three more fields per card, all described in "Style Gallery" below: `previewUrl`
(a generated preview photo), `usageCount` and `trending` (real tap counts from the
events log — never fabricated).

## Seeding from competitor research (VeoSee)

The library is seeded from the **VeoSee / Neuroplace prompt-library scrape** (the
exact competitor NeuroShot clones — see the `dark_kitchen` research repo,
`research/saas-ideas/competitor-intel.md`). Findings that shaped it:

- **82% of their 395 recipes are product (45%) + fashion/portrait (37%)** —
  empirical proof of where the paying demand is, and it maps exactly onto
  NeuroShot's two wedges (marketplace product cards; AI selfie-photoshoots).
- Their whole format is "pick model → upload photo → this exact prompt → this
  result." Users copy prompts; they don't invent them. → **ship template menus.**
- Recurring patterns baked in: **identity-lock**, **product-lock**, quiet-luxury
  aesthetic, and the figurine/avatar sub-genre.

Seeded looks added from this research:
- `candid_lux` 🚗, `paris_rain` 🗼, `pixar_me` 🧸 — the three highest-recurring
  single-photo, identity-locked scenarios, adapted to our schema.
- `figurine` 🧍, `retro90s` 📼 — original looks (NeuroShot's own wording, not
  copied) filling the top gaps the research flagged.
- **Second curation batch** (aspirational editorial + viral shareables):
  `cafe_night` 🌃, `yacht_lux` 🛥, `photobooth_bw` 🖤, `paper_doll` ✂️,
  `low_battery` 🔋 (photo); `product_editorial` 🧴, `product_drama` 💧 (premium
  product packshots). Each was hand-picked from the shortlist, translated to
  English, compressed from a ~1–1.5k-char recipe to one flowing clause, had its
  brand names / hard-coded aspect ratios stripped, and got the shared identity-
  or product-lock guard appended.
- **Third curation batch** (billionaire-lifestyle editorial + viral shareables):
  `billionaire_heli` 🚁, `alpine_lux` 🏔, `kitten_editorial` 🐱, `mini_squad` 👥,
  `sketch_journal` ✏️ (photo); `product_jewelry` 💎, `product_action` 💥
  (product). Same checklist as the prior batches — hand-picked from the
  product/fashion shortlist, translated to English, compressed to one flowing
  clause, brand names and hard-coded aspect ratios stripped, identity- or
  product-lock guard appended. Departure from batches 1–2: instead of routing
  only on the on-image-text/stylization heuristic, each look is pinned to the
  SAME engine VeoSee's own tutorial used for that recipe — the model the result
  was authored/tested against — so the one-tap result matches what the source
  actually demonstrated. See model routing below.

## Per-look model routing

A preset renders on the cheap `PRESET_MODEL` (Seedream edit, 2🔫) unless it pins a
stronger engine via the optional `model` key (`presetModel()` resolves it). Looks
that depend on **on-image text** or heavy **stylization** route up automatically,
with no extra user step — only the price the user sees changes:
- `figurine`, `product_hero`, `product_editorial`, `product_drama`, `product_action`
  → GPT Image 2 (`premium_edit`, 11🔫) — blister-pack titles / product-label
  typography Seedream garbles (see `docs/prompt-craft.md`), or (for
  `product_action`) matching the GPT Image 2 engine VeoSee's own recipe used.
- `pixar_me` → Nano Banana Pro (`nbpro_edit`, 8🔫) — cleaner 3D-toon stylization.
- **Third-batch VeoSee-engine matches**: `alpine_lux`, `sketch_journal` → Nano
  Banana Pro (`nbpro_edit`, 8🔫); `billionaire_heli`, `kitten_editorial`,
  `mini_squad`, `product_jewelry` → Nano Banana 2 (`nb2_edit`, 4🔫). These pin
  the exact engine the VeoSee tutorial specified for that recipe, not the
  text/stylization heuristic above.

## Style Gallery — marketplace preview cards

The studio sheet's "Фотосессия"/"Товар" tabs render `PRESETS` as a **Style
Gallery**: a 2-column card grid (`.pcards`/`.pcard` in `public/app.html`,
replacing the old plain text `.choices` list) — a preview photo, the label, the
price, and (when real) a "🔥 Тренд" badge and a tap count. This is the "ready to
go presets as marketplace cards" surface, chosen over a bottom-nav redesign or a
separate library page: it's the exact place users already go to pick a look, it
needed no new information architecture, and it upgrades a plain list that had
*zero* visual preview into the thing competitor apps (VeoSee/Higgsfield-class)
lead with.

- **Preview art** (`previewUrl: /img/card-preset-<id>.jpg`) is generated per
  preset, one clause distilled from the preset's own prompt (a stock scene/model,
  not a real user's photo — a marketing exemplar, same as the `card-<campaign>.jpg`
  art `CAMP_ART` already uses for campaign rail cards). **Golden rule: every image
  asset in this repo is produced via Higgsfield** (`mcp__higgsfield__generate_image`,
  `nano_banana_pro`, ~2 credits/image) — never hand-drawn, stock-licensed, or
  sourced elsewhere. To (re)generate a preset's card: submit a `generate_image`
  call with a one-clause preview prompt (strip the identity/product-lock guard —
  there's no real reference), poll `job_status(sync:true)` for the CDN url,
  download it, and save it as `public/img/card-preset-<id>.jpg` (`sips -s format
  jpeg` from the downloaded PNG keeps it consistent with the existing `card-*.jpg`
  convention). The client falls back to a flat gradient + the preset's own emoji
  (`.pcard.noart`, triggered by the image's `onerror`) if a preset ships before
  its art does — never a broken image.
- **Usage/trending** (`usageCount`, `trending`) come from `db.presetUsageCounts()`
  — a `GROUP BY` over the SAME `events` rows `sellerSegmentSizing` already reads
  (`type='preset'`, bare id, no colon — logged on every preset render, bot and
  web alike). The top 5 tapped presets (with ≥1 real tap) are flagged `trending`
  and sort first in the grid; a fresh deploy with no taps yet shows zero trending
  badges, never fabricated ones. No new instrumentation was needed — the tap
  logging already existed for `sellerSegmentSizing`.
- **Scope decision**: the bottom tab bar (Студия/Профиль/Друзья/Патроны/Ещё)
  and the overall page layout are UNCHANGED — a 6th tab or a dedicated library
  page was considered and deferred (see "Next" below) rather than redesigned
  speculatively against a production surface with 49 e2e + 64 web-app tests
  riding on the existing IA.

## Expanding the library

The full scrape (395 recipes `{id, date, model, prompt}`) lives in the **external
research repo** (`zakcination/dark_kitchen`, `research/saas-ideas/data/`), not in
this repository. It is a **curated-expansion source, not a bulk import**: the raw set is
noisy (video recipes, one-line Russian instructions, brand-specific asks), so new
presets should be hand-picked from the product/fashion/avatar subsets and
**adapted** — rewritten in NeuroShot's voice, identity/product-locked, cleaned of
brand names — before being added to `PRESETS`. Add a card and it automatically
appears in the studio picker (the catalog is data-driven) — no UI change needed.

### Next (proposed, not in this change)
- Search / category-tag filters within the Style Gallery grid (still just two
  hard-coded tabs, "Фотосессия"/"Товар") — fine at 26 looks, worth revisiting
  past ~40–50.
- A dedicated library tab in the bottom nav (or a shareable deep link per look)
  once there's a reason to browse the gallery outside the create flow — e.g. a
  "sent by a friend" share card. Deferred deliberately (see "Style Gallery"
  above), not an oversight.
- Higher-resolution / multiple-angle preview art (currently one 1K image per
  preset) if conversion data shows the card photo materially moves taps.
