# Menu media

Top-level menu visuals so every entry point shows an expected result:

| File | Where it shows | Model |
|---|---|---|
| `hero.jpg` | `/start` & `/menu` — carries the welcome caption + main-menu keyboard | GPT Image 2 (1:1), 4-panel use-case collage: headshot / product / restored family photo / kids fairy-tale |
| `animate.mp4` | 🎬 Оживить фото — plays before "пришлите фото" | Kling 3.0 Turbo (image→video, 720p) from `../previews/travel.jpg` |
| `text_example_1.jpg`, `text_example_2.jpg` | ✨ Картинка из текста — album before the prompt hint | GPT Image 2 (1:1) |

Sending is best-effort in `src/bot.ts` (`sendMainMenu` / `sendMenuVideo` /
`sendMenuAlbum`): if a file is missing the bot silently falls back to text.
Images downscaled (~1280px hero / ~864px examples, JPEG q82); video kept at
720p (~2.5 MB). Regenerate with `scripts/generate-menu-assets.sh`.
