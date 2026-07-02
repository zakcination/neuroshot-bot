# Preset previews

Example-result images shown as an album when a user opens a category menu
(📸 AI-фотосессия / 🛍 Фото товара) — so newcomers see what each button
produces before spending a credit. One `<preset_id>.jpg` per preset in
`src/models.ts`; `src/bot.ts` sends any that exist (≥2 per category).

Downscaled to ~864px JPEG (q82) to keep the repo light. To regenerate a
preview, run the model below with the prompt and replace the file (keep the
`<preset_id>.jpg` name).

| Preset | Model | Prompt summary |
|---|---|---|
| headshot | Higgsfield Soul V2 (3:4) | corporate headshot, tailored blazer, studio key light, gray backdrop |
| fashion | Higgsfield Soul V2 (3:4) | high-fashion editorial, designer outfit, Vogue lighting, film grain |
| travel | Higgsfield Soul V2 (3:4) | golden-hour Santorini rooftop, warm rim light, travel-magazine |
| cinematic | Higgsfield Soul V2 (3:4) | anamorphic movie-still, teal-orange grade, 35mm film aesthetic |
| product_hero | GPT Image 2 (1:1, high) | amber serum bottle on dark studio bg, soft shadow, 4k product |
| product_white | GPT Image 2 (1:1, high) | white sneaker on pure #FFFFFF, soft drop shadow, marketplace listing |
| product_lifestyle | GPT Image 2 (1:1, high) | ceramic mug on wood by a window, daylight, aspirational magazine |

Regenerate all previews with the committed script (needs the Higgsfield CLI,
an authenticated session and a selected workspace):

```bash
bash scripts/generate-previews.sh
```

The full prompt and model for each preset live in that script.
