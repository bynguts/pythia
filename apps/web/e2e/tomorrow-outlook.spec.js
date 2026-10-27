// Outlook on the Tomorrow page: the week ahead (city-wide t/day with what moved each day) and
// the Bantargebang intake model's backtest (weighed vs model per month, error vs the best simple
// rule, the Lebaran split), all from /api/forecast/outlook. Next months carry a figure only
// inside the backtested horizon. The stubbed tests pin the data; the live test checks the real
// API agrees with tomorrow's forecast card.
import { expect, test } from "@playwright/test";
import { signIn } from "./lib/tomorrow.js";

function jakartaDay(offset = 0) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

function day(offset, total, drivers, beyond = false) {
  return {
    date: jakartaDay(offset),
    weekday: 0,
    total_tons: total,
    normal_tons: 8000,
    with_events_total_t: total,
    kecamatan_at_risk: 0,
    beyond_weather_forecast: beyond,
    drivers: [
      {
        kind: "weather",
        detail: { rainfall_mm: drivers.rain ?? 0 },
        effect_tons: drivers.rainEffect ?? 0,
        input_classification: beyond ? "NOT_OBSERVED" : "REAL_FORECAST_INPUT",
      },
      ...(drivers.holiday ? [{ kind: "holiday", detail: { name: drivers.holiday }, effect_tons: null }] : []),
      { kind: "weekday", detail: { weekend: Boolean(drivers.weekend) }, effect_tons: null },
    ],
    provenance: "MODEL OUTPUT",
  };
}

function withCorrection(correction, days) {
  return days.map((d) => ({
    ...d,
    corrected_tons: correction.active ? Math.round(d.total_tons * correction.factor * 10) / 10 : null,
  }));
}

const BACKTEST_ROWS = [
  { month: "2025-01", actual: 7738, model: 7594, naive: 7611, lebaran: false },
  { month: "2025-02", actual: 7704, model: 7587, naive: 7602, lebaran: false },
  { month: "2025-03", actual: 7989, model: 7878, naive: 7588, lebaran: true },
  { month: "2025-04", actual: 6857, model: 7334, naive: 7573, lebaran: true },
  { month: "2025-05", actual: 7516, model: 7524, naive: 7543, lebaran: false },
];

function outlook({ backtest = true, learned = null, months = null } = {}) {
  const correction = learned ?? { active: false, factor: 1, pct: 0, n_days: 1, min_days: 3, clamp_pct: 25 };
  return {
    learned_correction: correction,
    generated_for: jakartaDay(0),
    inputs_auto: true,
    provenance: "MODEL OUTPUT",
    week: {
      days: withCorrection(correction, [
        day(0, 8100, {}),
        day(1, 8640, { rain: 20, rainEffect: 640 }),
        day(2, 8200, { holiday: "Hari Uji" }),
        day(3, 8000, { weekend: true }),
        day(4, 8050, {}),
        day(5, 8000, {}, true),
        day(6, 8000, {}, true),
      ]),
    },
    monthly_intake: {
      available: true,
      fitted_through: "2026-04",
      backtested_horizon_months: [1, 2, 3],
      months: months ?? [
        { month: "2026-05", tons_per_day: 7311, horizon_months: 1, within_backtested_horizon: true },
        { month: "2026-06", tons_per_day: 7322, horizon_months: 2, within_backtested_horizon: true },
        { month: "2026-07", tons_per_day: 7333, horizon_months: 4, within_backtested_horizon: false },
      ],
      backtest: backtest
        ? {
            mape_model_pct: 3.87,
            mape_naive_pct: 4.61,
            period: "2022-12..2026-04",
            first_origin: "2025-01",
            last_origin: "2025-05",
            n_target_months: 5,
            target_class: "real",
            lebaran_months: ["2025-03", "2025-04"],
            lebaran_skill_pct: 38.5,
            normal_skill_pct: 0.4,
            one_month_ahead: BACKTEST_ROWS,
          }
        : null,
    },
  };
}

