# Graveyard — features removed on purpose

When a block is cut from a screen, the **code** goes and the **idea** lands
here: what it was, why it went, what took its place. That way a rebuild can
actually delete things (see [`wireframes/README.md`](wireframes/README.md))
without the reasoning being lost, and a feature can be reconsidered later
without a dead implementation sitting in the page in the meantime.

Nothing here is a promise to bring anything back.

---

## Главная

### Hero «Одно фото — целая студия» *(H3)*

**Was:** a headline and subline at the top of the Home tab —
«Одно фото — целая студия» / «Выберите результат — ИИ сделает остальное».

**Why it went:** it was the third thing competing for the same job. Between the
header and the entry tiles the screen carried a hero, a promo banner and a TV
banner — three promotional strips stacked, none of them the actual entry point.
The tiles (📸 Фото / 🎬 Видео) already say what the product does, and they can be
tapped.

**Replaced by:** nothing. Home opens straight into the promo banner and the two
tiles.

**If it comes back:** it belongs *inside* the empty state for a first-time user
who has no works yet — not above the fold for everyone, forever.

### «🆕 Новые модели» rail *(H4)*

**Was:** a horizontally sliding rail of the newest models with dots, sourced
from `MODEL_NEWS` in `src/models.ts`, each tile opening the Studio with that
model preselected.

**Why it went:** it sold *models* on a screen whose whole thesis is that users
should not have to think about models — «придумывать промпты не нужно», one-tap
presets, curation over breadth. It also duplicated the promo banner's job
whenever the promoted model was the one on sale, which was most of the time.

**Replaced by:** the promo banner (H5) for anything time-boxed, and the model
picker inside the Studio for anyone who does want to choose.

**Note:** this block *was* in wireframe v1. Cutting it is a deliberate amendment
made in v2, not drift.

**If it comes back:** as a row in «Ещё», or as a one-off announcement, not as
permanent furniture on the main screen.

---

## Студия

### Text sale banner *(S1)*

**Was:** an amber text strip at the top of the create sheet —
«🏷 Seedance −50% — до конца акции N дней».

**Why it went:** it is an ad rendered as a validation warning. Amber on a form
means "something needs your attention", and this needed none; it also pushed the
actual controls down on a screen that is already too long.

**Replaced by:** nothing yet. It returns as an **image** banner with a finished
design, once that design exists. Until then the sale is still visible on Home
(H5) and in every price the composer quotes.

### Standalone «Финальный кадр» picker *(S16)*

**Was:** its own labelled section near the bottom of the composer, with a
separate drop zone, for the frame a video morphs toward.

**Why it went:** it was a fourth, unrelated UI pattern for "give the model an
image", sitting far away from the other three. It is an input, and inputs now
live in one block.

**Replaced by:** a `🏁 финал` cell inside the same reference-photo grid as
источник (and, for Seedance with Director Mode on, персонаж/локация) — shown
only for `endFrame`-capable models and mutually exclusive with multi-photo
reference mode (adding a second photo clears it, with a toast explaining why,
not a silent disappearance). Audio/video stay a separate row below the grid —
they were never merged into it (see `home-studio.v3.html`).

### Subject toggle + «ракурс» framing *(S5–S7 first convergence attempt)*

**Was:** a товар/персонаж (subject) toggle above the extras grid, and every
non-source reference photo labelled «ракурс» (angle).

**Why it went:** neither concept did real work. The subject toggle asked the
user to classify their own upload before the model needed to know; «ракурс»
assumed every extra photo was another angle of the same subject, which was
never true once Director Mode's named character/location photos entered the
same grid. Cut per direct product decision — the unified grid speaks in roles
(Источник / Персонаж / Локация) that already exist in the server's own
`image_roles` model, not in a UI-only vocabulary invented on top of it.

**Replaced by:** the single reference-photo grid's role choice, offered only
where more than one role is actually possible (the Seedance umbrella model).
Every other model's "＋" just adds a source photo, no question asked.

### Персонажи / Локации as standalone accordions *(director-mode v1)*

**Was:** two always-open, independently-collapsible accordion sections
(`director-mode.v1.html`), living below the ordinary photo slots — Director
Mode on meant a SECOND input block appeared alongside the first.

**Why it went:** direct product rejection of an intermediate rebuild ("Неет
все еще не то... у нас 2 блока входных данных, при режиссёрском режиме, хотя
так не должно быть") — the goal was always one grid, Director Mode on or off,
not one grid plus two accordions.

**Replaced by:** 👤/📍 cells inside the same reference-photo grid as источник
and финал. The underlying mechanic (name + photo(s) → paid «Собрать карту»
sheet generation) is unchanged — only the entry point moved, from a dedicated
section to the grid's shared "＋".

### Manual shot-type picker *(Director Mode)*

**Was:** a 2-column grid of the eight `SHOT_TYPES` under the storyboard
candidates, as a fallback for picking a shot without running the LLM split.

**Why it went:** it never worked. A manually picked shot carried only a `type`,
while `/api/enhance` requires `momentRu` and `cameraDirectionEn` too, so
choosing one and pressing «Собрать промпт» could only ever return 400. Removed
before it ever shipped to a user.

**Replaced by:** the storyboard candidates, which carry all three fields. If the
split fails, the failure is now stated and no patron is spent.

**If it comes back:** it needs the client to synthesise a `momentRu` and a
camera direction from the scenario text, or the server to accept a
type-only shot and fill the rest — neither of which exists today.

### Storyboard split ("Кадр" step, Director Mode)

**Was:** the LLM-driven shot-picking step between the scenario and the
assembled prompt — `splitStoryboard()` (`src/enhance.ts`), `POST
/api/storyboard` (`src/webapp.ts`), and the "Кадр" accordion (candidate
cards, `dmShotAccordion()`, `public/app.html`) it fed. A free-text scenario
was split into 3-4 single-take candidates (`shotType`, `momentRu`,
`cameraDirectionEn`, `characterIds`, `locationIds`); the user picked one,
and that candidate became `/api/enhance`'s `context.shot`.

**Why it went:** owner's call — an extra LLM call and an extra tap that
picked one framing out of a fixed eight-shot vocabulary added friction
without adding creative control worth the cost. `context.shot` was already
optional at both the type and the runtime-validation level, so nothing
downstream needed to change to survive dropping it.

**Replaced by:** the scenario textarea feeds `/api/enhance` directly —
`composeEnhanceInput()` degrades to describing the whole cast/locations
without shot-scoping, same wording it already used when a shot's
`characterIds`/`locationIds` were absent. `SHOT_TYPES`/`ShotType`/
`SHOT_TYPE_IDS` (`src/enhance.ts`), the `.cand-*` CSS, and the manual
shot-type picker entry above are now dead history — the eight-shot
vocabulary they described no longer exists anywhere in the code.

**If it comes back:** it would need to be re-derived as its own feature,
not restored verbatim — the screenwriter pipeline's `expandVision()` already
covers "derive structure from a vision," so a future shot-picking step
should build on that instead of resurrecting `splitStoryboard`.
