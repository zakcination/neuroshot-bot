# Seedance screenwriter pipeline — spec + shipped implementation

**Status:** steps ①③④⑤⑥⑦ shipped, dark behind `SCREENWRITER_PIPELINE_ENABLED`
(default `false` — see `CLAUDE.md`'s feature-gating section). Server:
`expandVision()` (`src/enhance.ts`) + `POST /api/screenwriter/expand`
(`src/webapp.ts`). Client: the "Сценарист" accordion in Director Mode
(`public/app.html` — `dmScreenwriterHtml`, `swExpand`, `swOpenAddFor`,
`swGenerateBg`), reusing the existing sheet/storyboard/assemble flow
unchanged below the entity-extraction step.

**Shipped as the pragmatic single-prompt version this doc itself proposed**
(see the flagged research section below) — three things are explicitly
**not** done yet:
- **② purpose clarification** — not built; one generic plot-expansion system
  prompt for every vision, exactly the starting point flagged below.
- **⑧'s assemble extension** — `vfxNotes` exists in the UI and the expand
  API, but only feeds the plot-expansion prompt. It is not yet forwarded
  into `/api/enhance`'s assemble step, and the per-second-ranged beat format
  described below was not attempted — assemble is untouched, still one
  flowing paragraph.
- **No `docs/wireframes/` file** — the Non-goals section below called one
  out as expected before implementation; this shipped directly from the
  owner's go-ahead instead. Revisit if this UI needs its own wireframe pass.

**Scope note:** this is Track 2 of the Studio composer restructuring (Track 1 —
the non-Seedance composer's reordering, popup gallery, params-as-pills — shipped
in `public/app.html` directly). Track 2 was explicitly called out by the owner
as needing its own research pass before code, not something to build off a
single chat message — this doc is that pass's starting point, not its output.

## What exists today (verified against the code, not assumed)

The current Director Mode storyboard flow, unchanged by this spec:

1. **Cast comes first.** A user manually adds characters/locations one at a
   time through the unified reference grid's "+" (`extrasBlock()`,
   `public/app.html`) — each becomes a sheet via `SHEET_MODEL`/`SHEET_PROMPTS`
   (`src/models.ts`), a fixed server-side prompt run through `nb2_edit`, always
   from an **uploaded photo** (`webapp.ts:1491`: `if (!sheetType || !imageUrl)
   return 400` — there is no photo-less path today, despite an early wireframe
   sketching one).
2. **Then the scenario.** `splitStoryboard(scenario, characters, locations)`
   (`src/enhance.ts:451`) takes the free-text scenario plus the **already-built**
   cast (each entity: `{id, label, description?}`) and returns 3-4
   `StoryboardCandidate`s (`shotType`, `momentRu`, `characterIds`,
   `locationIds`, `cameraDirectionEn`) via one LLM call
   (`fal-ai/any-llm`, JSON-only contract, one retry, refunds on failure).
3. **Then assemble.** Picking a candidate feeds it back through
   `/api/enhance` with `model: "seedance"` — the existing model-aware
   enhancer weaves shot + cast + camera direction into one flowing English
   prompt.

The character sheet prompt (`SHEET_PROMPTS.character`) already explicitly
supports non-human subjects — *"whether the character is human or non-human,
any gender, realistic or stylized"* — so a creature or an object is not a new
sheet *type*, just another `character`-kind entity. Confirmed by reading the
prompt text directly, not assumed.

## What Track 2 adds (the ordering inverts)

Today: cast first, scenario second. The screenwriter pipeline asks for the
**opposite** order — a short vision first, everything else derived from it:

```
① short vision/plan (user types a few sentences)
② purpose clarification — ⚑ RESEARCH TODO, see below
③ plot expansion — LLM turns ① (+②'s chosen path) into a full scene-by-scene
   plot: "весь сценарий видео — что и как должно произойти"
④ entity extraction — from ③'s plot, identify named persons/creatures/objects
⑤ per-entity photo prompts — for each ④ entity, ask for a reference photo
   → runs the EXISTING sheet-generation flow (①-③ above, unchanged)
⑥ location photo prompt — same, but if no photo is given, derive a location
   DESCRIPTION from the plot instead — see the open gap below, this does not
   reduce cleanly to the existing photo-only sheet flow
⑦ once ④/⑤/⑥ are all resolved — run the EXISTING splitStoryboard(plot, cast)
   unchanged, cast is now populated automatically instead of by hand
⑧ assemble — extends the EXISTING /api/enhance seedance assembly with two
   new inputs it doesn't take today: optional VFX notes, and a per-second-
   ranged beat description instead of one flowing paragraph — see gaps below
```

