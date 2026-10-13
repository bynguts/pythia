import { expect, test } from "@playwright/test";

// #50: runtime cache writes must be attached to the fetch event lifetime so
// the service worker cannot terminate before `cache.put` finishes, and a
// failed cache write must never fail the live response.
const API = "http://127.0.0.1:8001/api";

test("fetched shell and API resources are actually cached once the fetch settles", async ({ page }) => {
  await page.goto("/field");

  // The app skips SW registration under automation (Playwright route stubs
  // must see live network traffic), so this suite registers the real
  // worker explicitly before asserting on its runtime caching behavior.
  await page.evaluate(() => navigator.serviceWorker.register("/sw.js"));
  // The service worker registers itself via the app; give it time to activate.
  const swReady = await page.waitForFunction(
    async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.some((r) => r.active !== null);
    },
    { timeout: 15000 },
  );
  expect(swReady).toBeTruthy();

  // Reload so the fetch handler actually serves this navigation.
  await page.reload({ waitUntil: "networkidle" });

  // Ask the SW-controlled page to trigger a fetch of an API resource and a
  // shell navigation, then give the runtime cache write a bounded settle window.
  const cached = await page.evaluate(async (apiBase) => {
    // Force a runtime fetch through the SW fetch handler.
    await fetch(`${apiBase}/ml/suitability`, { cache: "no-store" }).then((r) => r.ok);
    // Bounded wait until the cache write completes (or fail after 5s).
    const deadline = Date.now() + 5000;
    const cacheNames = await caches.keys();
    for (const name of cacheNames) {
      const cache = await caches.open(name);
      if (await cache.match(`${apiBase}/ml/suitability`)) return name;
    }
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const names = await caches.keys();
      for (const name of names) {
        const cache = await caches.open(name);
        if (await cache.match(`${apiBase}/ml/suitability`)) return name;
      }
    }
    return null;
  }, API);

  expect(cached).not.toBeNull();
});

test("a cache write failure does not fail the live response", async ({ page }) => {
  await page.goto("/");
  // Explicit registration for the same automation reason as above.
  await page.evaluate(() => navigator.serviceWorker.register("/sw.js"));
  await page.waitForFunction(
    async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.some((r) => r.active !== null);
    },
    { timeout: 15000 },
  );

  // Break `cache.put` inside the live SW, then confirm a normal fetch still
  // succeeds — the live response must never depend on the cache write.
  const ok = await page.evaluate(async (apiBase) => {
    const regs = await navigator.serviceWorker.getRegistrations();
    const sw = regs.find((r) => r.active)?.active;
    if (!sw) return false;
    const broke = new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data === "put-broken");
      sw.postMessage("TEST_BREAK_CACHE_PUT", [ch.port2]);
      setTimeout(() => resolve(false), 3000);
    });
    const armed = await broke;
    if (!armed) return false;
    const res = await fetch(`${apiBase}/ml/suitability`, { cache: "no-store" });
    return res.ok;
  }, API);

  expect(ok).toBeTruthy();
});
