# NeuroShot Cinema Studio — generation-flow redesign spec

**Status:** DRAFT for sign-off · **Owner:** product · **Created:** 2026-07-22
**Supersedes:** the current `viewPick()` tab-strip generation menu in `public/app.html`.
**Does NOT touch:** the app's visual theme, the home marketing rails, or the prompt/preset gallery (kept exactly as-is — see §2 "Non-goals").

---

## 1. TL;DR

Today, "generating something" is scattered across **five tabs and ~eight views** in a bottom sheet, and the **model you're paying for is invisible** on the most common path (presets pick it silently). This is the "not convenient" problem.

We replace it with **one page — the Studio** — a single, prefilled, top-to-bottom composer modelled on a Higgsfield-style cinema studio:

```
  ┌─────────────────────────────────────────┐
  │  ① Prompt block   (preset, editable/swap) │
  │  ② ✨ Улучшить промпт  1-е бесплатно/1🔫  │
  │  ③ Inputs         (device / my gallery)   │
  │  ④ [ 🖼 Фото  |  🎬 Видео ]  ← mode chips  │
  │  ⑤ Model picker   (ALL models · price ea) │
  │  ⑥ Parameters     (ratio/res/duration…)   │
  │  ⑦ Создать за N 🔫 (≈ M ₸)   ← total+CTA  │
  └─────────────────────────────────────────┘
```

The **home page stays a marketing surface** (presets, scenarios, gallery, news). Its only job is to *convert a tap into the Studio, prefilled* — pick "child as princess" and you land in the Studio with that prompt block plugged in, a sensible model preselected, and the price already shown. Nothing about the flow is a mystery anymore.

**Crucial grounding fact:** the backend already supports every selector we want. `src/models.ts` encodes per-model aspect ratios, resolution tiers (with price multipliers), video durations, and end-frame support; `priceFor(model, opts)` already computes exact credits for any combination. **This redesign is a UI unification, not a backend rebuild.** The new work is: one composer view, one adaptive model picker over the full registry, the prompt-enhancer micro-feature, and small catalog/endpoint widenings.

---

## 2. Goals & non-goals

### Goals
- **G1 — One coherent Studio.** Collapse `viewPick / viewPhoto / viewImageComposer / viewVideoComposer / viewCampaign / viewQuiz` into a single scrollable composer with progressive disclosure.
- **G2 — Model is visible and swappable everywhere,** with transparent price on every option. No more silent model selection.
- **G3 — Preset prompt as a "plugged-in" editable block** — swap the preset, or personalize it, without leaving the page.
- **G4 — Mode = a retro-iOS segmented chip** (🖼 Фото / 🎬 Видео) that re-filters the model list.
- **G5 — All models per mode,** each with inline approximate price (🔫 + ≈₸).
- **G6 — Prompt Enhancer loop** — one tap, **0.5 🔫**, upgrades the prompt; before/after; loopable.
- **G7 — Marketing home → prefilled Studio.** Every home entry point deep-links into the Studio with context.
- **G8 — Zero economic regression.** Same charge-once / refund-exactly-once lifecycle; server stays the pricing authority.

### Non-goals (explicitly out — per the user's requirement #1)
- **NG1 — The visual theme / CSS / brand.** Untouched.
- **NG2 — The prompt/preset gallery content.** The 28 presets (`PRESETS`, `models.ts:545-827`) and 6 campaigns (`CAMPAIGNS`, `models.ts:894-1312`) keep their copy, art, and categories. We change *where a preset tap goes*, not the presets.
- **NG3 — The generation economics / pricing ladder.** `CREDIT_COST_BASIS`, the pack ladder, `priceFor` all stay.
- **NG4 — The bot (Telegram-chat) generation path.** This spec is the **Mini App Studio** only. The bot keeps its keyboards; a later pass can mirror the model picker. (Flag if you want them unified now.)

---

## 3. Current state (grounded) — what we're replacing

> Full map in the exploration notes; file:line references below are load-bearing.

