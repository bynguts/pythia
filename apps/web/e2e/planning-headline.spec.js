// #N2-N3 (teardown v3): the Planning executive summary says "{district} needs additional
// capacity" only when a district is really at risk (>= 10% above its normal day, the shared
// engine.spike_risk classes), and the queue "before" column is the assumed current practice,
// never "all trucks at peak".
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page, lang) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(
    ({ token, role, lang }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
    },
    { ...principal, lang },
  );
}

const COPY = {
  id: {
    neutral: "Tidak ada wilayah yang diprakirakan ≥ 10% di atas hari normalnya (hasil model).",
    stale: /semua truk saat jam puncak|membutuhkan tambahan kapasitas|\+-/,
    baseline: /^Praktik saat ini \(keberangkatan SD [\d.,]+ menit, asumsi\)$/,
  },
  en: {
    neutral: "No district is forecast ≥ 10% above its normal day (model output).",
    stale: /all trucks at peak|needs additional capacity|\+-/,
    baseline: /^Current practice \(departures SD [\d.,]+ min, assumed\)$/,
  },
};

for (const lang of ["id", "en"]) {
  test(`a scenario with no district at risk gets a neutral headline (${lang})`, async ({ page }) => {
    const copy = COPY[lang];
    // Teardown v4 R1: Rencana reads /api/baseline/scenario. Answer with the real outlook
    // but every kecamatan at its normal day, so none is at risk and no truck is extra.
    await page.route("**/api/baseline/scenario?*", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const row of body.kecamatan) {
        row.predicted_tons = row.normal_tons;
        row.spike_percent = 0;
        row.risk_level = "normal";
      }
      body.kecamatan_at_risk = 0;
      body.recommendation = {
        ...body.recommendation,
        extra_trucks_needed: 0,
        deployable_trucks: 0,
        shortfall_trucks: 0,
      };
      await route.fulfill({ response, json: body });
    });
    await signIn(page, lang);
    await page.goto("/planning");
    await expect(page.getByTestId("planning-workspace")).toBeVisible({ timeout: 30000 });
    const headline = page.getByTestId("exec-headline");
    await expect(headline).toHaveText(copy.neutral, { timeout: 30000 });
    const summary = page.locator(".planning-summary");
    await expect(summary).not.toContainText(copy.stale);
    await expect(page.getByTestId("exec-impact-baseline")).toHaveText(copy.baseline, { timeout: 30000 });
  });
}
