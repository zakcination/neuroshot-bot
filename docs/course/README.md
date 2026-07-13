# GenAI video course — 101 → expert

The three-tier ladder from `docs/course-funnel.md`, written out as actual
lesson content. Free → $9 → $50, each tier a sellable, deliverable artifact
(Telegra.ph/PDF for the free guide, a private TG channel drip for the paid
tiers).

| File | Tier | Format |
|---|---|---|
| [`00-free-guide.md`](00-free-guide.md) | Free tripwire | 10 copy-paste prompts + partner deep link |
| [`01-fast-start.md`](01-fast-start.md) | $9 «Быстрый старт» | 5 lessons |
| [`02-flagship.md`](02-flagship.md) | $50 «AI-контент под ключ» | 3 modules + cohort |

## Design principle

Every lesson teaches through **the bot**, not raw prompting — that's the
product thesis (`docs/product-roadmap.md`: "our users are newcomers, not
pros"). Where the mentor curriculum taught manual prompt-writing in VN/Kling/
Seedance directly, these lessons route the same outcome through a one-tap
preset or campaign in `src/models.ts`, and only surface a written prompt when
teaching the "«Свой промпт»" power-user path in the flagship tier.

## Provenance

Source: `raw_data/ChatExport_2026-07-07` (Seymur Ragimov's «Мастер группа
"Нейро-Карьера"», Mar–Jul 2026), already mapped once in
`docs/mentor-course-analysis.md`. That export is thin on transcribed teaching
(the live lessons happened on Zoom, not in text) — what it contributes here:

- **Curriculum spine**: VN editing → product video → character pipeline →
  film/serial production → distribution & monetization (mentor-course-analysis
  §1) — this is the backbone of the fast-start and flagship tier structure.
  Not the exact same content: since the bot skips VN and battle-manual
  prompting, later lessons open with a "why this replaces X" callout for
  students crossing over from that path.
- **3 prompt templates** (cinematic 3D still, tokusatsu transformation shot
  breakdown, 8-frame narrator storyboard) — reused as worked examples in
  Module 2 of the flagship tier and adapted into the "«Свой промпт»" section.
- **Instagram growth formula** (hook/cover/hashtag split) — lesson 5 of the
  fast-start tier, close to verbatim (it's a formula, not prose to rewrite).
- **7-day launch playbook** — Module 3 of the flagship tier, lightly adapted
  from selling "your own AI course" to selling AI-content services generally.

Everything else — the actual step-by-step bot instructions, preset mappings,
and pricing — is authored fresh against the live product (`src/models.ts`,
`docs/pricing.md`), since the export never describes the bot at all.

## How it works (delivery, implemented)

Delivery is a **private-channel cohort invite**, not an in-chat content dump:
paying for `course_fast` or `course_flagship` (`src/models.ts` PACKS) grants
patrons like any pack, PLUS a one-time invite link into that tier's private
Telegram channel — `grantPurchase` (`src/payments.ts`) calls
`inviteToCourseCohort`, which resolves the channel id from config
(`COURSE_FAST_CHANNEL_ID` / `COURSE_FLAGSHIP_CHANNEL_ID`, `src/config.ts`) and
issues a single-use `createChatInviteLink` DM'd straight to the buyer.

**Manual prerequisite** — the Bot API cannot create Telegram channels, so
before this can actually invite anyone the owner must, per tier: create a
private Telegram group/channel, add this bot as admin with "Invite users via
link", and set the matching env var. Until that's done the purchase still
succeeds (credits granted, confirmation sent) — `inviteToCourseCohort` just
logs an error and skips the invite, it never fails or rolls back the purchase.

Actual lesson posting, homework review, and teaching inside the cohort channel
stays a **manual operation** for now, mirroring the original mentor's live
cohort model (`docs/mentor-course-analysis.md`) — the bot only opens the door.

**What's next** — a personal AI tutor that evaluates homework/prompts inside
these cohort channels is planned in ~2-3 months. `inviteToCourseCohort` was
deliberately kept as an access-only seam (it grants entry, nothing about who
or what reviews homework), so wiring the tutor in later won't require
touching `grantPurchase` at all.

## Open items before this ships as a real paid product

- [x] ~~Delivery mechanism~~ — implemented: private-channel cohort invite via
  `grantPurchase` → `inviteToCourseCohort` (see "How it works" above). Manual
  channel setup + env vars are the only remaining step, not code.
- [ ] Package the free guide as a Telegra.ph page or PDF with the partner
  deep-link (`?start=c_<code>`) baked in per `docs/course-funnel.md`. (The
  in-bot `/course` → "📖 Бесплатный гайд" callback ships the same 10 prompts
  today; Telegra.ph/PDF is for off-bot distribution.)
- [ ] Confirm current pricing against `docs/pricing.md` before publishing —
  it's mid-migration from Stars to Kaspi (KZT); lesson text below uses the
  README's rounded headline numbers (image 2 🔫, premium 11 🔫, video 25–76 🔫)
  rather than hard model-specific figures, to survive that migration.
  Re-check before print.
- [ ] Record or commission screen-capture GIFs per lesson (the mentor's own
  format was screencast-first) — text-only for now.
- [ ] Legal/IP check on the cartoon campaign (`docs/course-funnel.md`'s
  existing ⚠️ note) before using it as a lesson example in paid material.
