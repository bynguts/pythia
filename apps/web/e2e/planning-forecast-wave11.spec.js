// wave11 planning, wave13 Tomorrow: product, not lab. The page has no sliders or number
// inputs (the field-fact box is the only thing typed), the stepper follows the real state,
// one primary action shows at a time, and every modelled or simulated figure carries its
// thin label: a Model tag where the design shows one, data-provenance plus a tooltip.
import { expect, test } from "@playwright/test";
import { freeDay, signIn } from "./lib/tomorrow.js";

test("tomorrow has no manual what-if and follows the plan's state", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const day = await freeDay(page.request, [4, 5]);
  await signIn(page, { lang: "id", path: `/app/tomorrow?date=${day}` });
  await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });

  // No sliders anywhere; the one text input is the field fact.
  await expect(page.locator(".tmr input[type=range], .tmr input[type=number], .tmr select")).toHaveCount(0);
  await expect(page.locator(".tmr input[type=text], .tmr textarea")).toHaveCount(1);
  await expect(page.getByTestId("tmr-fact-input")).toBeVisible();

  // Before a plan: forecast done, field facts is the current step; one primary action.
  const steps = page.locator(".planning-progress li");
  await expect(steps.nth(0)).toHaveClass(/is-done/);
  await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
  await expect(page.locator(".tmr .ui-btn-primary:visible")).toHaveCount(1);

  // The day's drivers are model output; the weekday is always among them.
  const forecast = page.getByTestId("tmr-forecast");
  await expect(forecast).toHaveAttribute("data-provenance", "model");
  await expect(forecast.locator(".ui-tag-model")).toHaveText("Model");
  await expect(page.locator("[data-testid=plan-driver][data-kind=weekday], [data-kind=holiday]")).toHaveCount(
    1,
  );

  await page.getByTestId("tmr-build").click();
  await expect(page.getByTestId("tmr-truck-table")).toBeVisible({ timeout: 120000 });
  await expect(steps.nth(2)).toContainText(/CP-SAT/);
  await expect(page.locator(".tmr .ui-btn-primary:visible")).toHaveCount(
    await page.getByTestId("tmr-submit").count(),
  );

  // Thin labels: simulated fleet figures say so in a tooltip, the queue model is tagged.
  const trucks = page.getByTestId("tmr-kpi-trucks").locator("..");
  await expect(trucks).toHaveAttribute("data-provenance", "simulated");
  await expect(trucks).toHaveAttribute("title", "Armada pilot simulasi");
  await expect(page.getByTestId("tmr-kpi-queue").locator("..").locator(".ui-tag-model")).toHaveText("Model");
  await expect(page.locator(".tmr")).not.toContainText(/SIMULASI|SIMULATED/);
  await expect(page.locator(".tmr")).not.toContainText(/\blive\b|langsung/i);
});
