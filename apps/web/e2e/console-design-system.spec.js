// The approved console (docs/design/export-handoff) is a light sidebar
// beside the page on desktop and an off-canvas panel behind a menu button on phones; Archivo
// carries page titles and Inter the text; simulated values wear a thin label (data-provenance
// plus a tooltip), never a big badge.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page) {
  await page.goto("/");
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

test("desktop shell is a left sidebar beside the page with the top bar over the content", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/app/operations");
  const sidebar = page.locator(".cx-sidebar");
  await expect(sidebar).toBeVisible();
  const side = await sidebar.boundingBox();
  expect(side.x).toBe(0);
  expect(side.y).toBe(0);
  expect(side.width).toBeLessThan(320);

  const bar = await page.locator(".cx-topbar").boundingBox();
  expect(bar.x).toBeGreaterThanOrEqual(side.x + side.width - 1);
  expect(bar.y).toBe(0);
  const main = await page.getByRole("main").boundingBox();
  expect(main.x).toBeGreaterThanOrEqual(side.x + side.width - 1);
  expect(main.y).toBeGreaterThanOrEqual(bar.height - 1);
  await expect(page.locator(".cx-menu-toggle")).toBeHidden();
  await expect(page.getByTestId("workspace-navigation")).toBeVisible();
});

test("phones hide the sidebar behind a menu button and never scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/app/operations");
  await expect(page.getByTestId("workspace-navigation")).toBeHidden();
  const toggle = page.locator(".cx-menu-toggle");
  await expect(toggle).toBeVisible();
  const box = await toggle.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect(page.getByTestId("workspace-navigation")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Archivo and Inter load and carry page titles and text", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/app/work-orders");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          await document.fonts.ready;
          const loaded = new Set(
            [...document.fonts]
              .filter((f) => f.status === "loaded")
              .map((f) => f.family.replace(/["']/g, "")),
          );
          return ["Archivo", "Inter"].filter((family) => loaded.has(family));
        }),
      { timeout: 15000 },
    )
    .toEqual(["Archivo", "Inter"]);
  const family = (locator) => locator.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(await family(page.getByRole("main").getByRole("heading", { level: 1 }))).toMatch(/^"?Archivo"?/);
  expect(await family(page.locator(".cx-nav-item").first())).toMatch(/^"?Inter"?,/);
});

test("simulated values carry the thin label: data-provenance plus a tooltip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/app/fleet");
  const simulated = page.locator('[data-provenance="simulated"]');
  await expect(simulated.first()).toBeVisible({ timeout: 20000 });
  const titles = await simulated.evaluateAll((elements) => elements.map((element) => element.title.trim()));
  expect(titles.length).toBeGreaterThan(0);
  for (const title of titles) expect(title.length).toBeGreaterThan(0);
  await expect(page.getByText(/^SIMULASI$|^SIMULATED$/)).toHaveCount(0);
});
