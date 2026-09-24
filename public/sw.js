const DATA_CACHE = "mo-data-v1";
const ICON_CACHE = "mo-icons-v1";
// v3 Pick screen offline: pages network-first (fresh grades when online, the
// last copy when not), their build assets cache-first (content-hashed).
const PICK_CACHE = "mo-pick-v1";
const ASSET_CACHE = "mo-assets-v1";
const PICK_PAGE = /^\/(?:(?:en|zh-TW|zh-CN|ja|ko)\/)?pick(?:\/[^/]+)?\/?$/;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Decisions are member-gated and rate-limited — never serve or store a cached copy.
  if (url.pathname.startsWith("/api/decision/")) return;

  if (url.pathname.startsWith("/data/")) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  if (url.origin === self.location.origin && PICK_PAGE.test(url.pathname)) {
    event.respondWith(networkFirst(request, PICK_CACHE));
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/assets/icons/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (url.pathname.startsWith("/icons/")) {
    event.respondWith(staleWhileRevalidate(request, ICON_CACHE));
    return;
  }
});

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
