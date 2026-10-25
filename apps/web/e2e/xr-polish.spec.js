// #xr-polish: teardown v3 #9 on /xr — the twin's haul arcs (top 8 by the day's
// tonnes plus one bundle), a placeholder that fits a phone, no "event 0 people",
// the rain source in the one-line header, the forecast fetch time, and session
// writes from another client (the twin's handoff) reaching an open table.
import { expect, test } from "@playwright/test";
import { FLOW_TOP_N, flowRoutes } from "../src/surfaces/xr/buildCityModel.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function waitForXr(page) {
  await page.waitForFunction(
    () => window.__pythiaXr && window.__pythiaXr.ready === true && window.__pythiaXr.mode !== "detecting",
    null,
    { timeout: 45000 },
  );
}

function uniqueCode() {
  return `P${Date.now().toString(36).toUpperCase().slice(-5)}`.padEnd(6, "0");
}

// The day's heaviest districts, as the twin ranks them (ties by scene order).
function topIds(scene, day) {
  return scene.districts
    .map((d, i) => ({ id: d.id, i, tons: (d.series[day] || d.series[0]).predicted_tons }))
    .sort((a, b) => b.tons - a.tons || a.i - b.i)
    .slice(0, FLOW_TOP_N)
    .map((d) => d.id);
}

test("flowRoutes: top N own routes by the day's tonnes, a selected one, and one bundle", () => {
  const district = (id, tons) => ({ id, series: [{ predicted_tons: tons[0] }, { predicted_tons: tons[1] }] });
  const districts = [
    district("a", [10, 50]),
    district("b", [40, 10]),
    district("c", [30, 20]),
    district("d", [20, 40]),
    district("e", [5, 5]),
  ];
  const day0 = flowRoutes(districts, 0, null, 2);
  expect(day0.map((r) => (r.bundle ? "bundle" : districts[r.members[0]].id))).toEqual(["b", "c", "bundle"]);
  expect(day0[2]).toMatchObject({ bundle: true, tons: 35, members: [3, 0, 4] });
  // The ranking follows the selected day.
  const day1 = flowRoutes(districts, 1, null, 2);
  expect(day1.slice(0, 2).map((r) => districts[r.members[0]].id)).toEqual(["a", "d"]);
  // A selected district outside the top N leaves the bundle for its own route.
  const picked = flowRoutes(districts, 0, "e", 2);
  expect(picked.filter((r) => !r.bundle).map((r) => [districts[r.members[0]].id, r.selected])).toEqual([
    ["b", false],
    ["c", false],
    ["e", true],
  ]);
  expect(picked.at(-1).members).toEqual([3, 0]);
  // Five districts with N = 5: no bundle at all.
  expect(flowRoutes(districts, 0, null, 5).some((r) => r.bundle)).toBe(false);
});

