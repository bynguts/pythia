// gsc-2026 P1-10 + P2 + C2: /xr scenario presets re-fetch the scene, a shared session code syncs devices, and the readout shows scene crews and the scenario-scaled queue.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function waitForXr(page) {
  await page.waitForFunction(
    () => window.__pythiaXr && window.__pythiaXr.ready === true && window.__pythiaXr.mode !== "detecting",
    null,
    { timeout: 45000 },
  );
  return page.evaluate(() => ({ ...window.__pythiaXr }));
}

// Phones start with the presets folded away so the model stays visible.
async function openScenario(page) {
  const toggle = page.getByTestId("xr-scenario-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByTestId("xr-scenario-controls")).toBeVisible();
}

function uniqueCode() {
  return `T${Date.now().toString(36).toUpperCase().slice(-5)}`.padEnd(6, "0");
}

const xrScenario = (page) =>
  page.evaluate(() => ({
    rain: window.__pythiaXr.rainfall_mm,
    event: window.__pythiaXr.eventPreset,
    day: window.__pythiaXr.selectedDay,
    agreed: window.__pythiaXr.agreed,
  }));

test.describe("XR tabletop — interactive scenario and shared session", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a rain preset re-fetches the scene and the readout follows the payload", async ({ page }) => {
    await page.goto("/xr?city=jakarta&lang=en");
    await waitForXr(page);
    await openScenario(page);
    await expect(page.getByTestId("xr-rain-0")).toHaveAttribute("aria-pressed", "true");

    const response = page.waitForResponse(
      (r) => r.url().includes("/twin/scene?") && r.url().includes("rainfall_mm=80") && r.ok(),
      { timeout: 45000 },
    );
    await page.getByTestId("xr-rain-80").click();
    const scene = await (await response).json();
    expect(scene.scenario.rainfall_mm).toBe(80);
    await expect.poll(() => page.evaluate(() => window.__pythiaXr.sceneRainfall)).toBe(80);
    await expect(page.getByTestId("xr-rain-80")).toHaveAttribute("aria-pressed", "true");

    // Every readout number comes from the scene payload, not client constants.
    const fmt = (n) => Math.round(n).toLocaleString("en-GB");
    await expect(page.getByTestId("xr-total")).toHaveText(`${fmt(scene.horizon.daily_total_tons[0])} t`);
    const rows = scene.districts.map((d) => d.series[0]);
    const extra = rows.reduce((sum, row) => sum + row.predicted_tons - row.normal_tons, 0);
    await expect(page.getByTestId("xr-extra")).toHaveText(
      `${extra >= 0 ? "+" : "−"}${fmt(Math.abs(extra))} t`,
    );
    const trucks = rows.reduce((sum, row) => sum + row.trucks_required, 0);
    await expect(page.getByTestId("xr-fleet")).toHaveText(trucks.toLocaleString("en-GB"));
    if (scene.landfill_queue?.minutes_per_truck) {
      await expect(page.getByTestId("xr-queue")).toContainText("min/truck");
    } else {
      await expect(page.getByTestId("xr-queue")).toHaveCount(0);
    }
    // The model provenance stays on screen through scenario changes.
    await expect(page.getByTestId("xr-provenance")).toHaveAttribute("data-class", "MODEL_OUTPUT");

    // An event preset carries the venue to the scene request.
    const eventRequest = page.waitForRequest(
      (r) =>
        r.url().includes("/twin/scene?") &&
        r.url().includes("event_attendance=50000") &&
        r.url().includes("event_lat=-6.2183"),
    );
    await page.getByTestId("xr-event-50k").click();
    await eventRequest;
  });

  test("share shows a session code and a link that holds the scenario", async ({ page }) => {
    await page.goto("/xr?city=hcmc&lang=en");
    await waitForXr(page);
    await openScenario(page);
    await page.getByTestId("xr-rain-40").click();
    await page.getByTestId("xr-share").click();

    const codeEl = page.getByTestId("xr-session-code");
    await expect(codeEl).toHaveText(/^[A-Z0-9]{6}$/);
    const code = (await codeEl.textContent()).trim();
    await expect(page).toHaveURL(new RegExp(`session=${code}`));
    await expect(page.getByTestId("xr-session-url")).toContainText(`/xr?session=${code}&city=hcmc`);

    const state = await (await page.request.get(`${API}/xr/session/${code}`)).json();
    expect(state).toMatchObject({
      code,
      city: "hcmc",
      rainfall_mm: 40,
      event_preset: "none",
      agreed: false,
      classification: "SESSION_STATE",
    });
  });

  test("a device joined with ?session= picks up a scenario written elsewhere", async ({ page }) => {
    const code = uniqueCode();
    const put = (data) => page.request.put(`${API}/xr/session/${code}`, { data });
    expect(
      (await put({ city: "hcmc", rainfall_mm: 0, event_preset: "none", day: 0, agreed: false })).ok(),
    ).toBe(true);

    await page.goto(`/xr?session=${code}&city=hcmc&lang=en`);
    await waitForXr(page);
    await expect(page.getByTestId("xr-agreed")).toHaveCount(0);

    const sceneRequest = page.waitForRequest(
      (r) =>
        r.url().includes("/twin/scene?") &&
        r.url().includes("rainfall_mm=120") &&
        r.url().includes("event_attendance=100000"),
      { timeout: 15000 },
    );
    await put({ city: "hcmc", rainfall_mm: 120, event_preset: "100k", day: 3, agreed: true });
    await sceneRequest;
    await expect
      .poll(() => xrScenario(page), { timeout: 15000 })
      .toEqual({ rain: 120, event: "100k", day: 3, agreed: true });
    await expect(page.getByTestId("xr-agreed")).toHaveText("Agreed in session — not an official approval");
    await expect(page.getByTestId("xr-provenance")).toHaveAttribute("data-class", "SIMULATED_DEMO_CITY");
  });

  test("two devices share one scenario and its agreement", async ({ page, context }) => {
    await page.goto("/xr?city=hcmc&lang=en");
    await waitForXr(page);
    await openScenario(page);
    // Agreeing without a session starts one: the agreement must live somewhere shared.
    await page.getByTestId("xr-agree").click();
    await expect(page.getByTestId("xr-agreed")).toBeVisible();
    const code = (await page.getByTestId("xr-session-code").textContent()).trim();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);

    const other = await context.newPage();
    await other.goto(`/xr?session=${code}&city=hcmc&lang=en`);
    await waitForXr(other);
    await expect(other.getByTestId("xr-agreed")).toBeVisible({ timeout: 15000 });

    // Changing the scenario on one device withdraws the agreement on both.
    await page.getByTestId("xr-rain-40").click();
    await expect(page.getByTestId("xr-agreed")).toHaveCount(0);
    await expect
      .poll(() => xrScenario(other), { timeout: 15000 })
      .toEqual({ rain: 40, event: "none", day: 0, agreed: false });
    await expect(other.getByTestId("xr-agreed")).toHaveCount(0);

    // And the day travels too.
    await other.getByTestId("xr-day-next").click();
    await expect.poll(() => page.evaluate(() => window.__pythiaXr.selectedDay), { timeout: 15000 }).toBe(1);
    await other.close();
  });

  test("an unknown session code is reported and sharing stays available", async ({ page }) => {
    await page.goto(`/xr?session=${uniqueCode()}&city=hcmc&lang=en`);
    await waitForXr(page);
    await expect(page.getByTestId("xr-session-error")).toHaveText("Shared session not found or expired.");
    // gsc-2026 n32: the expired code leaves the URL, so a reload or a copied link does not bring it back.
    await expect(page).not.toHaveURL(/session=/);
    await expect(page).toHaveURL(/city=hcmc/);
    await openScenario(page);
    await expect(page.getByTestId("xr-share")).toBeVisible();
  });

  test("session writes go out one at a time, so the server ends on the newest edit", async ({ page }) => {
    // gsc-2026 m6: the first write is held back; without serialization the later
    // write would land first and the held one would then overwrite it.
    let held = false;
    let concurrent = 0;
    let maxConcurrent = 0;
    await page.route(/\/xr\/session\/[A-Z0-9]+$/, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const body = route.request().postDataJSON();
      if (!held && body.rainfall_mm === 80) {
        held = true;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      try {
        await route.continue();
      } finally {
        concurrent -= 1;
      }
    });
    await page.goto("/xr?city=hcmc&lang=en");
    await waitForXr(page);
    await openScenario(page);
    await page.getByTestId("xr-share").click();
    const code = (await page.getByTestId("xr-session-code").textContent()).trim();
    await page.getByTestId("xr-rain-80").click();
    await page.getByTestId("xr-rain-120").click();
    await expect
      .poll(async () => (await (await page.request.get(`${API}/xr/session/${code}`)).json()).rainfall_mm, {
        timeout: 15000,
      })
      .toBe(120);
    await page.waitForTimeout(2000);
    expect((await (await page.request.get(`${API}/xr/session/${code}`)).json()).rainfall_mm).toBe(120);
    expect(maxConcurrent).toBe(1);
  });

  test("stepping days stays local and the queue metric names the day it describes", async ({ page }) => {
    // gsc-2026 M5: the scene already holds every horizon day; a day step must not re-fetch it.
    const sceneUrls = [];
    page.on("request", (r) => {
      if (r.url().includes("/twin/scene?")) sceneUrls.push(r.url());
    });
    await page.goto("/xr?city=jakarta&lang=en");
    await waitForXr(page);
    await openScenario(page);
    const before = sceneUrls.length;
    await page.getByTestId("xr-day-next").click();
    await page.getByTestId("xr-day-next").click();
    await expect.poll(() => page.evaluate(() => window.__pythiaXr.selectedDay)).toBe(2);
    await page.waitForTimeout(1000);
    expect(sceneUrls.length).toBe(before);
    expect(sceneUrls.every((url) => !/[?&]day=/.test(url))).toBe(true);
    if (await page.getByTestId("xr-queue").count()) {
      const firstDate = await page.getByTestId("xr-day-scrubber").evaluate(() => {
        const ticks = document.querySelectorAll(".xr-range-ticks span");
        return ticks[0]?.textContent;
      });
      await expect(page.getByTestId("xr-queue-day")).toContainText(String(firstDate));
    }
  });

  test("open scenario controls meet 44px targets with no overflow at 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/xr?city=jakarta&lang=id");
    await waitForXr(page);
    await openScenario(page);
    await page.getByTestId("xr-share").click();
    await expect(page.getByTestId("xr-session-code")).toBeVisible();
    const report = await page.evaluate(() => {
      const small = [];
      document.querySelectorAll(".xr-overlay button, .xr-overlay a, .xr-overlay input").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.width < 44 || r.height < 44))
          small.push(`${el.outerHTML.slice(0, 60)} ${r.width}x${r.height}`);
      });
      return { small, overflow: document.documentElement.scrollWidth > window.innerWidth };
    });
    expect(report.small).toEqual([]);
    expect(report.overflow).toBe(false);
  });

  test("the readout shows scene crews and the scenario-scaled queue next to the normal day", async ({
    page,
  }) => {
    // The crew and scenario-scaled queue fields are optional; inject them on the real scene.
    await page.route(/\/twin\/scene\?/, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      const days = json.horizon.dates.length;
      json.horizon.daily_crews_required = Array.from({ length: days }, (_, i) => 300 + i);
      json.summary = { ...json.summary, crews_required_today: 300 };
      json.landfill_queue = {
        ...(json.landfill_queue || {}),
        minutes_per_truck: {
          baseline_mean: 55,
          staggered_mean: 24,
          classification: "SIMULATED",
          source: "e2e stub",
          scenario_scaled: true,
          normal_day: { trucks_per_day: 1200, baseline_mean: 42, staggered_mean: 18 },
        },
      };
      await route.fulfill({ response, json });
    });
    // A linked venue is named from the venue list by its coordinates.
    await page.goto("/xr?city=jakarta&lang=en&event_attendance=50000&event_lat=-6.1246&event_lng=106.8584");
    await waitForXr(page);
    await expect(page.getByTestId("xr-crews")).toHaveText("300");
    await expect(page.getByTestId("xr-queue")).toHaveText("55→24 min/truck (scenario) · normal day 42→18");
    // The simulated label stays on the queue row.
    await expect(page.getByTestId("xr-readout")).toContainText("TPA queue (simulated)");
    await openScenario(page);
    await expect(page.getByRole("group", { name: "Event · JIS" })).toBeVisible();
  });
});
