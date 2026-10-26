// /xr tabletop city twin — orbit fallback without WebXR,
// one bar per district, day scrubber, and honest provenance per city.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function waitForXr(page) {
  // Capability detection (isSessionSupported) settles independently of the
  // first rendered frame; wait for both.
  await page.waitForFunction(
    () => window.__pythiaXr && window.__pythiaXr.ready === true && window.__pythiaXr.mode !== "detecting",
    null,
    { timeout: 45000 },
  );
  return page.evaluate(() => ({ ...window.__pythiaXr }));
}

// Phones fold the header to one line and the controls to a bottom sheet.
async function openHead(page) {
  const toggle = page.getByTestId("xr-head-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
async function openSheet(page) {
  const toggle = page.getByTestId("xr-scenario-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

test.describe("XR tabletop twin", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("jakarta renders 42 district bars in the orbit viewer with model provenance", async ({ page }) => {
    const scene = await (
      await page.request.get(`${API}/twin/scene?city=jakarta&days=7`, { timeout: 45000 })
    ).json();
    expect(scene.districts).toHaveLength(42);

    await page.goto("/xr?city=jakarta&lang=id");
    const state = await waitForXr(page);
    expect(state.mode).toBe("orbit"); // headless Chromium has no immersive session
    expect(state.bars).toBe(42);
    expect(state.city).toBe("jakarta");
    expect(state.selectedDay).toBe(0);

    await expect(page.getByTestId("xr-canvas")).toBeVisible();
    await expect(page.getByTestId("xr-orbit-hint")).toBeVisible();
    await expect(page.getByTestId("xr-enter-ar")).toHaveCount(0);
    const prov = page.getByTestId("xr-provenance");
    await expect(prov).toHaveAttribute("data-class", "MODEL_OUTPUT");
    await expect(prov).toHaveText(/keluaran model/i);
    // Total for the selected day comes from the scene, not the client.
    const total = Math.round(scene.horizon.daily_total_tons[0]).toLocaleString("id-ID");
    await expect(page.getByTestId("xr-total")).toHaveText(`${total} t`);
  });

  test("day scrubber changes the selected day and the totals", async ({ page }) => {
    await page.goto("/xr?city=jakarta&lang=en");
    await waitForXr(page);
    const before = await page.getByTestId("xr-total").textContent();

    await page.getByTestId("xr-day-next").click();
    await expect.poll(() => page.evaluate(() => window.__pythiaXr.selectedDay)).toBe(1);

    await page.getByTestId("xr-day-scrubber").fill("4");
    await expect.poll(() => page.evaluate(() => window.__pythiaXr.selectedDay)).toBe(4);
    const date = await page.evaluate(() => window.__pythiaXr.date);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(page.getByTestId("xr-total")).not.toHaveText(before || "");

    await page.getByTestId("xr-day-prev").click();
    await expect.poll(() => page.evaluate(() => window.__pythiaXr.selectedDay)).toBe(3);
  });

  test("hcmc is labelled as a simulated demo city", async ({ page }) => {
    await page.goto("/xr?city=hcmc&lang=en");
    const state = await waitForXr(page);
    expect(state.city).toBe("hcmc");
    expect(state.bars).toBe(22);
    const prov = page.getByTestId("xr-provenance");
    await expect(prov).toHaveAttribute("data-class", "SIMULATED_DEMO_CITY");
    await expect(prov).toHaveText(/simulated demo city/i);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ho Chi Minh City");
    // gsc-2026 #13: Vietnam abolished the district tier on 1 July 2025; the note says
    // which boundaries the demo city draws, on screen and in the headset label.
    await expect(page.getByTestId("xr-provenance-note")).toContainText("Pre-July-2025 district boundaries");
    // No outlines and no satellite plate for the demo city: bars on the plain plate.
    expect(state.districtShape).toBe("bar");
    expect(state.plate).toBe("none");
    await expect(page.getByTestId("xr-imagery-credit")).toHaveCount(0);
    // The in-scene label that rides with the model into a VR headset.
    await expect
      .poll(() => page.evaluate(() => window.__pythiaXr.sceneLabel))
      .toMatch(/^Ho Chi Minh City · Simulated demo city \|.*Pre-July-2025 district boundaries$/);
  });

  test("gsc-2026 #2: the city rises with its plate, scenario rain and truck flows", async ({ page }) => {
    const sceneFor = async (rain) =>
      (
        await page.request.get(`${API}/twin/scene?city=jakarta&days=7${rain ? `&rainfall_mm=${rain}` : ""}`, {
          timeout: 45000,
        })
      ).json();
    // One dot per 4 trucks of the day's trucks_required (TRUCKS_PER_DOT), rounded per district.
    const dots = (scene, day = 0) =>
      scene.districts.reduce((sum, d) => {
        const trucks = d.series[day]?.trucks_required || 0;
        return sum + (trucks > 0 ? Math.round(trucks / 4) : 0);
      }, 0);
    const hook = (key) => page.evaluate((k) => window.__pythiaXr[k], key);

    const dry = await sceneFor(0);
    await page.goto("/xr?city=jakarta&lang=en");
    const state = await waitForXr(page);
    // Extruded outlines when the scene sends them, bars otherwise.
    const outlined = dry.districts.every((d) => Array.isArray(d.outline) && d.outline.length >= 3);
    expect(state.districtShape).toBe(outlined ? "prism" : "bar");
    expect(state.bars).toBe(42);
    // #N4 (teardown v3): rain falls only where the day has it; the base week's day 0
    // carries its own Open-Meteo forecast rain (scene.weather.days), dry if none.
    const forecastMm = Number(dry.weather?.days?.[0]?.rainfall_mm) || 0;
    expect(state.rainParticles).toBe(forecastMm > 0 ? Math.min(3600, Math.round(forecastMm * 12)) : 0);
    expect(dots(dry)).toBeGreaterThan(0);
    expect(state.flowCount).toBe(dots(dry));
    // The satellite plate loads from public/ and its licence credit is on screen and on the panel.
    await expect.poll(() => hook("plate"), { timeout: 15000 }).toBe("loaded");
    await expect(page.getByTestId("xr-imagery-credit")).toContainText(
      "EOxCloudless 2016 by EOX IT Services GmbH",
    );
    await expect(page.getByTestId("xr-imagery-credit")).toContainText("CC BY 4.0");
    await openSheet(page);
    await expect(page.getByTestId("xr-flow-note")).toContainText("not live GPS");
    const panel = await hook("panelText");
    expect(panel).toContain("Jakarta · Model output — Forecast by district model, not live measurement");
    expect(panel).toContain("CC BY 4.0");
    // #xr-crew-rule: equal truck and crew counts name the one-crew-per-truck rule
    // with the scene's crew size, in the readout and on the in-scene panel.
    expect(dry.horizon.daily_crews_required[0]).toBe(dry.horizon.daily_trucks_required[0]);
    const crewRule = `1 crew per truck (${dry.summary.crew_size_workers} workers)`;
    await expect(page.getByTestId("xr-crew-rule")).toHaveText(crewRule);
    expect(panel).toContain(`Crews · ${crewRule}`);

    // The flows follow the selected day.
    await page.getByTestId("xr-day-next").click();
    await expect.poll(() => hook("flowCount")).toBe(dots(dry, 1));

    // Rain: particles ∝ the scene's rainfall, and the heavier scenario moves the flows.
    const wet = await sceneFor(80);
    await page.goto("/xr?city=jakarta&lang=en&rainfall_mm=80");
    await waitForXr(page);
    await expect.poll(() => hook("rainParticles")).toBe(80 * 12);
    expect(await hook("flowCount")).toBe(dots(wet));
    expect(dots(wet)).not.toBe(dots(dry));
    await openSheet(page);
    await expect(page.getByTestId("xr-flow-note")).toContainText("not live weather");
  });

  test("the in-scene provenance label follows the language", async ({ page }) => {
    await page.goto("/xr?city=jakarta&lang=id");
    await waitForXr(page);
    await expect
      .poll(() => page.evaluate(() => window.__pythiaXr.sceneLabel))
      .toMatch(/^Jakarta · Keluaran model \|/);
    await openHead(page);
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.__pythiaXr.sceneLabel))
      .toMatch(/^Jakarta · Model output \|/);
  });

  test("a scenario passed in the URL is stated on screen, never implied", async ({ page }) => {
    await page.goto("/xr?city=hcmc&lang=en&rainfall_mm=60");
    await waitForXr(page);
    // The what-if names the one day it applies to (gsc-2026 #5); no crowd, no
    // event clause (teardown v3 #9).
    await expect(page.getByTestId("xr-scenario")).toHaveText(
      /^Scenario applied: rain 60 mm · \w{3} \d{1,2} \w{3}$/,
    );
    await page.goto("/xr?city=hcmc&lang=en");
    await waitForXr(page);
    await expect(page.getByTestId("xr-scenario")).toHaveCount(0);

    // The twin's "Open in AR/XR" link sends the event location too; it must
    // reach the scene request.
    const sceneRequest = page.waitForRequest(
      (r) =>
        r.url().includes("/twin/scene?") &&
        r.url().includes("event_lat=-6.2183") &&
        r.url().includes("event_lng=106.8022"),
    );
    await page.goto(
      "/xr?city=jakarta&lang=en&rainfall_mm=20&event_attendance=50000&event_lat=-6.2183&event_lng=106.8022",
    );
    await sceneRequest;
    await waitForXr(page);
    await expect(page.getByTestId("xr-scenario")).toContainText(
      "Scenario applied: rain 20 mm · event 50,000 people · ",
    );
  });

  // #twin-weather: the selected day's rain says where it comes from (scene.weather),
  // on screen and on the in-scene panel a headset reads.
  test("the day's rain source is stated: forecast, what-if or assumed dry", async ({ page }) => {
    await page.goto("/xr?city=hcmc&lang=en");
    await waitForXr(page);
    await expect(page.getByTestId("xr-weather")).toHaveText(
      "No weather forecast for the demo city · assumed dry (0 mm)",
    );
    await expect
      .poll(() => page.evaluate(() => window.__pythiaXr.panelText))
      .toContain("No weather forecast for the demo city · assumed dry (0 mm)");

    await page.goto("/xr?city=hcmc&lang=en&rainfall_mm=60");
    await waitForXr(page);
    await expect(page.getByTestId("xr-weather")).toHaveText("Scenario rain 60 mm · not observed weather");

    // Jakarta's base week runs on the Open-Meteo forecast; pin it so the copy is known.
    await page.route(/\/twin\/scene\?/, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.weather = {
        ...json.weather,
        source: "open-meteo",
        class: "REAL_FORECAST_INPUT",
        // No fetch time: the line ends at the source (xr-polish covers "fetched HH:MM").
        fetched_at: null,
        days: json.weather.days.map((d, i) => ({ ...d, input: "forecast", rainfall_mm: i === 0 ? 9 : 0 })),
      };
      await route.fulfill({ response, json });
    });
    await page.goto("/xr?city=jakarta&lang=en");
    await waitForXr(page);
    await expect(page.getByTestId("xr-weather")).toHaveText(
      "Forecast rain 9 mm · Open-Meteo forecast, not observed",
    );
  });

  test("taps on overlay panels never reach the XR session as a select", async ({ page }) => {
    await page.goto("/xr?city=jakarta");
    await waitForXr(page);
    const prevented = await page.evaluate(() => {
      const fire = (el) => {
        const event = new Event("beforexrselect", { bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      };
      return {
        header: fire(document.querySelector(".xr-head h1")),
        controls: fire(document.querySelector("[data-testid=xr-day-next]")),
        credit: fire(document.querySelector("[data-testid=xr-imagery-credit]")),
        spacer: fire(document.querySelector(".xr-spacer")),
      };
    });
    expect(prevented).toEqual({ header: true, controls: true, credit: true, spacer: false });
  });

  // Wave 13: English is the default, so the Indonesian checks pin ?lang=id.
  test("the boot fallback is localised", async ({ page }) => {
    await page.route(/\/assets\/XrTabletop-[^/]+\.js$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto("/xr?city=jakarta&lang=id");
    await expect(page.locator(".xr-boot")).toHaveText("Memuat Pythia XR…");
    await waitForXr(page);
  });

  test("a failed AR session start ends the session and reports it", async ({ page }) => {
    // Fake WebXR: AR is "supported" but the granted session cannot be wired
    // to the renderer, so setup fails after requestSession resolved.
    await page.addInitScript(() => {
      window.__fakeXrEnded = 0;
      class FakeSession extends EventTarget {
        constructor() {
          super();
          this.ended = false;
        }
        async end() {
          if (this.ended) return;
          this.ended = true;
          window.__fakeXrEnded += 1;
          this.dispatchEvent(new Event("end"));
        }
      }
      Object.defineProperty(navigator, "xr", {
        configurable: true,
        value: {
          isSessionSupported: async (mode) => mode === "immersive-ar",
          requestSession: async () => new FakeSession(),
        },
      });
    });
    await page.goto("/xr?city=jakarta&lang=en");
    const state = await waitForXr(page);
    expect(state.mode).toBe("ar");
    await page.getByTestId("xr-enter-ar").click();
    await expect(page.getByRole("alert")).toHaveText("Could not start the immersive session on this device.");
    await expect.poll(() => page.evaluate(() => window.__fakeXrEnded)).toBe(1);
    await expect(page.getByTestId("xr-tabletop")).toHaveAttribute("data-session", "none");
    // The inline viewer is still usable afterwards.
    await expect(page.getByTestId("xr-enter-ar")).toBeEnabled();
  });

  test("controls meet 44px targets with no horizontal overflow at 390px", async ({ page }) => {
    await page.goto("/xr?city=jakarta");
    await waitForXr(page);
    const audit = () =>
      page.evaluate(() => {
        const small = [];
        document.querySelectorAll(".xr-overlay button, .xr-overlay a, .xr-overlay input").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.width < 44 || r.height < 44))
            small.push(`${el.outerHTML.slice(0, 60)} ${r.width}x${r.height}`);
        });
        return { small, overflow: document.documentElement.scrollWidth > window.innerWidth };
      });
    expect(await audit()).toEqual({ small: [], overflow: false });
    // Unfolded header and sheet too (language, cities, presets, sharing).
    await openHead(page);
    await openSheet(page);
    expect(await audit()).toEqual({ small: [], overflow: false });
  });

  test("gsc-2026 #3: on a phone the city gets most of the screen and the queue wraps", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/xr?city=jakarta&lang=en&rainfall_mm=80");
    await waitForXr(page);
    // One-line header: city, date, total and the provenance chip; details fold away.
    const head = page.getByTestId("xr-head");
    await expect(page.getByTestId("xr-head-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("xr-head-summary")).toBeVisible();
    await expect(page.getByTestId("xr-provenance")).toBeVisible();
    await expect(page.getByTestId("xr-readout")).toBeHidden();
    const headBox = await head.boundingBox();
    expect(headBox.height).toBeLessThanOrEqual(64);
    // Bottom sheet: folded to the ask field and the scrubber.
    await expect(page.getByTestId("xr-scenario-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("xr-ask-input")).toBeVisible();
    await expect(page.getByTestId("xr-day-scrubber")).toBeVisible();
    // The free band between the header and the sheet, where the city is drawn,
    // is at least 55% of the 844 px viewport.
    const band = await page.evaluate(() => {
      const top = document.querySelector("[data-testid=xr-head]").getBoundingClientRect().bottom;
      const bottom = document.querySelector("[data-testid=xr-controls]").getBoundingClientRect().top;
      const canvas = document.querySelector("[data-testid=xr-canvas]").getBoundingClientRect();
      return { free: bottom - top, canvas: canvas.height, vh: window.innerHeight };
    });
    expect(band.canvas).toBe(band.vh);
    expect(band.free / band.vh).toBeGreaterThanOrEqual(0.55);
    // The view is centred in that band, not behind the panels: the districts'
    // mean screen position lies inside it.
    const ids = (
      await (await page.request.get(`${API}/twin/scene?city=jakarta&days=7`)).json()
    ).districts.map((d) => d.id);
    const centreY = await page.evaluate((list) => {
      const ys = list.map((id) => window.__pythiaXr.screenPoint(id)?.y).filter(Number.isFinite);
      return ys.reduce((a, b) => a + b, 0) / ys.length;
    }, ids);
    const bandCentre = headBox.y + headBox.height + band.free / 2;
    expect(Math.abs(centreY - bandCentre)).toBeLessThan(band.free * 0.1);

    // Expanded, the queue cell wraps its labelled numbers instead of truncating them.
    await openHead(page);
    const queue = page.getByTestId("xr-queue");
    await expect(queue).toContainText("without stagger");
    const clipped = await queue.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(false);
    await page.getByTestId("xr-head-toggle").click();
    await expect(page.getByTestId("xr-readout")).toBeHidden();

    // The longest city name and chip still fit one row at 320 px, date and total included.
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/xr?city=hcmc&lang=en");
    await waitForXr(page);
    const row = await page.evaluate(() => {
      const box = (id) => document.querySelector(`[data-testid=${id}]`).getBoundingClientRect();
      return {
        head: box("xr-head").height,
        summary: box("xr-head-summary").width,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    expect(row.overflow).toBe(false);
    expect(row.summary).toBeGreaterThan(60);
    expect(row.head).toBeLessThanOrEqual(64);
  });
});
