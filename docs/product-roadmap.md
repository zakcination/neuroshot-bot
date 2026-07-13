# NeuroShot — product roadmap

Turns the owner's PR#3 brief into an actionable split, grounded in the 10-month
VeoSee/Neuroplace teardown (1,932 posts, Sep 2025–Jul 2026). Guiding thesis:
our users are **newcomers, not pros** — they never see a prompt unless they ask.
Every VeoSee weakness (prompt complexity → $200 course, format fatigue,
aggregator treadmill, reliability debt) is an opening we design against.

Legend — effort: **S** ≤1 day · **M** a few days · **L** 1–2 weeks.
Status tags: **✅ done** · **🟡 partial** · **⬜ not started** · **🔁 in flight**
(PR open or an agent actively building it right now) · **💤 parked** (see
"proposed to deprioritize" below, pending your call) · **🗄 superseded**.

*Refreshed 2026-07-14 — full pass through every doc in `docs/` cross-checked
against `src/`. This doc is the single source of truth for backlog/roadmap;
`docs/products-2026-07-09.md` is an older dated snapshot, superseded on
payments/presets/pricing — see its banner.*

---

## 🟢 Shipped since this roadmap was last written

Not in the original plan at all, or shipped far beyond what was scoped here —
recorded so the tiers below aren't misread as "nothing has happened":

- **Payments rail replaced wholesale**: Telegram Stars removed entirely,
  replaced by **Kaspi (KZT)** — order → pay-link → admin/webhook/self-check
  confirm → `grantPurchase` (`src/kaspi.ts`, `src/payments.ts`, `src/webapp.ts`).
  This supersedes most of Tier F's original "Stars can't cover this" framing —
  see Tier F rewrite below.
- **Mini App**: full redesign — wallet, gallery, referral/partner tab, claim-
  gated welcome bonus + onboarding roadmap, "Ещё" catch-all tab
  (`public/app.html`, `src/webapp.ts`). Far beyond original Tier D scope.
- **Async generation**: renders run detached with a stale-render reaper
  (`src/generate.ts`, `docs/async-generation.md`) — reliability work beyond
  Tier 5's original "surface it in copy" scope.
- **CEO monitoring**: daily digest, `/dash`, 3 alert types, 48h re-engagement
  nudge (`src/monitor.ts`, `docs/monitoring.md`) — not in the original plan.
- **Legal/compliance**: mandatory AI-disclosure watermark + ffmpeg metadata
  (KZ Law 230-VIII) on every delivery (`src/watermark.ts`) — not in the
  original plan, now a hard compliance requirement, done.
- **Partner program v2**: self-serve creator codes, `/partner` dashboard,
  cashback withdrawal flow (`docs/partner-program.md`, `docs/creator-program.md`)
  — beyond original Tier A's "referral leaderboard" scope.
- **Prompt library curation**: 12 → 19 → 26 one-tap presets in 3 batches from
  the VeoSee scrape (`src/models.ts` `PRESETS`, `docs/prompt-library.md`),
  with per-look model routing (Seedream/NB2/NBPro/GPT-Image-2 matched to what
  each recipe actually needs). PR #56 has the 3rd batch open.
- **Course product** 🔁 **in flight right now** — free guide + $9/5-lesson +
  $50/3-module content (`docs/course/`), private-cohort-channel purchase
  delivery (`Pack.course` field, `grantPurchase` → `inviteToCourseCohort`,
  `/course` command) — being built and tested by a background agent as of
  this refresh; PR incoming. **Manual step still needed from the owner**: create
  2 private Telegram groups/channels, add the bot as admin with invite rights,
  set `COURSE_FAST_CHANNEL_ID`/`COURSE_FLAGSHIP_CHANNEL_ID`.
- **CI/CD**: auto-deploy to Fly on push to `main` (`.github/workflows/ci.yml`
  `deploy` job, `FLY_API_TOKEN` secret) — merged. `docs/deploy.md` still
  describes manual `fly deploy` only — doc hygiene item below.

---

## 🔴 URGENT tier — status of the original items

