# UI rebuild v2 — Главная + Студия

Collected from the block-by-block audit of 2 Aug. Row ids (`H*`, `S*`) are the
audit's, so this doc and that conversation line up.

Scope boundary: [`wireframes/home-studio.v2.html`](wireframes/home-studio.v2.html).
Anything on either screen that is not in v2 is cut — see
[`wireframes/README.md`](wireframes/README.md) for why that rule exists.

---

## ЭКРАН 1 — Главная

| id | Block | Decision |
|---|---|---|
| H2 | header `.top2` | keep |
| **H3** | hero «Одно фото — целая студия» | **soft remove** — code deleted, feature description → `graveyard.md` |
| **H4** | 🆕 Новые модели (`#newsrail`) | **soft remove** — same. *Was in v1; v2 amends it* |
| H5 | promo banner | keep |
| H6 | TV banner | ⚠️ **undecided** |
| H7 | `.tile2` — Фото / Видео tiles | keep |
| H8 | Галерея «Что снимаем?» | keep |
| H9 | unit hint | ⚠️ **undecided** |
| **H10** | roadmap «Ваш путь» | **keep, redesign** — visual upgrade + fix margins/padding |
| H11 | tabbar | keep |

**Soft remove** = the code goes, the *idea* is written down in
`docs/graveyard.md` so it can be reconsidered later without the dead
implementation sitting in the page in the meantime.

After H3 and H4 go, Главная opens: header → promo banner → the two entry tiles.
One promotional strip above the fold instead of three competing ones, which was
the actual complaint.

---

## ЭКРАН 2 — Студия

The screen is being reorganised, not just trimmed. Its problem is that the
blocks aren't MECE: several unrelated things all mean "give the model
something to work from", and they're scattered down the page in the order they
happened to be built.

### Target order

```
┌─ Студия ─────────────────────────────┐
│  🖼 Фото   │   🎬 Видео          [S8] │  ← mode, at the top
├──────────────────────────────────────┤
│  Режиссёрский режим          [ ○—] │  ← S11, its own row under the header
├──────────────────────────────────────┤
│  ВХОДНЫЕ ДАННЫЕ                      │  ← unified input system
│    фото · референсы · аудио · видео  │     S5 · S6 · S7
│    финальный кадр (as a slot label)  │     S16 folded in
│    персонажи/локации when S11 is on  │     director sheets
├──────────────────────────────────────┤
│  Промпт                         [S3] │  ← below the inputs
│  [textarea]              [✨ Улучшить]│     S4 beside it
├──────────────────────────────────────┤
│  Модель                         [S9] │
│  Уровень качества              [S10] │
├──────────────────────────────────────┤
│  формат · качество · кол-во · длит.  │  ← S12–S15, pinned
│  ▓▓▓  Создать за N 🔫  ▓▓▓           │
└──────────────────────────────────────┘
```

### Changes

| id | Block | Decision |
|---|---|---|
| **S1** | sale banner | **remove.** Later returns as an **image** banner with a finished design — not the text block it is now. Out of scope until that design exists |
| **S2** | preset chip | **change** — the preset's prompt is pasted into the prompt textarea (editable), with the preset name shown small beside it. ⚠️ see *Open question* below |
| **S3** | prompt block | **move** below the inputs |
| **S4** | ✨ Улучшить промпт | **move** — sits next to the prompt box |
| S5–S7 | photo zone · references · audio/video | **keep, unify** — see below |
| **S8** | mode 🖼/🎬 | **move to the top**, with the sheet header |
| S9 | Модель | keep |
| S10 | Уровень качества | keep |
| **S11** | Режиссёрский режим | **move to the top** — its own row directly under the studio header |
| **S12–S15** | формат · качество · количество · длительность | **restyle per wireframe and pin directly above «Создать»** — these are the render parameters and belong with the button that spends patrons on them |
| **S16** | Финальный кадр | **remove as a standalone block** — folded into the input system as a labelled slot, now that S5–S6 exist |
| S17 | videoStory quiz | keep |
| S18 | Создать / ← Галерея | keep |

### The input system (the real work)

Right now "give the model something" is spread across four unrelated UI
patterns: a drop zone (S5), a 6-slot grid (S6), two 3-slot rows (S7), a separate
final-frame picker (S16), and — since today — Director Mode's character and
location sheets (S11). They overlap, they're ordered arbitrarily, and nothing
tells the user which combination actually improves the result.

They are one family and should read as one: **everything you give the model,
in one place, each slot labelled with the job it does.** Director Mode is not a
separate feature next to this — it is the *guided* version of the same thing,
tailoring input to multiply Seedance 2.0 output quality. The toggle should feel
like turning on assistance for the input block, not like entering a different
screen.

Concretely: one input section, slots typed by role (источник · ракурсы ·
финальный кадр · аудио · видео · персонаж · локация), with the Director Mode
toggle enriching that same section rather than appending three accordions below
everything else.

---

## S2 — preset prompts become visible and editable

**Decided: ship the real prompt to the client.**

The earlier objection here was that the preset library is a curation moat and
publishing it hands it to competitors. That was wrong, and it's worth writing
down why so it doesn't get re-litigated:

- Our own competitive positioning (`CLAUDE.md`) lists Higgsfield as
  **open-source, and counts that as their trust signal.** Secrecy isn't what
  we're selling.
- The moat there is defined as *curation and reliability* — which is the
  judgement to pick and maintain a library, not the confidentiality of forty
  text strings. A competitor who copies the prompts still has no preset
  mechanic, no credit ledger, no refund discipline, no Telegram integration.
- Visible prompts are the market norm (Midjourney, Lexica, Civitai are built
  on exactly this) and they *teach*: a user who sees what a good prompt looks
  like generates more, not fewer.

So: the preset's prompt lands in the textarea, editable, with the preset name
shown beside it.

### What that changes on the wire

The open part is no longer whether to show the text — it's what a render
*becomes* once the text has been edited, because that feeds the generation
metadata shipped in #98 (`source_kind`, `source_id`, `user_prompt`, «Повторить»,
and the per-preset analytics that tell us which presets are worth keeping).

Three options, and they are not equivalent:

| | Wire | Cost |
|---|---|---|
| A | keep `source:"preset"`, send the edit as `custom` | wrong — the server would compose the canonical prompt *plus* the edited copy |
| B | switch to `source:"model"` with the full prompt | loses preset attribution: `source_kind` becomes `model`, the «Стиль: X» label and per-preset stats go dark |
| **C** | **`source:"preset"` + `prompt_override`** | **recommended** |

**C** keeps `source_kind:"preset"` and `source_id`, records the override as
`user_prompt` (which is already defined as "text the user actually typed", so
it stays truthful), and leaves «Повторить» and `sourceLabelFor` working
untouched. An untouched prompt sends no override at all, so the canonical
server-side text still runs — meaning a preset retune keeps reaching everyone
who didn't edit it.

Catalog gains the prompt text per preset; `generateResponse`'s preset branch
gains an optional `prompt_override` that replaces `p.prompt` after
`sanitizePrompt`. The moderation and pricing paths are unchanged.

## Also undecided

- **H6** (TV banner) and **H9** (unit hint) — both flagged as outside wireframe
  v1. H6 was built 1 Aug on explicit request, *after* v1 was drawn, so cutting
  it on the wireframe rule alone would delete something recently asked for.
