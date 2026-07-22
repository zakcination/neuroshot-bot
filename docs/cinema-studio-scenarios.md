# NeuroShot Cinema Studio — end-to-end scenarios

Companion to `docs/cinema-studio-spec.md`. Concrete, step-by-step user journeys through the redesigned Studio, plus the edge cases the build must handle. Each scenario names the Studio blocks (①–⑦) from the spec and the underlying calls, so it doubles as a test script.

Legend: 🔫 = patron · block refs ①–⑦ = spec §4 · "server" = `/api/*` in `webapp.ts`.

---

## Part A — Happy-path journeys (personas)

### S1 — Айгуль, a parent: "child as princess" (preset → image)
1. Home → "Сценарии" → taps **🎀 Принцесса**. `openStudio(ctx)` fires (spec §5).
2. Studio opens **prefilled**: ① block = "🎀 Принцесса" (editable), ④ mode = **🖼 Фото**, ⑤ **Сцена по фото (2 🔫 · ≈100 ₸)** preselected and highlighted, ③ says **"нужно фото"**.
3. She taps ③ **📷 С устройства**, picks her daughter's photo → downscaled → uploaded → thumbnail shows.
4. ⑦ now reads **"Создать за 2 🔫 (≈100 ₸)"**, balance 4 🔫. She taps it.
5. `POST /api/generate {source:"preset", id, image_url, opts}` → pending id → poll → `viewResult` with the princess image. Balance 2 🔫.
6. She sees ④ still there and taps **🎬 Видео** → "оживить" → picks **⚡ Видео — эконом (10 🔫)** → but balance is 2 → CTA becomes **"Пополнить"** (→ S9).

*Covers: preset prefill, image input, single charge, mode-switch upsell, insufficient handoff.*

### S2 — Данияр, a creator: text→image with the enhancer (free-text → image)
1. Home → "Из текста". Studio opens: ① empty `<textarea>`, ④ 🖼, ⑤ **✨ Картинка из текста (2 🔫)** primary (no photo).
2. Types a rough prompt: *"кот в очках, неон"*.
3. Taps ② **✨ Улучшить промпт** → −0.5 🔫 → before/after sheet shows an upgraded, directable prompt (lighting, lens, mood). Taps **Применить**.
4. Wants more punch → picks ⑤ **🎨 Картинка — детально (2K) — 8 🔫**, then ⑥ sets aspect **9:16** and quality **4K** → ⑦ live-updates to the multiplied price (`priceFor` with `resolution` mult).
5. Generates. Result in ⑦-flow; balance reflects 0.5 (enhance) + render.

*Covers: free-text prompt, enhancer charge + apply, model swap changes params, resolution multiplier pricing.*

### S3 — Мадина, a marketplace seller: product shot (preset "product" → edit model)
1. Home → "Что создаём" → **🛍 Товар** → taps **product_hero**. Studio prefilled: ① product preset, ④ 🖼, ⑤ preset's pinned edit model preselected (e.g. `nbpro_edit`, 8 🔫), ③ "нужно фото".
2. Uploads her product photo. Taps ✎ **Изменить** → personalization "белый фон, мягкий свет".
3. ⑥ aspect **1:1** (marketplace). ⑦ "Создать за 8 🔫 (≈400 ₸)". Generates.

*Covers: product category, edit-model default, personalization layer, aspect for a use-case.*

### S4 — Ерлан, a football fan: campaign with quiz + one-tap video (campaign → image → video)
1. Home → "Сценарии" → **⚽ Worldcup**. Studio prefilled with the campaign preset; ① block shows the campaign **quiz chips** (team, pose) + personalization.
2. Answers quiz, uploads selfie, generates the image (campaign `PRESET_MODEL`).
3. On the result, taps ④ **🎬 Видео** → the just-made image becomes the source; ⑤ shows all video models; campaign default `animateModel` (`hailuo_fast`, 10 🔫) preselected. ⑥ duration **6s**.
4. Generates the video. (D5-A: two explicit charges — image then video.)

*Covers: campaign quiz, image→video via mode switch on a result, campaign default video model, duration default 6s for hailuo.*

### S5 — Power user: full manual control (blank → video with end-frame)
1. Home → video model card (e.g. **🎬 Кино-движение / kling3**). Studio: ④ 🎬, ⑤ kling3 preselected (42 🔫).
2. Uploads a start frame; ⑥ reveals **end-frame** upload (`endFrame:true`) → uploads a second image; duration **10s** → ⑦ scales to `priceFor` at 10s.
3. Generates a 10s cinematic transition.

*Covers: explicit video model, end-frame input, duration-scaled price.*

---

## Part B — Edge cases & failure modes (must-handle)

