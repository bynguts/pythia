// #xr-lite: /xr on budget Android phones (2–3 GB RAM, entry GPUs, metered 4G,
// often no ARCore). Lite mode is detected from the device, can be switched by
// hand, says so on screen, and keeps every provenance label; an Android phone
// without ARCore is told why it gets the orbit view.
import { expect, test } from "@playwright/test";
import {
  LITE_RENDER,
  decideLite,
  liteOverride,
  liteReasons,
  simplifyRing,
} from "../src/surfaces/xr/xrLite.js";
import { rainParticleCount } from "../src/surfaces/xr/buildCityModel.js";

async function waitForXr(page) {
  await page.waitForFunction(
    () => window.__pythiaXr && window.__pythiaXr.ready === true && window.__pythiaXr.mode !== "detecting",
    null,
    { timeout: 45000 },
  );
}

// A 2 GB phone with the browser's data saver on.
async function emulateBudgetPhone(page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => 2 });
    Object.defineProperty(Navigator.prototype, "connection", {
      configurable: true,
      get: () => ({ saveData: true, effectiveType: "3g", addEventListener() {}, removeEventListener() {} }),
    });
  });
}

test("liteReasons reads memory, cores and data saver; nothing known means none", () => {
  expect(liteReasons({ deviceMemory: 2, hardwareConcurrency: 8 })).toEqual(["memory"]);
  expect(liteReasons({ deviceMemory: 3 })).toEqual(["memory"]);
  expect(liteReasons({ deviceMemory: 4, hardwareConcurrency: 4 })).toEqual(["cpu"]);
  expect(liteReasons({ deviceMemory: 8, hardwareConcurrency: 8, saveData: true })).toEqual(["data"]);
  expect(liteReasons({ reducedData: true })).toEqual(["data"]);
  expect(liteReasons({ deviceMemory: 2, hardwareConcurrency: 2, saveData: true })).toEqual([
    "memory",
    "cpu",
    "data",
  ]);
  // Browsers that expose nothing (Safari, Firefox) and a desktop are not guessed lite.
  expect(liteReasons({})).toEqual([]);
  expect(liteReasons({ deviceMemory: 8, hardwareConcurrency: 12, saveData: false })).toEqual([]);
  expect(liteReasons({ deviceMemory: 0, hardwareConcurrency: 0 })).toEqual([]);
});

test("decideLite: a manual choice beats the device guess either way", () => {
  expect(decideLite({ reasons: ["memory"] })).toEqual({ lite: true, source: "auto" });
  expect(decideLite({ reasons: [] })).toEqual({ lite: false, source: "auto" });
  expect(decideLite({ override: "off", reasons: ["memory", "data"] })).toEqual({
    lite: false,
    source: "manual",
  });
  expect(decideLite({ override: "on", reasons: [] })).toEqual({ lite: true, source: "manual" });
  expect(liteOverride("1")).toBe("on");
  expect(liteOverride("0")).toBe("off");
  expect(liteOverride("maybe")).toBeNull();
  expect(liteOverride(null)).toBeNull();
});

test("lite geometry: outlines thinned to a cap, fewer rain particles", () => {
  const ring = Array.from({ length: 226 }, (_, i) => [106.8 + i * 1e-4, -6.2]);
  const thin = simplifyRing(ring, LITE_RENDER.outlinePoints);
  expect(thin).toHaveLength(LITE_RENDER.outlinePoints);
  expect(thin[0]).toBe(ring[0]);
  // Points keep their order along the ring.
  expect(thin.every((p, i) => i === 0 || p[0] > thin[i - 1][0])).toBe(true);
  const small = ring.slice(0, 14);
  expect(simplifyRing(small, LITE_RENDER.outlinePoints)).toBe(small);
  expect(rainParticleCount(80)).toBe(960);
  expect(rainParticleCount(80, true)).toBe(80 * LITE_RENDER.rainPerMm);
  expect(rainParticleCount(1000, true)).toBe(LITE_RENDER.rainMax);
  expect(rainParticleCount(0, true)).toBe(0);
});

