---
name: run-neuroshot-bot
description: Build, run, and drive NeuroShot (Telegram GenAI bot + Mini App). Use when asked to start the bot, send it messages/photos/button-taps, run its tests, or screenshot/interact with the Mini App web UI.
---

NeuroShot is a Telegram bot (grammY, long polling) plus a Mini App web layer
(`public/app.html` + `src/webapp.ts`), sharing one Postgres-backed credit
ledger. **`npm start` needs a real Telegram bot token and crashes without
one** (see Gotchas) — the actual way to run and drive this project without
real credentials is two small scripts in this directory:
`driver.mjs` feeds fabricated Telegram Updates straight into the real bot
logic (no network), and `webapp-only.mjs` + `screenshot.mjs` start the Mini
App server and drive it headlessly with Playwright. Both are verified below.

All paths are relative to the repo root.

## Prerequisites

Already satisfied by a normal `npm install` on this repo (Node ≥19, `tsx` is
a devDependency). One extra, not in `package.json` on purpose (it's agent
tooling, not product code):

```bash
npm install --no-save playwright   # only needed for screenshot.mjs
npx playwright install chromium    # downloads the browser binary (~150MB), once
```

`--no-save` keeps `package.json`/`package-lock.json` untouched — verify with
`git status --short package.json package-lock.json` after, it should be empty.
(A plain `npm install` before this also regenerates an unrelated `engines`
field in `package-lock.json` on some npm versions — `git checkout --
package-lock.json` if you see that diff and didn't mean to touch it.)

`chromium-cli` is NOT installed in this environment — `screenshot.mjs` is the
documented fallback (`playwright`'s `chromium.launch()` directly).

## Run (agent path) — bot logic

`driver.mjs` sets fake `BOT_TOKEN`/`FAL_KEY`/empty `DATABASE_URL` (forces the
embedded in-memory pglite — never touches a real DB), stubs every outgoing
Telegram Bot API call and every `fal.subscribe` generation call (same pattern
`test/e2e.ts` uses), then reads scripted commands from stdin and prints the
bot's replies. State (users, credits) lives only for the process's lifetime.

```bash
npx tsx .claude/skills/run-neuroshot-bot/driver.mjs <<'EOF'
msg 1001 /start
cb 1001 claim:welcome
cb 1001 menu:photoshoot
photo 1001
cb 1001 preset:headshot
credits 1001
msg 1001 /buy
quit
EOF
```

That exact script (verified this session) walks: signup → claim the welcome
bonus → open the photoshoot menu → send a photo → apply a preset → get a
rendered result back (stubbed fal asset URL) with credits correctly deducted
(12 → 10 for a 2🔫 preset) → `/buy` showing the live Kaspi pack ladder.

| command | what it does |
|---|---|
| `msg <userId> <text>` | simulate a text message (leading `/` → treated as a bot command) |
| `photo <userId> [fileId]` | simulate sending a photo |
| `cb <userId> <data>` | simulate an inline-button tap (callback query) |
| `credits <userId>` | print the user's current patron balance |
| `raw` | dump every intercepted Bot API call so far as JSON |
| `quit` | exit |

Run interactively (not piped) if you want to improvise commands one at a
time: `npx tsx .claude/skills/run-neuroshot-bot/driver.mjs`, then type
commands and read replies as you go; `Ctrl-D` or `quit` to exit.

## Run (agent path) — Mini App (web UI)

Two steps: start the webapp-only server, then drive it with Playwright.

```bash
# 1. Start the server (backgrounded) — never calls bot.start(), so it can't
#    crash from an invalid token the way `npm start` does (see Gotchas).
nohup npx tsx .claude/skills/run-neuroshot-bot/webapp-only.mjs \
  > /tmp/webapp-only.log 2>&1 &
disown
for i in $(seq 1 30); do
  grep -q WEBAPP_READY /tmp/webapp-only.log 2>/dev/null && break
  sleep 1
done
cat /tmp/webapp-only.log   # last line: "WEBAPP_READY port=8099 token=<jwt>"

# 2. Screenshot it, authenticated as the fake user the script just created.
TOKEN=$(grep WEBAPP_READY /tmp/webapp-only.log | sed -n 's/.*token=//p')
SESSION_TOKEN="$TOKEN" WEBAPP_PORT=8099 \
  npx tsx .claude/skills/run-neuroshot-bot/screenshot.mjs /tmp/neuroshot-screenshot.png

# 3. Stop it when done.
pkill -f webapp-only.mjs
```

`screenshot.mjs` pre-seeds `localStorage["neuroshot_session"]` with the token
via `page.addInitScript` (must happen before the page's own scripts run —
`app.html` reads it on first render; a post-load `evaluate()` is too late),
then walks the real first-run flow: dismiss the onboarding carousel
(`#wskipbtn` "Пропустить" — only jumps to its LAST step, a free-credits claim
screen, not past onboarding — see Gotchas), dismiss that too ("Продолжить без
патронов"), then screenshots the actual tab-bar studio. It writes up to 3
files: `<name>-1-onboarding.png`, `<name>-2-claim-step.png`, `<name>.png`
(the final studio view) — only the ones actually shown appear.

## Run (human path)

```bash
cp .env.example .env   # fill in a REAL BOT_TOKEN (@BotFather) and FAL_KEY
npm run dev            # tsx watch — restarts on file change
```

Long polling, opens a real Telegram conversation. Useless headless without a
real token (see Gotchas) — the driver above is the way to run this without one.

## Test

```bash
npm run typecheck && npm run lint && npm run test:e2e && npm run test:webapp
```

Expect: typecheck/lint silent, `test:e2e` → "All 49 steps passed" (embedded
pglite), `test:webapp` → "All 63 web-app checks passed" (counts will grow as
the project does — these are what passed on `main` this session).

## Gotchas

- **`npm start`/`npm run dev` crash the whole process within ~2s with a fake
  `BOT_TOKEN`** — verified by actually running it. `src/index.ts` calls
  `bot.start()` without `await` or `.catch()`; internally that calls
  `deleteWebhook`, which 401s against real Telegram with an invalid token,
  and the resulting **unhandled rejection kills the entire process** — taking
  the Mini App server down with it even though it had already started
  ("Mini App server on :8099" prints, then the process dies). There is no
  way to run the real entrypoint without a genuine Telegram bot token from
  @BotFather. `driver.mjs` / `webapp-only.mjs` sidestep this entirely by
  never calling `bot.start()`.
- **Static `import` beats top-level `process.env` assignments in ESM.**
  `config.ts`/`db.ts` read env vars at import time, but ES module imports are
  evaluated before any of the importing file's own top-level statements run —
  regardless of source order. Setting `process.env.BOT_TOKEN` above a
  `import { createBot } from "../src/bot.js"` line does NOT work; it must be
  a dynamic `await import(...)` after the env is set (exactly what
  `test/e2e.ts`, `driver.mjs`, and `webapp-only.mjs` all do).
- **`readline`'s `'line'` event does not await async handlers.** Piping a
  multi-line script into a `rl.on("line", async (line) => {...})` handler
  fires every line's callback nearly simultaneously — a `quit` on the last
  line can `process.exit()` before earlier commands finish their awaits.
  Fixed in `driver.mjs` with `for await (const line of rl)`, which properly
  serializes one command at a time.
- **grammY's `InputFile` deliberately throws on `JSON.stringify`.** Any reply
  that sends a local asset (menu hero images, category preview albums via
  `sendMediaGroup`) carries an `InputFile` in its payload; naively
  `JSON.stringify`-ing a captured API call for logging throws
  `"InputFile instances must be sent via grammY"`. `driver.mjs`'s
  `printReplies` special-cases `sendMediaGroup` and wraps the generic
  fallback in try/catch.
- **The Mini App's first render is onboarding, not the tab bar.** The tab bar
  (`.tabbtn`) is already in the DOM on first load (just visually covered), so
  `waitForSelector(".tabbtn")` alone resolves instantly and does NOT prove
  it's on screen — you'll get a screenshot of the onboarding carousel instead
  if you stop there. `screenshot.mjs` clicks through onboarding → the
  claim-or-skip step → and waits for `.tabbtn` to be *visible*, not just
  present, before the final screenshot.
- **`npx playwright install chromium` alone isn't enough to `import
  "playwright"`.** It only downloads the browser binary into npx's cache; the
  `playwright` npm package itself must also be resolvable from
  `node_modules` (`npm install --no-save playwright`) for `screenshot.mjs`'s
  `import { chromium } from "playwright"` to work.
- **`file test/e2e.ts` reports "data", not "text"** (emoji-heavy source
  confuses `file`'s heuristic) — plain `grep` on it silently returns nothing;
  use `grep -a` to force text mode when grepping test files in this repo.

## Troubleshooting

- **`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/bot.js'`**:
  running the driver with plain `node` instead of `tsx` — the `src/*.ts`
  files are never compiled to `.js` in this repo (no build step); always run
  driver scripts via `npx tsx <path>`, not `node <path>`.
- **`Missing required env var BOT_TOKEN`**: a static import pulled in
  `config.ts` before your env assignment ran — see the ESM import-order
  Gotcha above; switch to dynamic `import()`.
- **`curl: (7) Failed to connect to localhost port 8099`** right after
  backgrounding `webapp-only.mjs`: it hasn't finished pglite init yet — poll
  `/tmp/webapp-only.log` for the `WEBAPP_READY` line (as the Run section
  does) instead of a fixed `sleep`. Observed startup time varied from ~5s to
  ~12s across runs in this session with no other change — give the poll loop
  real headroom (30s), not a tight one.