test.describe("XR tabletop polish", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("arcs: the day's top 8 districts on their own arcs plus one bundle, following day and pick", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const scene = await (
      await page.request.get(`${API}/twin/scene?city=jakarta&days=7`, { timeout: 45000 })
    ).json();
    const code = uniqueCode();
    const put = (data) => page.request.put(`${API}/xr/session/${code}`, { data });
    const base = { city: "jakarta", rainfall_mm: 0, event_preset: "none", day: 0, agreed: false };
    expect((await put(base)).ok()).toBe(true);
    await page.goto(`/xr?session=${code}&city=jakarta&lang=en`);
    await waitForXr(page);
    const arcs = () => page.evaluate(() => window.__pythiaXr.flowArcs);

    const day0 = await arcs();
    expect(day0).toHaveLength(FLOW_TOP_N + 1);
    expect(day0.filter((a) => !a.bundle).map((a) => a.district)).toEqual(topIds(scene, 0));
    expect(day0.at(-1)).toMatchObject({ bundle: true, size: scene.districts.length - FLOW_TOP_N });
    // Own arcs are ordered heaviest first (their colour ramps with tonnes).
    const tons = day0.filter((a) => !a.bundle).map((a) => a.tons);
    expect([...tons].sort((a, b) => b - a)).toEqual(tons);

    // Day 1: the ranking is that day's.
    await page.getByTestId("xr-day-next").click();
    await expect
      .poll(async () => (await arcs()).filter((a) => !a.bundle).map((a) => a.district))
      .toEqual(topIds(scene, 1));

    // A district picked on another device (outside the top 8) gets its own selected arc.
    const light = scene.districts.find((d) => !topIds(scene, 1).includes(d.id));
    expect((await put({ ...base, day: 1, selected_id: light.id })).ok()).toBe(true);
    await expect
      .poll(async () => (await arcs()).filter((a) => a.selected).map((a) => a.district), { timeout: 15000 })
      .toEqual([light.id]);
    const picked = await arcs();
    expect(picked).toHaveLength(FLOW_TOP_N + 2);
    expect(picked.at(-1)).toMatchObject({ bundle: true, size: scene.districts.length - FLOW_TOP_N - 1 });
  });

  test("a session write from another client reaches the open table (twin handoff)", async ({ page }) => {
    const code = uniqueCode();
    const put = (data) => page.request.put(`${API}/xr/session/${code}`, { data });
    const base = { city: "jakarta", rainfall_mm: 0, event_preset: "none", day: 0, agreed: false };
    expect((await put(base)).ok()).toBe(true);
    await page.goto(`/xr?session=${code}&city=jakarta&lang=en`);
    await waitForXr(page);
    // The laptop's twin writes a what-if; the table follows without a reload.
    const sceneRequest = page.waitForRequest(
      (r) => r.url().includes("/twin/scene?") && r.url().includes("rainfall_mm=80"),
      { timeout: 15000 },
    );
    expect((await put({ ...base, rainfall_mm: 80, day: 2, scenario_day: 2 })).ok()).toBe(true);
    await sceneRequest;
    await expect
      .poll(() => page.evaluate(() => [window.__pythiaXr.rainfall_mm, window.__pythiaXr.scenarioDay]), {
        timeout: 15000,
      })
      .toEqual([80, 2]);
    await expect(page.getByTestId("xr-head-weather")).toHaveText("What-if 80 mm");
  });

  test("the ask placeholder fits the field at 390 and 320 px in both languages", async ({ page }) => {
    const fits = () =>
      page.getByTestId("xr-ask-input").evaluate((input) => {
        const style = getComputedStyle(input);
        const ctx = document.createElement("canvas").getContext("2d");
        ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { text: input.placeholder, fits: ctx.measureText(input.placeholder).width <= room };
      });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      for (const lang of ["en", "id"]) {
        await page.goto(`/xr?city=jakarta&lang=${lang}`);
        await waitForXr(page);
        const result = await fits();
        expect(result.text).toBe(lang === "en" ? "80 mm rain tomorrow?" : "Hujan 80 mm besok?");
        expect(result.fits, `${lang} at ${width}px`).toBe(true);
      }
    }
  });

  test("a rain-only what-if has no event clause", async ({ page }) => {
    await page.goto("/xr?city=hcmc&lang=en&rainfall_mm=60");
    await waitForXr(page);
    await page.getByTestId("xr-head-toggle").click();
    await expect(page.getByTestId("xr-scenario")).toHaveText(
      /^Scenario applied: rain 60 mm · \w{3} \d{1,2} \w{3}$/,
    );
    await expect(page.getByTestId("xr-scenario")).not.toContainText("people");
    await page.goto("/xr?city=hcmc&lang=id&rainfall_mm=60");
    await waitForXr(page);
    await page.getByTestId("xr-head-toggle").click();
    await expect(page.getByTestId("xr-scenario")).toHaveText(/^Skenario diterapkan: hujan 60 mm · /);
    await expect(page.getByTestId("xr-scenario")).not.toContainText("orang");
  });

  test("the collapsed header names the day's rain source and stays one row", async ({ page }) => {
    await page.goto("/xr?city=hcmc&lang=en");
    await waitForXr(page);
    await expect(page.getByTestId("xr-head-toggle")).toHaveAttribute("aria-expanded", "false");
    const chip = page.getByTestId("xr-head-weather");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText("Assumed dry");
    await expect(page.getByTestId("xr-provenance")).toBeVisible();

    await page.goto("/xr?city=hcmc&lang=en&rainfall_mm=60");
    await waitForXr(page);
    await expect(chip).toHaveText("What-if 60 mm");
    await expect(chip).toHaveAttribute("data-input", "scenario");
    // Expanded, the full weather line takes over; the summary folds away.
    await page.getByTestId("xr-head-toggle").click();
    await expect(page.getByTestId("xr-weather")).toBeVisible();
    await expect(chip).toBeHidden();

    // 320 px, the longest city name: chip still on screen, header still short, no overflow.
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/xr?city=hcmc&lang=id&rainfall_mm=60");
    await waitForXr(page);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText("Skenario 60 mm");
    const layout = await page.evaluate(() => {
      const box = (id) => document.querySelector(`[data-testid=${id}]`).getBoundingClientRect();
      const wx = document.querySelector("[data-testid=xr-head-weather]");
      return {
        head: box("xr-head").height,
        clipped: wx.scrollWidth > wx.clientWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    expect(layout.clipped).toBe(false);
    expect(layout.overflow).toBe(false);
    expect(layout.head).toBeLessThanOrEqual(64);
  });

  test("forecast weather says when it was fetched", async ({ page }) => {
    const fetchedAt = "2026-10-24T03:05:00+00:00";
    await page.route(/\/twin\/scene\?/, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.weather = {
        ...json.weather,
        source: "open-meteo",
        class: "REAL_FORECAST_INPUT",
        fetched_at: fetchedAt,
        days: json.weather.days.map((d, i) => ({ ...d, input: "forecast", rainfall_mm: i === 0 ? 9 : 0 })),
      };
      await route.fulfill({ response, json });
    });
    await page.goto("/xr?city=jakarta&lang=en");
    await waitForXr(page);
    const hhmm = await page.evaluate(
      (iso) =>
        new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }),
      fetchedAt,
    );
    await expect(page.getByTestId("xr-head-weather")).toHaveText("Forecast 9 mm");
    await page.getByTestId("xr-head-toggle").click();
    await expect(page.getByTestId("xr-weather")).toHaveText(
      `Forecast rain 9 mm · Open-Meteo forecast, not observed · fetched ${hhmm}`,
    );
    // The in-scene panel a headset reads carries it too.
    await expect.poll(() => page.evaluate(() => window.__pythiaXr.panelText)).toContain(`fetched ${hhmm}`);
  });
});
