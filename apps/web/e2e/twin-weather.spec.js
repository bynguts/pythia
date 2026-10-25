// #twin-weather: the twin's default week runs on the real Open-Meteo forecast rain, so the
// scenario chip and the map label say where each day's rain comes from (forecast, what-if,
// or assumed dry when no forecast is available), and a what-if stays on its own day while
// the timeline moves. The weather block is pinned per test: Open-Meteo is live upstream.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page, lang = "en") {
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

// A scene refetch may still be in flight through pinWeather's stub when a test ends.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

async function waitForTwin(page, predicate = "true") {
  await page.waitForFunction(`window.__pythiaTwin && window.__pythiaTwin.ready && (${predicate})`, null, {
    timeout: 45000,
  });
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__pythiaTwin)));
}

/** Rewrite the scene's weather block: every non-scenario day gets `input`, its rain and carried rain. */
async function pinWeather(page, { input = "forecast", rain = [], carried = [], cls, source }) {
  await page.route(/\/twin\/scene\?/, async (route) => {
    // Without a forecast, the backend computes the scene dry too (weather=none), so
    // values derived server-side (the queue's day basis) match the pinned week.
    const url = new URL(route.request().url());
    if (input !== "forecast") url.searchParams.set("weather", "none");
    // One retry: the proxied fetch can hit a reset keep-alive socket on a busy local server.
    const response = await route
      .fetch({ url: url.toString() })
      .catch(() => route.fetch({ url: url.toString() }));
    const json = await response.json();
    json.weather = {
      ...json.weather,
      class: cls ?? (input === "forecast" ? "REAL_FORECAST_INPUT" : "UNAVAILABLE"),
      source: source ?? (input === "forecast" ? "open-meteo" : "unavailable"),
      days: json.weather.days.map((d, i) =>
        d.input === "scenario"
          ? d
          : {
              ...d,
              input,
              rainfall_mm: input === "forecast" ? (rain[i] ?? 0) : 0,
              carried_rain_mm: carried[i] ?? 0,
              beyond_training_range: false,
            },
      ),
    };
    await route.fulfill({ response, json });
  });
}

test("forecast rain is named as an Open-Meteo forecast, never as a scenario or observed", async ({
  page,
}) => {
  await signIn(page);
  await pinWeather(page, { rain: [12, 0] });
  await page.goto("/twin?present=1");
  await waitForTwin(page);
  const label = page.getByTestId("twin-rain-label");
  await expect(label).toHaveText("Forecast rain 12 mm · Open-Meteo forecast, not observed");
  await expect(label).toHaveAttribute("data-input", "forecast");
  await expect(page.getByTestId("twin-scenario-text")).toHaveText(
    "Forecast rain 12 mm (Open-Meteo, not observed) · No crowd event · Today",
  );
  // The next day has no forecast rain: the label follows the selected day.
  await page.getByTestId("twin-day-1").click();
  await expect(label).toHaveText("No rain forecast · Open-Meteo forecast, not observed");
});

test("without a forecast every day is labelled assumed dry (id)", async ({ page }) => {
  await signIn(page, "id");
  await pinWeather(page, { input: "assumed_dry" });
  await page.goto("/twin?present=1");
  await waitForTwin(page);
  await expect(page.getByTestId("twin-rain-label")).toHaveText(
    "Prakiraan hujan tidak tersedia · dianggap kering (0 mm)",
  );
  await expect(page.getByTestId("twin-scenario-text")).toHaveText(
    "Prakiraan hujan tidak tersedia: dianggap kering · Tanpa keramaian · Hari ini",
  );
});

test("a what-if stays on its own day while the timeline moves", async ({ page }) => {
  await signIn(page);
  await page.goto("/twin");
  await waitForTwin(page);
  await page.getByTestId("twin-rainfall").fill("60");
  await waitForTwin(
    page,
    "window.__pythiaTwin.scenario.rainfall_mm === 60 && window.__pythiaTwin.scenario.scenario_day === 0",
  );
  await expect(page.getByTestId("twin-rain-label")).toHaveText("Scenario rain 60 mm · not observed weather");

  // Picking another day refetches for that day's queue, but the what-if keeps day 0.
  const request = page.waitForRequest(
    (r) =>
      r.url().includes("/twin/scene?") && r.url().includes("day=3") && r.url().includes("scenario_day=0"),
  );
  await page.getByTestId("twin-day-3").click();
  await request;
  const state = await waitForTwin(page, "window.__pythiaTwin.scenario.day === 3");
  expect(state.selectedDay).toBe(3);
  expect(state.scenario.scenario_day).toBe(0);
  await expect(page.getByTestId("twin-rain-label")).not.toHaveAttribute("data-input", "scenario");
  await expect(page).toHaveURL(/[?&]scenario_day=0(&|$)/);

  // Playback moves the selected day only; when it stops, the what-if is still on day 0.
  await page.getByTestId("twin-play").click();
  await page.waitForFunction("window.__pythiaTwin.selectedDay !== 3", null, { timeout: 10000 });
  await page.getByTestId("twin-play").click();
  const after = await waitForTwin(
    page,
    "window.__pythiaTwin.scenario.day === window.__pythiaTwin.selectedDay",
  );
  expect(after.scenario.scenario_day).toBe(0);
  expect(after.scenario.rainfall_mm).toBe(60);
});

