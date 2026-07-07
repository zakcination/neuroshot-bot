/*
 * NeuroShot PWA service worker. Makes the Mini App installable + launchable
 * offline (app shell), while keeping user data always fresh:
 *   • /api/*  → network-only  (auth'd, per-user — never cached)
 *   • shell   → cache-first with background refresh
 * Bump CACHE on any shell change so old assets are evicted.
 */
const CACHE = "neuroshot-shell-v2"; // v2: premium redesign of the app shell
// Include both entry URLs — the app is reachable at "/" (rewritten to the shell)
// and at "/app" — so an offline launch from either resolves from cache.
const SHELL = ["/", "/app", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the authenticated API — always hit the network.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        // Offline: fall back to this request's cache, then the app shell for
        // navigations, so we never resolve respondWith with undefined.
        .catch(() => cached || (request.mode === "navigate" ? caches.match("/") : undefined));
      return cached || network;
    }),
  );
});
