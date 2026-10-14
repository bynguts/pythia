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

test.describe("XR tabletop twin", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("jakarta renders 42 district bars in the orbit viewer with model provenance", async ({ page }) => {
    const scene = await (
      await page.request.get(`${API}/twin/scene?city=jakarta&days=7`, { timeout: 45000 })
    ).json();
    expect(scene.districts).toHaveLength(42);

    await page.goto("/xr?city=jakarta");
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
    // The in-scene label that rides with the model into a VR headset.
    await expect
      .poll(() => page.evaluate(() => window.__pythiaXr.sceneLabel))
      .toMatch(/^Ho Chi Minh City · Simulated demo city \|/);
  });

  test("the in-scene provenance label follows the language", async ({ page }) => {
    await page.goto("/xr?city=jakarta");
    await waitForXr(page);
    await expect
      .poll(() => page.evaluate(() => window.__pythiaXr.sceneLabel))
      .toMatch(/^Jakarta · Keluaran model \|/);
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.__pythiaXr.sceneLabel))
      .toMatch(/^Jakarta · Model output \|/);
  });

  test("a scenario passed in the URL is stated on screen, never implied", async ({ page }) => {
    await page.goto("/xr?city=hcmc&lang=en&rainfall_mm=60");
    await waitForXr(page);
    await expect(page.getByTestId("xr-scenario")).toHaveText("Scenario applied: rain 60 mm · event 0 people");
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
    await expect(page.getByTestId("xr-scenario")).toHaveText(
      "Scenario applied: rain 20 mm · event 50,000 people",
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
        spacer: fire(document.querySelector(".xr-spacer")),
      };
    });
    expect(prevented).toEqual({ header: true, controls: true, spacer: false });
  });

  test("the boot fallback is localised", async ({ page }) => {
    await page.route(/\/assets\/XrTabletop-[^/]+\.js$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto("/xr?city=jakarta");
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
});
