// wave11 map perf: the fleet map stays smooth on a budget phone. The cruise loop that glides
// the trucks writes marker positions at a bounded rate (about 10 steps a second, a truck only
// when its screen pixel changes), does no marker work while the operator pans or zooms
// (MapLibre repositions the markers itself then), and stops under reduced motion, where each
// poll's fix is jumped to instead. Counters come from window.__pythiaMapPerf (automation only).
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page) {
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
  await page.goto("/fleet", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      window.__pythiaMapPerf &&
      document.querySelectorAll(".truck-marker:not(.event-permit-marker)").length >= 5,
    null,
    { timeout: 60000 },
  );
  // Let the first fit-to-fleet camera move finish.
  await page.waitForFunction(() => window.__pythiaMap && !window.__pythiaMap.isMoving(), null, {
    timeout: 15000,
  });
}

const counters = (page) =>
  page.evaluate(() => {
    const { reset, ...rest } = window.__pythiaMapPerf;
    void reset;
    return { ...rest, trucks: document.querySelectorAll(".truck-marker:not(.event-permit-marker)").length };
  });

test("the cruise loop steps at a bounded rate while the map is idle", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.evaluate(() => window.__pythiaMapPerf.reset());
  const started = Date.now();
  await page.waitForTimeout(3000);
  const perf = await counters(page);
  const seconds = (Date.now() - started) / 1000;
  // Still cruising, but never more than ~10 steps a second (60 before), and never more
  // than one position write per truck per step.
  expect(perf.ticks).toBeGreaterThan(0);
  expect(perf.ticks / seconds).toBeLessThanOrEqual(12);
  expect(perf.writes).toBeLessThanOrEqual(perf.ticks * perf.trucks);
  expect(perf.movingWrites).toBe(0);
});

test("the cruise loop does no marker work while the map pans and zooms", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.evaluate(() => window.__pythiaMapPerf.reset());
  // A 1.5 s pan + zoom: the camera is moving for the whole window that is counted.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const map = window.__pythiaMap;
        map.once("moveend", resolve);
        map.easeTo({ center: [106.82, -6.22], zoom: map.getZoom() + 1.5, duration: 1500 });
      }),
  );
  const perf = await counters(page);
  // The loop saw the movement and stood down, and wrote no marker while the map moved.
  expect(perf.skippedMoving).toBeGreaterThan(0);
  expect(perf.movingWrites).toBe(0);
});

test("reduced motion: no cruise, trucks sit on their reported fix", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.evaluate(() => window.__pythiaMapPerf.reset());
  await page.waitForTimeout(1500);
  const perf = await counters(page);
  expect(perf.trucks).toBeGreaterThan(0);
  expect(perf.ticks).toBe(0);
  expect(perf.writes).toBe(0);
});

// wave11 map cap: the founder asked for a lighter map. It draws at most 10 trucks, the
// off-corridor truck always among them, and the legend says how many of the fleet are shown.
test("the map draws at most ten trucks and keeps the off-corridor one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const markers = page.locator(".truck-marker:not(.event-permit-marker)");
  expect(await markers.count()).toBeLessThanOrEqual(10);
  await expect(page.locator('.truck-marker[aria-label^="T-047"]')).toHaveCount(1);
  await page.getByTestId("map-legend").locator("summary").click();
  await expect(page.getByTestId("map-fleet-denominator")).toHaveText(/^10 dari \d+ ditampilkan/);
});
