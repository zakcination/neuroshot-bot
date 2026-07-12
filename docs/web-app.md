# Web layer — Telegram Mini App (and beyond)

The bot and the web app are **one product over one state**. Both read and write
the same SQLite database (credits, ledger, generations), so a user's balance and
their gallery of creations are identical whether they're in the chat or the app.
The same store later backs a public website — no content or logic is duplicated.

```
        ┌──────────────┐        ┌──────────────────┐
Telegram│  Bot (grammY)│        │ Mini App (webapp)│  ← same HTML later served
 chat   │ long polling │        │  http + initData │     as the public website
        └──────┬───────┘        └────────┬─────────┘
               │      shared writes/reads │
               └──────────► SQLite ◄───────┘
                    users · ledger · generations · events
```

## What ships here (foundation)

- **`src/webapp.ts`** — the web handlers, shared by the Node HTTP server (process
  host) and the Vercel functions in `api/`. Validates Telegram WebApp `initData`
  by HMAC against the bot token (`verifyInitData`, per Telegram spec: tampered
  hashes, foreign-token signatures and stale `auth_date` are all rejected).
- **`POST /api/auth`** — exchanges `initData` for a **client-agnostic session
  token** (`src/auth.ts`: compact JWT, HS256, key derived from the bot token).
  Called once at launch; the client caches it so an installed PWA / native app
  keeps working outside Telegram, where there is no `initData`.
- **`GET /api/me`** — returns the caller's shared state: `dashboard` (balance,
  creations, credits spent, referral earnings), `generations` (recent gallery
  with result URLs), `welcomeBonus` (`{pending, claimed}` — the claim-gated
  signup gift, see below) and `roadmap` (real "Ваш путь в NeuroShot" step
  completion — `firstPhoto`/`ownIdea`/`revivePhoto`/`scenario`/`invitedFriend`,
  computed from actual generation/event history, not a fabricated bar; see
  `roadmapProgress` in `src/db.ts`). Authenticates by `initData` **or** a
  `Bearer` session token. Opening the app onboards idempotently, same as the bot.
- **`POST /api/claim-welcome`** — the welcome flow's "🎁 Получить" tap: moves
  the parked signup + referral/partner join bonus into the spendable balance,
  exactly once (`claimWelcomeBonus`). Shared with the bot's own `claim:welcome`
  inline button — same DB function, same one-time guarantee, whichever surface
  the user claims from.
- **`public/app.html`** — the Mini App: a personal cabinet (balance, top-up,
  gallery of the user's own work, usage stats), a first-launch welcome/
  onboarding flow (currency + pricing-ladder explainer, claim CTA), and a
  "Ваш путь в NeuroShot" roadmap replacing
  the old wallet card. Completing all 5 steps unlocks a one-time gift
  (`config.roadmapBonus`, default 10 🔫, env `ROADMAP_BONUS`) — a note under
  the checklist states the reward up front, and a claim button appears once
  every step is real (`claimRoadmapBonus` in `src/db.ts`, same atomic
  claim-gating as the welcome bonus; `POST /api/claim-roadmap`). The checklist
  itself re-renders live after every finished job (`renderRoadmap` in
  `app.html`), not only on a full reload. Adapts to Telegram theme.
- **Onboarding slideshow visibility is decoupled from the welcome-bonus
  claim** (`users.onboarding_seen`, `markOnboardingSeen` in `src/db.ts`,
  `POST /api/ack-onboarding`). It pops once for every account — including
  ones that claimed or already spent their free patrons long before this
  flow existed, since `onboarding_seen` defaults `false` for every existing
  row, not just new signups — and its last slide shows a claim button only
  while there's something unclaimed to grant; otherwise it shows an
  "already received" note instead of re-offering credits. Always replayable
  on demand from the "Ещё" tab (`#moreWelcome`) regardless of the seen flag.
- **`public/manifest.webmanifest` + `public/sw.js`** — make it an **installable
  PWA**: home-screen launch, offline app shell (the auth'd API is never cached).
- **Bot integration** — a `🌐 Приложение` menu button + `/app` command +
  chat menu button, all gated on `WEBAPP_URL`. Dark until you deploy.
- Result URLs are persisted (`generations.output_url`) so the app shows the
  exact images the bot produced.

Run the process-host server by setting `WEBAPP_URL` (public HTTPS), `WEBAPP_PORT`,
`BOT_USERNAME`; or deploy the web layer to Vercel (see [`vercel.md`](./vercel.md)).
Register the URL in @BotFather → Configure Mini App. Tested by
`npm run test:webapp` (initData + session-token auth + shared-state, no Telegram
needed).

## Why this is the moat — differentiation

Competitors in this niche (VeoSee/Neuroplace-class bots) are **consumer
prompt-toys**: model-first menus, paste-a-200-word-prompt UX, no user account,
no dashboard, no B2B surface. Their own channel data shows the ceiling of that
model (engagement halved over 10 months of "все нейросети в одном боте").

NeuroShot's wedge is the opposite: a **managed creative workspace** for
marketplace sellers and small agencies. The web layer is what makes the
management features below possible — and they're exactly the surface a
chat-only competitor structurally cannot add quickly.

## Novel management features — first-player roadmap

Ordered by leverage. None of these exist in the incumbent bots today.

1. **Personal creative dashboard** — *shipped foundation.* The user sees their
   own balance, gallery, spend and referral earnings. Nobody in the niche shows
   the user their own data.
2. **Projects / collections** — organize generations into named sets
   ("Весенний каталог"), re-run a whole set with a new style.
3. **Brand kits** — save logo, palette, product reference shots; one tap applies
   consistent brand styling across every generation. The retention hook for sellers.
4. **Batch queue** — drop an album/CSV of products, get all marketplace cards in
   one managed job with progress + per-item status. Turns a toy into a tool.
5. **Team / agency workspaces** — a shared credit pool, member roles, per-member
   usage. The B2B management layer that unlocks agency revenue.
6. **Affiliate console** — live referral earnings, sub-affiliates, payout
   management (the incumbents pay referrals but expose no console).
7. **Scheduled auto-posting** — push finished content to the seller's own TG
   channel / marketplace on a calendar.
8. **Spend & ROI analytics** — cost-per-listing, forecast, model mix — for power
   sellers deciding where credits go.
9. **API keys / integrations** — wire NeuroShot into a seller's Ozon/WB listing
   flow; makes the product infrastructure, not a novelty.
10. **White-label / reseller mode** — agencies run NeuroShot under their own
    brand for clients.

The foundation (shared state + authenticated app + persisted gallery) is the
prerequisite for all ten; each becomes an additive API + page, not a rewrite.
