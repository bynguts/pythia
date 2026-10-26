import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// wave13 lane L: the public landing page at "/" and the designed sign-in behind "Sign in".
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
  for (const id of ["product", "how", "honesty", "faq"]) await expect(page.locator(`#${id}`)).toHaveCount(1);
  // The modelled citywide figure is labelled as a model estimate, never presented as measured.
  await expect(page.getByText("8,500 t is Pythia's modelled estimate")).toBeVisible();
  await expect(page.getByText("Live GPS tracking is coming soon.").first()).toBeAttached();
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
