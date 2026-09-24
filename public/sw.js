const DATA_CACHE = "mo-data-v1";
const ICON_CACHE = "mo-icons-v1";
// v3 Pick screen offline: pages network-first (fresh grades when online, the
// last copy when not), their build assets cache-first (content-hashed).
const PICK_CACHE = "mo-pick-v1";
const ASSET_CACHE = "mo-assets-v1";
const PICK_PAGE = /^\/(?:(?:en|zh-TW|zh-CN|ja|ko)\/)?pick(?:\/[^/]+)?\/?$/;
const KNOWN_CACHES = [DATA_CACHE, ICON_CACHE, PICK_CACHE, ASSET_CACHE];
// On a weak connection, fall back to the last copy instead of hanging.
const NETWORK_TIMEOUT_MS = 4000;
// Content-hashed build files pile up across deploys; keep the newest.
const ASSET_LIMIT = 400;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("mo-") && !KNOWN_CACHES.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Decisions are member-gated and rate-limited — never serve or store a cached copy.
  if (url.pathname.startsWith("/api/decision/")) return;

  if (url.pathname.startsWith("/data/")) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE, event));
    return;
  }

  // Pick pages as documents only: router prefetches and RSC data requests pass
  // through, so the cache holds the pages a visitor opened, as HTML.
  if (url.origin === self.location.origin && PICK_PAGE.test(url.pathname)) {
    if (request.headers.get("RSC") || request.headers.get("Next-Router-Prefetch")) return;
    event.respondWith(networkFirst(request, PICK_CACHE, event));
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // Icons keep their URL across patches, so refresh them in the background.
  if (url.pathname.startsWith("/icons/") || url.pathname.startsWith("/assets/icons/")) {
    event.respondWith(staleWhileRevalidate(request, ICON_CACHE, event));
    return;
  }
});

async function staleWhileRevalidate(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) return cache.put(request, response.clone()).catch(() => {}).then(() => response);
      return response;
    })
    .catch(() => cached);
  // keep the worker alive for the background refresh
  if (event) event.waitUntil(network.catch(() => {}));
  return cached || network;
}

async function networkFirst(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  let stored = Promise.resolve();
  const network = fetch(request).then((response) => {
    if (response.ok) stored = cache.put(request, response.clone()).catch(() => {});
    return response;
  });
  // a late failure after the timeout is handled below or not at all; keep the
  // worker alive until the network copy is in the cache, even after a timeout
  const settled = network.then(() => stored, () => {});
  if (event) event.waitUntil(settled);
  let timer;
  const timedOut = new Promise((resolve) => (timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS)));
  try {
    const first = await Promise.race([network, timedOut]).finally(() => clearTimeout(timer));
    if (first) return first;
    // slow network: the last copy if there is one, else keep waiting
    return (await cache.match(request, { ignoreSearch: true })) || (await network);
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
  if (response.ok) cache.put(request, response.clone()).then(() => trim(cache, ASSET_LIMIT)).catch(() => {});
  return response;
}

async function trim(cache, limit) {
  const keys = await cache.keys();
  // Cache.keys() lists entries in insertion order: drop the oldest
  await Promise.all(keys.slice(0, Math.max(0, keys.length - limit)).map((k) => cache.delete(k)));
}
