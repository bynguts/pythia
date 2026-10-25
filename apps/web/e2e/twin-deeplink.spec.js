// gsc-2026 P0-6 + C2: twin deep link (/twin?city=&rain=&event=&venue=&day=&present=1) sets the scenario, present mode shows the cause → effect chip (venue, scenario-scaled queue), and the URL follows scenario changes.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// #twin-weather: the chip and the map label say where the day's rain comes from, so
// tests that read them pin the scene's weather block (Open-Meteo is live upstream).
function forecastWeather(json, rain = []) {
  json.weather = {
    ...json.weather,
    source: "open-meteo",
    class: "REAL_FORECAST_INPUT",
    kind: "forecast",
    days: json.weather.days.map((d, i) =>
      d.input === "scenario" ? d : { ...d, input: "forecast", rainfall_mm: rain[i] ?? 0 },
    ),
  };
}

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

async function waitForTwin(page, predicate = "true") {
  await page.waitForFunction(`window.__pythiaTwin && window.__pythiaTwin.ready && (${predicate})`, null, {
    timeout: 45000,
  });
  // JSON round-trip drops the hook's functions, keeping the serialisable state.
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__pythiaTwin)));
}

test("a deep link opens the twin on its rain, event and day", async ({ page }) => {
  await signIn(page);
  await page.goto("/twin?rain=80&event=50k&day=1");
  const state = await waitForTwin(page, "window.__pythiaTwin.scenario.rainfall_mm === 80");
  expect(state.city).toBe("jakarta");
  expect(state.selectedDay).toBe(1);
  expect(state.scenario.event_attendance).toBe(50000);
  await expect(page.getByTestId("twin-rainfall-value")).toHaveText("80 mm");
  await expect(page.getByTestId("twin-event-50k")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("twin-day-1")).toHaveAttribute("aria-pressed", "true");
  // The XR hand-off carries the same scenario.
  const xrHref = await page.getByTestId("twin-xr-link").getAttribute("href");
  expect(xrHref).toContain("rainfall_mm=80");
  expect(xrHref).toContain("event_attendance=50000");
  // Opening a deep link does not rewrite it.
  await expect(page).toHaveURL(/\/twin\?rain=80&event=50k&day=1$/);
});

test("invalid deep-link values are ignored", async ({ page }) => {
  await signIn(page);
  await page.goto("/twin?city=paris&rain=abc&event=1m&day=99");
  const state = await waitForTwin(page);
  expect(state.city).toBe("jakarta");
  expect(state.selectedDay).toBe(0);
  expect(state.scenario.rainfall_mm).toBe(0);
  expect(state.scenario.event_attendance || 0).toBe(0);
  await expect(page.getByTestId("twin-event-none")).toHaveAttribute("aria-pressed", "true");
});

test("the URL follows scenario changes and reloads into the same scenario", async ({ page }) => {
  await signIn(page);
  await page.goto("/twin");
  await waitForTwin(page);
  await page.getByTestId("twin-rainfall").fill("60");
  await page.getByTestId("twin-event-100k").click();
  await page.getByTestId("twin-day-2").click();
  await expect(page).toHaveURL(/[?&]rain=60(&|$)/);
  await expect(page).toHaveURL(/[?&]event=100k(&|$)/);
  await expect(page).toHaveURL(/[?&]day=2(&|$)/);
  await expect(page).toHaveURL(/[?&]city=jakarta(&|$)/);

  await page.reload();
  const state = await waitForTwin(page, "window.__pythiaTwin.scenario.rainfall_mm === 60");
  expect(state.selectedDay).toBe(2);
  expect(state.scenario.event_attendance).toBe(100000);

  // Back to defaults drops the scenario params again.
  await page.getByTestId("twin-rainfall").fill("0");
  await page.getByTestId("twin-event-none").click();
  await page.getByTestId("twin-day-0").click();
  await expect(page).toHaveURL(/\/twin\?city=jakarta$/);
});

test("present mode shows the scenario chip and the simulated queue headline", async ({ page }) => {
  await signIn(page);
  // The per-truck queue metric is optional in the scene; inject one so the
  // headline renders deterministically against the real scene response.
  await page.route(/\/twin\/scene\?/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.landfill_queue = {
      ...(json.landfill_queue || {}),
      minutes_per_truck: {
        baseline_mean: 42,
        staggered_mean: 18.5,
        baseline_p95: 70,
        staggered_p95: 30,
        staggered_ci95: [17, 20],
        baseline_ci95: [40, 44],
        replications: 200,
        seed: 7,
        trucks_per_day: 1200,
        classification: "SIMULATED",
        source: "e2e stub",
      },
    };
    await route.fulfill({ response, json });
  });
  await page.goto("/twin?present=1&rain=80&event=50k&day=1");
  const chip = page.getByTestId("twin-scenario-chip");
  await expect(chip).toBeVisible({ timeout: 45000 });
  await expect(page.getByTestId("twin-scenario-text")).toHaveText(
    // The app renders compact counts ("50k"); the case of the suffix is not what this checks.
    /^Rain 80 mm · Concert 50k at GBK · Day \+1$/i,
  );
  await expect(page.getByTestId("twin-present-queue-metric")).toHaveText(
    // #twinrender: each side of the arrow says which arm it is.
    "TPA weighbridge queue, day average: 42 min/truck without stagger → 18.5 with Pythia stagger (Simulated)",
  );
  // Provenance stays on screen in footage mode.
  await expect(page.getByTestId("twin-provenance-landfill_queue")).toBeVisible();
  await expect(page.getByTestId("twin-present-queue")).toHaveText("Queue data: Simulated");
});