- **Shell:** single `public/app.html`, inline JS, no framework. 5 bottom-tab pages + a modal **"studio sheet"** (`#sheet`/`#sheetBody`, `app.html:603`) that hosts *all* generation views via `sheetBody.innerHTML`. Router `showPage` (`app.html:2087`). Client generation state = `st.pick` (`app.html:854`), assembled in `run()` (`app.html:1089-1125`).
- **The generation menu = `viewPick()`** (`app.html:890-956`): a **5-tab strip** (`TABS`, `app.html:873`) — `shoot / product / scenes / video / text`. Each tab renders a different body:
  - **shoot/product** → preset cards grid (price `${p.credits} 🔫`), tap → `viewPhoto()`.
  - **scenes** → campaign grid → `viewCampaign()`.
  - **video** → a plain list of `catalog.videoModels` → `viewVideoComposer(m)`.
  - **text** → `<textarea>` + list of `catalog.imageModels` → `viewImageComposer(m)`.
- **Model selection is implicit** for preset/campaign flows (server resolves `presetModel(p)` / campaign `animateModel`; user sees only a price) and **explicit only** in the video/text tabs. This asymmetry is the core UX debt.
- **Composers already have rich params:** `viewImageComposer` (`app.html:1289-1320`) = aspect chips + resolution ladder + live price `#pr`; `viewVideoComposer` (`app.html:1327-1471`) = model-swap chips, scene chips, aspect, quality tier, **duration chips with live per-duration pricing** (`priceOf` mirrors server `priceFor`), optional **end-frame** upload. **We are reusing this logic, not inventing it** — just hoisting it into one always-present block driven by the selected model's capabilities.
- **Inputs:** `viewPhoto()` (`app.html:1010-1056`) = file `<input>` → `downscale()` to ≤1600px JPEG data-URL → `st.photo`; **or** "…из моих работ" strip (`myImages()`, prior non-video `ok` gens) → `generation_id` (no re-upload, owner-scoped server-side). Upload at `run()` via `/api/upload` (base64 data-URL, `UPLOAD_LIMIT = 9MB`, `webapp.ts:435-447`) → fal HTTPS URL. `/api/generate` body itself is capped at 64 KB (`webapp.ts:851`) — only URLs/ids travel.
- **Endpoint:** `POST /api/generate` (`webapp.ts:479-615`) branches on `source ∈ {preset, campaign, campaign_video, model}`, validates, calls `startWebGeneration(userId, model, prompt, imageUrl, crafted, opts)` (`generate.ts:119-163`). 402 → `{need, balance, packs}`. The **`model` branch's allow-list is `IMAGE_MODEL_PICKER ∪ VIDEO_MODEL_PICKER ∪ {photo_edit, premium_edit}`** (`webapp.ts:559-571`) — narrower than the full registry (see §6).

---

## 4. The Studio, block by block

