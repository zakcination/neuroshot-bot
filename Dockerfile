# NeuroShot — bot (long polling) + Mini App server in one process (src/index.ts).
# Runs via tsx (the repo's `npm start`), so devDeps (tsx/typescript) are needed.
FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilt binaries for this platform; keep a toolchain as a
# fallback so `npm ci` still works if a prebuild is ever unavailable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. Keep devDeps: the app is executed by tsx.
COPY package.json package-lock.json ./
RUN npm ci

# App source + shipped assets (previews, menu media, webapp.html).
COPY . .

ENV NODE_ENV=production \
    DATABASE_PATH=/data/bot.db \
    WEBAPP_PORT=8080
EXPOSE 8080
VOLUME ["/data"]

# Liveness: the Mini App server exposes /healthz (only when WEBAPP_URL is set).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

CMD ["npm", "start"]
