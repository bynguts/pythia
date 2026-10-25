// wave9 numbers coherence: one "today" (GET /api/baseline/today) behind every headline,
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

// "52 aktif / 59 unit" → { active: 52, total: 59 }. wave11 fleet: the Fleet tile prints
// "52 / 59 unit" under its "Truk aktif" label, so "aktif" is optional there.
async function denominatorOf(locator) {
  const text = (await locator.textContent()) || "";
  const match = text.match(/(\d+)(?: aktif)? \/ (\d+) unit/);
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

test("Prediksi, Rencana and the twin print the same today", async ({ page }) => {
  await signIn(page, "/forecast");
  const baseline = await apiJson(page, "/baseline/today?days=7");
  expect(baseline.kind).toBe("baseline");

  const total = page.getByTestId("baseline-total");
  await expect(total).toBeVisible({ timeout: 30000 });
  expect(await numberOf(total)).toBe(baseline.total_tonnage_t);
  expect(await numberOf(page.getByTestId("baseline-at-risk"))).toBe(baseline.kecamatan_at_risk);
  expect(await numberOf(page.getByTestId("baseline-trucks"))).toBe(baseline.trucks_needed);

  await page.goto("/planning");
  const outlook = page.getByTestId("plan-outlook");
  await expect(outlook).toHaveAttribute("data-kind", "baseline", { timeout: 30000 });
  await expect(page.getByTestId("plan-scenario-badge")).toHaveCount(0);
  expect(await numberOf(page.getByTestId("plan-total"))).toBe(baseline.total_tonnage_t);
  expect(await numberOf(page.getByTestId("plan-at-risk"))).toBe(baseline.kecamatan_at_risk);
  expect(await numberOf(page.getByTestId("plan-trucks"))).toBe(baseline.trucks_needed);

  // The twin's briefing "today" column is the same call (forecast/baseline.build_outlook).
  const briefing = await apiJson(page, "/twin/briefing");
  expect(briefing.before.total_tonnage_t).toBe(baseline.total_tonnage_t);
  expect(briefing.before.trucks_needed).toBe(baseline.trucks_needed);
  expect(briefing.before.kecamatan_at_risk).toBe(baseline.kecamatan_at_risk);
});

test("a what-if is labelled Skenario and keeps the baseline beside it", async ({ page }) => {
  await signIn(page, "/planning?scenario=gbk_event&attendance=200000&venue=gbk");
  const outlook = page.getByTestId("plan-outlook");
  await expect(outlook).toHaveAttribute("data-kind", "scenario", { timeout: 30000 });
  await expect(page.getByTestId("plan-scenario-badge")).toHaveText("Skenario");
  const baseline = await apiJson(page, "/baseline/today?days=7");
  await expect(page.getByTestId("plan-delta")).toContainText(
    baseline.total_tonnage_t.toLocaleString("id-ID", { maximumFractionDigits: 2 }),
  );
  expect(await numberOf(page.getByTestId("plan-total"))).toBeGreaterThan(baseline.total_tonnage_t);
});

test("every screen shows the same fleet denominator", async ({ page }) => {
  const token = await signIn(page, "/fleet");
  // wave9 fleet composition: the fleet table left /fleet; the "Truk aktif" tile carries it.
  await expectFleetDenominator(page, page.locator("[data-metric=active]"));

  // The simulated safety roster is the fleet roster (no orphan corridor unit). Once the
  // driver app has logged events on this server the panel lists only observed trucks.
  const overview = await page.request.get(`${API}/safety/overview`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(overview.ok()).toBeTruthy();
  const safety = await overview.json();
  const { fleet } = await apiJson(page, "/baseline/today?days=7");
  if (safety.classification !== "OBSERVED_APP_EVENTS") {
    expect(safety.trucks.length).toBe(fleet.total);
    await page.locator('[role="tab"][aria-controls="fleet-safety-surface"]').click();
    const showAll = page.getByTestId("safety-show-all");
    await expect(showAll).toBeVisible({ timeout: 20000 });
    expect(await numberOf(showAll)).toBe(fleet.total);
  }

  await page.goto("/planning");
  await expectFleetDenominator(page, page.getByTestId("fleet-denominator"));

  await page.goto("/drivers");
  await expectFleetDenominator(page, page.getByTestId("drivers-fleet-denominator"));
});

test("the recommendation never exceeds the pilot fleet", async ({ page }) => {
  await signIn(page, "/planning?scenario=custom&attendance=200000&rain_mm=100&venue=gbk");
  await expect(page.getByTestId("plan-outlook")).toHaveAttribute("data-kind", "scenario", {
    timeout: 30000,
  });
  const scenario = await apiJson(
    page,
    "/baseline/scenario?rainfall_mm=100&event_attendance=200000&venue=gbk&days=7",
  );
  const rec = scenario.recommendation;
  const reserve = Math.max(0, scenario.fleet.total - scenario.fleet.active);
  expect(rec.fleet_reserve).toBe(reserve);
  expect(rec.deployable_trucks).toBeLessThanOrEqual(reserve);
  expect(rec.deployable_trucks + rec.shortfall_trucks).toBe(rec.extra_trucks_needed);

  // The executive summary and the preflight state the shortfall; neither asks for "+N truk".
  const summary = page.locator(".planning-summary");
  await expect(page.getByTestId("exec-headline")).not.toHaveText("", { timeout: 30000 });
  await expect(summary).not.toContainText(/\+\s*\d[\d.]*\s*(truk|kru)/);
  await expect(page.getByTestId("plan-extra-need")).not.toContainText("+");
  if (rec.shortfall_trucks > 0) {
    await expect(summary).toContainText(/kekurangan \d+ truk/);
    await expect(page.getByTestId("plan-extra-need")).toContainText(/kekurangan \d+/);
  }
});

test("a closed weighbridge lane from the twin changes only the TPA queue in Rencana", async ({ page }) => {
  const briefing = await apiJson(page, "/twin/briefing?scenario=weighbridge_lane_down");
  expect(briefing.after.weighbridge_lanes).toBe(3);
  await signIn(
    page,
    `/planning?scenario=weighbridge_lane_down&rain_mm=0&attendance=0&lanes=3&date=${briefing.date}`,
  );
  const outlook = page.getByTestId("plan-outlook");
  await expect(outlook).toHaveAttribute("data-kind", "scenario", { timeout: 30000 });
  await expect(page.getByTestId("plan-scenario-badge")).toHaveText("Skenario");
  await expect(outlook).toContainText("1 jalur timbang ditutup");
  await expect(page.getByTestId("plan-lanes-note")).toContainText(
    "asumsi: 1 dari 4 jalur timbang ditutup: tonase dan kebutuhan truk sama",
  );

  // Tonnes and trucks are today's baseline: the lane scenario invents no tonnage change.
  const baseline = await apiJson(page, "/baseline/today?days=7");
  expect(await numberOf(page.getByTestId("plan-total"))).toBe(baseline.total_tonnage_t);
  expect(await numberOf(page.getByTestId("plan-trucks"))).toBe(baseline.trucks_needed);
  await expect(page.getByTestId("plan-delta")).toHaveCount(0);

  // The queue before/after is the twin briefing's simulated queue.
  if (briefing.before.queue_minutes_per_truck != null && briefing.after.queue_minutes_per_truck != null) {
    const queue = page.getByTestId("plan-lanes-queue");
    await expect(queue).toHaveAttribute("data-before", String(briefing.before.queue_minutes_per_truck));
    await expect(queue).toHaveAttribute("data-after", String(briefing.after.queue_minutes_per_truck));
    await expect(queue).toContainText("Antre timbang TPA, rata-rata sehari (simulasi)");
  }
});

test("an agreement at the XR table shows in Rencana as a session note, not an approval", async ({ page }) => {
  // A table session agrees on the GBK briefing scenario (the same write /xr makes).
  const code = `W${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const agree = (agreed) =>
    page.request.put(`${API}/xr/session/${code}`, {
      data: { city: "jakarta", scenario_id: "gbk_event", agreed },
    });
  expect((await agree(true)).ok()).toBeTruthy();
  const { date } = await apiJson(page, "/twin/briefing");
  try {
    const token = await signIn(
      page,
      `/planning?scenario=gbk_event&rain_mm=0&attendance=50000&venue=gbk&date=${date}`,
    );
    await expect(page.getByTestId("plan-outlook")).toHaveAttribute("data-kind", "scenario", {
      timeout: 30000,
    });
    const note = page.getByTestId("plan-xr-agreed");
    await expect(note).toBeVisible({ timeout: 15000 });
    await expect(note).toContainText(/Disepakati di meja XR · \d+ perangkat/);
    await expect(note).toContainText("bukan persetujuan resmi");

    // Withdrawing at the table withdraws the note once no other table agreed on it.
    expect((await agree(false)).ok()).toBeTruthy();
    const standing = await page.request.get(`${API}/twin/agreements?scenario=gbk_event&date=${date}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if ((await standing.json()).agreements.length === 0) {
      await page.reload();
      await expect(page.getByTestId("plan-outlook")).toHaveAttribute("data-kind", "scenario", {
        timeout: 30000,
      });
      await expect(note).toHaveCount(0);
    }
  } finally {
    await agree(false);
  }
});

// wave11 numbers: a queue figure says which quantity it is. The modelled peak hour's wait
// per truck and the whole day's average per truck are the weighbridge stage of one
// simulated normal day, so they differ by definition. wave11 fleet: the Fleet tile headlines
// the staggered day average and names the peak hour's wait in its meta line.
test("the peak-hour wait and the day average name different quantities", async ({ page }) => {
  const status = await apiJson(page, "/tpa/queue-status");
  const metric = await apiJson(page, "/tpa/queue-metric");
  expect(status.quantity).toBe("peak_hour_mean_per_truck");
  expect(metric.quantity).toBe("day_mean_per_truck");
  expect(status.stage).toMatch(/^weighbridge \(gate\) stage only/);
  expect(metric.stage).toBe(status.stage);
  expect(status.trucks_per_day).toBe(metric.trucks_per_day);

  await signIn(page, "/fleet");
  const tile = page.getByTestId("metric-strip").locator("[data-metric=queue]");
  await expect(tile.locator(".metric-meta")).toContainText(
    `±${Math.trunc(status.avg_wait_minutes)} mnt/truk`,
    { timeout: 30000 },
  );
  await expect(tile.locator("strong")).toHaveText(/^\d+(,\d)? mnt\/truk$/);
  await expect(tile).toContainText(/antre timbang, hari normal/i);

  await page.getByRole("tab", { name: /Antrean TPA/ }).click();
  const headline = page.getByTestId("tpa-queue-metric");
  await expect(headline).toContainText("Antre timbang TPA: rata-rata sehari per truk", { timeout: 30000 });
  await expect(headline.locator("strong")).toContainText(
    `${metric.baseline_mean} → ${metric.staggered_mean}`,
  );
});

// wave11 numbers: trucks are units (tonnes / truck capacity per shift), gate trips are rit
// from the real weighing data, and the tonnage is modelled generation read against SIPSN.
test("trucks, gate trips and tonnage each carry their own definition", async ({ page }) => {
  const baseline = await apiJson(page, "/baseline/today?days=7");
  const metric = await apiJson(page, "/tpa/queue-metric");
  expect(baseline.trucks_basis).toContain("not TPA gate trips");
  expect(baseline.gate_trips.trips_per_day).toBe(metric.normal_day.trucks_per_day);
  expect(baseline.gate_trips.trips_per_day).not.toBe(baseline.trucks_needed);
  expect(baseline.tonnage_reference.classification).toBe("REAL");
  expect(baseline.provenance.tonnage).toBe("MODEL_OUTPUT");

  await signIn(page, "/forecast");
  const trucks = page.getByTestId("baseline-trucks");
  await expect(trucks).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Kebutuhan truk (unit)").first()).toBeVisible();
});

// wave11 numbers: the safety panel's gate waits are example dwells per simulated truck,
// never output of the weighbridge queue model, and the panel says so.
test("simulated gate waits say they are examples, not the queue model", async ({ page }) => {
  const token = await signIn(page, "/fleet");
  const response = await page.request.get(`${API}/safety/overview`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const safety = await response.json();
  test.skip(safety.classification === "OBSERVED_APP_EVENTS", "this server holds observed app events");
  expect(safety.gate_wait_basis).toContain("not drawn from the weighbridge queue model");
  await page.locator('[role="tab"][aria-controls="fleet-safety-surface"]').click();
  await expect(page.getByTestId("safety-basis")).toContainText("bukan keluaran model antre timbang", {
    timeout: 20000,
  });
});

// wave11 numbers: "Open in XR" lands on the twin's selected day, so the tabletop and the
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

// wave11 numbers: the decision-room briefing's "today" queue and the twin HUD's queue are
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
