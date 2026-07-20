/* FinTrack service worker — caches the static app shell (same-origin files) so the
   offline/local-only mode keeps working with no connection at all. It never touches
   cross-origin requests (Google auth/Drive API) — those always hit the live network,
   which is what makes cloud sync correct rather than serving stale cached data.

   App logic files (HTML/JS) use network-first: always try the live network so a
   deploy is visible on the very next reload, falling back to the cache only when
   offline. Library files (lib/*) rarely change, so they stay cache-first to avoid
   re-downloading them every load. */

const CACHE_NAME = "fintrack-shell-v8";
const APP_FILES = [
  "./", "./index.html", "./app.js", "./tracker.html", "./tracker.js",
  "./shared.css", "./theme.js", "./drive-sync.js", "./manifest.json"
];
const LIB_FILES = ["./lib/xlsx.full.min.js", "./lib/chart.umd.min.js", "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES.concat(LIB_FILES)))
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

function isAppFile(pathname) {
  return APP_FILES.some((f) => pathname.endsWith(f.replace("./", "/")) || (f === "./" && pathname.endsWith("/")));
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never intercept Google/auth/API calls
  if (event.request.method !== "GET") return;

  if (isAppFile(url.pathname)) {
    // network-first: today's deploy wins whenever online; cache is only the offline fallback.
    // cache: "no-store" is required here — plain fetch() still honors the browser's own HTTP
    // cache (GitHub Pages serves these with a 10-minute max-age), so without this a reload
    // could silently get a stale copy from disk cache even though this code is "network-first".
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return resp;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

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
