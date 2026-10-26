import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn } from "./lib/tomorrow.js";

// #42, wave13: the Tomorrow forecast exposes its numbers as text (no aria-label on plain
// elements), and the page passes axe for prohibited ARIA and contrast.
test("tomorrow's forecast is readable as text and passes axe", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, { lang: "id", path: "/app/tomorrow" });
  const forecast = page.getByTestId("tmr-forecast");
  await expect(forecast.getByTestId("plan-total")).toHaveText(/^[\d.]+ t$/, { timeout: 60000 });
  await expect(page.getByTestId("plan-driver").first()).toBeVisible();
  expect(
    await page.locator(".tmr div[aria-label]:not([role]), .tmr span[aria-label]:not([role])").count(),
  ).toBe(0);

  const results = await new AxeBuilder({ page })
    .include(".tmr")
    .withRules(["aria-prohibited-attr", "color-contrast", "button-name", "label"])
    .analyze();
  const violations = results.violations.map((v) => ({
    id: v.id,
    nodes: v.nodes.map((n) => n.target.join(" ")),
  }));
  expect(violations).toEqual([]);
});
