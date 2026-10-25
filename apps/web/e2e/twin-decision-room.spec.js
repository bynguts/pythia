// wave10 twin decision room: the twin is where this week's scenario is decided. A briefing
// scenario puts today's canonical baseline (the Prediksi / Rencana figures) beside the
// scenario, goes to Rencana, and opens on the XR table with the same numbers; the table's
// agreement reaches the plan as a session note. /xr says why AR is off and links back.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const fmt = (n) => Math.round(n).toLocaleString("en-GB");

async function login(page) {
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function signIn(page, lang = "en") {
  await page.goto("/");
  const principal = await login(page);
  await page.evaluate(
    ({ token, role, lang }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
      localStorage.removeItem("pythia_table_origin");
      sessionStorage.removeItem("pythia_table_session");
    },
    { ...principal, lang },
  );
  return principal;
}

async function waitForTwin(page, predicate = "true") {
  await page.waitForFunction(`window.__pythiaTwin && window.__pythiaTwin.ready && (${predicate})`, null, {
    timeout: 45000,
  });
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__pythiaTwin)));
}

async function waitForBriefing(page, scenario) {
  const card = page.getByTestId("twin-briefing");
  await expect(card).toHaveAttribute("data-scenario", scenario, { timeout: 45000 });
  await expect(card).toHaveAttribute("data-state", "ready", { timeout: 45000 });
  return card;
}

async function waitForXr(page) {
  await page.waitForFunction(
    () => window.__pythiaXr && window.__pythiaXr.ready === true && window.__pythiaXr.mode !== "detecting",
    null,
    { timeout: 45000 },
  );
  return page.evaluate(() => ({ ...window.__pythiaXr }));
}

const cell = (page, side, metric) => page.getByTestId(`twin-briefing-${side}-${metric}`);
const value = async (page, side, metric) => Number(await cell(page, side, metric).getAttribute("data-value"));

async function noHorizontalOverflow(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBeTruthy();
}

