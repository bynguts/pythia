import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn } from "./lib/tomorrow.js";

// #37, wave13: the Tomorrow page's headings follow a contiguous outline (h1 → h2 → h3, no
// skipped levels) independent of visual styling.
test("tomorrow headings follow a contiguous outline and pass axe", async ({ page }) => {
  await signIn(page, { lang: "id", path: "/app/tomorrow" });
  await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId("tmr-alloc-loading")).toHaveCount(0, { timeout: 30000 });

  const levels = await page
    .locator(".tmr h1, .tmr h2, .tmr h3, .tmr h4, .tmr h5, .tmr h6")
    .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))));
  expect(levels.length).toBeGreaterThan(1);
  expect(levels[0]).toBe(1);
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i], `heading ${i} jumps from h${levels[i - 1]} to h${levels[i]}`).toBeLessThanOrEqual(
      levels[i - 1] + 1,
    );
  }

  const results = await new AxeBuilder({ page }).include(".tmr").withRules(["heading-order"]).analyze();
  expect(results.violations).toEqual([]);
});
