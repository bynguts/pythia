// Numbers coherence: one "today" (GET /api/baseline/today) behind every headline,
// one fleet denominator ("52 aktif / 59 unit") on every screen, and a recommendation that
// never asks for more trucks than the pilot fleet has (teardown v4 T1, F4, R1).
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page, path) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
  await page.goto(path);
  return principal.token;
}

async function apiJson(page, path) {
  const response = await page.request.get(`${API}${path}`);
  expect(response.ok(), path).toBeTruthy();
  return response.json();
}

const numberOf = async (locator) => Number(await locator.getAttribute("data-value"));

// "52 aktif / 59 unit" → { active: 52, total: 59 }. Operations: the "Truk di jalan"
// KPI prints "52/ 59", so "aktif" and "unit" are optional.
async function denominatorOf(locator) {
  const text = (await locator.textContent()) || "";
  const match = text.match(/(\d+)(?: aktif)?\s*\/ (\d+)(?: unit)?/);
  expect(match, text).toBeTruthy();
  return { active: Number(match[1]), total: Number(match[2]) };
}

// The simulated fleet ticks every few seconds; compare against a fresh count until they meet.
async function expectFleetDenominator(page, locator) {
  await expect(locator).toBeVisible({ timeout: 30000 });
  await expect(async () => {
    const { fleet } = await apiJson(page, "/baseline/today?days=7");
    expect(await denominatorOf(locator)).toEqual({ active: fleet.active, total: fleet.total });
  }).toPass({ timeout: 20000 });
}

