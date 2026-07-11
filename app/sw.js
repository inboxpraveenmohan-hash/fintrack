/* FinTrack service worker — caches only the static app shell (same-origin files) so the
   offline/local-only mode keeps working with no connection at all. It never touches
   cross-origin requests (Google auth/Drive API) — those always hit the live network,
   which is what makes cloud sync correct rather than serving stale cached data.

   Bump CACHE_NAME on every deploy that changes any cached file, or returning users will
   keep loading a stale shell until the old cache is evicted. */

const CACHE_NAME = "fintrack-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./drive-sync.js",
  "./manifest.json",
  "./lib/xlsx.full.min.js",
  "./lib/chart.umd.min.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never intercept Google/auth/API calls
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return resp;
      }).catch(() => cached);
    })
  );
});
