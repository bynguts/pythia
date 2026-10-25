// gsc-2026 P0-4/P0-5: the stagger panel never shows the old fixed 47→19 / 116→48 / 58.6% figures, and the TPA, stagger, carbon and A* panels carry a SIMULATED label in both languages.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

const COPY = {
  id: { sim: "SIMULASI", queueTab: /Antrean TPA/, actionTab: /Perlu tindakan/ },
  en: { sim: "SIMULATED", queueTab: /TPA Queue/, actionTab: /Needs action/ },
};

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
  await page.reload({ waitUntil: "domcontentloaded" });
}

test("stagger panel shows a loading state, not the old fixed figures, before the simulation answers", async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const hold = async (route) => {
    await gate;
    await route.continue();
  };
  await page.route("**/api/tpa/queue-metric", hold);
  await page.route("**/api/simulator/stagger", hold);

  await signIn(page, "en");
  await page.getByRole("tab", { name: COPY.en.queueTab }).click();
  const panel = page.getByTestId("stagger-panel");
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("stagger-queue-metric-status")).toBeVisible();
  const before = await panel.innerText();
  expect(before).not.toMatch(/58[.,]6|\b116\b|\b47\b|\b19\b/);

  release();
  const metric = page.getByTestId("stagger-queue-metric");
  await expect(metric).toBeVisible({ timeout: 30000 });
  await expect(metric).toContainText("seed");
  await expect(page.getByTestId("stagger-panel")).not.toContainText("58.6%");
});

// wave9 fleet composition: the carbon panel left /fleet (teardown v4 F8) and the reroute
// panel moved from the layers panel into the "Perlu tindakan" rail tab.
for (const lang of ["id", "en"]) {
  test(`queue, stagger and reroute panels are labelled simulated (${lang})`, async ({ page }) => {
    const copy = COPY[lang];
    await signIn(page, lang);

    await page.getByRole("tab", { name: copy.queueTab }).click();
    await expect(page.getByTestId("tpa-sim-badge")).toHaveText(copy.sim, { timeout: 15000 });
    await expect(page.getByTestId("stagger-sim-badge")).toHaveText(copy.sim);
    await expect(page.getByTestId("tpa-queue-panel")).not.toContainText(/real-time|live clock|waktu nyata/i);
    await expect(page.getByTestId("tpa-queue-metric-sim-badge")).toHaveText(copy.sim, { timeout: 30000 });

    await page.getByRole("tab", { name: copy.actionTab }).click();
    await expect(page.getByTestId("astar-sim-badge")).toHaveText(copy.sim, { timeout: 15000 });
    await expect(page.getByTestId("astar-panel")).not.toContainText(/real-time/i);
  });
}

// gsc teardown #3: the fleet is a simulated pilot fleet, so the fleet KPI area never claims
// "live" / "langsung", and the landfill KPI names the modelled peak hour the API serves
// (never the wall-clock hour of a modelled profile).
// wave9 fleet composition: the landfill tile reads "Puncak 09.00: ±89 mnt" (never "89m"),
// labelled simulated in its helper; the problem strip and fleet heading are gone.
const FLEET_COPY = {
  id: { simulated: "armada pilot simulasi", peak: "jam puncak model", tile: "Puncak", min: "mnt", sep: "." },
  en: { simulated: "simulated pilot fleet", peak: "modelled peak hour", tile: "Peak", min: "min", sep: ":" },
};

