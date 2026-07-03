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
- `BOT_TOKEN` (@BotFather), `FAL_KEY` (fal.ai), and a **funded fal.ai balance**
  (generations fail-and-refund until topped up).

### Steps
```bash
git clone https://github.com/zakcination/neuroshot-bot.git
cd neuroshot-bot
cp .env.example .env
# edit .env — at minimum:
#   BOT_TOKEN=...            FAL_KEY=...
#   BOT_USERNAME=neuroshot_ai_bot
#   ADMIN_IDS=<your_tg_id>
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
- **Data** persists in the `botdata` volume (`/data/bot.db`, WAL mode). Take a
  **consistent hot backup** with SQLite's online backup (safe while the app runs —
  do not just copy `bot.db`, recent writes live in `-wal`):
  ```bash
  docker compose exec app node -e "require('better-sqlite3')('/data/bot.db').backup('/data/backup.db').then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
  docker compose cp app:/data/backup.db ./backup-$(date +%F).db
  ```
- **Update**: `git pull && docker compose up -d --build`
- **Logs**: `docker compose logs -f app`
- **Bot only, no Mini App**: leave `WEBAPP_URL`/`WEBAPP_DOMAIN` empty and run just
  the `app` service (`docker compose up -d --build app`); the web server stays off.

## Option B — Fly.io (recommended PaaS)

Fits the app as-is: one always-on Docker VM + a volume for SQLite; Fly provides
the HTTPS URL (no Caddy). Config is in `fly.toml`.

```bash
fly launch --no-deploy                       # or: fly apps create <name>
fly volumes create botdata --size 1 --region waw
fly secrets set BOT_TOKEN=... FAL_KEY=... BOT_USERNAME=neuroshot_ai_bot \
  ADMIN_IDS=<your_id> WEBAPP_URL=https://<app>.fly.dev
fly deploy
```
Then @BotFather → Configure Mini App → `https://<app>.fly.dev`. `fly.toml` pins
`min_machines_running = 1` and disables auto-stop so the long poller never pauses.

## Option C — Railway / Render (connect-the-repo)

Both build the `Dockerfile` directly — no CLI needed, deploy from the dashboard:
1. New project → Deploy from GitHub repo (this repo).
2. Add a **persistent volume/disk mounted at `/data`** (SQLite lives there).
3. Set env vars: `BOT_TOKEN`, `FAL_KEY`, `BOT_USERNAME`, `ADMIN_IDS`,
   `WEBAPP_URL=https://<app>.up.railway.app` (or `.onrender.com`), `WEBAPP_PORT=8080`.
   Leave `WEBAPP_DOMAIN` unset.
4. Ensure the service is **always-on** (Railway: default; Render: a paid Web
   Service — the free tier sleeps on inactivity, which breaks long polling).
5. Register `WEBAPP_URL` in @BotFather → Configure Mini App.

## Not a fit: Vercel / Netlify / Cloudflare Pages

These are serverless — no persistent process (long polling can't stay up) and an
ephemeral/read-only FS (SQLite won't persist). Running here needs a refactor:
switch the bot to **webhook** mode (`grammy` `webhookCallback` in a serverless
function) and move state to a **hosted DB** (e.g. Turso/libSQL, minimal change
from SQLite; or Postgres). Ask if you want that path built.

## Notes
- The app is executed with `tsx` (matches `npm start`), so the image keeps
  devDeps — no build step. `DATABASE_PATH` defaults to `/data/bot.db` in the image.
- Long polling means a single instance only — do **not** scale the `app` service
  to >1 replica (two pollers conflict). The Mini App server is stateless behind it.
- Before real traffic: top up fal.ai and smoke-test each model endpoint in
  `src/models.ts` (see README "Before going live").
