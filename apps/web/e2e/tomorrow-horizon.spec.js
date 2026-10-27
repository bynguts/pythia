// Outlook horizon on the Tomorrow page: the 7 / 14 / 30-day switch, the horizon summary (total,
// average, peak day, trucks at the peak) and the daily chart with the days past the weather
// window marked, plus the "learns from the weighbridge" panel. Stubbed tests pin the data at
// 1440 and 390 px; the live test checks the real API's 30 days add up.
import { expect, test } from "@playwright/test";
import { signIn } from "./lib/tomorrow.js";

const ROUTE = /\/api\/forecast\/outlook(\?.*)?$/;

function jakartaDay(offset = 0) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

const WAITING = {
  active: false,
  factor: 1,
  pct: 0,
  n_days: 0,
  min_days: 3,
  window_days: 14,
  clamp_pct: 25,
  since: null,
  last_day: null,
  classification: "LEARNED_FROM_OBSERVED",
};

// Day i: 8,000 t + 10 t a day, the peak on day 9 (8,600 t); Open-Meteo covers days 0–15 (forecast_days=16).
function outlookFor(n, learned = WAITING) {
  const factor = learned.active ? learned.factor : null;
  const adjust = (v) => (factor ? Math.round(v * factor * 10) / 10 : null);
  const days = Array.from({ length: n }, (_, i) => {
    const total = i === 9 ? 8600 : 8000 + i * 10;
    const beyond = i >= 16;
    return {
      date: jakartaDay(i),
      weekday: 0,
      total_tons: total,
      normal_tons: 8000,
      with_events_total_t: total,
      kecamatan_at_risk: 0,
      beyond_weather_forecast: beyond,
      corrected_tons: adjust(total),
      drivers: [
        {
          kind: "weather",
          detail: { rainfall_mm: 0 },
          effect_tons: 0,
          input_classification: beyond ? "NOT_OBSERVED" : "REAL_FORECAST_INPUT",
        },
        { kind: "weekday", detail: { weekend: false }, effect_tons: null },
      ],
      provenance: "MODEL OUTPUT",
    };
  });
  const totals = days.map((d) => d.total_tons);
  const total = Math.round(totals.reduce((a, b) => a + b, 0) * 10) / 10;
  const avg = Math.round((total / n) * 10) / 10;
  const peak = totals.indexOf(Math.max(...totals));
  return {
    generated_for: jakartaDay(0),
    inputs_auto: true,
    horizon_days: n,
    horizons_available: [7, 14, 30],
    provenance: "MODEL OUTPUT",
    learned_correction: learned,
    week: {
      days,
      horizon_days: n,
      summary: {
        total_tons: total,
        avg_tons_per_day: avg,
        peak_date: days[peak].date,
        peak_tons: totals[peak],
        peak_trucks_needed: 499,
        truck_capacity_tons: 18,
        days_with_weather_forecast: Math.min(n, 16),
        days_beyond_weather_forecast: Math.max(0, n - 16),
        corrected_total_tons: adjust(total),
        corrected_avg_tons_per_day: adjust(avg),
        corrected_peak_tons: adjust(totals[peak]),
        provenance: "MODEL OUTPUT",
      },
    },
    monthly_intake: { available: false, months: [], backtest: null },
  };
}

async function stub(page, learned) {
  await page.route(ROUTE, (route) => {
    const n = Number(new URL(route.request().url()).searchParams.get("days") || 7);
    return route.fulfill({ json: outlookFor(n, learned) });
  });
}

