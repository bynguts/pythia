// #21, Tomorrow: the plan derives from the inputs on the page. Field facts are the only
// manual input: a fact that keeps a truck in the workshop takes it out of the rebuilt plan,
// the plan records the fact it applied, and the trucks KPI names the held truck. Removing
// the fact and rebuilding brings the truck back into the solver's fleet.
import { expect, test } from "@playwright/test";
import { API, freeDay, signIn } from "./lib/tomorrow.js";

test("a workshop fact takes its truck out of the rebuilt plan", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const day = await freeDay(page.request, [4, 5]);
  const token = await signIn(page, { path: `/app/tomorrow?date=${day}` });
  await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });

  const build = async (testId) => {
    const built = page.waitForResponse(
      (res) => res.url().includes("/operations/plan?") && res.request().method() === "POST",
      { timeout: 120000 },
    );
    await page.getByTestId(testId).click();
    return (await built).json();
  };
  const first = await build("tmr-build");
  const truck = first.assignments[0].truck_code;

  await page.getByTestId("tmr-fact-input").fill(`${truck} stays in the workshop`);
  await expect(page.getByTestId("tmr-fact-hold")).toBeChecked();
  const saved = page.waitForResponse((res) => res.url().endsWith("/field-facts") && res.status() === 201);
  await page.getByTestId("tmr-fact-input").press("Enter");
  const fact = await (await saved).json();
  expect(fact.effect).toEqual({ kind: "truck_unavailable", truck_code: truck });
  await expect(page.getByTestId("tmr-fact").filter({ hasText: truck })).toContainText("left out of the plan");
  await expect(page.locator(".planning-progress li").nth(1)).toContainText("1 added");

  const second = await build("tmr-rebuild");
  expect(second.plan_id).not.toBe(first.plan_id);
  expect(second.assignments.map((a) => a.truck_code)).not.toContain(truck);
  expect(second.scenario.auto_inputs.field_facts_applied).toEqual([{ fact_id: fact.id, truck_code: truck }]);
  await expect(page.locator(`[data-testid=tmr-truck-row][data-truck="${truck}"]`)).toHaveCount(0);
  await expect(page.getByTestId("tmr-kpis")).toContainText(`${truck} in workshop`);

  // The rebuilt plan replaced the first one: it was withdrawn, never left for the approver.
  const old = await page.request.get(`${API}/operations/plans/${first.plan_id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect((await old.json()).status).toBe("withdrawn");

  await page.getByRole("button", { name: `Remove fact: ${truck} stays in the workshop` }).click();
  await expect(page.getByTestId("tmr-fact")).toHaveCount(0);
  const third = await build("tmr-rebuild");
  expect(third.scenario.auto_inputs.field_facts_applied).toEqual([]);
});
