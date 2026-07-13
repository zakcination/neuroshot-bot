# VeoSee prompt library (competitor research)

Scraped from `t.me/machinelearningall` ("VeoSeeBot | Промпты ИИ") — the prompt library run by
VeoSee/Neuroplace, the incumbent NeuroShot competes with. Their published recipes are proven on
paying users, so this is a ready-made source for our **presets, campaigns, and marketing seed posts**.

## Files

| File | Contents |
|---|---|
| `veosee-prompts-2026.json` | **398 parsed recipes** since 2026-01-01: `{id, date, model, category, prompt, url}` |
| `veosee-prompts-2026-raw.json` | 1,237 raw posts (`{id, date, text}`) — full context incl. non-recipe posts |
| `scrape.py` | The scraper (paged `t.me/s/machinelearningall`, date cutoff `2026-01-01`). Re-run to refresh. |

Date range: **2026-01-02 → 2026-07-13**.

## What the data shows

- **Category mix** (parsed recipes): product/e-commerce 179 (45%), fashion/portrait 132 (33%),
  video 21, avatar/character 18, interior 1, other 47. → **78% is product + fashion**, the two
  segments NeuroShot wedges on.
- **Model stack they push**: GPT Image 2 (~117), Nano Banana 2/Pro (~162), Seedance 2.0 (video, 10s).
  Matches our `src/models.ts` routing (Nano Banana / Seedream / GPT Image 2 / Kling+Seedance video).
- **Recurring prompt patterns** worth reusing verbatim:
  - **Identity lock** — "preserve face 100% identical, no beautification, no retouch" opens nearly
    every portrait. We enforce the same via `KEEP_ID` in `src/models.ts`.
  - **Product lock** — "preserve exact packaging, label, colors in every frame."
  - **Outfit transfer** (identity from photo A + outfit from photo B) — a whole virtual-try-on sub-genre.
  - **Quiet-luxury house style** — "ultra-realistic luxury fashion, quiet luxury, Parisian chic,
    cinematic lighting, 8K".

## How this feeds the product

1. **Presets / campaigns** (`src/models.ts` `PRESETS` / `CampaignPreset`): the highest-recurring,
   single-photo, identity-locked scenarios become one-tap presets. Already imported: `candid_lux`,
   `paris_rain`, `pixar_me`.
2. **Marketing seed posts** (`marketing/seed-posts.md`): each recipe is a ready "this model + this
   prompt → this result" post — VeoSee's own retention/SEO loop, copyable.
3. **Prompt craft** (`docs/prompt-craft.md`): source material for the composer's curated-prompt guards.

## Filtering examples

```bash
# all product recipes
jq '[.[] | select(.category=="product")]' veosee-prompts-2026.json
# clean, self-contained English prompts (no cyrillic placeholders), portrait
jq '[.[] | select(.category=="fashion") | select(.prompt|test("[а-яА-Я]")|not)]' veosee-prompts-2026.json
```

Source channel: https://t.me/machinelearningall · Provenance: `research/saas-ideas/competitor-intel.md` in `zakcination/dark_kitchen`.