test.describe("twin decision room", () => {
  test.setTimeout(120000);

  test("a briefing scenario sits beside the canonical baseline and changes the numbers", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.goto("/twin");
    await waitForTwin(page);
    await waitForBriefing(page, "none");

    // "Today" is the one baseline Prediksi and Rencana print, not a twin recomputation.
    const base = await (await page.request.get(`${API}/baseline/today`)).json();
    expect(await value(page, "before", "tons")).toBe(base.total_tonnage_t);
    expect(await value(page, "before", "trucks")).toBe(base.trucks_needed);
    await expect(cell(page, "before", "tons")).toHaveText(`${fmt(base.total_tonnage_t)} t`);
    await expect(cell(page, "after", "tons")).toHaveText("—");
    await expect(page.getByTestId("twin-apply-plan")).toBeDisabled();
    // Each row says which model it comes from.
    const table = page.getByTestId("twin-briefing-table");
    await expect(table.locator("tr[data-metric=tons] th")).toContainText("Model output");
    await expect(table.locator("tr[data-metric=queue] th")).toContainText("Simulated");

    await page.getByTestId("twin-briefing-heavy_rain").click();
    await expect(page.getByTestId("twin-briefing-heavy_rain")).toHaveAttribute("aria-pressed", "true");
    await waitForBriefing(page, "heavy_rain");
    const rainTons = await value(page, "after", "tons");
    expect(rainTons).toBeGreaterThan(base.total_tonnage_t);
    expect(await value(page, "after", "trucks")).toBeGreaterThanOrEqual(base.trucks_needed);
    expect(await value(page, "after", "queue")).toBeGreaterThanOrEqual(await value(page, "before", "queue"));
    expect(await value(page, "before", "tons")).toBe(base.total_tonnage_t);
    // The map shows the same scenario on today, with the same total.
    const rainState = await waitForTwin(page, "window.__pythiaTwin.scenario.rainfall_mm === 50");
    expect(rainState.selectedDay).toBe(0);
    expect(Math.round(rainState.totalTons)).toBe(Math.round(rainTons));
    await expect(page).toHaveURL(/[?&]scenario=heavy_rain/);
    await expect(page.getByTestId("twin-rainfall-value")).toHaveText("50 mm");
    // The KPI strip now holds scenario values: each tile names the scenario, with its
    // change against today's baseline, and never calls them a forecast.
    const tiles = page.getByTestId("twin-workspace").getByTestId("metric-cell");
    const totalTile = tiles.nth(0).locator("small");
    await expect(totalTile).toContainText("Scenario: Heavy rain 50 mm");
    await expect(totalTile).toContainText(`vs today (${fmt(base.total_tonnage_t)} t)`);
    await expect(totalTile).not.toContainText("forecast for");
    await expect(tiles.nth(2).locator("small")).toContainText("Scenario: Heavy rain 50 mm");
    await expect(tiles.nth(3).locator("small")).toContainText(
      `vs today (${base.trucks_needed.toLocaleString("en-GB")})`,
    );

    await page.getByTestId("twin-briefing-gbk_event").click();
    await waitForBriefing(page, "gbk_event");
    const eventTons = await value(page, "after", "tons");
    expect(eventTons).not.toBe(rainTons);
    expect(eventTons).toBeGreaterThan(base.total_tonnage_t);
    const eventState = await waitForTwin(page, "window.__pythiaTwin.scenario.event_attendance === 50000");
    expect(eventState.venue).toBe("gbk");
    expect(eventState.scenario.rainfall_mm).toBe(0);

    // A hand edit leaves the briefing scenario (the numbers would no longer be its own).
    await page.getByTestId("twin-rainfall").fill("80");
    await waitForBriefing(page, "none");
    await expect(page.getByTestId("twin-briefing-gbk_event")).toHaveAttribute("aria-pressed", "false");
    await expect(page).not.toHaveURL(/[?&]scenario=/);
    // A hand-made what-if is labelled the same way, against the normal day.
    await waitForTwin(page, "window.__pythiaTwin.scenario.rainfall_mm === 80");
    await expect(totalTile).toContainText("Scenario: manual what-if");
    await expect(totalTile).toContainText("vs a normal day");
    await expect(totalTile).not.toContainText("forecast for");
  });

  test("Terapkan ke Rencana lands on /planning with the scenario", async ({ page }) => {
    await signIn(page, "id");
    await page.goto("/twin?scenario=gbk_event");
    await waitForTwin(page, "window.__pythiaTwin.scenario.event_attendance === 50000");
    await waitForBriefing(page, "gbk_event");
    const apply = page.getByTestId("twin-apply-plan");
    await expect(apply).toHaveText("Terapkan ke Rencana");
    const { date } = await (await page.request.get(`${API}/twin/scenarios`)).json();
    await apply.click();
    // Rencana's contract: the scenario id plus the inputs it ran on.
    await expect(page).toHaveURL(
      new RegExp(`/planning\\?scenario=gbk_event&rain_mm=0&attendance=50000&venue=gbk&date=${date}$`),
    );
  });

  test("a closed weighbridge lane changes only the queue, labelled as an assumption", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.goto("/twin");
    await waitForTwin(page);
    await waitForBriefing(page, "none");
    await page.getByTestId("twin-briefing-weighbridge_lane_down").click();
    await waitForBriefing(page, "weighbridge_lane_down");
    // Same day, same waste and trucks; one lane fewer makes the simulated queue longer.
    expect(await value(page, "after", "tons")).toBe(await value(page, "before", "tons"));
    expect(await value(page, "after", "trucks")).toBe(await value(page, "before", "trucks"));
    expect(await value(page, "after", "queue")).toBeGreaterThan(await value(page, "before", "queue"));
    await expect(page.getByTestId("twin-briefing-assumption")).toHaveText(
      "assumption: 1 of 4 weighbridge lanes closed (not a reported closure)",
    );
    const queueAfter = await value(page, "after", "queue");
    const { date } = await (await page.request.get(`${API}/twin/scenarios`)).json();
    await page.getByTestId("twin-apply-plan").click();
    await expect(page).toHaveURL(
      new RegExp(`/planning\\?scenario=weighbridge_lane_down&rain_mm=0&attendance=0&lanes=3&date=${date}$`),
    );

    // The XR table prints the same lane-closed queue, with the same assumption.
    await page.goto("/xr?city=jakarta&scenario=weighbridge_lane_down");
    await waitForXr(page);
    const minutes = queueAfter.toLocaleString("en", { maximumFractionDigits: 1 });
    await expect(page.getByTestId("xr-num-queue")).toHaveText(minutes, { timeout: 45000 });
    await expect(page.locator(".xr-numbers [data-metric=queue]")).toContainText(
      "assumption: 1 of 4 weighbridge lanes closed",
    );
  });

  test("the TPA tooltip opens on tap only and the method sits under the controls", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.goto("/twin");
    await waitForTwin(page);
    const tag = page.getByTestId("twin-landfill-tag");
    await expect(tag).toBeVisible();
    await expect(tag).toHaveAttribute("aria-expanded", "false");
    await expect(tag).toContainText("Queue data: Simulated");
    await expect(tag).not.toContainText("Peak hour");
    await tag.click();
    await expect(tag).toHaveAttribute("aria-expanded", "true");
    await expect(tag).toContainText(/Peak hour \d{2}:00 \(modelled\)/);
    await tag.click();
    await expect(tag).not.toContainText("Peak hour");

    // T3: the rain methodology is folded into "Method", after the scenario controls.
    const method = page.getByTestId("twin-method");
    await expect(method).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("twin-rain-response")).toBeHidden();
    const [rainBox, methodBox] = await Promise.all([
      page.getByTestId("twin-rainfall").boundingBox(),
      method.boundingBox(),
    ]);
    expect(methodBox.y).toBeGreaterThan(rainBox.y);
    await method.locator("summary").click();
    await expect(page.getByTestId("twin-rain-response")).toBeVisible();
  });

  test("the table handoff warns that an http:// address cannot start AR", async ({ page }) => {
    await signIn(page);
    await page.goto("/twin");
    await waitForTwin(page);
    await page.getByTestId("twin-briefing-table-open").click();
    const dialog = page.getByTestId("twin-handoff");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("twin-handoff-code")).toHaveText(/^[A-Z0-9]{6}$/);
    const origin = page.getByTestId("twin-handoff-origin");
    await origin.fill("http://192.168.1.20:5175");
    const warning = page.getByTestId("twin-handoff-http-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("AR will not start");
    await expect(warning).toContainText("https://");
    await origin.fill("https://pythia.example.org");
    await expect(warning).toHaveCount(0);
    await expect(page.getByTestId("twin-handoff-url")).toHaveText(/^https:\/\/pythia\.example\.org\/xr\?/);
    await page.getByTestId("twin-handoff-stop").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("twin-briefing-table-open")).toBeFocused();
  });

  test("the XR table shows the same scenario and numbers, why AR is off, and the way back", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await signIn(page);
    const briefing = await (await page.request.get(`${API}/twin/briefing?scenario=heavy_rain`)).json();
    await page.goto("/xr?city=jakarta&scenario=heavy_rain&lang=en");
    const state = await waitForXr(page);
    expect(state.mode).toBe("orbit");
    expect(state.rainfall_mm).toBe(50);

    await expect(page.getByTestId("xr-scenario-heavy_rain")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("xr-briefing-name")).toHaveText("On the table: Heavy rain 50 mm");
    // X4: three numbers, the twin briefing's own, today's baseline under each.
    await expect(page.getByTestId("xr-num-tons")).toHaveText(`${fmt(briefing.after.total_tonnage_t)} t`);
    await expect(page.getByTestId("xr-num-trucks")).toHaveText(fmt(briefing.after.trucks_needed));
    await expect(page.getByTestId("xr-num-tons-before")).toHaveText(
      `today ${fmt(briefing.before.total_tonnage_t)} t`,
    );
    await expect(page.getByTestId("xr-numbers").locator("dt")).toHaveCount(3);
    await expect(page.getByTestId("xr-method")).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("xr-readout")).toBeHidden();

    // X1: a capability banner, not a silent fallback.
    const banner = page.getByTestId("xr-orbit-hint");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-reason", "no-webxr");
    await expect(banner).toContainText("AR needs HTTPS + Chrome on Android with ARCore");
    await expect(banner).toContainText("Now: the 3D table on screen");

    // X1: back to the twin on the same city, day and scenario.
    const back = page.getByTestId("xr-back");
    await expect(back).toHaveAttribute("href", /^\/twin\?city=jakarta&scenario=heavy_rain/);
    const box = await back.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await back.click();
    await expect(page).toHaveURL(/\/twin\?city=jakarta&scenario=heavy_rain/);
    await waitForTwin(page, "window.__pythiaTwin.scenario.rainfall_mm === 50");
    await expect(page.getByTestId("twin-briefing-heavy_rain")).toHaveAttribute("aria-pressed", "true");
  });

  test("agreeing at the table reaches Rencana as a session note", async ({ page }) => {
    const { token } = await signIn(page);
    await page.goto("/xr?city=jakarta&scenario=gbk_event&lang=en");
    await waitForXr(page);
    await page.getByTestId("xr-agree").click();
    await expect(page.getByTestId("xr-agreed")).toHaveText(
      "Agreed at the table and sent to Planning as a session note, not an official approval.",
    );
    await page.waitForFunction(() => Boolean(window.__pythiaXr?.sessionCode));
    const code = await page.evaluate(() => window.__pythiaXr.sessionCode);
    const headers = { Authorization: `Bearer ${token}` };
    await expect
      .poll(async () => {
        const res = await page.request.get(`${API}/twin/agreements?scenario=gbk_event`, { headers });
        return (await res.json()).agreements.map((note) => note.session_code);
      })
      .toContain(code);
    const [note] = (
      await (await page.request.get(`${API}/twin/agreements?scenario=gbk_event`, { headers })).json()
    ).agreements.filter((n) => n.session_code === code);
    expect(note.official).toBe(false);
    expect(note.participants).toBeGreaterThanOrEqual(1);

    // Withdrawing the agreement withdraws the note.
    await page.getByTestId("xr-agree").click();
    await expect
      .poll(async () => {
        const res = await page.request.get(`${API}/twin/agreements?scenario=gbk_event`, { headers });
        return (await res.json()).agreements.map((n) => n.session_code);
      })
      .not.toContain(code);
  });

  test("390 px: briefing, tooltip and table fit without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "id");
    await page.goto("/twin");
    await waitForTwin(page);
    await waitForBriefing(page, "none");
    await noHorizontalOverflow(page);
    await page.getByTestId("twin-briefing-heavy_rain").click();
    await waitForBriefing(page, "heavy_rain");
    await expect(page.getByTestId("twin-apply-plan")).toBeEnabled();
    await noHorizontalOverflow(page);
    for (const id of ["twin-briefing-heavy_rain", "twin-apply-plan", "twin-briefing-table-open"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box.height, id).toBeGreaterThanOrEqual(44);
    }
    // The folded tooltip stays inside the map window.
    const tag = page.getByTestId("twin-landfill-tag");
    await expect(tag).toHaveAttribute("aria-expanded", "false");
    const [mapBox, tagBox] = await Promise.all([
      page.getByTestId("twin-map").boundingBox(),
      tag.boundingBox(),
    ]);
    expect(tagBox.y + tagBox.height).toBeLessThanOrEqual(mapBox.y + mapBox.height);

    await page.goto("/xr?city=jakarta&scenario=gbk_event&lang=id");
    await waitForXr(page);
    await noHorizontalOverflow(page);
    const back = page.getByTestId("xr-back");
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("aria-label", "Kembali ke Kota 3D");
  });
});