test.describe("XR lite mode", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a 2 GB phone with data saver gets lite mode, labelled, with provenance intact", async ({ page }) => {
    test.setTimeout(90000);
    await emulateBudgetPhone(page);
    const plates = [];
    page.on("request", (r) => {
      if (r.url().includes("/xr/jakarta-plate")) plates.push(new URL(r.url()).pathname);
    });
    await page.goto("/xr?city=jakarta&lang=en&rainfall_mm=80");
    await waitForXr(page);
    const state = await page.evaluate(() => ({
      lite: window.__pythiaXr.lite,
      source: window.__pythiaXr.liteSource,
      reasons: window.__pythiaXr.liteReasons,
      pixelRatio: window.__pythiaXr.pixelRatio,
      antialias: window.__pythiaXr.antialias,
      shadows: window.__pythiaXr.shadows,
      arcSegments: window.__pythiaXr.arcSegments,
      rain: window.__pythiaXr.rainParticles,
    }));
    // (A runner with 4 cores or fewer adds "cpu"; memory and data saver are emulated.)
    const { reasons, ...render } = state;
    expect(reasons).toEqual(expect.arrayContaining(["memory", "data"]));
    expect(render).toEqual({
      lite: true,
      source: "auto",
      pixelRatio: 1,
      antialias: false,
      shadows: false,
      arcSegments: LITE_RENDER.arcSegments,
      rain: 80 * LITE_RENDER.rainPerMm,
    });
    await expect(page.getByTestId("xr-lite-label")).toBeVisible();
    await expect(page.getByTestId("xr-lite-label")).toHaveText("Lite mode");
    // Every provenance label stays: the data class chip, the imagery credit.
    await expect(page.getByTestId("xr-provenance")).toHaveAttribute("data-class", "MODEL_OUTPUT");
    await expect(page.getByTestId("xr-provenance")).toBeVisible();
    await expect(page.getByTestId("xr-imagery-credit")).toContainText("CC BY 4.0");
    // The small plate is fetched after the first frame, never the full one.
    await expect.poll(() => page.evaluate(() => window.__pythiaXr.plate), { timeout: 15000 }).toBe("loaded");
    expect(plates).toEqual([LITE_RENDER.plateUrl]);

    // Switched off by hand: the full renderer, remembered on this device.
    await page.getByTestId("xr-scenario-toggle").click();
    const toggle = page.getByTestId("xr-lite-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-lite", "off");
    await expect(toggle).toHaveAttribute("data-source", "manual");
    await expect(page.getByTestId("xr-lite-label")).toHaveCount(0);
    await waitForXr(page);
    await expect.poll(() => page.evaluate(() => window.__pythiaXr.shadows)).toBe(true);
    expect(await page.evaluate(() => window.__pythiaXr.arcSegments)).toBe(24);
    await expect.poll(() => page.evaluate(() => window.__pythiaXr.rainParticles)).toBe(80 * 12);
    await expect.poll(() => plates.includes("/xr/jakarta-plate.jpg"), { timeout: 15000 }).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("pythia_xr_lite"))).toBe("0");
    await page.reload();
    await waitForXr(page);
    expect(await page.evaluate(() => [window.__pythiaXr.lite, window.__pythiaXr.liteSource])).toEqual([
      false,
      "manual",
    ]);
  });

  test("lite mode thins the district outlines and can be forced with ?lite=1", async ({ page }) => {
    await page.goto("/xr?city=jakarta&lang=en&lite=0");
    await waitForXr(page);
    const full = await page.evaluate(() => [window.__pythiaXr.lite, window.__pythiaXr.districtVertices]);
    expect(full[0]).toBe(false);
    await page.goto("/xr?city=jakarta&lang=id&lite=1");
    await waitForXr(page);
    const lite = await page.evaluate(() => [window.__pythiaXr.lite, window.__pythiaXr.districtVertices]);
    expect(lite[0]).toBe(true);
    expect(lite[1]).toBeLessThan(full[1]);
    await expect(page.getByTestId("xr-lite-label")).toHaveText("Mode ringan");
  });

  test("a desktop browser stays in full mode with no lite label", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => 8 });
      Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { configurable: true, get: () => 8 });
    });
    await page.goto("/xr?city=hcmc&lang=en");
    await waitForXr(page);
    expect(await page.evaluate(() => window.__pythiaXr.lite)).toBe(false);
    await expect(page.getByTestId("xr-lite-label")).toHaveCount(0);
  });
});

test.describe("XR on Android without ARCore", () => {
  test.use({
    viewport: { width: 360, height: 760 },
    userAgent:
      "Mozilla/5.0 (Linux; Android 12; SM-A035F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  });

  test("immersive-ar unsupported: the orbit view says AR needs ARCore", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "xr", {
        configurable: true,
        get: () => ({ isSessionSupported: async () => false }),
      });
    });
    await page.goto("/xr?city=jakarta&lang=en");
    await waitForXr(page);
    expect(await page.evaluate(() => window.__pythiaXr.mode)).toBe("orbit");
    const hint = page.getByTestId("xr-orbit-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute("data-reason", "no-arcore");
    await expect(hint).toContainText("AR needs ARCore");
    await expect(hint).toContainText("Orbit view");
    await expect(page.getByTestId("xr-enter-ar")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });
});
