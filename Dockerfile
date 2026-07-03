# NeuroShot — bot (long polling) + Mini App server in one process (src/index.ts).
# Runs via tsx (the repo's `npm start`), so devDeps (tsx/typescript) are needed.
# State is in Postgres (set DATABASE_URL) — no native modules, no local volume.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. Keep devDeps: the app is executed by tsx.
COPY package.json package-lock.json ./
RUN npm ci

# App source + shipped assets (previews, menu media, public/ PWA + app.html).
COPY . .

ENV NODE_ENV=production \
    WEBAPP_PORT=8080
EXPOSE 8080

# Liveness: probe the Mini App /healthz on WEBAPP_PORT when the web layer is on.
# In bot-only mode (no WEBAPP_URL) there is no HTTP server, so report healthy and
# let Docker's own process supervision handle liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD sh -c '[ -z "$WEBAPP_URL" ] || wget -qO- "http://127.0.0.1:${WEBAPP_PORT:-8080}/healthz" >/dev/null 2>&1'

CMD ["npm", "start"]