### 1. Foundational base menu — proven formats as one-tap presets · S — 🗄 superseded
19→26 presets shipped via 3 curation batches, but **none of the 8 specific
named demand items from this list ever got added** (Love is вкладыш, 8 марта
обложка, мама-дочь акварель, Новый год семейное, детский рисунок→реалистичный,
авто из «Форсажа», Instagram-сетка 3×3, Pixar-аватар). **Decided 2026-07-14**:
scrape-based curation (VeoSee prompt-library, `docs/prompt-library.md`)
supersedes this original top-8 list — not pursuing it as a separate item.

### 2. Newcomer interaction layer — inspiration-first · M — 🟡 partial
First-run guided `/start` + persona-routed entry links: **done**
(`src/bot.ts` `routeEntry`). Gallery "сделать такое же" browse and «Удиви
меня» random-preset button: **not started** — genuine gap, still worth doing.

### 3. Prompt library v1 — curated, browsable · S–M — 🟡 partial
Presets exist and are keyboard-browsable by category, but there's no
dedicated `/library` command and only 2 categories (photo/product) — no
Тренды/Праздники buckets, no richer surface (thumbnails/search) per
`docs/prompt-library.md`'s own "Next" section.

### 4. Trend tracking v1 · S — ⬜ not started
No `/trends` command, no `subscribed` flag, no new-model/new-trend push
broadcast anywhere in the code. Untouched since this was written.

### 5. Reliability as a stated feature · S — 🟡 partial
Auto-refund is real and now far more robust (async generation + reaper) than
originally scoped, but the copy/self-check half never shipped: no `/status`
command, no "сбой = мгновенный авто-возврат" messaging found in `src/text.ts`.

---

## 🟡 BACKLOG tier — status of the original items

### A. Community virality engine · L — ⬜ not started
Referral crediting is real (basic lifetime %, milestones), but none of:
leaderboard, UGC contests, "Сделано в NeuroShot" attribution toggle,
ambassador tier, share-to-earn. Full item still open.

### B. Trend auto-ingestion pipeline · L — ⬜ not started
No code. Depends on #4 above existing first.

### C. Prompt library v2 (search, favorites, "промпт дня") · M — ⬜ not started
No code. `docs/prompt-library.md`'s own "Next (proposed)" section duplicates
this — **doc hygiene**: that section is stale in a second way too (it also
lists GPT Image 2 routing as "proposed", which shipped 2 batches ago).

### D. Platform expansion · L — 🟡 partial, rescoped
Mini App: **done**, far exceeds original scope (see Shipped section above).
Web app + SEO landings, email/contact hedge against a TG block: still not
started — this is the part of D still genuinely open.

### E. Advanced creator tools · L — ⬜ not started
No identity-consistency model (Soul-ID/LoRA), no batch generation, no brand
kits, no Veo/Sora premium tier. Fully open — `docs/prompt-craft.md` confirms
the LoRA/trained-face piece specifically is still nothing.

### F. Payments & monetization — 🟡 rescoped, partially done, partially stale
**Kaspi shipped for real** (order → pay-link → webhook/self-check/admin
confirm → grant) — this was the essential, market-specific piece (KZ cards).
Everything else in the original multi-provider list (YooKassa, Crypto/TON,
PayPal, SEPA) is still **⬜ not started**. **Decided 2026-07-14**: holding —
Kaspi alone required its own compliance effort (`docs/kaspi.md` +
`docs/payment-compliance.md`; KZ interbank QR mandate goes live
**2026-07-19**, still unconfirmed with Kaspi merchant support). Don't start a
second rail until that's confirmed and purchase volume through Kaspi
justifies the overhead of a third-party integration.

- Email-for-receipt + currency select · S — ⬜ not started.
- **Promo codes** · S — ⬜ not started. This exact ask also appears
  independently in `docs/creator-program.md`'s backlog (distinct from partner
  codes) — same item, two docs, still nothing built either place.
- **Subscription tiers** · M — ⬜ not started, **still on the table (confirmed
  2026-07-14)** — not deprioritized despite the "patrons not subscription"
  framing elsewhere; revisit once pack/course LTV data is in.

Already covered (unchanged): profile/balance, gallery, partner tab — done,
exceeds original scope.

