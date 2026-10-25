// Pythia Twin — the 3D digital twin renders all 42 Jakarta
// districts from /api/twin/scene, a rainfall scenario raises district risk,
// the Ho Chi Minh City demo city is labelled as simulated, every layer shows
// its provenance, and the workspace stays touch-friendly at 390 px.
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function waitForTwin(page, predicate = "true") {
  await page.waitForFunction(`window.__pythiaTwin && window.__pythiaTwin.ready && (${predicate})`, null, {
    timeout: 45000,
  });
  return page.evaluate(() => {
    const { startTour, stopTour, setDay, setCity, setRainfall, setEventPreset, ...state } =
      window.__pythiaTwin;
    return state;
  });
}

async function openTwin(page) {
  await page
    .getByTestId("workspace-navigation")
    .getByRole("button", { name: "3D City", exact: true })
    .click();
  await expect(page.getByTestId("twin-workspace")).toBeVisible();
}

// wave9 fleet composition: the twin ("3D City") is the last workspace before Settings.
test("twin is in the rail and renders all 42 Jakarta districts with provenance", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await expect(page.getByTestId("workspace-navigation").getByRole("button").nth(4)).toHaveText("3D City");
  await openTwin(page);
  await expect(page.getByRole("heading", { name: "City waste digital twin" })).toBeVisible();

  const state = await waitForTwin(page);
  expect(state.city).toBe("jakarta");
  expect(state.districtCount).toBe(42);
  expect(state.selectedDay).toBe(0);
  expect(state.scenario.rainfall_mm).toBe(0);

  const cells = page.getByTestId("twin-workspace").getByTestId("metric-cell");
  await expect(cells).toHaveCount(4);
  for (const cell of await cells.all()) {
    await expect(cell.locator("strong")).not.toHaveText("—");
  }
  await expect(cells.first().locator("strong")).toHaveText(/^[\d,]+ t$/);

  // Data honesty: every layer carries its class, and nothing is labelled live.
  const provenance = page.getByTestId("twin-provenance");
  await expect(provenance.getByTestId("twin-provenance-districts")).toContainText("Model output");
  await expect(provenance.getByTestId("twin-provenance-tps")).toContainText("Real data");
  await expect(provenance.getByTestId("twin-provenance-trucks")).toContainText("Simulated");
  await expect(provenance.getByTestId("twin-provenance-landfill_queue")).toContainText("Simulated");
  await expect(provenance).not.toContainText(/live/i);
  await expect(page.getByTestId("twin-demo-banner")).toHaveCount(0);
  // The landfill queue label on the map states that the queue is simulated.
  expect(state.landfillLabel).toContain("Queue data: Simulated");

  // Day scrubber: picking a later day moves the selected day.
  await page.getByTestId("twin-day-3").click();
  await expect.poll(() => page.evaluate(() => window.__pythiaTwin.selectedDay)).toBe(3);
  await expect(page.getByTestId("twin-day-3")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("twin-day-0").click();

  expect(errors).toEqual([]);
});

test("rainfall scenario re-forecasts and raises districts at risk", async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page);
  await openTwin(page);
  const before = await waitForTwin(page);

  const slider = page.getByTestId("twin-rainfall");
  await slider.focus();
  for (let i = 0; i < 16; i += 1) await slider.press("ArrowRight");
  await expect(page.getByTestId("twin-rainfall-value")).toHaveText("80 mm");

  const after = await waitForTwin(
    page,
    "window.__pythiaTwin.scenario && window.__pythiaTwin.scenario.rainfall_mm === 80",
  );
  expect(after.districtCount).toBe(42);
  expect(after.districtsAtRisk).toBeGreaterThan(0);
  expect(after.districtsAtRisk).toBeGreaterThanOrEqual(before.districtsAtRisk);
  // Column heights follow tonnes: the rain scenario must grow the city load.
  expect(after.totalTons).toBeGreaterThan(before.totalTons);
  const riskCell = page.getByTestId("twin-workspace").getByTestId("metric-cell").nth(2);
  await expect(riskCell.locator("strong")).toHaveText(String(after.districtsAtRisk));

  // "Open in AR/XR" carries the scenario on screen to the tabletop.
  const xrLink = page.getByTestId("twin-xr-link");
  await expect(xrLink).toHaveAttribute("href", "/xr?city=jakarta&rainfall_mm=80");
  await page.getByTestId("twin-event-50k").click();
  await expect(xrLink).toHaveAttribute(
    "href",
    "/xr?city=jakarta&rainfall_mm=80&event_attendance=50000&event_lat=-6.2183&event_lng=106.8022",
  );
});

