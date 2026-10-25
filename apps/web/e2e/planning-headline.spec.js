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
    // Every scenario request answers with the normal day itself (no rain, no event), so
    // every district's spike against its normal day is 0% and none is at risk.
    await page.route("**/api/predictions/kecamatan?*", async (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("rainfall_mm", "0");
      url.searchParams.set("event_attendance", "0");
      url.searchParams.delete("event_lat");
      url.searchParams.delete("event_lng");
      await route.continue({ url: url.toString() });
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