Small standalone win: **`/support`** command · S — ⬜ still not started,
cheap, still worth doing.

---

## 🆕 New backlog surfaced by this audit (not in the original doc)

Pulled from `docs/creator-program.md`, `docs/course/README.md`,
`docs/web-app.md`, `docs/model-inputs.md`, `docs/compliance.md` — all
verified ⬜ not started against current code:

- **Signature preset packs w/ per-generation attribution & payout** (creator
  deals, offer #3 in `docs/creator-program.md`) — no field for it in `Preset`.
- **Wholesale pack invoicing** for course/creator bundles — no code.
- **Partner web dashboard** in the Mini App (richer than `/partner`) — no route.
- Course free-guide packaging as Telegra.ph/PDF (`docs/course/README.md`
  open item) — currently delivered in-chat via `/course` → `course:guide`
  instead (simpler, ships now); Telegra.ph packaging is a nice-to-have on top.
- Course lesson screen-capture GIFs (`docs/course/README.md` open item).
- Legal/IP check on the cartoon campaign before using it in paid course
  material (`docs/course/README.md` + `docs/course-funnel.md`'s existing ⚠️).
- Robust image provenance marking (EXIF/XMP/C2PA writer) — current watermark
  is best-effort ffmpeg metadata only, flagged in `docs/compliance.md` itself
  as a tracked follow-up.
- Proportional watermark badge sizing (vs. fixed `AI_WIDTH = 400` px).
- `docs/web-app.md` roadmap items 2–10 (projects/collections, brand kits,
  batch queue, team workspaces, affiliate console, scheduled auto-posting,
  spend/ROI analytics, API keys, white-label) — item 1 (personal dashboard)
  is done; everything past it is untouched, consistent with Tier E/D above.
- `num_images` (batch variations) and GPT-Image-2 transparent background —
  both flagged accurate-and-still-open in `docs/model-inputs.md`.
- Art. 21 legal-scope question (all AI media vs. deepfake-of-real-persons
  only) — unresolved at the law level per `docs/compliance.md`, not a code gap.

---

## 🧹 Doc hygiene debt (separate workstream — batch-fixable, not urgent)

The Stars→Kaspi payment migration and 3 preset-curation batches left comment/
doc rot across the repo. None of these are functional bugs — money and
generation both work correctly — but they'll mislead the next person (human
or agent) who reads them:

1. **`README.md`** — still says "Payments via Telegram Stars (XTR)"; the
   `src/payments.ts` Architecture-table row still says "Stars invoices,
   pre-checkout"; "Before going live" #3 references a "Stars cash-out
   discount" that no longer exists; roadmap #4 says "YooKassa/Paddle" when
   Kaspi is what shipped; Architecture table is missing 7 of 15 `src/` files
   (`config.ts`, `kaspi.ts`, `monitor.ts`, `offer.ts`, `promptcraft.ts`,
   `text.ts`, `watermark.ts`); no mention of `docs/kaspi.md` or `docs/course/`.
2. **`docs/watermark.md`** — cites function/constant names that were renamed
   (`watermarkVideo`/`watermarkImage` → `brandForDelivery`; `MARK_WIDTH` etc.
   → `AI_WIDTH`/`CTA_WIDTH`/`CORNER_WIDTH`); never mentions the mandatory
   legal AI-disclosure feature that's the module's actual main job now;
   describes the "corner" UGC style as live when `deliveryStyles()` never
   selects it; says `corner_watermark.png` doesn't exist yet — it does.
3. **`docs/monitoring.md`** — references `STAR_USD`/stars-based revenue math;
   actual code computes revenue in KZT via `KZT_PER_USD`.
4. **`docs/deploy.md`** — describes manual `fly deploy` as the only path;
   doesn't mention the new CI auto-deploy-on-push-to-main job.
5. **`docs/vercel.md`** — "What runs on Vercel" table lists only `/api/auth`
   + `/api/me`, but `src/webapp.ts` now has ~10 more API routes
   (`/api/generate`, `/api/order`, `/api/kaspi/callback`, etc.) with no
   Vercel wrappers — the doc reads as if Vercel covers the whole web layer;
   it covers a shrinking fraction of it.
6. **`docs/course-funnel.md`** — "Payments: Stars today... card checkout
   (Kaspi/YooKassa, roadmap) unlocks fully" is inverted — Kaspi is the live
   rail today, not a future unlock. *(Being touched by the in-flight course
   agent right now — don't fix in parallel, let that PR land first.)*
7. **`docs/creator-program.md`** / **`docs/partner-program.md`** — both
   describe purchases as funded by "Stars spend"; also `creator-program.md`'s
   backlog item "card paywalls beyond Stars (Crypto → Kaspi → YooKassa)"
   still frames Kaspi as future when it's live.
8. **`docs/mentor-course-analysis.md`** — quotes our own "Старт" pack as
   "⭐720"; it's 3,700 ₸ now. (Competitor Stars figures elsewhere in the same
   file are about other bots and are fine, don't touch those.)
9. **`docs/prompt-library.md`** — "Next (proposed): a GPT Image 2 route" is
   already shipped 2 sections earlier in the same file (self-contradicting);
   preset count/list is stale after batch 3 (still says the batch-2 total).
10. **`docs/prompt-craft.md`** — describes "Seedream 4.5 edit" as an upgrade
    still ahead of the default; it's already the shipped default.
11. **`docs/products-2026-07-09.md`** — entire doc is a dated snapshot,
    materially stale on payments (§6/§7 describe Stars/openInvoice), presets
    (§2 says 7, now 26), and lists 2 ideas (aspect_ratio, end-frame, 1080p
    tier) as unbuilt that have since shipped. **Proposal**: add a one-line
    "superseded — see `docs/product-roadmap.md`" banner at the top rather
    than deleting it (keeps the historical idea-log intact).

**Proposal**: run this as one batch-fix pass (parallel agents mirroring the
audit clusters above), once course-funnel.md's in-flight PR lands so there's
no edit collision. Low risk, no strategic judgment calls needed except item
11's banner wording.

---

## ✅ Strategy calls — decided 2026-07-14

1. **Tier 1's original named-preset-8 list** — superseded by scrape-based
   curation (26 presets across 3 batches). Not pursuing the original list.
2. **Multi-provider payment expansion** (YooKassa, Crypto/TON, PayPal, SEPA)
   — holding until Kaspi's compliance posture is confirmed (interbank QR
   mandate, 2026-07-19) and purchase volume justifies a second rail.
3. **Subscription tiers** — still on the table, not deprioritized. Revisit
   once pack/course LTV data is in; the "patrons not subscription" framing
   elsewhere is current positioning, not a permanent constraint.
4. **`docs/products-2026-07-09.md`** — archived with a superseded banner
   (not deleted) — done, see banner added to that file.
5. **Doc-hygiene batch fix** (10 files, Stars→Kaspi rot etc.) — greenlit,
   scheduled to run once the in-flight course-cohort PR lands (avoids an
   edit collision on `docs/course-funnel.md`).

---

## ⚠️ Anti-goals (unchanged, still holding)
1. **Don't become an aggregator.** Stay wedge-first: models live behind use
   cases, never as a menu of names.
2. **Don't make prompts the product.** That's what built VeoSee's $200
   course and capped adoption.
3. **No urgency theatre / price wars.** Compete on one-tap UX + results.
4. **Don't relax moderation for growth.**
5. **Don't stay Telegram-only past traction.** Hedge the platform early —
   still true; still nothing built toward this (see Tier D).

---

## Suggested next sprint (concrete, updated)
1. Land the in-flight course PR (private-cohort delivery) — needs your 2
   manual Telegram-channel setup steps once it's up.
2. Merge PR #56 (3rd preset batch) if you're happy with it.
3. Pick a lane on Tier 2/3 above (gallery browse + «Удиви меня» is the
   cheapest remaining gap in the original "newcomer interaction layer").
4. Greenlight the doc-hygiene batch fix (low-risk, no strategic calls needed
   beyond the `products-2026-07-09.md` banner wording).
5. Rule on the 4 "propose to deprioritize" items above so the roadmap stops
   carrying dead-but-undeclared plans.