The Studio is one view (`viewStudio(ctx)`) rendered into the existing sheet. It replaces `viewPick` and the standalone composers. A `studioState` object (superset of today's `st.pick`) holds everything; every block reads/writes it and re-renders the live total.

### ① Prompt block — the "plugged-in", editable/swappable prompt
- **Preset/campaign context:** render the choice as a **labeled block chip** — the preset's emoji + human label (e.g. "🎀 Принцесса из сказки"), not the raw English prompt. Two affordances:
  - **✎ Изменить** — expands an inline **personalization layer**: a free-text field ("допишите детали: имя, цвет, настроение…") plus any preset/campaign **quiz chips** (today's `viewQuiz`, `QuizStep/QuizOption`, `models.ts` — story-builder options). This is the "edit" surface.
  - **⇄ Сменить пресет** — opens a compact preset-swap sheet (the same gallery, condensed), returns to the Studio preserving inputs/mode/params.
- **Free-text context** (the "from text" / news-banner path): a plain `<textarea>` is the prompt block.
- **Security invariant kept:** curated prompts never travel from the client — the client sends validated **preset/campaign ids + quiz fragment ids + a sanitized personalization string**, exactly as today (`webapp.ts:500-558`, `craftPrompt`/`sanitizePrompt`). See **Decision D1** for whether we ever expose the *raw* prompt text for editing.

### ② Prompt Enhancer loop — first free, then 1 🔫 *(DECIDED: D2 = "first free, then 1🔫")*
- Button **"✨ Улучшить промпт"** under the prompt block. On tap: send the current effective prompt (free-text and/or personalization) to a small LLM that rewrites it into a richer, more directable prompt; show **before → after** with **Применить / Вернуть**; **loopable** (each press is another enhance).
- **Charge: the first enhance of each generation is FREE; every further enhance costs 1 🔫**, server-authoritative, logged as its own event. This needs no fractional-ledger change — just a per-generation "free enhance used?" flag + normal `spendCredits(1)` thereafter. (Supersedes the earlier "0.5 🔫" framing throughout this doc.)
- Provider for the rewrite → **Decision D3** (still open).
- Copy: "Первое улучшение — бесплатно, дальше 1 🔫 · делает промпт детальнее, результат — лучше".

### ③ Inputs — device or gallery
- Reuse `viewPhoto()` wholesale: **📷 С устройства** (file → `downscale` → data-URL → `/api/upload`) and **🖼 Из моих работ** (`myImages()` → `generation_id`).
- The block is **input-aware**: it knows if the current mode+model *needs* an image (video always; image-edit models yes; text→image no) and shows the right prompt ("нужно фото" vs "фото по желанию").
- End-frame (video, for `endFrame` models) is a secondary input revealed by ⑥ when relevant (as today, `app.html:1099-1104`).
- v1 stays **single source image + optional end-frame** (today's shape). Multi-reference is a future note (§9).

### ④ Mode chip selector — 🖼 Фото / 🎬 Видео (retro-iOS segmented)
- A two-segment control. Switching mode re-filters ⑤ and ⑥.
- **The elegant unification:** switching an image context to 🎬 Видео = "animate this" — the attached photo (or a gallery pick, or a just-generated result) becomes the video **source frame**. This folds today's separate "Оживить в видео" upsell (`viewAnimateFrom`, `app.html:1267`) into the mode switch.
- **Guard:** Video mode requires a source image. If the user is in a preset with no image yet, the mode chip shows Видео but selecting it prompts "сначала добавьте фото или создайте картинку" → **Decision D5** on whether we auto-run the image step first.

### ⑤ Model picker — ALL models for the mode, price inline
- Iterate the **full registry by kind**, not the curated pickers:
  - **🖼 Фото mode:** `kind ∈ {text_to_image, image_edit}` → 7 models.
  - **🎬 Видео mode:** `kind === image_to_video` → 7 models.
- Each row = **friendly label · one-line benefit · inline price**: `🎨 Картинка — быстро · 4 🔫 · ≈200 ₸`. Price from `priceFor(model)` at default opts; ≈₸ from the **pack rate** (~50 ₸/🔫), *not* the 480 ₸/$ margin rate (**Decision D4**).
- **Adaptive to inputs** (resolves today's "hidden edit models" mess): with a photo attached, edit models (`image_edit`) are primary and `text_to_image` is shown as "создаст с нуля (без фото)"; with no photo, `text_to_image` is primary and edit models show "нужно фото". Everything is *visible* (your "ALL models" requirement) but incompatible ones are clearly gated, not silently dropped → **Decision D6** on exact treatment (disabled vs "показать все" reveal).
- **Preset default preselected & visible:** the preset's resolved model (`presetModel(p)`) is the initial selection — so preset flows still "just work" — but now it's a highlighted, swappable row with its price shown. This is the heart of G2.

### ⑥ Parameters — per selected model, from its capability block
- Rendered entirely from `MODELS[key].image` / `.video`:
  - **Aspect ratio** chips (`aspectRatios`, e.g. `IMAGE_ASPECTS`).
  - **Quality/resolution** tiers when present (`NB_RES` 1K/2K/4K, `NBPRO_RES` 2K/4K, `SEEDANCE_RES` 720p/1080p) — each labeled with its price effect.
  - **Duration** chips for video (`durations`, default first) with **live per-duration price** (`priceFor` mirror, exactly today's `priceOf`).
  - **End-frame** upload for `endFrame` video models.
- Unsupported params simply don't render (driven by the data). No model-specific `if`-ladder in the UI.

### ⑦ Transparent total + Generate
- Sticky CTA: **"Создать за N 🔫 (≈ M ₸)"**, live-updating from `priceFor(model, opts)`; shows current balance; if `need > balance`, the button becomes **"Пополнить"** (opens paywall — today's 402 → `viewPaywall`, `app.html:1538`).
- If the enhancer was used, its 0.5 🔫 is shown as a separate already-charged line ("промпт улучшен: −0.5 🔫"), so the generate total stays the render price only.
- Submit → same `run()` → `/api/generate` → pending id → poll → `viewResult`.

---

## 4.1 Persistent in-progress generations (reload-safe status)

**Problem.** The "generating…" state lives only in the browser's in-memory `jobs` map (`app.html:868,1128,1151`). A page reload (or reopening the Mini App) empties it, so an in-flight render **vanishes from the UI** even though it's still running server-side — the user can't tell if it's working, done, or failed. This is a top confusion source.

**Grounding — the durable part already exists.** Every render's lifecycle is persisted in the `generations` table `status` column (`pending → ok | error`), written by the detached server tail and backstopped by the stale-generation reaper (`GEN_STALE_MINUTES`). `recentGenerations(userId, 30)` (`db.ts:1270`) returns **all** statuses, and `/api/me` already ships those 30 rows to the client (`webapp.ts:322`). **No fal webhook is needed** — the DB is the source of truth; the client simply ignores the pending rows today. `galleryPage` (the paginated «Мои работы») is intentionally ok-only (`db.ts:1284`) so page numbers stay stable, so pending must be surfaced *alongside* it, not inside it.

**Design.**
1. **Resume polling on load.** After `load()`, scan `ME.generations` for `status === 'pending'` and re-register each via `startJob(id, isVideo)` so the poll loop + jobs pill come back exactly as if the page never reloaded. (Pure client change; reuses `pollJob`.)
2. **Show pending in the gallery.** A small **"⏳ Генерируется…"** strip pinned above the finished «Мои работы» grid, fed from `ME.generations` (the pending subset), each card showing the model label + a spinner. When a poll transitions an item to `ok`, it moves into the grid; the strip auto-hides when empty. No pagination churn (the strip is separate from `galleryPage`).
3. **Surface recent failures, briefly.** A just-failed render renders once as **"⚠️ Не получилось · патроны возвращены"** (dismissible), so "it failed and you were refunded" is explicit rather than a silent disappearance. (Refund already happens via the pending→error CAS.)
4. **Timeout ≠ lost.** The client poll's 6-min timeout only stops *this tab's* polling; the DB still resolves the row, so it appears correctly on the next load. Nothing can hang forever (reaper guarantees terminal state + refund).

**Optional push (v2, the real "webhook").** When a **web-initiated** generation completes, also send the user a Telegram message ("✅ Готово — открыть") — mirroring how the bot path already delivers to chat — so they're notified even with the Mini App closed. Polling-on-resume covers the reload case without it; this is an additive nicety, gated behind a per-user notify toggle to avoid noise.

**Backend delta:** essentially none for the reload fix (data already flows). The optional push adds a `bot.api.sendMessage` on web-render completion in the detached tail (`generate.ts` web branch), behind a setting.

---

## 5. Home → Studio (the marketing→conversion contract)

The home page keeps every current rail (`Что создаём`, `Сценарии`, `🆕 Новые модели`, roadmap). We change only the **deep-link target**: instead of routing to a fragmented sub-view, each entry calls **`openStudio(ctx)`** with a context object that pre-fills the composer.

| Home entry (current) | Prefill on landing in Studio |
|---|---|
| Preset card (shoot/product) | prompt block = preset (editable), mode = 🖼, model = `presetModel(p)` preselected, inputs = "нужно фото" |
| Scenario/campaign card | prompt block = campaign preset (with quiz), mode per campaign, `animateModel` preselected if video |
| Video model (video tab) | mode = 🎬, that model preselected, inputs = "нужно фото" |
| News-banner model (`tryModel`) | mode by kind, that model preselected |
| "Из текста" | mode = 🖼, empty prompt textarea, `text_to_image` preselected |

Result: the home stays a pure **conversion funnel**; the Studio is the single **fulfillment surface**, always arriving warm.

---

## 6. Backend / data changes (small, enumerated)

1. **Widen the `/api/generate` `model` allow-list** (`webapp.ts:559-571`) from the curated pickers to the **full registry, validated by `kind` + input requirement + `normalizeOpts`.** Currently a user can't pick, e.g., `nb2_edit` or `seedream_edit` via the model path. Guard rules: text→image requires prompt; edit/video requires image; opts validated as today. *(This is the only backend change that gates the "ALL models" requirement.)*
2. **Extend the catalog payload** (`catalogPayload`, `webapp.ts:200-222`; delivered by `/api/me`) to expose, per mode, the **full model list** with `{key, label, benefit, credits, approxKzt, kind, image?, video?}` so the client renders picker + params without hardcoding. Most fields exist; add `benefit` copy, `approxKzt`, and ensure capability blocks ride along.
3. **Prompt Enhancer endpoint** `POST /api/enhance` — auth, rate-limit, charge 0.5 🔫 (per D2), call the enhancer (per D3), return `{prompt, charged}`. Log `enhance` event for COGS/monitoring. On provider failure: **no charge** (refund/again-exactly-once, same discipline as generation).
4. **(D2-dependent) fractional charge support** — either a numeric credit path or an enhance-counter micro-ledger. Scoped in the decision.
5. **No schema change to `generations`** — enhancer is a pre-generation step, not a render row.

Everything else — `startWebGeneration`, `createPendingGeneration`, `completeGeneration` CAS, refund, reaper, `/api/upload`, poll — is **unchanged**.

---

## 7. Open decisions (need sign-off before build)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | Prompt block editability | **(A)** Curated prompt stays server-side; user edits a *personalization* layer + swaps preset (keeps trend-safe, secure). **(B)** Expose raw prompt text for full editing (client sends raw prompt → must re-sanitize; loses curation guarantee). | **A** — keeps the security invariant; personalization + swap already feels like "editing". |
| **D2** | How to charge **0.5 🔫** | **(A)** Make the credit ledger fractional (numeric) — clean, enables future sub-credit ops, needs a migration + audit of integer assumptions. **(B)** Zero-migration: **1 🔫 = 2 enhances** via a per-user enhance counter. **(C)** First enhance free, then 1 🔫 each. | **B** for v1 (no migration, ships fast), revisit A if sub-credit ops proliferate. |
| **D3** | Enhancer LLM provider | fal text model · OpenAI · Anthropic. COGS ~fractions of a ¢ either way (0.5 🔫 ≈ $0.01 basis → healthy margin). | Cheapest reliable text model already reachable from the stack; confirm on integration (same "confirm-on-integration" note style as Kaspi/ElevenLabs). |
| **D4** | "≈₸" display basis | **(A)** Pack rate (~50 ₸/🔫), rounded — the honest retail number. **(B)** Patrons only, no ₸. | **A** — matches how packs are actually sold; `KZT_PER_USD=480` is margin-reporting only and must NOT be used here. |
| **D5** | Video mode from a preset with no image yet | **(A)** Require attach/generate-image-first (explicit). **(B)** Auto two-step: render image then animate (two charges, one tap). | **A** for v1 (clear, one charge at a time); B is a nice v2 "one-tap film". |
| **D6** | "ALL models" vs input compatibility | **(A)** Show compatible-first; incompatible collapsed under "показать все" with a requirement hint. **(B)** Show all always; incompatible visibly disabled. | **A** — satisfies "all models" while keeping the list scannable. |
| **D7** | Bot path parity | Mirror the visible model picker in the Telegram-chat flow now, or Mini App only for v1. | Mini App only for v1; bot pass later. |

### 7.1 Decisions locked (2026-07-22)
- **D1 = A** — Personalize + swap. Curated prompt stays server-side; user edits an "extra details" layer and can swap the preset. Security invariant kept.
- **D2 = "first free, then 1 🔫"** — First enhance of each generation is free; further enhances cost 1 🔫 each. No fractional ledger. (See block ②.)
- **D5 = A** — Explicit "image first" for v1: flipping to 🎬 Видео without a source image asks the user to add a photo or generate the image first. One-tap film deferred to v2.
- **D4 (default, confirm)** — "≈₸" shown from the pack rate (~50 ₸/🔫), rounded — never the 480 ₸/$ margin rate. Proceeding on this default unless overridden.
- **D6 → reframed as the fal-platform question (§7.2).** The UI-treatment default (compatible-first + reveal) stands **unless overridden**; the substantive ask was catalog *breadth/accuracy*, addressed next.

### 7.2 fal platform integration — the "all models" ask, properly scoped
You asked to **add a fal MCP for direct access to the full fal platform** (search models, read schemas, run inference, upload files, browse docs). That splits into two very different things, and the distinction is load-bearing:

**(a) Dev-time grounding — YES, high value, low risk.** A fal MCP (or fal's REST/docs) lets *us during development* look up the exact input schema, parameter ranges, output shape, and current price of any fal model, then **add/verify models in `src/models.ts` accurately** — correct `aspectRatios`, `resolutions`, `durations`, `perSecondUsd`, and COGS-based credit pricing. This directly powers "more models in the Studio", vetted, with correct params and margins. It's the right way to grow the 14-model registry to 20/30/… fast and correctly.

> **The official fal MCP (`https://fal.ai/docs/mcp`) is exactly this dev-time tool** — verified 2026-07-22. It is a **read-only documentation-search server**, no auth / no `FAL_KEY`, scoped to fal's published site. Tools: `search_fal` (knowledge base incl. API references & OpenAPI specs), `query_docs_filesystem_fal` (`rg`/`head`/`cat` over the docs + OpenAPI filesystem), `submit_feedback`. It does **not** run inference or upload files — those stay in the app's existing fal-SDK path (`falRun`, `fal.storage.upload`, `FAL_KEY`). Add it with `claude mcp add --transport http fal https://fal.ai/docs/mcp`. Until it's a connector, it's still reachable directly (JSON-RPC over HTTP) for grounding — so registry expansion is unblocked either way.

**(b) Runtime exposure of the *entire* fal catalog to end users — NO for v1 (breaks the business model).** Counter-argument first: NeuroShot's economics *depend on a curated registry with known per-model COGS* (`approxCostUsd`/`perSecondUsd` → `credits = ceil(usd / 0.02)` → sold at 47–62 ₸/🔫, ≥4× margin). If users could run *any* fal model:
  - **Pricing/margin breaks** — every fal model has a different, changing cost; we'd be charging fixed patrons for unknown COGS → we could sell renders at a loss.
  - **Quality/curation breaks** — the preset gallery's whole value is *hand-tuned* model+prompt pairings; raw model soup regresses the "one-tap, high-quality" promise you set for this redesign.
  - **Safety/ToS** — an open model runner invites NSFW/abuse surface we currently avoid by curation.
  - **Params variance** — arbitrary schemas can't all map to the fixed selector set (ratio/res/duration); the Studio UI would degrade to a raw JSON form.

**Recommended architecture — curated-but-expandable, MCP as an *admin/dev* tool:**
- Keep the **runtime** Studio catalog **curated** (the registry), so pricing/quality/safety stay controlled — this is what the phased build targets.
- Use the **fal MCP at dev time** to research + add models correctly, and (optionally, later) behind an **admin-only "Model Lab"** to trial a new fal model, capture its schema + measured COGS, set its credit price, and *promote* it into the registry. End users still only ever see vetted, priced models.
- **Practical note on adding the MCP:** I can't add MCP connectors to your Claude Code config myself (same limitation we hit with the Higgsfield MCP) — you enable it on your side (Settings → Connectors / `claude mcp add …` with fal's MCP endpoint + your `FAL_KEY`). Once it's connected and enabled for the chat, I can use it immediately to expand the registry. **In the meantime this is not blocking** — I can ground new models from fal's public model pages via WebFetch and the models we already run.

*If you actually want end users to browse/run the raw fal catalog (an "advanced/pro" surface), that's a separate, larger initiative — say so and I'll spec it with a dynamic-pricing + safety design; it should not gate the Studio v1.*

---

## 8. Phased build plan (safe, testable increments — same discipline as the dubbing engine)

- **Phase 0 — Docs (this).** This spec + `cinema-studio-scenarios.md`. Sign-off on §7 decisions. *(No code.)*
- **Phase 1 — Unified Studio composer (no enhancer).** New `viewStudio(ctx)` + `openStudio` deep-links; mode chip; full-registry model picker (D6); params from capability blocks; live total; wire to existing `/api/generate` with the widened allow-list (§6.1) + catalog extension (§6.2). Delete/retire `viewPick` and fold the standalone composers in. **Testable now:** `npm run test:webapp` asserts the catalog exposes all models per kind + valid opts; add composer-state assertions. No new economics.
- **Phase 2 — Prompt Enhancer loop.** `/api/enhance` + charge mechanism (D2) + provider (D3) + before/after UI + loop. e2e test: charge path, provider-failure no-charge, loop idempotency.
- **Phase 3 — Polish & unification.** ≈₸ everywhere, animate-via-mode-switch (D5 v2 if chosen), optional bot parity (D7), model-compare affordance.

Each phase = its own green `typecheck / lint / check:patron / test:e2e / test:webapp` and its own PR.

---

## 9. Future / explicitly deferred
- Multi-reference image inputs (Seedream/Nano support it; code is single-image today).
- One-tap "film" (image→video auto-chain, D5-B).
- Bot-chat model-picker parity (D7).
- Saved "recipes" (a preset + model + params combo the user can re-run).
- Fractional credit ledger (D2-A) if sub-credit features grow.

---

## 10. Definition of Done (feature-complete, all phases)
1. Every home generation entry lands in **one** Studio view, prefilled per §5.
2. On every path the **selected model is visible, swappable, and priced inline** (🔫 + ≈₸).
3. The **prompt block is editable/swappable** without leaving the Studio (per D1).
4. **Mode chip** switches image↔video and re-filters models/params correctly.
5. **All models** of a mode are reachable (per D6); params render only where supported.
6. **Prompt Enhancer** charges per D2, shows before/after, loops, and never charges on provider failure.
7. **Total** always equals the server's `priceFor`; 402 handled; refunds still exactly-once.
8. Home theme + preset gallery **visibly unchanged**.
9. **In-progress generations survive reload** — a pending render re-appears as "⏳ Генерируется…" and resumes to completion; a failure shows the refunded state (spec §4.1).
10. All CI gates green; `viewPick` and orphaned composer code removed.

---

## 11. Acceptance criteria (concrete, testable)
- **AC1** From a preset tap, the Studio opens with that preset's block, its default model preselected and priced, and a photo prompt — in one view, no tab-hopping.
- **AC2** Changing the model row updates ⑥ params and ⑦ total live; picking a video model in 🎬 mode reveals duration/end-frame; the total matches `priceFor(model, opts)` for every combination tested.
- **AC3** With a photo attached, all `image_edit` models are selectable; without one, they're gated with "нужно фото" and `text_to_image` is primary (D6).
- **AC4** "Улучшить промпт" charges per D2, returns an upgraded prompt with before/after, applies on accept, and a forced provider error leaves balance unchanged.
- **AC5** Insufficient balance turns the CTA into "Пополнить" and opens the paywall; no pending row, no charge.
- **AC6** The catalog exposes 7 image + 7 video models with valid capability blocks; `test:webapp` iterates and asserts each renders a valid param set and a positive price.
- **AC7** The preset gallery content and app theme are byte-identical to pre-change (diff shows no CSS/preset-copy edits).
- **AC8** `viewPick` is gone; a grep for the old tab-strip generation menu returns nothing.
- **AC9** After starting a render and reloading the page, the pending render re-appears as "⏳ Генерируется…" and completes live (poll resumes from `/api/me` pending rows, not in-memory state); a failed render shows "патроны возвращены" with the balance already refunded.
