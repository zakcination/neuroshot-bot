# NeuroShot Mini App — strategy memo · 2026-07-23

**Audience:** owner/CEO. **Scope:** the Telegram Mini App as the primary product surface.
**Relation to other docs:** `product-roadmap.md` = backlog source of truth · `growth-campaign-2026-07.md` = channel plan · `cinema-studio-spec.md` = the composer's design record. This memo is the strategic synthesis on top of them, refreshed with what actually shipped through **PR #67 (merged)** and **PR #68 (open: Prompt Enhancer)**.

---

## 1. Where the Mini App is today (shipped, verified)

The Mini App has crossed a line: it is no longer "the bot's web mirror" — it is now the **best surface we have**, with capabilities the bot chat cannot match.

| Capability | State | Data |
|---|---|---|
| **Cinema Studio composer** | ✅ live (merged #67) | ONE prefilled page: preset chip (✎ personalize / ⇄ swap keeping photo) → inputs → 🖼/🎬 segmented mode → **full model registry** (9 image + 5 video) with **patron-only prices** → per-model params (aspect/quality/duration/end-frame/story) → live total → paywall handoff. Verified by a 20-step real-Chromium smoke. |
| **Prompt Enhancer** | 🔁 PR #68 | «✨ Улучшить · 1-е бесплатно» — first enhance after every render free, then 1 🔫; runs on `fal-ai/any-llm` (existing FAL_KEY, zero new deps); auto-refund on provider failure. |
| **Reload-safe progress** | ✅ live | Pending renders survive reload (re-hydrated from `/api/me`), show as ripple cards in «Мои работы», failures show "патроны возвращены". Bot-started renders appear too. |
| **Marketplace killer-feature presets** | ✅ live | `kaspi_card` (white bg) + `wb_apparel_card` (#f2f3f5), **3:4 pinned server-side** — the growth plan's differentiation bet ("upload-ready card in 40 seconds"). |
| **Paywall exit-offer** | ✅ live | Dismissing the paywall surfaces the combo (1000 ₸ / 36 🔫 ≈ 28 ₸/🔫, ~50% under ladder) once per session. |
| **In-app payments** | ✅ live | Full Kaspi loop inside the app: order → pay link → «Я оплатил» → verify/admin → auto-credit. HMAC webhook ready for merchant API. |
| **Catalog** | ✅ | **29 presets** (20 photo + 9 product incl. the 2 marketplace cards), 7 campaigns, 14 models — all fal-schema-verified (2026-07-22), two pricing drifts fixed (phantom Seedance 1080p removed; NB2 4K overcharge 2.5×→2×). |
| **Dubbing engine (foundation)** | ✅ backend | ElevenLabs client + exactly-once economics; RU/EN ready, KK gated on Phase-0 validation; needs `ELEVENLABS_API_KEY` + product flow. |

**Quality bar:** 70 webapp + 57 e2e checks, patron-emoji CI guard, typecheck/lint — all green in CI on every PR.

## 2. The economics (current, exact)

- **Unit:** 1 🔫 ≈ $0.02 provider cost (`CREDIT_COST_BASIS`); every model priced `ceil(usd/0.02)`.
- **Retail ladder:** 3 700 ₸/60 (≈62 ₸/🔫) → 11 000/200 (55) → 25 000/500 (50) → 42 000/900 (47) + combo 1 000/36 (28, offer). **Gross margin ≥4×** at ladder rates.
- **Pricing language (decided):** generations are priced **in patrons only** — no ₸ conversions on estimates; real ₸ appears solely on pack purchases. One currency inside the product, one honest exchange surface on the top-up screen.
- **Free hook:** 4 🔫 signup (≈ one Nano Banana render) + one-time free scenario; claim-gated, phone-gate available behind `FREE_GATE_ENABLED` when paid acquisition scales.
- **COGS truth:** every render stores real `cost_usd` + provider request id → the CEO digest computes actual margin; the enhancer and dubbing log their own events for the same treatment.

## 3. Strategic position (the argument)

1. **Against VeoSee-class aggregators** (the 1,932-post teardown): they sell *access to models* and drown newcomers in prompts/formats. We sell *outcomes* — a preset gallery that converts into a prefilled Studio where the prompt is optional, the model is visible-but-chosen-for-you, and the price is one number. The Studio ships this thesis; the Enhancer removes the last "I can't write prompts" objection.
2. **The moat candidate is vertical, not horizontal:** the **Kaspi/WB seller card** (correct 3:4 + background spec, one tap, 2 🔫). ~40k+ KZ Wildberries sellers (H1 2023, understated) with a deadline-shaped pain no generic bot owns. This is the type-4 buyer the growth plan's whole paid budget targets.
3. **Curated-but-expandable catalog:** runtime stays curated (known COGS → safe fixed patron prices); the fal docs MCP grounds dev-time expansion (schemas/pricing verified before a model ships). We deliberately rejected raw-catalog exposure — it breaks pricing, quality, and safety at once.
4. **Distribution before ads:** per the growth plan, no Meta spend until ≥10 payments with known source from near-free channels (TG посевы, seller DMs, organic before/afters). The product side of that funnel — attribution deep-links, watermark CTA, exit-offer, first-session corridor — is built; the campaign execution is an owner motion, not a code motion.

## 4. KPIs to watch weekly (all already instrumented)

| KPI | Source | Why it gates strategy |
|---|---|---|
| First-session conversion: open → first render | events (`gen_start`/visits, `/dash`) | The "money is made in the first session" doctrine — this is the funnel's mouth |
| Paywall → purchase rate; exit-offer take rate | `paywall` events vs orders; combo orders | Tests the sales-page + offer mechanics before ads |
| Payments with known source | `ENTRY_LINKS` attribution in `/dash` | The Phase-1 → Meta gate (≥10 payments, source known) |
| `kaspi_card`/`wb_apparel_card` usage + seller-segment size | `preset` events (id-level) | Validates the killer-feature bet; sizing already queryable |
| Enhancer: free→paid conversion, enhances/render | `enhance` events (free/paid meta) | First data on willingness to pay for prompt help |
| Reroll/failure rate + margin per model | `cost_usd`, `gen_error` | Catches provider drift (like the Seedance 1080p bug) in money terms |

## 5. Next bets, in order (with effort)

1. **Merge #68** (Enhancer) — done pending CI/review. *(S)*
2. **Multi-image compositing** — all edit models already take `image_urls[]` (payload is list-form today); "me + friend", "product + props" unlocks new preset classes for ~a day of work. *(S/M — task #59's cheap half)*
3. **Multi-output `count`** — `num_images` 1–4/1–6 needs multi-output rows/gallery/delivery; pairs naturally with a "выбери лучший" picker that doubles as a quality signal. *(M — task #58)*
4. **Campaigns into the Studio** (Phase 3) — the last non-unified flow (quiz + scenes still on the legacy path). *(M)*
5. **Dubbing product flow** — target picker + 15s demo + consent; blocked on `ELEVENLABS_API_KEY` for Phase-0 KK validation, RU/EN could soft-launch earlier. *(M, plus owner-side key + native-speaker judge)*
6. **Owner motions (not code):** deploy + click through the Studio; drop the ElevenLabs key; run the 30-seller DM test; start TG посевы. The next strategy update should be written against *their* numbers.

## 6. Risks & mitigations

- **`gpt-image-2` / `hailuo-2.3` endpoints absent from current fal docs** (possible retirement/rename) → verify with one live render each before leaning on them in promos; fallbacks identified (`gpt-image-1.5`, current MiniMax i2v). *(params doc P7)*
- **Studio is a big UX change for existing users** → the gallery/home didn't move (deliberately); watch `gen_start` rate week-over-week post-deploy for regression; the old flows' server contracts are unchanged, so a client-side rollback is a single-file revert.
- **Kazakh dubbing quality** (v3-alpha TTS) → stays behind `DUB_KAZAKH_ENABLED` until a paid native-speaker validation passes; RU/EN don't wait for it.
- **Free-plan farming** if paid acquisition scales → `FREE_GATE_ENABLED` phone gate is built and off; flip when scaling paid.

## 7. Decision log (locked, this cycle)

D1 personalize+swap (curated prompts stay server-side) · D2 enhancer first-free-then-1🔫 · **D4 patron-only pricing on all generation estimates (user, 2026-07-22)** · D5 image-first before video (one-tap film = v2) · D6 compatible-first model list with «показать все» · fal = dev-time grounding tool, runtime catalog stays curated · partner enrollment admin-served · Meta ads only after the Phase-1 payment gate.
