import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The public landing page at "/" and the designed sign-in behind "Sign in".
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pythia_lang", "en"));
});

async function expectNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test("landing renders its story with one main landmark", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Waste operations,");
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Main" })).not.toContainText(/Data honesty/);
  for (const id of ["product", "how", "honesty", "faq"]) await expect(page.locator(`#${id}`)).toHaveCount(1);
  // The citywide figure is sourced (SIPSN) and says so in its tooltip.
  const citywide = page.locator('#main [data-provenance="real"]').first();
  await expect(citywide).toContainText("8,700");
  await expect(citywide).toHaveAttribute("title", /SIPSN/);
  await expect(page.getByText("Live GPS tracking is coming soon.").first()).toBeAttached();
  // Claims stay within what the data shows: trips (not trucks), no daily error band, no deployment.
  const body = page.locator("body");
  await expect(body).toContainText("1,228 trips a day");
  // The yearly queue cost comes from apps/api/data/models/queue_cost_per_year.json.
  await expect(body).toContainText("about 430,000 truck-hours a year");
  await expect(body).toContainText("about 385,000 truck-hours a year back on the road");
  await expect(body).not.toContainText(/error band|Running today|trucks a day/);
  // No on-screen provenance tags or "built on" label; provenance lives in tooltips and Settings.
  await expect(body).not.toContainText(/Model output|Real data|Open map|Built on open data/i);
});

for (const width of [1440, 390, 320]) {
  test(`landing has no horizontal overflow at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoOverflow(page);
  });
}

test("Sign in reaches the login gate and the driver link opens the driver app", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("landing-signin").click();
  await expect(page).toHaveURL(/\/app/);
  await expect(page.getByRole("heading", { name: "Sign in to Pythia" })).toBeVisible();
  await page.getByRole("link", { name: "Open the driver app" }).click();
  await expect(page).toHaveURL(/\/driver/);
});

test("the landing language switch follows the catalog", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("landing-lang").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Operasional sampah,");
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
});

test("FAQ answers open one at a time", async ({ page }) => {
  await page.goto("/");
  const first = page.getByRole("button", { name: /Does Pythia replace our dispatchers/ });
  const second = page.getByRole("button", { name: /Which data does it need/ });
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await second.click();
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await expect(first).toHaveAttribute("aria-expanded", "false");
});

test("landing text meets contrast requirements", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForTimeout(900);
  const results = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  expect(
    results.violations,
    JSON.stringify(results.violations.map(({ nodes }) => nodes.map(({ target }) => target))),
  ).toEqual([]);
});