// #N7 (teardown v3): a dry day still counts the previous days' forecast rain in its
// 3-day sum (weather.days[i].carried_rain_mm) and says so; a what-if is never carried.
test("a dry day after forecast rain says the earlier rain still counts", async ({ page }) => {
  await signIn(page);
  await pinWeather(page, { rain: [40, 0, 0], carried: [0, 40, 40] });
  await page.goto("/twin?present=1");
  await waitForTwin(page);
  await page.getByTestId("twin-day-1").click();
  const label = page.getByTestId("twin-rain-label");
  await expect(label).toHaveText(
    "No rain forecast · Open-Meteo forecast, not observed · Earlier forecast rain still counted: 40 mm in the 3-day sum",
  );
  await expect(label).toHaveAttribute("data-carried-mm", "40");
  await expect(page.getByTestId("twin-scenario-text")).toContainText("Earlier forecast rain still counted");
});

test("a what-if's rain is not carried into the next day (id)", async ({ page }) => {
  await signIn(page, "id");
  await pinWeather(page, { rain: [] });
  await page.goto("/twin?rain=60");
  await waitForTwin(page, "window.__pythiaTwin.scenario && window.__pythiaTwin.scenario.rainfall_mm === 60");
  await page.getByTestId("twin-day-1").click();
  // Wait for day 1's own scene (the click refetches it) before checking: asserting while
  // that fetch was still in flight passed vacuously and ended the test mid-route.
  await waitForTwin(page, "window.__pythiaTwin.scenario.day === 1 && window.__pythiaTwin.selectedDay === 1");
  await expect(page.getByTestId("twin-rain-label")).not.toHaveAttribute("data-input", "scenario");
  await expect(page.getByTestId("twin-rain-label")).not.toContainText("masih dihitung");
});

// The served rain effect is held at the training maximum; the twin says so (modelfix rain_response).
test("rain beyond the training range says the effect is held", async ({ page }) => {
  await signIn(page);
  await page.goto("/twin?rain=120");
  const state = await waitForTwin(
    page,
    "window.__pythiaTwin.scenario && window.__pythiaTwin.scenario.rainfall_mm === 120",
  );
  expect(state.scenario.scenario_day).toBe(0);
  await expect(page.getByTestId("twin-rain-label")).toContainText(
    /Effect held at [\d.]+ mm \(training range\)/,
  );
  await expect(page.getByTestId("twin-rain-response")).toContainText("never below the dry normal day");
  await expect(page.getByTestId("twin-rain-response")).toContainText(/Effect held at [\d.]+ mm/);
});

// #fix-6 (teardown v3): every timeline day shows its at-risk count, so a dry today
// never opens the week on a bare "0".
test("the timeline shows each day's at-risk count and the KPI names the week's peak", async ({ page }) => {
  await signIn(page);
  await page.route(/\/twin\/scene\?/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.horizon.daily_districts_at_risk = json.horizon.dates.map((_, i) => (i === 2 ? 6 : 0));
    json.districts = json.districts.map((d, k) => ({
      ...d,
      series: d.series.map((row, i) => ({ ...row, risk: i === 2 && k < 6 ? "high" : "normal" })),
    }));
    await route.fulfill({ response, json });
  });
  await page.goto("/twin");
  const state = await waitForTwin(page);
  expect(state.dailyAtRisk[2]).toBe(6);
  await expect(page.getByTestId("twin-day-2")).toHaveAttribute("data-at-risk", "6");
  await expect(page.getByTestId("twin-day-risk-2")).toHaveText("6");
  await expect(page.getByTestId("twin-day-2")).toHaveAttribute("aria-label", /· 6 at risk$/);
  await expect(page.getByTestId("twin-day-risk-0")).toHaveCount(0);
  const riskCell = page.getByTestId("twin-workspace").getByTestId("metric-cell").nth(2);
  await expect(riskCell.locator("strong")).toHaveText("0");
  await expect(riskCell.locator("small")).toContainText("week peak 6 on");
});

// #N6 (teardown v3): the beacon says which day its queue describes, against the Fleet KPI's normal day.
test("the landfill beacon names its queue basis against the Fleet queue", async ({ page }) => {
  await signIn(page);
  await pinWeather(page, { input: "assumed_dry" });
  await page.goto("/twin");
  await waitForTwin(page);
  // wave10 T2: the beacon's queue detail (and its basis) opens on tap.
  await page.getByTestId("twin-landfill-tag").click();
  await expect(page.getByTestId("twin-landfill-tag")).toContainText(
    "Normal day (no rain, no event): same basis as the Fleet queue",
  );
  await page.getByTestId("twin-rainfall").fill("80");
  await waitForTwin(page, "window.__pythiaTwin.scenario.rainfall_mm === 80");
  await expect(page.getByTestId("twin-landfill-tag")).toContainText(
    /Scaled to the what-if day; the Fleet queue shows the normal day · [\d,]+ gate trips\/day vs [\d,]+ on the normal day/,
  );
});