// Tomorrow prints the forecast API's own day: total, districts and city-wide trucks.
test("Tomorrow prints the same numbers as the forecast API", async ({ page }) => {
  const token = await signIn(page, "/app/tomorrow");
  const total = page.getByTestId("plan-total");
  await expect(total).toBeVisible({ timeout: 60000 });
  const date = await page.getByTestId("tmr-forecast").getAttribute("data-date");
  const response = await page.request.get(`${API}/forecast/tomorrow?date=${date}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBeTruthy();
  const forecast = await response.json();
  expect(await numberOf(total)).toBe(forecast.total_tonnage_t);
  await expect(page.getByTestId("tmr-forecast-delta")).toContainText(`${forecast.kecamatan_count} kecamatan`);
  await expect(page.getByTestId("tmr-res-trucks")).toContainText(
    forecast.trucks_needed.toLocaleString("id-ID"),
  );
  await expect(page.getByTestId("tmr-res-trucks")).toContainText(`${forecast.units.truck_capacity_tons} t`);
  await expect(page.getByTestId("tmr-res-manhours")).toContainText(`shift ${forecast.units.shift_hours} jam`);
  await expect(page.getByTestId("tmr-res-bins")).toContainText(
    `${forecast.units.bin_capacity_tons.toLocaleString("id-ID")} t per kontainer`,
  );
});

// The twin's briefing "today" column and the canonical baseline are one call
// (forecast/baseline.build_outlook), so the twin and the console never print two todays.
test("the twin briefing's today is the baseline's today", async ({ page }) => {
  await signIn(page, "/app/tomorrow");
  const baseline = await apiJson(page, "/baseline/today?days=7");
  expect(baseline.kind).toBe("baseline");
  const briefing = await apiJson(page, "/twin/briefing");
  expect(briefing.before.total_tonnage_t).toBe(baseline.total_tonnage_t);
  expect(briefing.before.trucks_needed).toBe(baseline.trucks_needed);
  expect(briefing.before.kecamatan_at_risk).toBe(baseline.kecamatan_at_risk);
});

// Tomorrow's city tonnes are the outlook's tomorrow: the forecast week the twin and XR read
// (/baseline/scenario, same build_outlook) prints the same number for that day.
test("Tomorrow's tonnes match the forecast week the twin and XR read", async ({ page }) => {
  await signIn(page, "/app/tomorrow");
  const total = page.getByTestId("plan-total");
  await expect(total).toBeVisible({ timeout: 60000 });
  const date = await page.getByTestId("tmr-forecast").getAttribute("data-date");
  const week = await apiJson(page, `/baseline/scenario?date=${date}&days=7`);
  expect(week.date).toBe(date);
  expect(await numberOf(total)).toBe(week.total_tonnage_t);
});

// The XR tabletop's day 1 is the same tomorrow: its city total prints the Tomorrow tonnes.
test("Tomorrow's tonnes match the XR tabletop's tomorrow", async ({ page }) => {
  await signIn(page, "/app/tomorrow");
  const total = page.getByTestId("plan-total");
  await expect(total).toBeVisible({ timeout: 60000 });
  const tonnes = Math.round(await numberOf(total));
  await page.goto("/xr?day=1");
  const xrTotal = page.getByTestId("xr-total");
  await expect
    .poll(async () => Number(((await xrTotal.textContent()) || "").replace(/\D/g, "")), { timeout: 45000 })
    .toBe(tonnes);
});

// Operations: the "Truk di jalan" KPI prints "52 / 59", the baseline's own count of
// the simulated fleet. The fleet desk's safety tab and the old drivers screen have no route
// In the console, so the roster check stays on the API.
test("every screen shows the same fleet denominator", async ({ page }) => {
  const token = await signIn(page, "/app/operations");
  await expectFleetDenominator(page, page.getByTestId("kpi-trucks").locator(".ui-kpi-value"));

  // The simulated safety roster is the fleet roster (no orphan corridor unit). Once the
  // driver app has logged events on this server the panel lists only observed trucks.
  const overview = await page.request.get(`${API}/safety/overview`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(overview.ok()).toBeTruthy();
  const safety = await overview.json();
  const { fleet } = await apiJson(page, "/baseline/today?days=7");
  if (safety.classification !== "OBSERVED_APP_EVENTS") expect(safety.trucks.length).toBe(fleet.total);
});

// The plan never uses more trucks than the pilot fleet has in service, and says
// which of them a field fact held back.
test("the plan never uses more trucks than the pilot fleet has in service", async ({ page }) => {
  test.setTimeout(180000);
  await signIn(page, "/app/tomorrow");
  await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId("tmr-alloc-loading")).toHaveCount(0, { timeout: 30000 });
  if (await page.getByTestId("tmr-build").count()) {
    await page.getByTestId("tmr-build").click();
  }
  const kpi = page.getByTestId("tmr-kpi-trucks");
  await expect(kpi).toBeVisible({ timeout: 120000 });
  const fleet = await apiJson(page, "/fleet");
  const inService = fleet.filter((truck) => !truck.is_damaged).length;
  const used = await numberOf(kpi);
  await expect(kpi).toHaveText(`${used} dari ${inService}`);
  expect(used).toBeLessThanOrEqual(inService);
  // #numbers: the denominator is the roadworthy fleet, and the tile says so.
  await expect(page.locator(".tmr-kpi dt").first()).toHaveText("Truk laik jalan terpakai");
});

// #numbers: Fleet's roadworthy count leaves out the trucks in the workshop, so "N / 59"
// agrees with the header's "7 in the workshop" and with Tomorrow's roadworthy denominator.
test("Fleet's roadworthy count leaves out the trucks in the workshop", async ({ page }) => {
  const token = await signIn(page, "/app/fleet");
  const kpi = page.getByTestId("fleet-kpi-roadworthy");
  await expect(kpi).toBeVisible({ timeout: 30000 });
  await expect(async () => {
    const overview = await apiJson(page, "/fleet/status-overview");
    const damage = await page.request.get(`${API}/damage-reports`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(damage.ok()).toBeTruthy();
    const { reports } = await damage.json();
    const off = new Set([
      ...overview.damaged_trucks.map((truck) => truck.truck_code),
      ...reports.filter((r) => r.status === "baru" && r.severity === "berat").map((r) => r.truck_code),
    ]);
    const total = overview.total_trucks;
    await expect(kpi).toContainText(`${total - off.size} / ${total}`, { timeout: 1000 });
    if (overview.damaged_count) await expect(kpi).toContainText(`${overview.damaged_count} di bengkel`);
    const hold = overview.by_activity.maintenance_hold || 0;
    await expect(page.getByText(`${hold} di bengkel`).first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20000 });
});

// #numbers: Reports' "Tomorrow" line prints the forecast the Tomorrow page prints, not the
// approved plan's demand (a different, district-by-district sum).
test("Reports' tomorrow tonnes are the Tomorrow page's forecast", async ({ page }) => {
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
  await page.route(/\/api\/operations\/plans/, (route) =>
    route.fulfill({
      json: [
        {
          plan_id: "PLAN-NUM",
          plan_date: tomorrow,
          total_demand_tons: 1234,
          approved_at: new Date().toISOString(),
          status: "approved",
        },
      ],
    }),
  );
  const token = await signIn(page, "/app/reports");
  const response = await page.request.get(`${API}/forecast/tomorrow?date=${tomorrow}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBeTruthy();
  const forecast = await response.json();
  const summary = page.getByTestId("recap-summary");
  await expect(summary).toContainText(
    `Besok: prakiraan ${forecast.total_tonnage_t.toLocaleString("id-ID", { maximumFractionDigits: 0 })} t`,
    { timeout: 30000 },
  );
  await expect(summary).not.toContainText("1.234");
});

// Numbers: a queue figure says which quantity it is. The modelled peak hour's wait
// per truck and the whole day's average per truck are the weighbridge stage of one
// Simulated normal day, so they differ by definition. Operations: with no gate slot
// for now, the gate KPI shows the peak hour's wait and says it is the modelled peak.
test("the peak-hour wait and the day average name different quantities", async ({ page }) => {
  const status = await apiJson(page, "/tpa/queue-status");
  const metric = await apiJson(page, "/tpa/queue-metric");
  expect(status.quantity).toBe("peak_hour_mean_per_truck");
  expect(metric.quantity).toBe("day_mean_per_truck");
  expect(status.stage).toMatch(/^weighbridge \(gate\) stage only/);
  expect(metric.stage).toBe(status.stage);
  expect(status.trucks_per_day).toBe(metric.trucks_per_day);

  await page.route(/\/api\/gate\/slots$/, (route) =>
    route.fulfill({ json: { slots: [], recommendations: [], reason: "no_approved_plan" } }),
  );
  await signIn(page, "/app/operations");
  const tile = page.getByTestId("kpi-gate");
  await expect(tile.locator(".ui-kpi-value strong")).toHaveText(
    `${Math.round(status.avg_wait_minutes)} mnt`,
    { timeout: 30000 },
  );
  const hour = `${String(status.modelled_hour).padStart(2, "0")}.00`;
  await expect(tile.locator(".ui-kpi-sub")).toHaveText(`per truk, puncak model ${hour}`);
});

// Numbers: trucks are units (tonnes / truck capacity per shift), gate trips are rit
// from the real weighing data, and the tonnage is modelled generation read against SIPSN.
test("trucks, gate trips and tonnage each carry their own definition", async ({ page }) => {
  const baseline = await apiJson(page, "/baseline/today?days=7");
  const metric = await apiJson(page, "/tpa/queue-metric");
  expect(baseline.trucks_basis).toContain("not TPA gate trips");
  expect(baseline.gate_trips.trips_per_day).toBe(metric.normal_day.trucks_per_day);
  expect(baseline.gate_trips.trips_per_day).not.toBe(baseline.trucks_needed);
  expect(baseline.tonnage_reference.classification).toBe("REAL");
  expect(baseline.provenance.tonnage).toBe("MODEL_OUTPUT");

  // Tomorrow's trucks tile states its unit (tonnes per truck), not gate trips.
  await signIn(page, "/app/tomorrow");
  const trucks = page.getByTestId("tmr-res-trucks");
  await expect(trucks).toContainText(`${baseline.units.truck_capacity_tons} t per truk`, { timeout: 30000 });
  // #honesty: the counts are capacity-based (a full truck), and the tooltip says so.
  await expect(trucks).toContainText("kapasitas");
  await expect(trucks).toHaveAttribute("title", /^Berbasis kapasitas/);
});

// Numbers: the safety panel's gate waits are example dwells per simulated truck,
// never output of the weighbridge queue model. The safety panel has no route in the
// console, so the API's basis is what is checked.
test("simulated gate waits say they are examples, not the queue model", async ({ page }) => {
  const token = await signIn(page, "/app/operations");
  const response = await page.request.get(`${API}/safety/overview`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const safety = await response.json();
  test.skip(safety.classification === "OBSERVED_APP_EVENTS", "this server holds observed app events");
  expect(safety.gate_wait_basis).toContain("not drawn from the weighbridge queue model");
});

// Numbers: "Open in XR" lands on the twin's selected day, so the tabletop and the
// twin print the same date and the same city tonnage for one scenario (judge: XR said
// Mon 26 / 9,505 t while the twin said Tue 27 / 9,548 t).
test("the twin hands XR its selected day: same date and the same tonnes", async ({ page }) => {
  await signIn(page, "/twin?scenario=gbk_event&day=1");
  await page.waitForFunction(
    () =>
      window.__pythiaTwin?.ready &&
      window.__pythiaTwin.selectedDay === 1 &&
      window.__pythiaTwin.scenario?.event_attendance === 50000,
    null,
    { timeout: 45000 },
  );
  const twin = await page.evaluate(() => ({
    date: window.__pythiaTwin.selectedDate,
    tons: window.__pythiaTwin.totalTons,
  }));
  const href = await page.getByTestId("twin-xr-link").getAttribute("href");
  expect(href).toContain("scenario=gbk_event");
  expect(href).toMatch(/[?&]day=1(&|$)/);

  await page.goto(href);
  const dateText = await page.evaluate(
    (iso) =>
      new Date(`${iso}T00:00:00`).toLocaleDateString("id-ID", {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
    twin.date,
  );
  await expect(page.getByTestId("xr-date")).toHaveText(dateText, { timeout: 45000 });
  await expect(page.getByTestId("xr-total")).toHaveText(`${Math.round(twin.tons).toLocaleString("id-ID")} t`);
});

// Numbers: the decision-room briefing's "today" queue and the twin HUD's queue are
// one simulation (scenario_queue_metric on today's forecast tonnes vs its normal day), so
// the twin screen never shows two answers for today's weighbridge wait.
test("the briefing's today queue is the twin HUD's queue", async ({ page }) => {
  const briefing = await apiJson(page, "/twin/briefing");
  const scene = await apiJson(page, "/twin/scene?city=jakarta&days=7&rainfall_mm=0");
  const hud = scene.landfill_queue.minutes_per_truck;
  expect(briefing.before.date).toBe(scene.horizon?.dates?.[0] ?? briefing.before.date);
  expect(briefing.before.weighbridge_lanes).toBe(hud.assumptions.weighbridge_lanes);
  expect(briefing.before.queue_trips_per_day).toBe(hud.trucks_per_day);
  expect(briefing.before.queue_minutes_per_truck).toBe(hud.baseline_mean);
  expect(briefing.before.queue_staggered_minutes_per_truck).toBe(hud.staggered_mean);
});