### E1 — Insufficient balance (the paywall handoff)
- At ⑦, if `priceFor(model, opts) > balance`: CTA renders **"Пополнить"** not "Создать". Tap → `viewPaywall` (today's 402 path). **No** `/api/generate` call, **no** pending row, **no** charge. Returning from top-up restores the exact Studio state.

### E2 — Enhancer provider failure → no charge
- ② tapped, provider errors/times out → user sees "не получилось улучшить, попробуйте ещё" and **balance is unchanged** (charge is committed only on a successful enhancement, mirroring generation's refund-exactly-once discipline).

### E3 — Enhancer with empty prompt
- ② disabled (greyed) until there's a non-empty effective prompt. No call, no charge.

### E4 — Switching mode to 🎬 Видео with no source image
- ④ → 🎬 while ③ is empty and no result exists → inline notice "добавьте фото или сначала создайте картинку"; ⑤/⑥ stay visible but ⑦ is disabled until a source exists (D5-A). No half-formed request.

### E5 — Switching model to an incompatible one (D6)
- In 🖼 with a photo attached, `text_to_image` shows "создаст с нуля (без фото)"; picking it drops the photo requirement (photo becomes ignored, with a hint). In 🖼 with no photo, `image_edit` models show "нужно фото" and are gated until one is added. Nothing silently drops.

### E6 — Model swap resets invalid params
- Switching from a model that supports 4K to one that doesn't (e.g. `nbpro`→`text_to_image`) must **clamp `studioState.opts`** to the new model's capabilities via a client mirror of `normalizeOpts`; the server re-validates and 400s on any stale/invalid opt (`webapp.ts:594-600`). Test both layers.

### E7 — Preset swap preserves context
- ① **⇄ Сменить пресет** → pick another preset → returns to Studio with the new prompt block but the **same** uploaded photo, mode, and (if still valid) model/params. Params re-clamp if the new preset pins a different default model.

### E8 — Video source rejected
- If a user selects a **video** from "мои работы" as an image source, the server rejects it (`webapp.ts:495`); the picker also filters videos out client-side (`myImages()` is non-video only). Belt-and-suspenders.

### E13 — Reload / reopen during a generation (persistent in-progress) — spec §4.1
- Айгуль starts a 10s video, then accidentally reloads (or Telegram evicts the web view). On reload, `load()` reads `ME.generations`, finds the row `status:"pending"`, and **auto-resumes polling** — the jobs pill and a **"⏳ Генерируется…"** card reappear at the top of «Мои работы». When it finishes, the card becomes the finished video. She is never left wondering.
- Variant: it *failed* while she was away → on load she sees **"⚠️ Не получилось · патроны возвращены"** once (dismissible), and her balance already reflects the refund. No silent disappearance.
- Variant: she closes the app entirely → next open, the finished render is simply in the gallery (DB is truth). If the optional Telegram push (v2) is on, she also got "✅ Готово" in chat.
- **Asserts:** pending rows from `/api/me` re-hydrate poll jobs; pending strip renders and clears; failed row shows the refunded state; no dependence on in-memory `jobs` surviving reload.

### E9 — Concurrency: generate while another job runs
- Studio submit registers an independent poll job (`jobs` Map, `pollJob`); a second generation can be started (balance permitting) without blocking the first. Each has its own pending row / lifecycle. (Unchanged from today.)

### E10 — Balance changes mid-session
- ⑦ recomputes affordability against the **live** `ME.balance` after any charge (enhance or a completed sibling job). A user who just spent their last patrons on an enhance sees ⑦ flip to "Пополнить" before generate.

### E11 — 0.5 🔫 accounting (D2-B, if chosen)
- With the "1 🔫 = 2 enhances" counter: first enhance decrements a half-credit counter; the ledger shows a whole-🔫 debit only on the 2nd enhance. UI copy stays "≈0.5 🔫" and the running balance is consistent with the counter. Test the odd/even boundary.

### E12 — Theme/gallery untouched (regression guard)
- A visual/diff check that home CSS, preset copy, and preset art references are unchanged (DoD #8 / AC7). Any diff to `PRESETS` copy or theme tokens fails review.

---

## Part C — Scenario → test-hook map

| Scenario | Primary asserts | Where |
|---|---|---|
| S1–S5 | prefill context correct; `priceFor` == displayed total for each opts combo | `test:webapp` (catalog + composer state) |
| E1, E5, E6, E8 | server guards: allow-list, `normalizeOpts` 400, video-source reject, kind/input rules | `test:e2e` (`/api/generate` branches) |
| E2, E3, E11 | enhancer charge-once / no-charge-on-failure / fractional accounting | `test:e2e` (`/api/enhance`) |
| E12 | no theme/preset diff | review + a grep guard |

---

## Part D — What a "great" session feels like (north star)
One screen. You see your idea as an editable block, make it sharper with a tap, drop a photo, flip between photo and video like an old iPhone toggle, and every model you could pick is right there with its price — no hunting, no surprises, no "wait, which model am I even paying for?". You hit one button and know exactly what it costs. That's the Higgsfield-studio feel, sized for a Telegram Mini App.
