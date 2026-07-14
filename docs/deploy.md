# Deploy

One process runs both the bot (Telegram long polling — no inbound port needed)
and the Mini App server. The only thing that needs to be public is the Mini App,
which Caddy fronts with automatic HTTPS.

## Option A — Docker Compose + Caddy on a VPS (recommended)

Brings up the app + a TLS reverse proxy with one command. Fits the "runs on any
$5 VPS" design.

### Prerequisites
- A Linux VPS with Docker + Docker Compose.
- A domain (or subdomain) with a DNS **A record → your VPS IP**, e.g.
  `app.example.com`. Required for the Mini App HTTPS certificate.
- A **Postgres database** — a free Neon project works; grab its pooled
  connection string.
- `BOT_TOKEN` (@BotFather), `FAL_KEY` (fal.ai), and a **funded fal.ai balance**
  (generations fail-and-refund until topped up).

### Steps
```bash
git clone https://github.com/zakcination/neuroshot-bot.git
cd neuroshot-bot
cp .env.example .env
# edit .env — at minimum:
#   BOT_TOKEN=...            FAL_KEY=...
#   DATABASE_URL=postgresql://…-pooler.…neon.tech/…?sslmode=require
#   BOT_USERNAME=neuroshot_ai_bot
#   ADMIN_IDS=<your_tg_id[,id2,...]>
#   WEBAPP_DOMAIN=app.example.com
#   WEBAPP_URL=https://app.example.com
docker compose up -d --build
```

Then register the Mini App domain: **@BotFather → your bot → Bot Settings →
Configure Mini App → Enable / set URL → `https://app.example.com`**. (Optional:
set the chat menu button there too; the bot also sets it from `WEBAPP_URL`.)

### Verify
```bash
curl -fsS https://app.example.com/healthz      # {"ok":true}
docker compose logs -f app                      # "NeuroShot bot starting…" + "Mini App server on :8080"
```
Open the bot → `/start` shows the 🌐 button; `/app` opens the cabinet.

### Operate
- **Data** lives in your Postgres (`DATABASE_URL`) — the container is stateless.
  Back up with your provider's tooling (Neon has point-in-time restore + branch
  snapshots), or `pg_dump "$DATABASE_URL" > backup-$(date +%F).sql`.
- **Update**: `git pull && docker compose up -d --build`
- **Logs**: `docker compose logs -f app`
- **Bot only, no Mini App**: leave `WEBAPP_URL`/`WEBAPP_DOMAIN` empty and run just
  the `app` service (`docker compose up -d --build app`); the web server stays off.

## Option B — Fly.io (recommended PaaS)

Fits the app as-is: one always-on Docker VM (state in Postgres); Fly provides
the HTTPS URL (no Caddy). Config is in `fly.toml`.

**Production deploys are automatic**: the `deploy` job in
`.github/workflows/ci.yml` runs `flyctl deploy --remote-only` (using the
`FLY_API_TOKEN` repo secret) on every push to `main` that passes CI — merging
a PR to `main` ships it. The manual steps below are the one-time app bootstrap
and the fallback for local testing / deploying without going through `main`.

```bash
fly launch --no-deploy                       # or: fly apps create <name>
fly secrets set BOT_TOKEN=... FAL_KEY=... BOT_USERNAME=neuroshot_ai_bot \
  ADMIN_IDS=<your_tg_id[,id2,...]> WEBAPP_URL=https://<app>.fly.dev \
  DATABASE_URL="postgresql://…-pooler.…neon.tech/…?sslmode=require"
fly deploy
```
Then @BotFather → Configure Mini App → `https://<app>.fly.dev`. `fly.toml` pins
`min_machines_running = 1` and disables auto-stop so the long poller never pauses.

## Option C — Railway / Render (connect-the-repo)

Both build the `Dockerfile` directly — no CLI needed, deploy from the dashboard:
1. New project → Deploy from GitHub repo (this repo).
2. Set env vars: `BOT_TOKEN`, `FAL_KEY`, `DATABASE_URL` (Neon), `BOT_USERNAME`,
   `ADMIN_IDS`, `WEBAPP_URL=https://<app>.up.railway.app` (or `.onrender.com`),
   `WEBAPP_PORT=8080`. Leave `WEBAPP_DOMAIN` unset.
3. Ensure the service is **always-on** (Railway: default; Render: a paid Web
   Service — the free tier sleeps on inactivity, which breaks long polling).
4. Register `WEBAPP_URL` in @BotFather → Configure Mini App.

## Vercel + Neon — the web layer (Mini App / PWA / API)

The **stateless web layer** — the Mini App, its API (`/api/auth`, `/api/me`) and
the installable PWA — runs on Vercel serverless against Neon. This is also the
layer that lets a home-screen PWA or a future iOS app talk to the same data. See
**[`docs/vercel.md`](./vercel.md)** for the full walkthrough.

**The bot itself stays on a process host** (Docker/Fly/Railway above): it uses
long polling and each generation blocks on fal.ai for up to ~3 minutes — neither
fits a stateless serverless webhook (Vercel's max duration and Telegram's webhook
timeout both cut it off). So the production shape is **bot on a process host +
web layer on Vercel, both pointed at the same Neon `DATABASE_URL`.** A
queue-backed webhook that would let the bot run on Vercel too is future work.

## Notes
- The app is executed with `tsx` (matches `npm start`), so the image keeps
  devDeps — no build step. State is in Postgres via `DATABASE_URL`.
- Long polling means a single instance only — do **not** scale the `app` service
  to >1 replica (two pollers conflict). The Mini App server is stateless behind it.
- Before real traffic: top up fal.ai and smoke-test each model endpoint in
  `src/models.ts` (see README "Before going live").