test("the outlook shows seven model days with drivers, today and tomorrow marked", async ({ page }) => {
  await page.route(/\/api\/forecast\/outlook(\?.*)?$/, (route) => route.fulfill({ json: outlook() }));
  await signIn(page, { lang: "en", path: "/app/tomorrow" });
  const section = page.getByTestId("tmr-outlook");
  await expect(section).toHaveAttribute("data-provenance", "model");
  await expect(section.locator(".ui-tag-model")).toHaveCount(0);
  const days = section.getByTestId("tmr-outlook-day");
  await expect(days).toHaveCount(7);
  await expect(days.nth(0)).toHaveAttribute("data-when", "today");
  await expect(days.nth(0)).toContainText("Today");
  await expect(days.nth(1)).toHaveAttribute("data-when", "tomorrow");
  await expect(days.nth(1)).toContainText("Tomorrow");
  await expect(days.nth(2)).toHaveAttribute("data-when", "");
  await expect(days.nth(1).locator(".tmr-ol-value")).toHaveText("8,640 t");
  // What moved each day reads as quiet inline text: the weather input, then calendar markers.
  await expect(days.nth(1).getByTestId("tmr-outlook-input")).toHaveText("20 mm · +8%");
  await expect(days.nth(1).getByTestId("tmr-outlook-input")).toHaveAttribute("data-kind", "rain");
  await expect(days.nth(1).getByTestId("tmr-outlook-mark")).toHaveCount(0);
  await expect(days.nth(2).getByTestId("tmr-outlook-input")).toHaveText("Dry");
  await expect(days.nth(2).getByTestId("tmr-outlook-mark")).toHaveText(["Hari Uji"]);
  await expect(days.nth(3).getByTestId("tmr-outlook-mark")).toHaveText(["Weekend"]);
  await expect(days.nth(6).getByTestId("tmr-outlook-input")).toHaveText("Dry-day baseline");
  await expect(days.nth(6).getByTestId("tmr-outlook-input")).toHaveAttribute("data-kind", "baseline");
  // No chips, no visible Model badge; provenance stays on the section.
  await expect(section.locator(".tmr-ol-chip, .ui-tag")).toHaveCount(0);
  // No sliders, inputs or what-if wording anywhere in the section.
  await expect(section.locator("input, select, [role=slider]")).toHaveCount(0);
  await expect(section).not.toContainText(/what-if/i);
});