Step ⑦ is the load-bearing design decision from the earlier "storyboard
relation" call: **this wraps `splitStoryboard`, it does not replace it.**
`splitStoryboard`'s signature already accepts entities with exactly the shape
steps ④-⑥ produce (`id`/`label`/`description`) — the pipeline is a new front
end that populates the cast automatically, feeding the same, unmodified
downstream function. Steps ①-④ and the VFX/per-second extension in ⑧ are the
only genuinely new server-side pieces.

## ⚑ Flagged as its own research task (per the owner's own instruction)

**Purpose clarification + "a few prepared paths per purpose."** The brief:
support emotional, selling, documentary, and capability-demonstration videos,
clarify which one the user wants, then run a purpose-specific path. Not
scoped here — needs a dedicated pass (a director/screenwriter-agent design
exercise) covering at minimum:
- How purpose is actually detected — a direct question to the user, or
  inferred from the vision text, or both (inferred with a confirm step)?
- What differs per path — a different plot-expansion system prompt seems
  necessary at minimum. Does shot selection (`splitStoryboard`'s `SHOT_TYPES`
  vocabulary) need purpose-specific weighting too, or is that overreach for
  a first cut?
- How many purposes ship at once vs. get added incrementally — four at
  launch is untested scope, not a given.

Nothing downstream (④-⑧) is blocked on this being resolved — the pipeline can
ship with a single generic plot-expansion prompt first and layer purpose
paths in later, but the owner asked for this to be researched before it's
built, not decided in this doc.

## Other open gaps (surfaced while grounding this spec, not resolved)

- **Location-with-no-photo is a two-model problem, not one — resolved.**
  `SHEET_MODEL` (`nb2_edit`) is an *edit* model — it transforms an existing
  image, it cannot originate one from text. Shipped as: a `text_to_image`
  render from the entity's LLM-derived `hint`, chained into the SAME sheet
  draft an upload would use (`swGenerateBg`/`swBgDone`, `public/app.html`),
  then the existing edit-based sheet flow runs unchanged. Two provider calls,
  two charges — the button quotes both together (`swBgPrice() + dmSheetPrice()`)
  before either fires, so the pricing decision this gap called for is: show
  the combined cost up front, same discipline as every other paid action in
  this composer.
- **Per-second-ranged beat description is unvalidated.** Today's assemble
  step produces one flowing English paragraph; the pipeline asks for a
  timestamped breakdown ("0-3s: X, 3-6s: Y") instead. Whether Seedance's
  actual endpoint responds better to that structure than to prose is an
  empirical question — untested, should be validated with real renders
  before it's treated as the target format, not assumed because it sounds
  more precise.
- **VFX notes** — no field for this exists anywhere in the composer today.
  Needs a UI home (a new optional textarea in the vision/plan step, most
  likely) and a slot in the assemble prompt; not designed here.
- **Entity extraction's failure mode.** `splitStoryboard` already has a
  precedent for "the LLM call fails or returns garbage" (one retry, then a
  refund, per the existing `parseStoryboard`/retry logic) — entity
  extraction needs the same discipline, but the exact schema/validation
  isn't drafted here.

## Non-goals for this doc

- No new database schema is proposed here — nothing in ①-⑧ obviously needs
  persistent state beyond what a single composer session already holds
  (`stu.*` client-side state, same as the rest of the Studio composer).
  Revisit if the research pass in the flagged section above concludes
  otherwise (e.g., saved purpose-path preferences per user).
- No UI mockups — Track 1's wireframe-first discipline
  (`docs/wireframes/README.md`) applies once this moves from spec to build;
  a `docs/wireframes/` file is expected before implementation, not included
  here.