for (const lang of ["id", "en"]) {
  test(`fleet KPI area says simulated, never live, and names the modelled peak hour (${lang})`, async ({
    page,
  }) => {
    const copy = FLEET_COPY[lang];
    const status = await (await page.request.get(`${API}/tpa/queue-status`)).json();
    expect(status.classification).toBe("SIMULATED");
    expect(Number.isInteger(status.modelled_hour)).toBe(true);
    const hour = `${String(status.modelled_hour).padStart(2, "0")}:00`;

    await signIn(page, lang);
    const strip = page.getByTestId("metric-strip");
    const tileHour = `${String(status.modelled_hour).padStart(2, "0")}${copy.sep}00`;
    const tile = strip.locator("[data-metric=queue]");
    await expect(strip).toContainText(copy.simulated, { timeout: 15000 });
    await expect(tile).toContainText(
      `${copy.tile} ${tileHour}: ±${Math.trunc(status.avg_wait_minutes)} ${copy.min}`,
      { timeout: 30000 },
    );
    await expect(tile).not.toContainText(/\d+m\b/);

    const kpiArea = await strip.innerText();
    expect(kpiArea).not.toMatch(/\blive\b|langsung/i);
    expect(kpiArea).toContain(tileHour);

    // The what-if beacon and the headline band come from the same model.
    await page.getByRole("tab", { name: COPY[lang].queueTab }).click();
    await page
      .getByTestId("tpa-queue-panel")
      .getByRole("button", { name: lang === "id" ? "Skenario" : "What-if" })
      .click();
    await expect(page.getByTestId("tpa-modelled-hour")).toHaveText(`${copy.peak} ${hour}`, {
      timeout: 15000,
    });
    await expect(page.getByTestId("tpa-queue-metric-band")).toContainText("SD", { timeout: 30000 });

    // The weighbridge log is the seeded peak hour's own arrivals, each labelled simulated.
    expect(status.scale_logs.length).toBeGreaterThan(0);
    expect(status.scale_logs.every((log) => log.source === "SIMULATED")).toBe(true);
    const logs = page.getByTestId("tpa-scale-logs");
    await expect(logs.locator("li")).toHaveCount(status.scale_logs.length);
    await expect(logs.getByTestId("tpa-scale-log-source")).toHaveText(
      status.scale_logs.map(() => COPY[lang].sim),
    );
    await expect(logs).toContainText(status.scale_logs[0].truck);
    await expect(logs).toContainText(status.scale_logs[0].arrived);
    expect(status.scale_logs[0].arrived.startsWith(hour.slice(0, 3))).toBe(true);
    await expect(logs).not.toContainText(/T-0\d\d|\btons?\b/);
  });
}

test("TPA arrival rate unit follows the language", async ({ page }) => {
  await page.route("**/api/ai/tpa-queue-live", (route) =>
    route.fulfill({
      json: {
        trucks_in_queue: 3,
        arriving_soon: 2,
        arrival_rate_per_h: 12,
        predicted_wait_min: 4,
        wait_ci95: [3, 5],
        trend: "stable",
        congestion_level: "low",
      },
    }),
  );
  await signIn(page, "en");
  await page.getByRole("tab", { name: COPY.en.queueTab }).click();
  await expect(page.getByTestId("tpa-arrival-rate")).toHaveText("12/h", { timeout: 15000 });
});

// #honesty: the login story never calls the simulated fleet "live" and never reads as a
// DLH product; it names the case it was built for.
const LOGIN_COPY = {
  id: {
    proof: "Armada, pengemudi, dan antrean TPA dalam satu tampilan (armada simulasi)",
    footer: "Prototipe untuk studi kasus DLH DKI Jakarta",
    stale: /Operasi langsung|Prediksi terukur|Dinas Lingkungan Hidup Provinsi/,
  },
  en: {
    proof: "Fleet, drivers and TPA queue in one view (simulated fleet)",
    footer: "Prototype built for the DLH DKI Jakarta case",
    stale: /Live operations|Measured forecasts|Jakarta Environmental Agency/,
  },
};

for (const lang of ["id", "en"]) {
  test(`login proof strings say simulated and name the case, not a DLH product (${lang})`, async ({
    page,
  }) => {
    const copy = LOGIN_COPY[lang];
    await page.addInitScript((value) => localStorage.setItem("pythia_lang", value), lang);
    await page.goto("/");
    const proof = page.getByTestId("login-proof-list");
    await expect(proof).toContainText(copy.proof);
    await expect(page.locator(".login-story-footer")).toHaveText(copy.footer);
    const story = await page.locator(".login-story").innerText();
    expect(story).not.toMatch(copy.stale);
    expect(story).not.toMatch(/\blive\b/i);
  });
}

