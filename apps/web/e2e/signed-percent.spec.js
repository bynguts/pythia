// #v3-9 (teardown v3 §9): percentages carry their own sign. A zero or negative change never
// prints "+0%" or "+-2%" in the Forecast weather panel or the Planning 7-day outlook.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(
    ({ token, role }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", "en");
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
    },
    { ...principal },
  );
}

const DRY_DAY = (date) => ({
  date,
  rainfall_mm: 0,
  precipitation_probability: 5,
  waste_impact_percent: 0,
  risk_level: "normal",
  temperature_min_c: 25,
  temperature_max_c: 32,
  operational_advice: "Normal operations.",
});

test("the weather panel prints a zero rain impact as 0%, never +0%", async ({ page }) => {
  await page.route("**/api/command-center", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.weather = {
      ...(json.weather || {}),
      forecast: ["2026-10-24", "2026-10-25", "2026-10-26"].map(DRY_DAY),
    };
    await route.fulfill({ response, json });
  });
  await signIn(page);
  await page.goto("/forecast");
  const panel = page.locator(".weather-panel");
  await expect(panel.locator(".weather-trend-row em").first()).toHaveText("0%", { timeout: 30000 });
  await expect(panel).not.toContainText("+0%");
  await expect(panel).not.toContainText("+-");
});

test("the planning outlook signs volume deltas from the printed value", async ({ page }) => {
  await page.route("**/api/ai/event-forecast", (route) =>
    route.fulfill({
      json: {
        outlook: [
          { date: "2026-10-24", rainfall_mm: 0, events: [], volume_delta_pct: 0.001 },
          { date: "2026-10-25", rainfall_mm: 0, events: [], volume_delta_pct: -2 },
          { date: "2026-10-26", rainfall_mm: 40, events: [], volume_delta_pct: 8.5 },
        ],
      },
    }),
  );
  await signIn(page);
  await page.goto("/planning");
  const cells = page.locator(".ai-outlook-table tbody td:last-child");
  await expect(cells).toHaveText(["0%", "-2%", "+8.5%"], { timeout: 30000 });
  await expect(page.locator(".ai-outlook-table")).not.toContainText("+0");
  await expect(page.locator(".ai-outlook-table")).not.toContainText("+-");
});
