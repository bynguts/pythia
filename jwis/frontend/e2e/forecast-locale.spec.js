import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";

// #68: Forecast headings, controls, section kickers, and context rail labels
// follow the selected locale.
async function signIn(page, lang) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const principal = await response.json();
  await page.evaluate(({ token, role, lang }) => {
    localStorage.setItem("jwis_auth", "true");
    localStorage.setItem("jwis_lang", lang);
    localStorage.setItem("jwis_token", token);
    localStorage.setItem("jwis_role", role);
  }, { ...principal, lang });
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function openForecast(page) {
  await page.locator(".command-nav").getByRole("button", { name: "Forecast", exact: true }).click();
  await expect(page.getByTestId("forecast-workspace")).toBeVisible();
}

test("forecast section copy follows the locale", async ({ page }) => {
  await signIn(page, "en");
  await openForecast(page);

  await expect(page.locator(".workspace-kicker")).toContainText("Demand intelligence");
  await expect(page.locator(".forecast-horizon-control .control-label")).toContainText("Analysis range");
  await expect(page.locator("#forecast-analysis-title")).toHaveText("Service demand map");
  await expect(page.locator(".forecast-primary-analysis .section-intro p")).toContainText("Rank districts by predicted load");
  await expect(page.locator(".forecast-context-rail")).toHaveAccessibleName("Forecast drivers");
  await expect(page.locator(".forecast-context-rail h2").first()).toHaveText("Trigger factors");
  await expect(page.locator("#forecast-evidence-title")).toHaveText("Forecast detail");
  await expect(page.locator(".forecast-evidence-section .section-intro p")).toContainText("validate districts");

  // Horizon control labels localize.
  await expect(page.locator(".forecast-horizon-control button").first()).toContainText("7 days");

  await page.getByTestId("lang-switch-id").click();
  await expect(page.locator(".workspace-kicker")).toContainText("Intelijen permintaan");
  await expect(page.locator(".forecast-horizon-control .control-label")).toContainText("Rentang analisis");
  await expect(page.locator("#forecast-analysis-title")).toHaveText("Peta kebutuhan layanan");
  await expect(page.locator(".forecast-context-rail")).toHaveAccessibleName("Faktor pemicu prediksi");
  await expect(page.locator("#forecast-evidence-title")).toHaveText("Rincian prediksi");
  await expect(page.locator(".forecast-horizon-control button").first()).toContainText("7 hari");
});
