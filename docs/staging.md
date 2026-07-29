# Staging — a real, in-Telegram preview build

A second, disposable deployment of the exact same code, so "does PR #94 actually
look right" is answerable by opening the real Mini App inside Telegram — not a
screenshot, not a local dev server — without touching production.

## How it works

**One shared Fly app** (`neuroshot-bot-staging`), redeployed on every push to an
open PR by `.github/workflows/staging.yml`. Not a preview-per-PR fleet — that's
real ongoing Fly cost/complexity this project doesn't need yet. If two PRs are
open at once, staging always reflects whichever pushed most recently; the
in-app banner and the workflow's PR comment both name which one that is.

**No second bot.** Telegram signs a Mini App's `initData` with whichever bot the
user actually opened it from, so staging shares production's real `BOT_TOKEN` —
a second bot's token couldn't verify a session opened from the real one anyway.
What makes sharing the token safe is `ROLE=webapp` (`src/index.ts`): staging
never calls `bot.start()`, never touches `setMyCommands`/`setChatMenuButton`,
never runs the CEO monitor. Telegram allows exactly **one** `getUpdates` caller
per token — see `fly.toml`'s own note on the outage that caused once already —
so a second poller is the one thing staging must never become.

**No separate database.** Staging's `DATABASE_URL` is deliberately unset, so
`src/db.ts` falls back to embedded, in-memory Postgres (pglite). State resets on
every deploy/restart — nobody's real credits or history ever live here, and
there's nothing to provision.

**Enter it exactly like production**: in the bot chat, `/staging` (admin-only,
`config.adminIds`) replies with a "🧪 Открыть тестовую сборку" button — the same
`InlineKeyboard.webApp()` mechanism `/app` uses for production, just pointed at
a different URL. Telegram renders it as the identical native Mini App webview
either way.

## One-time setup

```bash
fly apps create neuroshot-bot-staging --org personal   # staging.yml also does this, idempotently
fly secrets set -a neuroshot-bot-staging \
  BOT_TOKEN=<same token as production> \
  FAL_KEY=<same key as production> \
  BOT_USERNAME=neuroshot_ai_bot \
  ADMIN_IDS=<same as production>
```

Real secrets, on purpose: initData verification needs the real `BOT_TOKEN`, and
exercising an actual generation on staging needs a real `FAL_KEY` — **that
generation costs real provider money**, same as any other fal.ai call. Kaspi
payments are unaffected either way (`KASPI_*` stays unset on staging, so the
buy flow behaves the same "not open yet" way it does in any env without it).

Nothing else to configure — `fly.staging.toml` ships everything else
(`ROLE=webapp`, the staging `WEBAPP_URL`, `auto_stop_machines` so the machine
scales to zero between visits instead of running 24/7 like production's does).

## What ships automatically (`staging.yml`)

On every `opened`/`synchronize`/`reopened` event for any open PR:
1. Checks out that PR's head commit.
2. `flyctl apps create neuroshot-bot-staging --org personal || true` (harmless
   no-op after the first run).
3. `flyctl deploy -c fly.staging.toml -a neuroshot-bot-staging --remote-only
   -e STAGING_LABEL="PR #<n> · <title>"` — the one env var that changes per
   deploy; everything else comes from `fly.staging.toml`.
4. Comments (or updates its own prior comment) on the PR with the staging URL
   and a one-line reminder to use `/staging` in the bot.

`STAGING_LABEL` is what the in-app "🧪 STAGING" banner reads (`ME.staging.label`
via `/api/me`, rendered at the very top of the Home tab in `public/app.html`) —
the whole reason it exists is so nobody has to guess which build they're
looking at, or mistakes it for production while poking at it.

## Manual redeploy

`workflow_dispatch` on `staging.yml` takes a `pr_number` input for redeploying
without a new commit (e.g. after fixing staging infra itself, not the PR's own
code).

## Notes

- CI (`ci.yml`'s `check` job) runs in parallel on the same PR events, but
  `staging.yml` does **not** gate on it — staging is for looking at
  in-progress work, so a red check doesn't block a preview. It just means what
  you're looking at might be broken; production deploys still require green CI.
- Deliberately no `[deploy] strategy = "immediate"` in `fly.staging.toml`
  (unlike `fly.toml`) — that setting exists solely to prevent the getUpdates
  race that `ROLE=webapp` already makes impossible here, and the default
  rolling strategy gives staging zero-downtime redeploys instead.
