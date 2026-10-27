// #forecast-honesty: the one forecast backtested on real data (Bantargebang monthly intake)
// is under Settings → Data and provenance (wave13), and every month says whether it is inside the backtested
// 1–3-month horizon. The exported PDF states the assumed current-practice baseline, its
// band and the SIMULATED class instead of "all trucks at peak".
import { expect, test } from "@playwright/test";
import { buildSummaryReportHtml, queueImpactHtml } from "../src/features/forecast/summaryReport.js";

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

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

test("forecast workspace shows the backtested monthly intake with each month's horizon", async ({ page }) => {
  const res = await page.request.get(`${API}/ml/monthly-intake?months=3&start_month=${currentMonth()}`);
  expect(res.ok()).toBeTruthy();
  const api = await res.json();
  expect(api.classification).toBe("MODEL OUTPUT");
  expect(api.fitted_through).toBe("2026-04");

  await signIn(page, "en");
  await page.goto("/app/settings?tab=data&lang=en", { waitUntil: "domcontentloaded" });
  const strip = page.getByTestId("monthly-intake-strip");
  await expect(strip).toBeVisible({ timeout: 15000 });
  await expect(strip.locator("h2")).toHaveText("Bantargebang intake, monthly forecast");
  const note = strip.getByTestId("monthly-intake-note");
  await expect(note).toContainText("Data through Apr 2026 (data.go.id)");
  await expect(note).toContainText("1–3 months ahead (May 2026–Jul 2026)");
  await expect(strip.getByTestId("monthly-intake-class")).toContainText("MODEL OUTPUT");

  // Teardown v4 P2: consecutive months with the same rounded level and horizon flag
  // share one row ("data-months"), so three equal numbers never read as a broken chart.
  for (const month of api.months) {
    const row = strip.locator(`li[data-months~="${month.month}"]`);
    await expect(row).toBeVisible();
    const grouped = ((await row.getAttribute("data-months")) || "").split(" ");
    const badge = row.getByTestId("monthly-intake-horizon");
    await expect(badge).toHaveAttribute("data-within", String(month.within_backtested_horizon));
    if (grouped.length > 1) {
      const first = api.months.find((m) => m.month === grouped[0]).horizon_months;
      const last = api.months.find((m) => m.month === grouped.at(-1)).horizon_months;
      await expect(badge).toHaveText(
        month.within_backtested_horizon
          ? `${first}–${last} months ahead: inside the backtested horizon`
          : `${first}–${last} months ahead: outside the backtested horizon`,
      );
      await expect(row.locator("strong")).toContainText("≈");
    } else {
      await expect(badge).toHaveText(
        month.within_backtested_horizon
          ? `Inside the backtested horizon (month ${month.horizon_months} ahead)`
          : `Month ${month.horizon_months} ahead: outside the backtested horizon`,
      );
    }
  }
});

test("monthly intake badges follow the API flag in Indonesian", async ({ page }) => {
  await page.route("**/api/ml/monthly-intake*", (route) =>
    route.fulfill({
      json: {
        available: true,
        classification: "MODEL OUTPUT",
        fitted_through: "2026-04",
        backtested_horizon_months: [1, 2, 3],
        months: [
          { month: "2026-07", tons_per_day: 7100.4, horizon_months: 3, within_backtested_horizon: true },
          { month: "2026-08", tons_per_day: 7150.2, horizon_months: 4, within_backtested_horizon: false },
        ],
      },
    }),
  );
  await signIn(page, "id");
  await page.goto("/app/settings?tab=data&lang=id", { waitUntil: "domcontentloaded" });
  const strip = page.getByTestId("monthly-intake-strip");
  await expect(strip.getByTestId("monthly-intake-note")).toContainText("Data hingga Apr 2026 (data.go.id)", {
    timeout: 15000,
  });
  await expect(strip.getByTestId("monthly-intake-2026-07").getByTestId("monthly-intake-horizon")).toHaveText(
    "Di dalam horizon uji mundur (3 bulan ke depan)",
  );
  await expect(strip.getByTestId("monthly-intake-2026-08").getByTestId("monthly-intake-horizon")).toHaveText(
    "4 bulan ke depan: di luar horizon uji mundur",
  );
  await expect(strip.getByTestId("monthly-intake-2026-08")).toContainText("t/hari");
  await expect(strip.getByTestId("monthly-intake-class")).toContainText("HASIL MODEL");
});

test("PDF queue line states the assumed baseline, its band and the SIMULATED class", async ({ page }) => {
  const login = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const { token } = await login.json();
  const res = await page.request.get(`${API}/reports/executive-summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  const impact = data.queue_impact;
  const metric = impact.minutes_per_truck;
  const [low, high] = metric.sensitivity.baseline_band;

  const html = queueImpactHtml(impact);
  expect(html).not.toContain("all trucks at peak");
  expect(html).toContain(
    `Current-practice baseline (departures SD ${metric.baseline_departure_sd_minutes} min, assumed)`,
  );
  expect(html).toContain(`band <b>${low.toLocaleString("en-GB")}–${high.toLocaleString("en-GB")} min</b>`);
  expect(html).toContain("across SD 10–60 min");
  expect(html).toContain(`staggered <b>${impact.optimized_wait_minutes.toLocaleString("en-GB")} min</b>`);
  expect(html).toContain("SIMULATED");

  const report = buildSummaryReportHtml(data);
  expect(report).toContain(html.trim());
  expect(report).toContain("1–3 months ahead of its last observed month");
  expect(report).not.toMatch(/saat ini mencapai/);
  expect(data.summary).toContain("jam puncak model (simulasi)");
});
