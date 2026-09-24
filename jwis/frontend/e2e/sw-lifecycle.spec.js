import { expect, test } from "@playwright/test";

/**
 * #48: service-worker lifecycle coverage against the production build —
 * first install, controlled reload, offline /field and /driver navigation,
 * cache-version cleanup on update, and update activation.
 *
 * The app skips SW registration under automation (route-stub determinism),
 * so each test starts from an empty CacheStorage and no registration, then
 * registers the real /sw.js explicitly.
 */

async function cleanSlate(page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  });
}

async function installWorker(page) {
  await page.evaluate(() => navigator.serviceWorker.register("/sw.js"));
  await page.waitForFunction(
    async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.some((r) => r.active !== null);
    },
    { timeout: 15000 },
  );
}

test("first install caches the app shell and controls subsequent loads", async ({ page }) => {
  await cleanSlate(page);

  // Before install: no registration, no caches.
  const before = await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length === 0));
  expect(before).toBe(true);

  await installWorker(page);

  // Install pre-caches the app shell entries.
  const shellCached = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    return Promise.all(["/", "/field", "/manifest.webmanifest", "/jwis-icon.svg"].map((p) => cache.match(p).then(Boolean)));
  });
  expect(shellCached).toEqual([true, true, true, true]);

  // A reload is SW-controlled and still renders the application shell.
  await page.reload({ waitUntil: "domcontentloaded" });
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  expect(controlled).toBe(true);
  await expect(page.locator("main, #root").first()).toBeVisible();
});

test("offline navigation serves /field and /driver from the app shell", async ({ page, context }) => {
  await cleanSlate(page);
  await installWorker(page);
  await page.reload({ waitUntil: "domcontentloaded" });

  // Drop all network while the SW stays in control.
  await context.setOffline(true);

  for (const path of ["/field", "/driver"]) {
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(response?.ok() ?? true).toBeTruthy();
    // Rendered application content, not just a successful navigation.
    await expect(page.locator("main")).toBeVisible();
  }

  await context.setOffline(false);
});

test("a new build version replaces the old cache on activation", async ({ page }) => {
  await cleanSlate(page);
  await installWorker(page);
  await page.reload({ waitUntil: "domcontentloaded" });

  const liveName = (await page.evaluate(() => caches.keys()))[0];
  expect(liveName).toBeTruthy();

  // Simulate a stale cache version left by a previous build: the activate
  // handler must evict every cache that does not match the current
  // build-stamped CACHE_NAME.
  await page.evaluate(() => caches.open("jwis-stale-previous-build").then((c) => c.put("/", Response.json({ stale: true }))));
  await page.evaluate(() => navigator.serviceWorker.register("/sw.js?v=next-build"));
  await page.waitForFunction(
    async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.some((r) => r.active?.scriptURL.includes("v=next-build"));
    },
    { timeout: 15000 },
  );

  // Activation evicts the previous version's cache but keeps the live one.
  const keys = await page.evaluate(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const names = await caches.keys();
      if (!names.includes("jwis-stale-previous-build")) return names;
      await new Promise((r) => setTimeout(r, 250));
    }
    return await caches.keys();
  });
  expect(keys).not.toContain("jwis-stale-previous-build");
  expect(keys).toContain(liveName);
});