test("the months carry the backtest evidence from the API, never a hardcoded figure", async ({ page }) => {
  await page.route(/\/api\/forecast\/outlook(\?.*)?$/, (route) => route.fulfill({ json: outlook() }));
  await signIn(page, { lang: "id", path: "/app/tomorrow" });
  // Weighed vs model for every backtested month, Lebaran months marked.
  const rows = page.getByTestId("tmr-outlook-backtest-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(3)).toContainText("Lebaran");
  await expect(rows.nth(3)).toContainText("6.857");
  await expect(rows.nth(3)).toContainText("7.334");
  await expect(page.getByTestId("tmr-outlook-backtest-readout")).toContainText(
    "tertimbang 7.516 · model 7.524 t/hari",
  );
  const evidence = page.getByTestId("tmr-outlook-evidence");
  await expect(evidence).toContainText("Teruji pada 5 bulan data timbangan nyata Bantargebang");
  await expect(evidence).toContainText("galat 3,9% vs 4,6%");
  await expect(page.getByTestId("tmr-outlook-lebaran")).toContainText(
    "Paling tajam di bulan Lebaran (diarsir): galat 38,5% lebih kecil dari aturan sederhana, 0,4% di bulan biasa",
  );
  // Only months inside the backtested horizon get a figure; the one past it is named only.
  const months = page.getByTestId("tmr-outlook-month");
  await expect(months).toHaveCount(2);
  await expect(months.nth(0)).toContainText("7.311 t/hari");
  const beyond = page.getByTestId("tmr-outlook-months-beyond");
  await expect(beyond).toHaveText("Jul 2026 terbuka begitu data timbangan Bantargebang terbaru masuk.");
  await expect(beyond).not.toContainText("7.333");
});

test("months past the backtested horizon get no figure at all", async ({ page }) => {
  const months = [
    ["2026-11", 7],
    ["2026-12", 8],
    ["2027-01", 9],
  ].map(([month, h]) => ({
    month,
    tons_per_day: 7247,
    horizon_months: h,
    within_backtested_horizon: false,
  }));
  await page.route(/\/api\/forecast\/outlook(\?.*)?$/, (route) =>
    route.fulfill({ json: outlook({ months }) }),
  );
  await signIn(page, { lang: "en", path: "/app/tomorrow" });
  await expect(page.getByTestId("tmr-outlook-backtest")).toBeVisible();
  await expect(page.getByTestId("tmr-outlook-month")).toHaveCount(0);
  const beyond = page.getByTestId("tmr-outlook-months-beyond");
  await expect(beyond).toHaveText("Nov 2026–Jan 2027 unlock as new Bantargebang weighings arrive.");
  await expect(page.getByTestId("tmr-outlook")).not.toContainText("7,247");
});

test("without a backtest the evidence reads a dash", async ({ page }) => {
  await page.route(/\/api\/forecast\/outlook(\?.*)?$/, (route) =>
    route.fulfill({ json: outlook({ backtest: false }) }),
  );
  await signIn(page, { lang: "en", path: "/app/tomorrow" });
  await expect(page.getByTestId("tmr-outlook-evidence")).toHaveText(
    "Accuracy figures appear here once the backtest has run.",
  );
  await expect(page.getByTestId("tmr-outlook-backtest")).toHaveCount(0);
});

test("the live outlook agrees with tomorrow's forecast card", async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page, { lang: "en", path: "/app/tomorrow" });
  const total = page.getByTestId("plan-total");
  await expect(total).toHaveText(/^[\d,]+ t$/, { timeout: 60000 });
  const tomorrow = page.locator("[data-testid=tmr-outlook-day][data-when=tomorrow]");
  await expect(tomorrow).toBeVisible({ timeout: 60000 });
  expect(await tomorrow.getAttribute("data-value")).toBe(await total.getAttribute("data-value"));
  await expect(page.getByTestId("tmr-outlook-day")).toHaveCount(7);
  await expect(page.getByTestId("tmr-outlook-backtest-row")).toHaveCount(23);
  await expect(page.getByTestId("tmr-outlook-evidence")).toContainText(
    "Validated on 23 months of real Bantargebang weighings",
  );
  await expect(page.getByTestId("tmr-outlook-lebaran")).toContainText("Sharpest in Lebaran months");
});

test("the outlook says when it starts learning from the weighbridge", async ({ page }) => {
  await page.route(/\/api\/forecast\/outlook(\?.*)?$/, (route) => route.fulfill({ json: outlook() }));
  await signIn(page, { lang: "en", path: "/app/tomorrow" });
  const panel = page.getByTestId("tmr-outlook-learning");
  await expect(panel).toHaveAttribute("data-active", "false");
  await expect(panel.getByTestId("tmr-outlook-learn-status")).toContainText(
    "Self-correcting from day 3 · 1 weighed so far",
  );
  await expect(panel.getByTestId("tmr-outlook-learn-correction")).toContainText("Starts on day 3");
  await expect(page.getByTestId("tmr-outlook-corrected")).toHaveCount(0);
});

test("an active correction shows its days and percent beside the raw model value", async ({ page }) => {
  const learned = { active: true, factor: 1.069, pct: 6.9, n_days: 4, min_days: 3, clamp_pct: 25 };
  await page.route(/\/api\/forecast\/outlook(\?.*)?$/, (route) =>
    route.fulfill({ json: outlook({ learned }) }),
  );
  await signIn(page, { lang: "id", path: "/app/tomorrow" });
  const panel = page.getByTestId("tmr-outlook-learning");
  await expect(panel).toHaveAttribute("data-active", "true");
  await expect(panel.getByTestId("tmr-outlook-learn-status")).toContainText(
    "Mengoreksi diri · 4 hari tertimbang",
  );
  await expect(panel.getByTestId("tmr-outlook-learn-correction")).toContainText("+6.9%");
  const tomorrow = page.locator("[data-testid=tmr-outlook-day][data-when=tomorrow]");
  await expect(tomorrow.locator(".tmr-ol-value")).toHaveText("8.640 t");
  await expect(tomorrow.getByTestId("tmr-outlook-corrected")).toHaveText("Disesuaikan 9.236 t");
});
