// #forecast-honesty: the audit model card shows the monthly forecast against the strongest
// naive baseline on REAL data, read from the API, and labels synthetic-target resolutions.
// #w8-audit-320: the audit page holding it never overflows a 320 px phone, even when an
// imported evidence run carries long unbroken provenance.
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

async function backtest(page) {
  const res = await page.request.get(`${API}/ml/suitability`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).monthly_backtest;
}

test("model card shows real-data model vs strongest naive and labels synthetic resolutions", async ({
  page,
}) => {
  await signIn(page, "en");
  const metrics = await backtest(page);
  expect(metrics.landfill_month).toBeTruthy();

  await page.goto("/audit?lang=en", { waitUntil: "domcontentloaded" });
  const card = page.getByTestId("model-card");
  await expect(card).toBeVisible({ timeout: 15000 });

  const landfill = card.getByTestId("model-card-landfill_month");
  await expect(landfill).toContainText("Real data");
  // Numbers come from the API, not from the page source.
  const mae = Number(metrics.landfill_month.mae_model).toLocaleString("en-GB", { maximumFractionDigits: 1 });
  await expect(landfill).toContainText(`${mae} t/day`);
  await expect(landfill).toContainText("12-month average");
  const verdict = card.getByTestId("model-card-verdict-landfill_month");
  const beats = metrics.landfill_month.skill_pct > 0 && metrics.landfill_month.skill_ci90_pct[0] > 0;
  await expect(verdict).toHaveClass(beats ? /good/ : /bad/);
  await expect(verdict).toHaveText(beats ? "Beats the baseline" : "Does not beat the baseline");

  const synthetic = card.getByTestId("model-card-synthetic");
  for (const key of ["city_day", "district_day", "hotspot_rank"]) {
    await expect(synthetic.getByTestId(`model-card-synthetic-${key}`)).toContainText("Calibrated-synthetic");
  }
  await expect(synthetic.getByTestId("model-card-synthetic-hotspot_rank")).toContainText(
    "not evidence of skill",
  );
  // City-day is a sum of synthetic series: never "Reliable" anywhere in the audit view.
  await expect(page.locator("main")).not.toContainText("Reliable");
});

test("model card is localized and fits a 320 px phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await signIn(page, "id");
  // The audit page also lists imported Scentinel runs; their provenance is long unbroken
  // text (repository URL@version, run id, digest) that must wrap, not widen the page.
  const token = await page.evaluate(() => localStorage.getItem("pythia_token"));
  const runId = `e2e-wide-${Date.now()}${"x".repeat(40)}`;
  const imported = await page.request.post(`${API}/scentinel/evidence`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      manifest: {
        schema: "scentinel.run.v1",
        run_id: runId,
        source_repository: "https://github.com/alertxsto/scentinel-sensor-placement-pipeline",
        source_version: "v1.2.0",
        scenario: "tps-cilandak-compact",
        gas_set: ["ch4"],
        candidate_sensors: [{ sensor_id: "S1", lat: -6.29, lng: 106.79, rationale: "upwind boundary" }],
        execution: {
          pipeline_success: true,
          numerical_convergence: true,
          mesh_independence: true,
          mass_balance: true,
          experimental_validation: false,
          finished_at: "2026-09-24T04:00:00Z",
        },
        input_digest: "f".repeat(64),
      },
      sensor_csv: "timestamp,sensor_id,gas,ppm\n2026-09-24T04:00:01Z,S1,ch4,12.5\n",
    },
  });
  expect(imported.status()).toBe(201);
  await page.goto("/audit?lang=id", { waitUntil: "domcontentloaded" });
  const card = page.getByTestId("model-card");
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.getByTestId("model-card-landfill_month")).toContainText("Data riil");
  await expect(card.getByTestId("model-card-landfill_month")).toContainText("t/hari");
  await expect(card).toContainText("Sintetis terkalibrasi");
  await expect(page.getByText(runId)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
