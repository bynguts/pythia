// Pythia service worker.
// Cache names are build-stamped at bundle time (vite config replaces
// __BUILD_ID__), so every new deploy activates a fresh cache and `activate`
// evicts the previous one. Navigations and /index.html are NETWORK-FIRST —
// users must never be pinned to a stale build — with cache as offline
// fallback only. Hashed /assets/* are immutable by name, so cache-first is
// safe there.
//
// #50: runtime cache writes are RETURNED from cachePut and attached to the
// fetch event via event.waitUntil(), so the worker cannot terminate before
// cache.put finishes. A failed cache write is caught and logged — it must
// never fail the live response.
// "v2" bumps the name by hand as well, because the pre-cached shell below changed.
const CACHE_NAME = "pythia-v2-__BUILD_ID__";
// The driver PWA installs from /driver with its own manifests (EN/ID); their
// PNG icons are pre-cached so an offline launch keeps its home-screen icon.
const APP_SHELL = [
  "/",
  "/field",
  "/driver",
  "/manifest.webmanifest",
  "/manifest.driver.webmanifest",
  "/manifest.driver.id.webmanifest",
  "/pythia-icon.svg",
  "/pythia-icon-192.png",
  "/pythia-icon-512.png",
  "/pythia-icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  // Test-only hook (#50 verification): break cache.put so the suite can
  // prove a failed cache write does not fail the live response. Never
  // armed in normal operation — only the E2E suite posts this message.
  if (event.data === "TEST_BREAK_CACHE_PUT" && event.ports[0]) {
    self.__breakCachePut = true;
    event.ports[0].postMessage("put-broken");
  }
  // Assets the page loaded before this worker controlled it (the first visit,
  // including lazy chunks such as the fleet map) never passed through the
  // fetch handler; cache them now so they are available offline after one load.
  if (event.data?.type === "CACHE_ASSETS" && Array.isArray(event.data.urls)) {
    event.waitUntil(cacheAssets(event.data.urls));
  }
});

function isAssetUrl(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/assets/");
}

function cacheAssets(urls) {
  const assets = urls.map((raw) => new URL(raw, self.location.origin)).filter(isAssetUrl);
  return caches
    .open(CACHE_NAME)
    .then((cache) =>
      Promise.all(
        assets.map((url) =>
          cache.match(url.href).then((hit) => hit || cache.add(url.href).catch(() => null)),
        ),
      ),
    );
}

function cachePut(request, response) {
  if (response.ok) {
    // #46: stamp the cached copy with the wall-clock time of the live write
    // so a later cache fallback can surface the age of the data.
    const headers = new Headers(response.headers);
    headers.set("X-Pythia-Cached-At", new Date().toISOString());
    const copy = new Response(response.clone().body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    // Return the write promise so callers can attach it to the fetch
    // event lifetime; a rejected write is swallowed so the live response
    // is unaffected either way.
    if (self.__breakCachePut) return Promise.reject(new Error("test: cache put broken"));
    return caches
      .open(CACHE_NAME)
      .then((cache) => cache.put(request, copy))
      .catch((error) => {
        // Observable but non-fatal: the live response already succeeded.
        console.warn("[sw] cache write failed", request.url, error);
        return null;
      });
  }
  return Promise.resolve(null);
}

// #46: re-serve a cached API response with observable stale metadata —
// operators must be able to tell cache-served data from a live backend.
function serveStaleApi(request) {
  return caches.match(request).then((cached) => {
    if (!cached) return Response.json({ detail: "offline" }, { status: 503 });
    const headers = new Headers(cached.headers);
    const cachedAt = headers.get("X-Pythia-Cached-At") || new Date(0).toISOString();
    headers.set("X-Pythia-Stale", "1");
    headers.set("X-Pythia-Cached-At", cachedAt);
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Keep the worker alive until the cache write settles (#50).
          event.waitUntil(cachePut(request, response));
          return response;
        })
        .catch(() => serveStaleApi(request)),
    );
    return;
  }

  // Network-first for navigations and the shell: a deploy must reach users
  // without manual cache clearing.
  if (request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          event.waitUntil(cachePut(request, response));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/"))),
    );
    return;
  }

  // Scripts, styles and other assets: cache-first. An uncached one that cannot
  // be fetched is a network error, never the HTML shell — a module script
  // answered with HTML fails its MIME check and takes the route down with it.
  // Only navigations (above) fall back to the shell. Hashed /assets/* are
  // immutable by name, so a `Vary: Origin` from the static server (vite
  // preview sends one) must not turn a cached copy into a miss just because
  // the request that stored it and the one asking differ in their Origin header.
  event.respondWith(
    caches.match(request, { ignoreVary: isAssetUrl(url) }).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          event.waitUntil(cachePut(request, response));
          return response;
        })
        .catch(() => Response.error());
    }),
  );
});
