# Staging — a real, in-Telegram pre-prod

A second deployment of the exact same code, so "does this actually look right"
is answerable by opening the real Mini App inside Telegram — not a screenshot,
not a local dev server — without touching production.

## What it shows, by default

**`main`.** Staging is a pre-prod, not a preview fleet: its resting state is the
code that is live for users right now. Every merge redeploys it, so opening
staging always has one unambiguous answer.

A PR can **borrow** the box when you actually want to look at it — see below.

## The one rule for multiple PRs

There is one staging app, so exactly one thing can be on it at a time. Which
thing is recorded in two places that cannot disagree:

- the **`staging` label** on the PR that currently holds it (at most one PR ever
  carries it — the workflow moves it, you don't), and
- the **`🧪 STAGING` banner** in the app itself, which names the build.

A PR without the label is not on staging, no matter what any comment says. When
a PR loses the box, its comment is rewritten in place to say so — no PR is ever
left claiming to be live when it isn't.

> This replaced auto-deploy on every PR push. That was last-push-wins across
> every open PR: with a stack of PRs open, each one's "this PR is now live"
> comment stayed up forever while at most one could be true, and staging
> silently flipped between branches under you.

## Borrowing the box for a PR

**Actions → Staging → Run workflow**, set `pr_number`. That deploys the PR's
head, moves the `staging` label onto it, and comments the link.

It comes back to `main` automatically when:

- **anything lands on main** (a merge always wins — staging's job is to track
  what shipped), or
- **that PR closes**, merged or not.

To hand it back early, run the workflow with `pr_number` empty.

## Entering it

In the bot chat: **`/staging`** (admin-only, `config.adminIds`) replies with a
"🧪 Открыть тестовую сборку" button — the same `InlineKeyboard.webApp()`
mechanism `/app` uses for production, just pointed at a different URL. Telegram
renders the identical native Mini App webview either way.

## What to expect from it

|                | Production | Staging |
|---|---|---|
| Code | `main`, after green CI | `main`, or a borrowed PR |
| Bot token | real | **the same real one** |
| `FAL_KEY` | real | **the same real one — renders cost real money** |
| Database | Neon, persistent | pglite in-process |
| State lifetime | forever | **survives idle; wiped on every deploy** |
| Kaspi | live | unset — the buy flow shows "not open yet" |
| Polling Telegram | yes | **never** (`ROLE=webapp`) |

Two consequences worth internalising:

- **A deploy wipes staging.** Your balance, history and onboarding state go with
  it. That's intended — it's a test-iteration box — but it means "let me finish
  this tomorrow" doesn't work if anything merges overnight. Within a session it
  is stable: the machine no longer scales to zero, precisely so a coffee break
  doesn't reset your account (it used to, and each reset also re-granted the
  welcome bonus, which then bought renders against the real `FAL_KEY`).
- **Generations are billed for real.** Same fal.ai account as production.

## Why it shares production's bot token

Telegram signs a Mini App's `initData` with whichever bot the user actually
opened it from, so a second bot's token could not verify a session opened from
the real one. What makes sharing safe is `ROLE=webapp` (`src/index.ts`): staging
never calls `bot.start()`, never touches `setMyCommands`/`setChatMenuButton`,
never runs the CEO monitor. Telegram allows exactly **one** `getUpdates` caller
per token — see `fly.toml`'s note on the outage this caused once — so a second
poller is the one thing staging must never become.

## One-time setup

```bash
fly apps create neuroshot-bot-staging
fly secrets set -a neuroshot-bot-staging \
  BOT_TOKEN=<same token as production> \
  FAL_KEY=<same key as production> \
  BOT_USERNAME=neuroshot_ai_bot \
  ADMIN_IDS=<same as production>

# CI needs its own deploy token for this app — Fly deploy tokens are scoped
# to ONE app, so production's FLY_API_TOKEN (used by ci.yml's `deploy` job)
# cannot also push here even though it's the same Fly account.
fly tokens create deploy -a neuroshot-bot-staging
# → add the printed token as a GitHub Actions repo secret named
#   FLY_STAGING_API_TOKEN (Settings → Secrets and variables → Actions).
```

Everything else ships in `fly.staging.toml` (`ROLE=webapp`, the staging
`WEBAPP_URL`, `NODE_ENV=staging` so `db.ts` falls back to pglite,
`min_machines_running = 1`).

## Notes

- `STAGING_LABEL` is set per-deploy by the workflow and is the only thing that
  differs between a main deploy and a PR deploy. It is what the in-app banner
  renders (`ME.staging.label` via `/api/me`), and `/api/me` only exposes it for
  a `role: "webapp"` deploy — production can never accidentally show a banner.
- `staging.yml` does **not** gate on CI. Staging is for looking at in-progress
  work, so a red check doesn't block a borrow; it just means what you're looking
  at might be broken. Production deploys still require green CI.
- The workflow never interpolates a PR title or commit subject into a shell
  command — both are attacker-controlled text and the job holds a Fly deploy
  token. They travel via step outputs and `env:`.
- Deliberately no `[deploy] strategy = "immediate"` in `fly.staging.toml`
  (unlike `fly.toml`) — that setting exists solely to prevent the getUpdates
  race that `ROLE=webapp` already makes impossible here, and the default rolling
  strategy gives staging zero-downtime redeploys instead.