for (const width of [1440, 390]) {
  test(`the outlook switches 7 → 14 → 30 days at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stub(page);
    await signIn(page, { lang: "en", path: "/app/tomorrow" });
    const section = page.getByTestId("tmr-outlook");
    const seven = section.getByTestId("tmr-outlook-horizon-7");
    const fourteen = section.getByTestId("tmr-outlook-horizon-14");
    const thirty = section.getByTestId("tmr-outlook-horizon-30");
    await expect(seven).toHaveAttribute("aria-pressed", "true");
    await expect(section.getByRole("group", { name: "Forecast horizon" })).toBeVisible();
    for (const button of [seven, fourteen, thirty]) {
      const box = await button.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }

    // 7 days: the day cards, the week's summary, every day inside the weather window.
    await expect(section.getByTestId("tmr-outlook-days-heading")).toHaveText(
      "Next 7 days · city-wide, t/day",
    );
    await expect(section.getByTestId("tmr-outlook-day")).toHaveCount(7);
    await expect(section.getByTestId("tmr-outlook-bar")).toHaveCount(0);
    await expect(section.getByTestId("tmr-outlook-sum-total")).toContainText("Total, 7 days");
    await expect(section.getByTestId("tmr-outlook-sum-total")).toContainText("56,210 t");
    await expect(section.getByTestId("tmr-outlook-weather-window")).toHaveText(
      "Open-Meteo weather drives every day in this range.",
    );
    await expect(section.locator(".ui-tag")).toHaveCount(0);

    // 14 days: a chart of 14 columns, every one on the Open-Meteo forecast.
    await fourteen.click();
    await expect(fourteen).toHaveAttribute("aria-pressed", "true");
    await expect(seven).toHaveAttribute("aria-pressed", "false");
    await expect(section.getByTestId("tmr-outlook-days-heading")).toHaveText(
      "Next 14 days · city-wide, t/day",
    );
    await expect(section.getByTestId("tmr-outlook-bar")).toHaveCount(14);
    await expect(section.locator("[data-testid=tmr-outlook-bar][data-beyond=true]")).toHaveCount(0);
    await expect(section.getByTestId("tmr-outlook-chart-cut")).toHaveCount(0);
    await expect(section.getByTestId("tmr-outlook-weather-window")).toHaveText(
      "Open-Meteo weather drives every day in this range.",
    );
    await expect(section.getByTestId("tmr-outlook-row")).toHaveCount(14);

    // 30 days: 30 columns, the peak and the trucks it needs from the API.
    await thirty.click();
    await expect(section.getByTestId("tmr-outlook-bar")).toHaveCount(30);
    // 30 days: the 14 past Open-Meteo's 16 days are dashed, cut and named.
    await expect(section.locator("[data-testid=tmr-outlook-bar][data-beyond=true]")).toHaveCount(14);
    await expect(section.getByTestId("tmr-outlook-chart-cut")).toHaveCount(1);
    await expect(section.getByTestId("tmr-outlook-weather-window")).toContainText(
      "Open-Meteo weather drives the first 16 days. From",
    );
    await expect(section.getByTestId("tmr-outlook-weather-window")).toContainText("0 mm rain");
    await expect(section.getByTestId("tmr-outlook-sum-total")).toContainText("Total, 30 days");
    await expect(section.getByTestId("tmr-outlook-sum-total")).toContainText("244,860 t");
    await expect(section.getByTestId("tmr-outlook-sum-avg")).toContainText("8,162 t");
    await expect(section.getByTestId("tmr-outlook-sum-peak")).toContainText("8,600 t");
    await expect(section.getByTestId("tmr-outlook-sum-trucks")).toContainText("499");
    await expect(section.getByTestId("tmr-outlook-sum-trucks")).toHaveAttribute("title", /18 t per truck/);
    await expect(section.getByTestId("tmr-outlook-sum-adjusted")).toHaveCount(0);

    // All 30 columns sit inside the card and the page never scrolls sideways.
    const plot = await section.getByTestId("tmr-outlook-chart-plot").boundingBox();
    const last = await section.getByTestId("tmr-outlook-bar").last().boundingBox();
    expect(last.x + last.width).toBeLessThanOrEqual(plot.x + plot.width + 1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // The readout opens on tomorrow; the arrow keys walk the days.
    const readout = section.getByTestId("tmr-outlook-readout");
    await expect(readout).toHaveAttribute("data-date", jakartaDay(1));
    await expect(readout).toContainText("Tomorrow");
    await section.getByTestId("tmr-outlook-chart-plot").focus();
    await page.keyboard.press("End");
    await expect(readout).toHaveAttribute("data-date", jakartaDay(29));
    await expect(readout).toContainText("Dry-day baseline");
    await page.keyboard.press("ArrowLeft");
    await expect(readout).toHaveAttribute("data-date", jakartaDay(28));

    // The switch works from the keyboard too.
    await seven.focus();
    await page.keyboard.press("Space");
    await expect(seven).toHaveAttribute("aria-pressed", "true");
    await expect(section.getByTestId("tmr-outlook-day")).toHaveCount(7);

    // The learning panel says it is waiting and what will happen, with no correction figure.
    const panel = section.getByTestId("tmr-outlook-learning");
    await expect(panel.getByRole("heading", { name: "Learns from the weighbridge" })).toBeVisible();
    await expect(panel).toHaveAttribute("data-active", "false");
    await expect(panel.getByTestId("tmr-outlook-learn-status")).toContainText(
      "Self-correcting from day 3 · 0 weighed so far",
    );
    await expect(panel.getByTestId("tmr-outlook-learn-correction")).toContainText("Starts on day 3");
    await expect(panel.getByTestId("tmr-outlook-learn-cap")).toContainText("±25%");
    await expect(panel.getByTestId("tmr-outlook-learn-basis")).toContainText(
      "From day 3, an adjusted figure appears beside each forecast.",
    );
  });
}

test("an active correction shows in the panel and next to every horizon figure", async ({ page }) => {
  const learned = {
    ...WAITING,
    active: true,
    factor: 1.05,
    pct: 5,
    n_days: 4,
    since: jakartaDay(-5),
    last_day: jakartaDay(-1),
  };
  await stub(page, learned);
  await signIn(page, { lang: "id", path: "/app/tomorrow" });
  const section = page.getByTestId("tmr-outlook");
  await section.getByTestId("tmr-outlook-horizon-30").click();
  await expect(section.getByTestId("tmr-outlook-days-heading")).toHaveText(
    "30 hari ke depan · se-kota, t/hari",
  );
  await expect(section.getByTestId("tmr-outlook-horizon-30")).toHaveText("30 hari");
  await expect(section.getByTestId("tmr-outlook-sum-total")).toContainText("244.860 t");
  await expect(section.getByTestId("tmr-outlook-sum-total")).toContainText("Disesuaikan 257.103 t");
  await expect(section.getByTestId("tmr-outlook-sum-peak")).toContainText("Disesuaikan 9.030 t");
  const panel = section.getByTestId("tmr-outlook-learning");
  await expect(panel).toHaveAttribute("data-active", "true");
  await expect(panel.getByRole("heading", { name: "Belajar dari jembatan timbang" })).toBeVisible();
  await expect(panel.getByTestId("tmr-outlook-learn-status")).toContainText(
    "Mengoreksi diri · 4 hari tertimbang",
  );
  await expect(panel.getByTestId("tmr-outlook-learn-correction")).toContainText("+5%");
  await expect(panel.getByTestId("tmr-outlook-learn-days")).toContainText("4 dari 14 terakhir");
  await expect(panel.getByTestId("tmr-outlook-learn-basis")).toContainText("dibatasi ±25%");
  // Indonesian mode stays Indonesian.
  await expect(section).not.toContainText(/Learns from|Total, 30 days|Dry-day baseline|Self-correcting/);
});

test("the live 30-day outlook adds up and marks the days past the weather window", async ({ page }) => {
  test.setTimeout(180000);
  await signIn(page, { lang: "en", path: "/app/tomorrow" });
  const section = page.getByTestId("tmr-outlook");
  await expect(section.getByTestId("tmr-outlook-day")).toHaveCount(7, { timeout: 90000 });
  await section.getByTestId("tmr-outlook-horizon-30").click();
  const bars = section.getByTestId("tmr-outlook-bar");
  await expect(bars).toHaveCount(30, { timeout: 90000 });
  const values = await bars.evaluateAll((els) => els.map((el) => Number(el.dataset.value)));
  const beyond = await bars.evaluateAll((els) => els.map((el) => el.dataset.beyond === "true"));
  // Open-Meteo serves at most 16 days, so at least the last 14 of the 30 are flagged.
  expect(beyond.filter(Boolean).length).toBeGreaterThanOrEqual(14);
  expect(beyond.slice(16).every(Boolean)).toBe(true);
  const total = values.reduce((a, b) => a + b, 0);
  const shown = await section.getByTestId("tmr-outlook-sum-total").locator(".tmr-ol-sum-value").innerText();
  expect(Math.abs(Number(shown.replace(/[^\d]/g, "")) - total)).toBeLessThanOrEqual(1);
  await expect(section.getByTestId("tmr-outlook-learning")).toBeVisible();
});
