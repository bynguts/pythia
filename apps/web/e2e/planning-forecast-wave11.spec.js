// wave11 planning: Rencana reads as one flow (a stepper that follows the real state,
// three full-width stages, input beside result, at most one primary action per stage,
// a plain 7-day table and a quiet what-if), and Prediksi leads with district demand
// (no kickers, ranked flat rows, every headline number labelled with its source).
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page, path) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const principal = await response.json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

const visiblePrimaryCount = (stage) =>
  stage.evaluate(
    (el) =>
      [...el.querySelectorAll(".primary-button")].filter((button) => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }).length,
  );

test("planning stages run full width with input beside result and one primary each", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/operations/plan?**", (route) =>
    route.fulfill({
      json: {
        plan_id: "PLAN-W11",
        status: "proposed",
        assignments: [
          {
            truck_code: "T-001",
            area: "tebet",
            assigned_tons: 24,
            evidence: { capacity_tons: 24, permit_compliant: true },
          },
        ],
        unmet_reasons: [],
        total_demand_tons: 24,
        total_assigned_tons: 24,
      },
    }),
  );
  // A live 7-day outlook (the AI engine is off under test) fills the side column.
  await page.route("**/api/ai/event-forecast", (route) =>
    route.fulfill({
      json: {
        outlook: [
          { date: "2026-10-27", rainfall_mm: 12, events: [], volume_delta_pct: 14 },
          { date: "2026-10-28", rainfall_mm: 0, events: [], volume_delta_pct: 2 },
        ],
      },
    }),
  );
  await signIn(page, "/planning");
  await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 30000 });

  // The stepper follows state: forecast done, allocation is the current step.
  const steps = page.locator(".planning-progress li");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveAttribute("data-state", "done");
  await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
  await expect(steps.nth(2)).toHaveAttribute("data-state", "next");

  // Stages stack full width: no stage sits beside a longer neighbour.
  const stage1 = page.locator(".planning-stage-card.stage-01");
  const stage2 = page.locator(".planning-stage-card.stage-02");
  const [box1, box2] = [await stage1.boundingBox(), await stage2.boundingBox()];
  expect(box2.y).toBeGreaterThanOrEqual(box1.y + box1.height - 1);
  expect(Math.abs(box1.width - box2.width)).toBeLessThanOrEqual(1);

  // Inside step 01 the input and the 7-day table sit side by side.
  const main = await stage1.locator(".plan-stage-main").boundingBox();
  const side = await stage1.locator(".plan-stage-side").boundingBox();
  expect(side.x).toBeGreaterThanOrEqual(main.x + main.width - 1);

  // The 7-day outlook is a plain table, not a tinted box, and is labelled as model output.
  const outlook = stage1.locator(".ai-outlook");
  expect(await outlook.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expect(outlook.getByTestId("prov")).toHaveText("HASIL MODEL");

  // The manual what-if is a quiet disclosure, closed by default, with a 44 px summary.
  const whatIf = page.getByTestId("manual-whatif");
  await expect(whatIf).not.toHaveAttribute("open", "");
  expect((await whatIf.locator("summary").boundingBox()).height).toBeGreaterThanOrEqual(44);

  // One primary action per stage at most.
  const stage3 = page.locator(".planning-approval-stage");
  expect(await visiblePrimaryCount(stage1)).toBe(0);
  expect(await visiblePrimaryCount(stage2)).toBe(1);
  expect(await visiblePrimaryCount(stage3)).toBe(0);

  await stage2.getByRole("button", { name: "Susun Alokasi Armada" }).click();
  await expect(stage2.getByText("ID rencana: PLAN-W11")).toBeVisible();
  await expect(steps.nth(1)).toHaveAttribute("data-state", "done");
  await expect(steps.nth(2)).toHaveAttribute("aria-current", "step");
  expect(await visiblePrimaryCount(stage2)).toBe(0);
  // A dispatcher proposes; the approval belongs to a supervisor, so step 03 waits.
  expect(await visiblePrimaryCount(stage3)).toBe(0);
  await expect(stage3.getByTestId("plan-awaiting-approval")).toBeVisible();
});

test("forecast leads with ranked district demand and labels every headline number", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "/forecast");
  const workspace = page.getByTestId("forecast-workspace");
  await expect(workspace.locator(".kec-row").first()).toBeVisible({ timeout: 30000 });

  await expect(workspace.locator(".workspace-kicker, .surface-kicker")).toHaveCount(0);

  const primary = page.getByTestId("forecast-primary-analysis");
  const context = page.locator(".forecast-context-rail");
  const [primaryBox, contextBox] = [await primary.boundingBox(), await context.boundingBox()];
  expect(primaryBox.x).toBeLessThan(contextBox.x);
  expect(primaryBox.width).toBeGreaterThan(contextBox.width * 2);

  // Ranked, flat rows: rank 01 first, no bordered card per row.
  const first = primary.locator(".kec-row").first();
  await expect(first.locator(".kec-rank")).toHaveText("01");
  expect(await first.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");

  // Every metric in the strip carries a provenance label.
  const cells = workspace.getByTestId("metric-cell");
  const count = await cells.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(cells.nth(i).getByTestId("prov")).toBeVisible();
  }
});

for (const width of [320, 390]) {
  test(`planning and forecast hold at ${width} px without sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await signIn(page, "/planning");
    await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 30000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      0,
    );
    // A built plan brings the quota table: it scrolls inside its wrap, never widens the page.
    test.setTimeout(150000);
    await page.getByRole("button", { name: "Susun Alokasi Armada" }).click();
    await expect(page.getByTestId("quota-usage")).toBeVisible({ timeout: 120000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      0,
    );
    await page.goto("/forecast", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".kec-row").first()).toBeVisible({ timeout: 30000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      0,
    );
  });
}

test("an empty 7-day outlook stacks under the day's numbers instead of leaving a hole", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/ai/event-forecast", (route) => route.fulfill({ json: { outlook: [] } }));
  await signIn(page, "/planning");
  const stage1 = page.locator(".planning-stage-card.stage-01");
  await expect(stage1.getByTestId("plan-total")).toBeVisible({ timeout: 30000 });
  await expect(stage1.locator(".plan-stage-split.is-stacked")).toHaveCount(1);
  const main = await stage1.locator(".plan-stage-main").boundingBox();
  const side = await stage1.locator(".plan-stage-side").boundingBox();
  expect(side.y).toBeGreaterThanOrEqual(main.y + main.height - 1);
  await expect(stage1.locator(".plan-stage-side").getByTestId("prov")).toHaveText("HASIL MODEL");
  // The at-risk count keeps the number in the value and "of 42" as its unit.
  await expect(stage1.locator(".plan-outlook-unit")).toHaveText(/^dari \d+$/);
});