test("keyboard users can pin a district from the at-risk list", async ({ page }) => {
  await signIn(page);
  await openTwin(page);
  await waitForTwin(page);
  const list = page.getByTestId("twin-risk-list");
  const items = list.getByRole("button");
  await expect(items).toHaveCount(5);
  const first = items.first();
  const name = (await first.locator(".twin-risk-name").textContent()).trim();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("twin-detail")).toContainText(name);
  // The list is ordered by risk, then by change against a normal day.
  const ranks = await items.evaluateAll((buttons) =>
    buttons.map((b) => {
      const tag = b.querySelector(".twin-risk-tag");
      return ["risk-normal", "risk-elevated", "risk-high", "risk-critical"].findIndex((c) =>
        tag.classList.contains(c),
      );
    }),
  );
  expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
});

test("Ho Chi Minh City is labelled as a simulated demo city", async ({ page }) => {
  await signIn(page);
  await openTwin(page);
  await waitForTwin(page);

  await page.getByTestId("twin-city-hcmc").click();
  const state = await waitForTwin(page, "window.__pythiaTwin.city === 'hcmc'");
  expect(state.districtCount).toBeGreaterThan(0);
  const banner = page.getByTestId("twin-demo-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/simulated demo city/i);
  await expect(page.getByTestId("twin-provenance-districts")).toContainText("Simulated demo city");
  await expect(page.getByTestId("twin-provenance-trucks")).toContainText("Unavailable");
  // The shell header names the city on screen, so it follows the switch.
  // wave11 design system: the city context moved into the top-bar status chip.
  await expect(page.getByTestId("shell-status")).toContainText(/Ho Chi Minh/);

  await page.getByTestId("twin-city-jakarta").click();
  await waitForTwin(page, "window.__pythiaTwin.city === 'jakarta'");
  await expect(page.getByTestId("shell-status")).toContainText(/Jakarta/);
  await expect(banner).toHaveCount(0);
});

test("cinematic tour runs through its stops and can be stopped", async ({ page }) => {
  await signIn(page);
  await openTwin(page);
  await waitForTwin(page);
  await page.getByTestId("twin-tour").click();
  const caption = page.getByTestId("twin-tour-caption");
  await expect(caption).toBeVisible();
  await expect(caption).toContainText("1 / 4");
  await expect(caption).toContainText("Highest-risk district", { timeout: 15000 });
  await page.keyboard.press("Escape");
  await expect(caption).toBeHidden({ timeout: 5000 });
  await expect(page.getByTestId("twin-xr-link")).toHaveAttribute("href", "/xr?city=jakarta");

  // A tour is scripted for one city: switching city ends it.
  await page.evaluate(() => window.__pythiaTwin.startTour());
  await expect(caption).toBeVisible();
  await page.getByTestId("twin-city-hcmc").click();
  await expect(caption).toBeHidden({ timeout: 5000 });
  await waitForTwin(page, "window.__pythiaTwin.city === 'hcmc' && !window.__pythiaTwin.tourActive");
});

test("under reduced motion the tour uses jump cuts", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  await openTwin(page);
  await waitForTwin(page);
  await page.evaluate(() => window.__pythiaTwin.startTour());
  const caption = page.getByTestId("twin-tour-caption");
  await expect(caption).toContainText("1 / 4");
  await expect(caption).toContainText("2 / 4", { timeout: 6000 });
  await page.getByTestId("twin-tour-caption").getByRole("button").click();
  await expect(caption).toBeHidden();
});

