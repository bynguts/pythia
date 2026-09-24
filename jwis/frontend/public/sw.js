// JWIS service worker.
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
const CACHE_NAME = "jwis-__BUILD_ID__";
const APP_SHELL = ["/", "/field", "/manifest.webmanifest", "/jwis-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
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
});

function cachePut(request, response) {
  if (response.ok) {
    // #46: stamp the cached copy with the wall-clock time of the live write
    // so a later cache fallback can surface the age of the data.
    const headers = new Headers(response.headers);
    headers.set("X-Jwis-Cached-At", new Date().toISOString());
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
    const cachedAt = headers.get("X-Jwis-Cached-At") || new Date(0).toISOString();
    headers.set("X-Jwis-Stale", "1");
    headers.set("X-Jwis-Cached-At", cachedAt);
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

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          event.waitUntil(cachePut(request, response));
          return response;
        })
        .catch(() => caches.match("/"));
    }),
  );
});