// #honesty: the planning executive summary is composed through the locale catalog, says the
// queue and fleet are simulated, and reads as a decision brief, not as a DLH document.
for (const [lang, copy] of [
  ["id", { nav: "Rencana", title: "Ringkasan eksekutif", queue: "Antrean TPA Bantargebang (simulasi)" }],
  ["en", { nav: "Planning", title: "Executive summary", queue: "TPA Bantargebang queue (simulated)" }],
]) {
  test(`executive summary labels the simulated queue and is not a DLH document (${lang})`, async ({
    page,
  }) => {
    await signIn(page, lang);
    await page.getByTestId("workspace-navigation").getByRole("button", { name: copy.nav }).click();
    const summary = page.locator(".planning-summary");
    await expect(summary.getByRole("heading", { name: copy.title })).toBeVisible({ timeout: 20000 });
    await expect(summary.locator(".queue-box strong")).toHaveText(copy.queue);
    expect(await summary.innerText()).not.toMatch(/DLH|Dinas Lingkungan Hidup/);
  });
}

// #N1 (teardown v3): the Forecast workspace never shows the canned June sample as this
// week's forecast. A live list with no district at risk renders an honest empty state;
// the sample only appears when the backend is unreachable, badged as not a forecast.
const FORECAST_COPY = {
  id: {
    empty: "Tidak ada wilayah yang diprakirakan ≥ 10% di atas hari normalnya minggu ini (hasil model).",
    sample: "CONTOH OFFLINE",
    normalDayTile: "hari normal (simulasi)",
  },
  en: {
    empty: "No district is forecast ≥ 10% above its normal day this week (model output).",
    sample: "OFFLINE SAMPLE",
    normalDayTile: "normal day (simulated)",
  },
};

for (const lang of ["id", "en"]) {
  test(`a live week with no district at risk shows an empty state, never the canned sample (${lang})`, async ({
    page,
  }) => {
    const copy = FORECAST_COPY[lang];
    await page.route("**/api/command-center", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.critical_predictions = [];
      json.predictions = (json.predictions || []).map((p) => ({
        ...p,
        risk_level: "normal",
        spike_percent: -2,
      }));
      json.kpis = { ...json.kpis, predicted_spike_percent: -2 };
      await route.fulfill({ response, json });
    });
    await signIn(page, lang);
    // The Fleet queue KPI names its basis (the normal day), unlike the twin's scaled beacon (#N6).
    // wave9 fleet composition: the tile helper reads "… hari normal (simulasi)".
    await expect(page.getByTestId("metric-strip")).toContainText(copy.normalDayTile, { timeout: 30000 });
    await page.goto("/forecast");
    const workspace = page.getByTestId("forecast-workspace");
    await expect(page.getByTestId("forecast-empty")).toHaveText(copy.empty, { timeout: 30000 });
    await expect(page.getByTestId("forecast-sample-badge")).toHaveCount(0);
    await expect(workspace).not.toContainText("41%");
    await expect(workspace).not.toContainText("2026-06-01");
    await expect(workspace).not.toContainText("+-");
    // Teardown v4 T1: the strip is the canonical baseline (/api/baseline/today), not the
    // city-level snapshot spike, so it never echoes the stubbed −2% as a headline.
    await expect(workspace.getByTestId("baseline-total")).toBeVisible();
    await expect(workspace.getByTestId("metric-strip")).not.toContainText("−2%");
  });

  test(`the canned sample appears only offline, badged as not a forecast (${lang})`, async ({ page }) => {
    const copy = FORECAST_COPY[lang];
    await page.route("**/api/command-center", (route) => route.abort());
    await signIn(page, lang);
    await page.goto("/forecast");
    await expect(page.getByTestId("forecast-sample-badge")).toContainText(copy.sample, { timeout: 30000 });
    await expect(page.getByTestId("forecast-empty")).toHaveCount(0);
  });
}

// wave9 numbers coherence: the carbon estimate moved to Prediksi → Ringkasan, collapsed at the
// bottom, and keeps its SIMULATED label.
test("the carbon estimate on Prediksi keeps its simulated label", async ({ page }) => {
  await signIn(page, "id");
  await page.goto("/forecast");
  const carbon = page.getByTestId("forecast-carbon");
  await expect(carbon).toBeVisible({ timeout: 30000 });
  await expect(carbon).not.toHaveAttribute("open", "");
  await carbon.locator("summary").click();
  await expect(carbon.getByTestId("carbon-sim-badge")).toHaveText("SIMULASI");
});
