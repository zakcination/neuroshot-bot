# Vercel + Neon — the web layer

Deploy NeuroShot's **stateless web layer** to Vercel: the Telegram Mini App, its
JSON API, and the installable PWA. It reads/writes the **same Neon database** the
bot uses, so a user's credits and gallery are identical in the bot, the in-Telegram
Mini App, and an installed home-screen app.

> The **bot** does not run here — it stays on an always-on process host
> (Docker/Fly/Railway, see [`deploy.md`](./deploy.md)) because long polling and
> multi-minute generations don't fit a stateless serverless webhook. Both point
> at the same `DATABASE_URL`.

## What runs on Vercel

| Path | Source | What it does |
|------|--------|--------------|
| `/`, `/app` | `public/app.html` | Mini App / PWA shell (static) |
| `/manifest.webmanifest`, `/sw.js`, `/icon.svg` | `public/` | PWA install + offline shell |
| `POST /api/auth` | `api/auth.ts` → `src/webapp.ts` | initData → client-agnostic session token |
| `GET /api/me` | `api/me.ts` → `src/webapp.ts` | shared state (credits, dashboard, gallery) |

The functions are thin wrappers over the same handlers the Node server uses, so
there is one implementation and the test suite (`npm run test:webapp`) covers it.

## Auth model (why an installed app works)

- **Inside Telegram**, every launch carries fresh `initData`; the client posts it
  to `/api/auth`, which HMAC-verifies it against the bot token and returns a
  short-lived **session token** (compact JWT, HS256, key derived from the bot
  token — no extra secret).
- The client caches that token and sends `Authorization: Bearer <token>` on
  subsequent calls, so the **same installed PWA / future native app keeps working
  outside Telegram**, where there is no `initData`. `/api/me` accepts either
  credential.

## Deploy

1. **Import the repo** in Vercel (New Project → this repo). No build step —
   `vercel.json` sets `outputDirectory: public` and Vercel compiles `api/*.ts`
   with its Node runtime.
2. **Environment variables** (Project → Settings → Environment Variables):
   - `BOT_TOKEN` — required (verifies initData + signs session tokens).
   - `DATABASE_URL` — your Neon **pooled** connection string
     (`…-pooler.…neon.tech/…?sslmode=require`).
   - `BOT_USERNAME` — so the app's "Пополнить" button can deep-link the bot.
   - `FAL_KEY` — the shared config requires it at import; the web layer never
     calls fal, but set it (any value) so the functions boot. Use the same key
     as the bot for simplicity.
3. **Deploy.** You get `https://<project>.vercel.app`.
4. **Register the Mini App URL**: @BotFather → your bot → Bot Settings →
   Configure Mini App → set URL to your Vercel URL. (Use the same URL for
   `WEBAPP_URL` on the bot's process host so the bot shows the 🌐 button.)

### Verify
```bash
curl -fsS https://<project>.vercel.app/manifest.webmanifest      # PWA manifest
curl -fsS -X POST https://<project>.vercel.app/api/auth           # 401 without initData (expected)
```
Open the bot → 🌐 button → the cabinet loads; on iOS Safari, "Add to Home Screen"
installs it as a standalone app.

## Notes
- **Neon pooled** connection is the right choice for serverless (many short-lived
  function invocations); the `@neondatabase/serverless` HTTP driver needs no
  connection management.
- The API responses are `Cache-Control: no-store` (per-user, auth'd); only the
  static shell is cached (by the service worker and the browser).
- A **custom domain** works the same way — add it in Vercel and register that URL
  in @BotFather instead.
