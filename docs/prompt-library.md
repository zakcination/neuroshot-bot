# Prompt library — curated one-tap looks

NeuroShot's core wedge is **"pick a result, not a prompt."** The prompt library is
the menu of one-tap looks a user applies to their own photo — they never write a
prompt. Data lives in `PRESETS` (`src/models.ts`); the Mini App surfaces it in the
studio sheet (`viewPick` in `public/app.html`) as a browsable grid of tappable
cards, and `/api/generate` with `source: "preset"` applies the picked look to the
uploaded photo through `PRESET_MODEL` (Seedream edit).

Each preset is `{ id, label, category: "photo" | "product", prompt }`. Every prompt
ends with the `KEEP_ID` identity-lock guard so the person's face is preserved —
the single most important line for consumer face products.

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

## Expanding the library

The full scrape (`data/veosee_prompts_clean.json`, 395 recipes `{id, date, model,
prompt}`) is a **curated-expansion source, not a bulk import**: the raw set is
noisy (video recipes, one-line Russian instructions, brand-specific asks), so new
presets should be hand-picked from the product/fashion/avatar subsets and
**adapted** — rewritten in NeuroShot's voice, identity/product-locked, cleaned of
brand names — before being added to `PRESETS`. Add a card and it automatically
appears in the studio picker (the catalog is data-driven) — no UI change needed.

### Next (proposed, not in this change)
- A dedicated, richer **library surface** (per-look preview thumbnails, search,
  category/tag filters) — the browsable gallery Higgsfield/VeoSee-class apps use.
  Needs preview assets per preset, so it's its own increment.
- Model routing the research says the market pays for (a GPT Image 2 route).