test("present mode renders no queue headline when the scene has no metric", async ({ page }) => {
  await signIn(page, "id");
  await page.route(/\/twin\/scene\?/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json.landfill_queue) delete json.landfill_queue.minutes_per_truck;
    forecastWeather(json);
    await route.fulfill({ response, json });
  });
  await page.goto("/twin?present=1");
  await expect(page.getByTestId("twin-scenario-chip")).toBeVisible({ timeout: 45000 });
  await expect(page.getByTestId("twin-scenario-text")).toHaveText(
    "Tanpa hujan menurut prakiraan (Open-Meteo) · Tanpa keramaian · Hari ini",
  );
  await expect(page.getByTestId("twin-present-queue-metric")).toHaveCount(0);
});

test("a venue deep link moves the event to that venue and the XR hand-off follows", async ({ page }) => {
  await signIn(page);
  await page.goto("/twin?event=50k&venue=jis");
  const state = await waitForTwin(page, "window.__pythiaTwin.scenario.event_attendance === 50000");
  expect(state.venue).toBe("jis");
  expect(state.scenario.event_lat).toBeCloseTo(-6.1246, 3);
  // #twinrender: the map pins the venue the scene was computed for, with the
  // boundary reach the scene states (scenario.event.radius_m), not a fixed radius.
  expect(state.venuePin).toMatchObject({ name: "JIS", radiusM: state.scenario.event.radius_m });
  expect(state.venuePin.reached).toBe(state.scenario.event.districts.length);
  await expect(page.getByTestId("twin-venue-jis")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("twin-event-50k")).toContainText("JIS");
  const box = await page.getByTestId("twin-venue-jis").boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  const xrHref = await page.getByTestId("twin-xr-link").getAttribute("href");
  expect(xrHref).toContain("event_lat=-6.1246");
  expect(xrHref).toContain("event_lng=106.8584");
  await expect(page).toHaveURL(/\/twin\?event=50k&venue=jis$/);

  // Picking a venue writes it into the URL; the default venue drops it again.
  await page.getByTestId("twin-venue-monas").click();
  await expect(page).toHaveURL(/[?&]venue=monas(&|$)/);
  await page.getByTestId("twin-venue-gbk").click();
  await expect(page).not.toHaveURL(/[?&]venue=/);
});

test("a venue from another city is ignored", async ({ page }) => {
  await signIn(page);
  await page.goto("/twin?city=hcmc&event=50k&venue=gbk");
  const state = await waitForTwin(page, "window.__pythiaTwin.city === 'hcmc'");
  expect(state.venue).toBe("d1");
  // #twinrender: the demo city puts the event in its nearest district only, so no reach ring.
  expect(state.venuePin).toMatchObject({ radiusM: null });
  await expect(page.getByTestId("twin-venue-d1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("twin-venue-gbk")).toHaveCount(0);
});

test("present mode names the venue and shows the scenario-scaled queue next to the normal day", async ({
  page,
}) => {
  await signIn(page);
  // The scenario-scaled fields are optional; inject them on the real scene response.
  await page.route(/\/twin\/scene\?/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.landfill_queue = {
      ...(json.landfill_queue || {}),
      minutes_per_truck: {
        baseline_mean: 55,
        staggered_mean: 24.5,
        baseline_p95: 90,
        staggered_p95: 40,
        staggered_ci95: [23, 26],
        baseline_ci95: [52, 58],
        replications: 200,
        seed: 7,
        trucks_per_day: 1350,
        classification: "SIMULATED",
        source: "e2e stub",
        scenario_scaled: true,
        normal_day: { trucks_per_day: 1200, baseline_mean: 42, staggered_mean: 18.5 },
      },
    };
    forecastWeather(json);
    await route.fulfill({ response, json });
  });
  await page.goto("/twin?present=1&event=100k&venue=monas");
  await expect(page.getByTestId("twin-scenario-chip")).toBeVisible({ timeout: 45000 });
  await expect(page.getByTestId("twin-scenario-text")).toHaveText(
    /^No rain forecast \(Open-Meteo\) · Concert 100k at Monas · Today$/i,
  );
  await expect(page.getByTestId("twin-present-queue-metric")).toHaveText(
    "TPA weighbridge queue, selected-day average: 55 min/truck without stagger → 24.5 with Pythia stagger · normal day 42 → 18.5 (Simulated)",
  );
  await expect(page.getByTestId("twin-present-queue")).toHaveText("Queue data: Simulated");
});
