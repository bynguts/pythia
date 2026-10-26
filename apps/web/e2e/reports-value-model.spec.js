// w15 value model: Reports shows the value per 1,000 gate trips from the real API, labelled
// SIMULATED x ASSUMPTION, with its low / base / high strip, the without-vs-with table and every
// parameter's rationale one tap away.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

test("Reports shows the value per 1,000 gate trips with its model label", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  const login = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const principal = await login.json();
  const model = await (
    await page.request.get(`${API}/reports/value-model`, {
      headers: { Authorization: `Bearer ${principal.token}` },
    })
  ).json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "en");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
  await page.goto("/app/reports", { waitUntil: "domcontentloaded" });

  const section = page.getByTestId("value-model");
  await expect(section).toBeVisible({ timeout: 30000 });
  await expect(section).toContainText("Value per 1,000 gate trips");
  await expect(page.getByTestId("value-model-tag")).toHaveText("Model · Simulated × assumption");
  for (const level of ["low", "base", "high"]) {
    const hours = Math.round(model.scenarios[level].queue_truck_hours_returned).toLocaleString("en-US");
    await expect(page.getByTestId(`value-model-${level}`).locator(".rp-stat-v")).toHaveText(hours);
  }
  // Low sits next to base and high in the table too, never base alone.
  const table = page.getByTestId("value-model-table");
  await expect(table.locator("thead th")).toHaveText(["Measure", "Low", "Base", "High"]);
  await expect(table.locator("tbody tr")).toHaveCount(6);
  const lowCell = table.locator("tbody tr").nth(2).locator("td").nth(1);
  await expect(lowCell).toHaveText(
    Math.round(model.scenarios.low.queue_truck_hours_returned).toLocaleString("en-US"),
  );
  await expect(table).toContainText("Idle diesel avoided (L, assumption)");
  await expect(table).toContainText(`Trips over the ${model.gate_alert_minutes}-min gate alert`);
  await expect(table).not.toContainText("Rp");

  const params = page.getByTestId("value-model-params");
  await params.locator("summary").click();
  await expect(params.locator("li")).toHaveCount(model.parameters.length);
  await expect(page.getByTestId("value-model-param-idle_fuel_l_per_h")).toContainText("Assumption");
  await expect(page.getByTestId("value-model-param-idle_fuel_l_per_h")).toContainText(
    "no source in this repository",
  );
  await expect(page.getByTestId("value-model-param-slot_adherence")).toContainText("Assumption");
  await expect(page.getByTestId("value-model-param-wait_without_min")).toContainText("Simulated");
  await expect(params).toContainText("not a field measurement");

  // a11y: the strip folds to one column at 320 px without sideways scroll.
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(section).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