test("twin stays touch-friendly with no horizontal overflow at 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "id");
  const nav = page.locator(".command-mobile-nav");
  await nav.getByRole("button", { name: "Kota 3D" }).click();
  await expect(page.getByTestId("twin-workspace")).toBeVisible();
  await waitForTwin(page);

  // Controls live in a bottom sheet; the map stays visible above it.
  const toggle = page.getByTestId("twin-sheet-toggle");
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId("twin-city-hcmc")).toBeHidden();
  await toggle.click();
  await expect(page.getByTestId("twin-city-hcmc")).toBeVisible();
  await expect(page.getByTestId("twin-map")).toBeVisible();

  const failures = await page.evaluate((min) => {
    const out = [];
    const selectors = [
      ".twin-workspace button",
      ".twin-workspace a",
      ".twin-workspace input[type=range]",
      ".command-mobile-nav button",
    ];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || style.display === "none" || style.visibility === "hidden")
          return;
        if (el.closest(".maplibregl-ctrl-attrib-inner")) return; // attribution text links
        if (r.width < min || r.height < min)
          out.push(
            `${selector} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
      });
    }
    return out;
  }, 44);
  expect(failures, failures.join(", ")).toEqual([]);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const width of [360, 320])
  test(`day buttons keep 44 px targets at ${width} px without page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await signIn(page, "id");
    await page.locator(".command-mobile-nav").getByRole("button", { name: "Kota 3D" }).click();
    await waitForTwin(page);
    const days = page.locator(".twin-day");
    await expect(days).toHaveCount(7);
    for (const day of await days.all()) {
      const box = await day.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    // The last day is reachable (scrolls inside the timeline if it must).
    await page.getByTestId("twin-day-0").focus();
    await page.keyboard.press("End");
    await expect.poll(() => page.evaluate(() => window.__pythiaTwin.selectedDay)).toBe(6);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

test("presentation HUD states that the landfill queue is simulated", async ({ page }) => {
  await signIn(page);
  await page.goto("/?present=1");
  // ?present=1 opens the twin full-screen over the shell (the nav sits under
  // the map, so it is not clicked); wait on the HUD itself.
  const hud = page.locator(".twin-present-hud");
  await expect(hud).toBeVisible({ timeout: 45000 });
  await expect(page.getByTestId("twin-present-queue")).toHaveText("Queue data: Simulated");
});

test("twin controls meet text contrast requirements", async ({ page }) => {
  await signIn(page, "id");
  await page
    .getByTestId("workspace-navigation")
    .getByRole("button", { name: "Kota 3D", exact: true })
    .click();
  await waitForTwin(page);
  await page.getByTestId("twin-city-hcmc").click();
  await waitForTwin(page, "window.__pythiaTwin.city === 'hcmc'");
  const results = await new AxeBuilder({ page })
    .include("[data-testid=twin-workspace]")
    .withRules(["color-contrast"])
    .analyze();
  expect(results.violations.map(({ nodes }) => nodes.map(({ target }) => target))).toEqual([]);

  // No layout-property transitions anywhere in the twin (#43 rule).
  const layoutTransitions = await page.evaluate(() => {
    const layout = /^(width|height|min-|max-|padding|margin|top|left|right|bottom)/;
    const bad = [];
    document.querySelectorAll("[data-testid=twin-workspace] *").forEach((el) => {
      const cs = getComputedStyle(el);
      const durations = cs.transitionDuration.split(", ");
      cs.transitionProperty.split(", ").forEach((prop, i) => {
        if ((prop === "all" || layout.test(prop)) && durations[i] && durations[i] !== "0s")
          bad.push(`${el.className} ${prop}`);
      });
    });
    return bad;
  });
  expect(layoutTransitions).toEqual([]);
});

// #twinrender (gsc-2026 teardown v2 #2): the blocks draw a roof silhouette, not
// wireframe "barcode" walls; district names are DOM chips over the scene that
// never overlap; the 42 haul arcs are thinned to the heaviest districts plus one bundle.
test("district blocks have no wireframe stripes, labels sit on top without overlapping, arcs are thinned", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/twin");
  const state = await waitForTwin(page, "window.__pythiaTwin.outlinedDistricts === 42");

  const layer = (id) => page.evaluate((layerId) => window.__pythiaTwin.inspectLayer(layerId), id);
  const blocks = await layer("twin-districts");
  expect(blocks).toMatchObject({ count: 42, extruded: true, wireframe: false });
  expect((await layer("twin-district-roofs")).count).toBe(42);
  // Names are no longer a depth-tested text layer buried in the geometry.
  expect(await layer("twin-district-labels")).toBeNull();

  // 8 named arcs + 1 bundle carrying the other 34 districts.
  expect(state.flowArcs).toBe(9);
  expect(state.flowBundled).toBe(34);
  expect((await layer("twin-flows")).count).toBe(9);

  // The map names the top three districts the risk list ranks, in that order (wave11 twin:
  // fewer names so the at-risk colour reads first).
  const listed = await page
    .getByTestId("twin-risk-list")
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((b) => b.dataset.testid.replace("twin-risk-item-", "")));
  expect(state.labelledDistricts).toEqual(listed.slice(0, 3));
  const labels = page.getByTestId("twin-label");
  await expect(labels).toHaveCount(3);
  await expect(page.locator('[data-testid=twin-label][data-placed="true"]').first()).toBeVisible();

  const geometry = await page.evaluate(() => {
    const map = document.querySelector("[data-testid=twin-map]").getBoundingClientRect();
    const tag = document.querySelector("[data-testid=twin-landfill-tag]")?.getBoundingClientRect();
    const placed = [...document.querySelectorAll('[data-testid=twin-label][data-placed="true"]')].map((el) =>
      el.getBoundingClientRect(),
    );
    const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    let overlaps = 0;
    placed.forEach((a, i) =>
      placed.slice(i + 1).forEach((b) => {
        if (hit(a, b)) overlaps += 1;
      }),
    );
    const layer = document.querySelector("[data-testid=twin-labels]");
    return {
      placed: placed.length,
      overlaps,
      onTag: tag ? placed.filter((r) => hit(r, tag)).length : 0,
      inside: placed.every(
        (r) => r.left >= map.left && r.top >= map.top && r.right <= map.right && r.bottom <= map.bottom,
      ),
      // DOM order puts the label layer after the canvas, so it paints over it.
      afterCanvas: Boolean(
        layer &&
        document.querySelector("[data-testid=twin-map]").compareDocumentPosition(layer) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    };
  });
  expect(geometry.placed).toBeGreaterThanOrEqual(2);
  expect(geometry).toMatchObject({ overlaps: 0, onTag: 0, inside: true, afterCanvas: true });

  // The selected district's label is marked, and leads the placement order.
  await page.getByTestId("twin-risk-list").getByRole("button").nth(1).click();
  await expect(page.locator(".twin-label.is-selected")).toHaveAttribute("data-district", listed[1]);
  await expect(labels.first()).toHaveAttribute("data-district", listed[1]);
});

// #twinrender (teardown v2 #2): a crowd event shows where it is: a pin over the
// roofs and a ring at the reach the scene states (scenario.event.radius_m: the
// kecamatan whose real boundary lies within it share the crowd).
test("a crowd event pins its venue with the scene's boundary-reach ring", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/twin?event=50k&venue=jis");
  const state = await waitForTwin(page, "window.__pythiaTwin.scenario.event_attendance === 50000");
  expect(state.scenario.event.radius_m).toBe(1000);
  expect(state.venuePin).toMatchObject({ name: "JIS", radiusM: 1000 });
  expect(state.venuePin.reached).toBe(state.scenario.event.districts.length);
  expect(state.venuePin.lat).toBeCloseTo(-6.1246, 3);

  const layer = (id) => page.evaluate((layerId) => window.__pythiaTwin.inspectLayer(layerId), id);
  expect(await layer("twin-venue-pin")).toMatchObject({ count: 1, depthCompare: "always" });
  expect(await layer("twin-venue-ring")).toMatchObject({ count: 1, depthCompare: "always" });
  const label = page.getByTestId("twin-venue-label");
  await expect(label).toHaveText(/JIS\s*1 km reach · \d+ districts share the crowd/);
  await expect(label).toHaveAttribute("data-placed", "true");
  await expect(label).toBeVisible();

  // No event, no pin.
  await page.getByTestId("twin-event-none").click();
  await waitForTwin(page, "!window.__pythiaTwin.scenario.event_attendance");
  await expect(page.getByTestId("twin-venue-label")).toHaveCount(0);
  expect(await layer("twin-venue-pin")).toBeNull();
});

// #twinrender (teardown v2 #4): the beacon says its peak hour is the unstaggered
// day and puts the staggered value beside it; the band is a range over assumed
// departure spreads, not a confidence interval; trucks vs gate trips are explained.
for (const [lang, copy] of [
  [
    "en",
    {
      peak: /Without stagger · Peak hour \d{2}:00 \(modelled\): [\d,]+ trucks queued · [\d,]+ min wait/,
      day: /Day average [\d.,]+ min\/truck without stagger → [\d.,]+ with Pythia stagger/,
      staggered: "With Pythia stagger, same hour: 12 queued · 9 min wait",
      band: /^TPA weighbridge queue, (day|selected-day) average: [\d.,]+ min\/truck without stagger \(range [\d.,]+–[\d.,]+ if departure spread is 10–60 min, assumed\) → [\d.,]+ with Pythia stagger .*\(Simulated\)$/,
      trips: /≈[\d.,]+ TPA gate trips each \([\d,]+ trips\/day, (real median|scaled real median)\)/,
    },
  ],
  [
    "id",
    {
      peak: /Tanpa keberangkatan bertahap · Jam puncak \d{2}:00 \(model\): [\d.]+ truk antre · tunggu [\d.]+ mnt/,
      day: /Rata-rata harian [\d.,]+ mnt\/truk tanpa bertahap → [\d.,]+ dengan bertahap Pythia/,
      staggered: "Dengan bertahap Pythia, jam yang sama: 12 truk antre · tunggu 9 mnt",
      band: /^Antre timbang TPA, rata-rata (sehari|hari terpilih): [\d.,]+ mnt\/truk tanpa bertahap \(rentang [\d.,]+–[\d.,]+ bila sebaran keberangkatan 10–60 mnt, asumsi\) → [\d.,]+ dengan bertahap Pythia .*\(Simulasi\)$/,
      trips: /≈[\d.,]+ rit gerbang TPA per truk \([\d.]+ rit\/hari, (median riil|median riil diskalakan)\)/,
    },
  ],
])
  test(`landfill beacon names the unstaggered peak hour and the staggered value (${lang})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, lang);
    // The staggered arm at the same modelled hour (landfill_queue.peak_hour.staggered):
    // pin its figures so the copy is checked against known numbers.
    await page.route(/\/twin\/scene\?/, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      const queue = json.landfill_queue;
      if (queue?.peak_hour?.staggered)
        queue.peak_hour.staggered = {
          ...queue.peak_hour.staggered,
          hour: queue.modelled_hour,
          queue_trucks_max: 12,
          mean_wait_minutes: 9,
        };
      await route.fulfill({ response, json });
    });
    await page.goto("/twin?present=1");
    await waitForTwin(page);
    const tag = page.getByTestId("twin-landfill-tag");
    await expect(tag).toContainText(copy.peak);
    await expect(tag).toContainText(copy.staggered);
    await expect(tag).toContainText(copy.day);
    await expect(page.getByTestId("twin-present-queue-metric")).toHaveText(copy.band);
    await expect(page.getByTestId("twin-present-queue-metric")).not.toContainText(/\(\d[\d.,]*–\d[\d.,]*\)/);
    await expect(
      page.getByTestId("twin-workspace").getByTestId("metric-cell").nth(3).locator("small"),
    ).toHaveText(copy.trips);
  });
