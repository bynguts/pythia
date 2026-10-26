// Console pages have URLs under /app: deep links survive the login gate, nav clicks
// change the URL, browser history moves between pages, pre-console paths redirect
// with their query, "/" is the public landing (?workspace=twin still opens the twin),
// and an offline deep link falls back to the cached app shell.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function storeSession(page) {
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "en");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
}

function navLink(page, id) {
  return page.getByTestId("workspace-navigation").getByTestId(`nav-${id}`);
}

test("a deep link keeps its page through the login gate", async ({ page }) => {
  await page.goto("/app/tomorrow");
  await page.evaluate(() => localStorage.removeItem("pythia_auth"));
  await page.reload();

  // Signed out: the login gate renders in place and the URL is kept.
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page).toHaveURL(/\/app\/tomorrow$/);

  await storeSession(page);
  await page.reload();
  await expect(navLink(page, "tomorrow")).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/\/app\/tomorrow$/);
});

test("nav clicks change the URL and browser history moves between pages", async ({ page }) => {
  await page.goto("/");
  await storeSession(page);
  await page.goto("/app");

  // /app lands on Operations.
  await expect(page).toHaveURL(/\/app\/operations$/);
  await expect(navLink(page, "operations")).toHaveAttribute("aria-current", "page");

  await navLink(page, "readiness").click();
  await expect(page).toHaveURL(/\/app\/readiness$/);
  await navLink(page, "tomorrow").click();
  await expect(page).toHaveURL(/\/app\/tomorrow$/);
  await expect(navLink(page, "tomorrow")).toHaveAttribute("aria-current", "page");

  await page.goBack();
  await expect(page).toHaveURL(/\/app\/readiness$/);
  await expect(navLink(page, "readiness")).toHaveAttribute("aria-current", "page");

  await page.goForward();
  await expect(page).toHaveURL(/\/app\/tomorrow$/);

  // A reload stays on the deep-linked page; an unknown page lands on Operations.
  await page.reload();
  await expect(navLink(page, "tomorrow")).toHaveAttribute("aria-current", "page");
  await page.goto("/app/nowhere?x=1");
  await expect(page).toHaveURL(/\/app\/operations\?x=1$/);
});

test("pre-console paths redirect to their /app page with the query kept", async ({ page }) => {
  await page.goto("/");
  await storeSession(page);
  for (const [from, to] of [
    ["/fleet", /\/app\/operations$/],
    ["/planning?scenario=event", /\/app\/tomorrow\?scenario=event$/],
    ["/forecast", /\/app\/tomorrow$/],
    ["/drivers", /\/app\/fleet$/],
    ["/settings?tab=team", /\/app\/settings\?tab=team$/],
    ["/audit", /\/app\/settings\?tab=data$/],
    ["/pengawas", /\/app\/tomorrow$/],
  ]) {
    await page.goto(from);
    await expect(page, from).toHaveURL(to);
  }
});

test('"/" is the public landing and ?workspace=twin opens the briefing room', async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("pythia_auth"));
  await page.reload();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);

  await storeSession(page);
  await page.goto("/?workspace=twin");
  await expect(page).toHaveURL(/\/twin$/);
  await expect(page.getByTestId("twin-workspace")).toBeVisible();
});

test("logout clears the stored session and keeps the page URL for the next sign-in", async ({ page }) => {
  await page.goto("/");
  await storeSession(page);
  await page.goto("/app/tomorrow");
  await expect(navLink(page, "tomorrow")).toHaveAttribute("aria-current", "page");

  await page.getByTestId("profile-button").click();
  await page.getByTestId("profile-logout").click();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page).toHaveURL(/\/app\/tomorrow$/);
  const stored = await page.evaluate(() =>
    ["pythia_auth", "pythia_token", "pythia_role"].map((key) => localStorage.getItem(key)),
  );
  expect(stored).toEqual([null, null, null]);
});

test("offline navigation to a deep link falls back to the cached app shell", async ({ page, context }) => {
  await page.goto("/");
  await storeSession(page);
  await page.goto("/app/settings");
  await expect(navLink(page, "settings")).toHaveAttribute("aria-current", "page");
  // The app skips SW registration under automation; register the real worker.
  // It claims this page, and the page hands over the assets it already loaded.
  await page.evaluate(() => navigator.serviceWorker.register("/sw.js"));
  // Every startup asset (entry script, preloaded vendor chunk, stylesheets) and the
  // console chunks loaded before the worker took control are cached without a second
  // load. Polled with expect.poll: page.waitForFunction does not await an async predicate.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const assets = [
            ...document.querySelectorAll(
              'script[type="module"][src], link[rel="modulepreload"], link[rel="stylesheet"][href^="/assets/"]',
            ),
          ].map((element) => element.src || element.href);
          const lazy = performance
            .getEntriesByType("resource")
            .map((entry) => entry.name)
            .filter((name) => /\/assets\/(ConsoleShell|SettingsPage)-[^/]+\.js$/.test(name));
          if (!navigator.serviceWorker.controller || !assets.length || lazy.length < 2) return false;
          const cached = await Promise.all([...assets, ...lazy].map((url) => caches.match(url)));
          return cached.every(Boolean);
        }),
      { timeout: 15000 },
    )
    .toBe(true);

  await context.setOffline(true);
  try {
    const response = await page.goto("/app/settings", { waitUntil: "domcontentloaded" });
    expect(response?.ok() ?? true).toBeTruthy();
    await expect(navLink(page, "settings")).toHaveAttribute("aria-current", "page");
    // Only navigations fall back to the shell: an uncached script offline is a
    // network error, never the HTML shell under a .js URL.
    const uncached = await page.evaluate(() =>
      fetch(`/assets/not-cached-${Date.now()}.js`).then(
        (res) => `answered ${res.status} ${res.headers.get("content-type")}`,
        () => "network-error",
      ),
    );
    expect(uncached).toBe("network-error");
  } finally {
    await context.setOffline(false);
    await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    });
  }
});
