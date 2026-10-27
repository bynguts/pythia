// wave12 readiness and recap: the Fleet record tabs carry the morning readiness board
// (one row per truck, ready or its blockers, under the counts) and the close-of-day recap
// (recorded vs planned, gate wait, incidents, evidence gaps and the day's summary), both
// read from the real API and labelled as recorded in the app or as model output.
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
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
  await page.goto("/fleet", { waitUntil: "domcontentloaded" });
  return principal;
}

test("Reports shows the day against the plan and never invents a figure", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { token } = await signIn(page);
  const recap = await (
    await page.request.get(`${API}/recap/daily`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();

  await page.goto("/app/reports", { waitUntil: "domcontentloaded" });
  const report = page.getByTestId("reports-page");
  await expect(report).toBeVisible({ timeout: 30000 });
  await expect(report).toHaveAttribute("data-date", recap.date);
  // A figure the day has not recorded reads "—", never 0.
  const weighed = page.getByTestId("recap-actual").locator(".rp-stat-v");
  if (recap.actual.receipt_tons == null) await expect(weighed).toHaveText("—");
  // The forecast figure is a backtest (model provenance, no badge), and the chart says it is
  // the pilot fleet.
  await expect(page.getByTestId("recap-error").locator("[data-provenance=model]")).toHaveCount(1);
  await expect(page.getByTestId("reports-chart")).toContainText("Armada pilot");
  await expect(page.getByTestId("recap-summary")).toContainText("Draf");
  await expect(page.getByTestId("reports-carried")).toBeVisible();
});
