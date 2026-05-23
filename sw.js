/**
 * ZoomCode - sw.js (Service Worker)
 * Offline support via cache-first strategy
 * 100% Free | No backend needed
 */

const CACHE_NAME = "zoomcode-v1";
const ASSETS = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
];

// ===== INSTALL: Cache all static assets =====
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[ZoomCode SW] Caching app shell");
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// ===== ACTIVATE: Clean old caches =====
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log("[ZoomCode SW] Deleting old cache:", key);
            return caches.delete(key);
          })
      )
    )
  );
  self.clients.claim();
});

// ===== FETCH: Cache-first for app files, Network-first for APIs =====
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API calls → always go to network (no caching of API responses in SW)
  if (
    url.hostname.includes("emkc.org") ||
    url.hostname.includes("wandbox.org") ||
    url.hostname.includes("fonts.googleapis.com") ||
    url.hostname.includes("fonts.gstatic.com")
  ) {
    event.respondWith(
      fetch(event.request).catch(() => {
        // If API fails offline, return a friendly error
        if (url.hostname.includes("emkc.org") || url.hostname.includes("wandbox.org")) {
          return new Response(
            JSON.stringify({ error: "Offline: Cannot compile without internet connection." }),
            { headers: { "Content-Type": "application/json" } }
          );
        }
      })
    );
    return;
  }

  // App shell → cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Return cached, but also update cache in background
        const networkFetch = fetch(event.request)
          .then((res) => {
            if (res && res.status === 200) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return res;
          })
          .catch(() => {});
        return cached;
      }

      // Not in cache → fetch from network
      return fetch(event.request).then((res) => {
        if (!res || res.status !== 200 || res.type !== "basic") return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      });
    })
  );
});
