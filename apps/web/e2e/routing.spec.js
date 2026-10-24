// Command-center workspaces have URLs: deep links survive the login gate, nav
// clicks change the URL, browser history moves between workspaces, the legacy
// ?workspace=twin entry point still opens the twin, and an offline deep link
// falls back to the cached app shell.
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
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
}

function navButton(page, name) {
  return page.getByTestId("workspace-navigation").getByRole("button", { name, exact: true });
}

test("a deep link keeps its workspace through the login form", async ({ page }) => {
  await page.goto("/forecast");
  await page.evaluate(() => {
    localStorage.removeItem("pythia_auth");
    localStorage.setItem("pythia_lang", "id");
  });
  await page.reload();

  // Signed out: the login gate renders in place and the URL is kept.
  await expect(page.getByRole("heading", { name: "Masuk ke pusat kendali" })).toBeVisible();
  await expect(page).toHaveURL(/\/forecast$/);

  await page.getByLabel("Nama pengguna").fill("dispatcher");
  await page.getByLabel("Kata sandi", { exact: true }).fill("dispatcher-demo-pass");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();

  await expect(page.getByTestId("forecast-workspace")).toBeVisible();
  await expect(page).toHaveURL(/\/forecast$/);
  await expect(navButton(page, "Prediksi")).toHaveAttribute("aria-current", "page");
});

test("nav clicks change the URL and browser history moves between workspaces", async ({ page }) => {
  await page.goto("/");
  await storeSession(page);
  await page.reload();

  // "/" lands on the fleet workspace.
  await expect(page).toHaveURL(/\/fleet$/);
  await expect(page.getByTestId("fleet-workspace")).toBeVisible();

  await navButton(page, "Prediksi").click();
  await expect(page).toHaveURL(/\/forecast$/);
  await expect(page.getByTestId("forecast-workspace")).toBeVisible();

  await navButton(page, "Rencana").click();
  await expect(page).toHaveURL(/\/planning$/);
  await expect(navButton(page, "Rencana")).toHaveAttribute("aria-current", "page");

  await page.goBack();
  await expect(page).toHaveURL(/\/forecast$/);
  await expect(page.getByTestId("forecast-workspace")).toBeVisible();
  await expect(navButton(page, "Prediksi")).toHaveAttribute("aria-current", "page");

  await page.goForward();
  await expect(page).toHaveURL(/\/planning$/);
  await expect(navButton(page, "Rencana")).toHaveAttribute("aria-current", "page");

  // A reload stays on the deep-linked workspace.
  await page.reload();
  await expect(navButton(page, "Rencana")).toHaveAttribute("aria-current", "page");
});

test("the legacy ?workspace=twin entry point opens the twin", async ({ page }) => {
  await page.goto("/");
  await storeSession(page);
  await page.goto("/?workspace=twin");

  await expect(page).toHaveURL(/\/twin$/);
  await expect(page.getByTestId("twin-workspace")).toBeVisible();
  await expect(navButton(page, "Kembaran Digital")).toHaveAttribute("aria-current", "page");
});

test("logout clears the stored session and keeps the workspace URL for the next sign-in", async ({
  page,
}) => {
  await page.goto("/");
  await storeSession(page);
  await page.goto("/planning");
  await expect(navButton(page, "Rencana")).toHaveAttribute("aria-current", "page");

  await page.locator(".command-logout").click();
  await expect(page.getByRole("heading", { name: "Masuk ke pusat kendali" })).toBeVisible();
  await expect(page).toHaveURL(/\/planning$/);
  const stored = await page.evaluate(() =>
    ["pythia_auth", "pythia_token", "pythia_role"].map((key) => localStorage.getItem(key)),
  );
  expect(stored).toEqual([null, null, null]);
});

test("offline navigation to a deep link falls back to the cached app shell", async ({ page, context }) => {
  await page.goto("/");
  await storeSession(page);
  await page.reload();
  // First visit: the fleet map's lazy chunk loads before any worker exists.
  await expect(page.getByTestId("fleet-workspace")).toBeVisible();
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => /\/assets\/LiveFleetMap-[^/]+\.js$/.test(entry.name)),
  );
  // The app skips SW registration under automation; register the real worker.
  // It claims this page, and the page hands over the assets it already loaded.
  await page.evaluate(() => navigator.serviceWorker.register("/sw.js"));
  // Every startup asset (entry script, preloaded vendor chunk, stylesheets) and
  // the lazy chunk loaded before the worker took control are cached without a
  // second load. Polled with expect.poll: page.waitForFunction does not await an
  // async predicate, so its returned Promise counted as "ready" at once and the
  // test went offline before anything was cached (the old intermittent failure).
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
            .filter((name) => /\/assets\/LiveFleetMap-[^/]+\.js$/.test(name));
          if (!navigator.serviceWorker.controller || !assets.length || !lazy.length) return false;
          const cached = await Promise.all([...assets, ...lazy].map((url) => caches.match(url)));
          return cached.every(Boolean);
        }),
      { timeout: 15000 },
    )
    .toBe(true);

  await context.setOffline(true);
  try {
    const response = await page.goto("/forecast", { waitUntil: "domcontentloaded" });
    expect(response?.ok() ?? true).toBeTruthy();
    await expect(page.getByTestId("forecast-workspace")).toBeVisible();
    await expect(navButton(page, "Prediksi")).toHaveAttribute("aria-current", "page");
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
