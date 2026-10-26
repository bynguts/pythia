// Outlook on the Tomorrow page: the week ahead (city-wide t/day with what moved each day) and
// the next three months of Bantargebang intake with its backtest error, all from
// /api/forecast/outlook. The stubbed tests pin the data; the live test checks the real API
// agrees with tomorrow's forecast card.
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

function outlook({ backtest = true } = {}) {
  return {
    generated_for: jakartaDay(0),
    inputs_auto: true,
    provenance: "MODEL OUTPUT",
    week: {
      days: [
        day(0, 8100, {}),
        day(1, 8640, { rain: 20, rainEffect: 640 }),
        day(2, 8200, { holiday: "Hari Uji" }),
        day(3, 8000, { weekend: true }),
        day(4, 8050, {}),
        day(5, 8000, {}, true),
        day(6, 8000, {}, true),
      ],
    },
    monthly_intake: {
      available: true,
      fitted_through: "2026-04",
      backtested_horizon_months: [1, 2, 3],
      months: [
        { month: "2026-05", tons_per_day: 7311, horizon_months: 1, within_backtested_horizon: true },
        { month: "2026-06", tons_per_day: 7322, horizon_months: 2, within_backtested_horizon: true },
        { month: "2026-07", tons_per_day: 7333, horizon_months: 4, within_backtested_horizon: false },
      ],
      backtest: backtest
        ? { mape_model_pct: 3.87, mape_naive_pct: 4.61, period: "2022-12..2026-04", target_class: "real" }
        : null,
    },
  };
}

test("the outlook shows seven model days with drivers, today and tomorrow marked", async ({ page }) => {
  await page.route(/\/api\/forecast\/outlook$/, (route) => route.fulfill({ json: outlook() }));
  await signIn(page, { lang: "en", path: "/app/tomorrow" });
  const section = page.getByTestId("tmr-outlook");
  await expect(section).toHaveAttribute("data-provenance", "model");
  await expect(section.locator(".ui-tag-model")).toHaveText("Model");
  const days = section.getByTestId("tmr-outlook-day");
  await expect(days).toHaveCount(7);
  await expect(days.nth(0)).toHaveAttribute("data-when", "today");
  await expect(days.nth(0)).toContainText("Today");
  await expect(days.nth(1)).toHaveAttribute("data-when", "tomorrow");
  await expect(days.nth(1)).toContainText("Tomorrow");
  await expect(days.nth(2)).toHaveAttribute("data-when", "");
  await expect(days.nth(1).locator(".tmr-ol-value")).toHaveText("8,640 t");
  await expect(days.nth(1).getByTestId("tmr-outlook-chip")).toHaveText(["Rain 20 mm +8%"]);
  await expect(days.nth(2).getByTestId("tmr-outlook-chip")).toHaveText(["Dry", "Hari Uji"]);
  await expect(days.nth(3).getByTestId("tmr-outlook-chip")).toHaveText(["Dry", "Weekend"]);
  await expect(days.nth(6).getByTestId("tmr-outlook-chip")).toHaveText(["No weather forecast"]);
  // No sliders, inputs or what-if wording anywhere in the section.
  await expect(section.locator("input, select, [role=slider]")).toHaveCount(0);
  await expect(section).not.toContainText(/what-if/i);
});

test("the months carry the backtest evidence from the API, never a hardcoded figure", async ({ page }) => {
  await page.route(/\/api\/forecast\/outlook$/, (route) => route.fulfill({ json: outlook() }));
  await signIn(page, { lang: "id", path: "/app/tomorrow" });
  const months = page.getByTestId("tmr-outlook-month");
  await expect(months).toHaveCount(3);
  await expect(months.nth(0)).toHaveAttribute("data-within", "true");
  await expect(months.nth(0)).toContainText("7.311 t/hari");
  await expect(months.nth(2)).toHaveAttribute("data-within", "false");
  await expect(months.nth(2)).toContainText("4 bulan setelah data");
  const evidence = page.getByTestId("tmr-outlook-evidence");
  await expect(evidence).toContainText("Galat 3,9% pada data timbangan nyata");
  await expect(evidence).toContainText("4,6%");
});

test("without a backtest the evidence reads a dash", async ({ page }) => {
  await page.route(/\/api\/forecast\/outlook$/, (route) =>
    route.fulfill({ json: outlook({ backtest: false }) }),
  );
  await signIn(page, { lang: "en", path: "/app/tomorrow" });
  await expect(page.getByTestId("tmr-outlook-evidence")).toContainText("Backtest error: —");
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
  await expect(page.getByTestId("tmr-outlook-month")).toHaveCount(3);
  await expect(page.getByTestId("tmr-outlook-evidence")).toContainText(/Error [\d.]+% on real weighing data/);
});
