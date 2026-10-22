// gsc-2026 P1-11: AR on foot — route-following arrow, vehicle-speed safety lock, TPA spotter mode.
// The SPJ, its planned path, the TPA queue and the weather are stubbed with
// page.route; a scripted navigator.geolocation feeds exact fixes (position,
// timestamp and device speed) so every step is deterministic.
import { expect, test } from "@playwright/test";
import { OFF_ROUTE_M, initialBearing, legToStop, routeTarget } from "../src/surfaces/driver/arMath.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const TRUCK = "T-247";

// An L-shaped planned leg: stop A (done), 400 m east to a corner, 400 m north to stop B.
const LAT0 = -6.25;
const LNG0 = 106.8;
const M_LAT = 1 / 111195;
const M_LNG = 1 / (111195 * Math.cos((LAT0 * Math.PI) / 180));
const at = (east, north) => ({ lat: LAT0 + north * M_LAT, lng: LNG0 + east * M_LNG });
const A = at(0, 0);
const B = at(400, 400);
const PATH = [A, at(200, 0), at(400, 0), at(400, 200), B];
const TPA = { lat: -6.331, lng: 106.991 };

function spjFixture(routeSource = "LIVE_EXTERNAL") {
  return {
    spj_id: "SPJ-AR-ROUTE",
    spj_number: "DLH-DKI/SPJ/E2E-AR-ROUTE",
    truck_code: TRUCK,
    driver_name: "E2E AR",
    destination: "TPST Bantargebang",
    status: "aktif",
    route_source: routeSource,
    stops: [
      {
        name: "TPS Rute A",
        kecamatan: "Cilandak",
        address: "Jl. Rute E2E 1",
        ...A,
        status: "completed",
        evidence_summary: { has_evidence: true, weighing_count: 1, total_weight_kg: 80 },
      },
      { name: "TPS Rute B", kecamatan: "Cilandak", address: "Jl. Rute E2E 2", ...B, status: "pending" },
    ],
  };
}

const QUEUE = {
  // gsc-2026 m8: trucks waiting (peak/mean) and arrivals per hour are separate fields.
  queue_trucks_max: 14,
  queue_trucks_mean: 6.2,
  arrivals_per_hour: 38,
  trucks_in_queue: 14,
  lat: TPA.lat,
  lng: TPA.lng,
  facility_name: "TPST Bantargebang",
  avg_wait_minutes: 21.4,
  p95_wait_minutes: 48.2,
  weighbridge_status: "OPERATIONAL",
  method: "seeded discrete-event queue simulation",
};

function localIsoDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "driver", password: "driver-demo-pass" }),
  });
  expect(res.ok).toBeTruthy();
  return res.json();
}

// Scripted geolocation: window.__pushFix({ lat, lng, speed, accuracy }) reaches
// every watcher with an explicit timestamp and device speed.
async function installScriptedGps(page) {
  await page.addInitScript(() => {
    const watchers = new Map();
    let nextId = 1;
    let last = null;
    const deliver = (cb, fix) =>
      cb({
        coords: {
          latitude: fix.lat,
          longitude: fix.lng,
          accuracy: fix.accuracy ?? 8,
          speed: fix.speed ?? null,
          heading: null,
          altitude: null,
          altitudeAccuracy: null,
        },
        timestamp: fix.at ?? Date.now(),
      });
    const geo = {
      watchPosition(success) {
        const id = nextId;
        nextId += 1;
        watchers.set(id, success);
        if (last) setTimeout(() => deliver(success, last), 0);
        return id;
      },
      clearWatch(id) {
        watchers.delete(id);
      },
      getCurrentPosition(success, error) {
        if (last) setTimeout(() => deliver(success, last), 0);
        else if (error) error({ code: 2, message: "no fix yet" });
      },
    };
    Object.defineProperty(navigator, "geolocation", { configurable: true, get: () => geo });
    // No camera in these specs: the compass card keeps the arrow readable.
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("none", "NotFoundError"));
    window.__pushFix = (fix) => {
      last = fix;
      for (const cb of watchers.values()) deliver(cb, fix);
    };
  });
}

async function stubBackend(page, { routeSource = "LIVE_EXTERNAL", path = PATH, weather } = {}) {
  await page.route(/\/api\/spj\?status=aktif$/, (route) =>
    route.fulfill({ json: { spj: [spjFixture(routeSource)], count: 1 } }),
  );
  await page.route(/\/api\/spj\?status=selesai$/, (route) => route.fulfill({ json: { spj: [], count: 0 } }));
  await page.route(/\/api\/pretrip\/today\//, (route) => route.fulfill({ json: { done: true } }));
  await page.route(/\/api\/spj\/active-path\//, (route) =>
    route.fulfill({
      json: {
        truck_code: TRUCK,
        has_active_spj: true,
        has_reference_path: path.length > 1,
        destination: "TPST Bantargebang",
        path,
      },
    }),
  );
  await page.route(/\/api\/tpa\/queue-status/, (route) => route.fulfill({ json: QUEUE }));
  await page.route(/\/api\/weather$/, (route) =>
    route.fulfill({
      json: weather || {
        source: "open-meteo",
        location: "Jakarta, Indonesia",
        forecast: [{ date: localIsoDate(), rainfall_mm: 42.5, precipitation_probability: 90 }],
      },
    }),
  );
}

async function openAr(page, lang = "en") {
  const principal = await login();
  await page.goto("/");
  await page.evaluate(
    ({ token, lang, truck }) => {
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_field_token", token);
      localStorage.setItem("pythia_driver", JSON.stringify({ driver_name: "E2E AR", truck_code: truck }));
      localStorage.removeItem("pythia_driver_outbox");
    },
    { token: principal.token, lang, truck: TRUCK },
  );
  await page.goto("/driver");
  const open = page.getByTestId("stop-1").getByTestId("ar-nav-open");
  await expect(open).toBeVisible({ timeout: 20000 });
  await open.click();
  const nav = page.getByTestId("ar-navigator");
  await expect(nav).toBeVisible();
  return nav;
}

const push = (page, fix) => page.evaluate((f) => window.__pushFix(f), fix);
const arrowAngle = async (page) =>
  Number(await page.getByTestId("ar-arrow").getAttribute("data-relative-angle"));
// The compass card is north-up (no orientation events here), so the arrow
// angle is the bearing itself.
const expectedRouteBearing = (fix) => {
  const leg = legToStop(PATH, [A, B], 1);
  const aim = routeTarget(leg, fix, B);
  return { bearing: Math.round(initialBearing(fix, aim.target)), remaining: Math.round(aim.remaining) };
};

test.use({ viewport: { width: 390, height: 844 } });

test("the AR arrow follows the planned leg, with distance along the route", async ({ page }) => {
  test.setTimeout(90000);
  await installScriptedGps(page);
  await stubBackend(page);
  const nav = await openAr(page);

  // On the road 100 m past stop A: the arrow points east along the road,
  // not north-east through the block, and the distance is the path distance.
  const onRoad = { ...at(100, 3), speed: 1.2 };
  await push(page, onRoad);
  await expect(nav).toHaveAttribute("data-route-mode", "route");
  const first = expectedRouteBearing(onRoad);
  await expect.poll(() => arrowAngle(page)).toBe(first.bearing);
  expect(Math.abs(first.bearing - Math.round(initialBearing(onRoad, B)))).toBeGreaterThan(30);
  const distance = page.getByTestId("ar-distance");
  await expect(distance).toHaveAttribute("data-meters", String(first.remaining));
  await expect(page.getByTestId("ar-route-mode")).toHaveAttribute("data-mode", "route");
  await expect(page.getByTestId("ar-route-mode")).toHaveText(
    "Following the planned route · distance along the route",
  );

  // Round the corner and up the second street: the arrow turns north.
  const north = { ...at(400, 150), speed: 1.2 };
  await push(page, north);
  const second = expectedRouteBearing(north);
  await expect.poll(() => arrowAngle(page)).toBe(second.bearing);
  expect(Math.abs(second.bearing) <= 5 || Math.abs(second.bearing - 360) <= 5).toBe(true);
  await expect(distance).toHaveAttribute("data-meters", String(second.remaining));

  // Far off the leg: an honest, labelled straight bearing to the stop.
  const off = { ...at(100, 200), speed: 1.2 };
  await push(page, off);
  await expect(nav).toHaveAttribute("data-route-mode", "straight");
  await expect(page.getByTestId("ar-route-mode")).toHaveAttribute("data-reason", "off");
  await expect(page.getByTestId("ar-route-mode")).toHaveText(
    `Straight line to the stop — you are more than ${OFF_ROUTE_M} m off the planned route`,
  );
  await expect.poll(() => arrowAngle(page)).toBe(Math.round(initialBearing(off, B)));
});

test("a straight-line fallback route is labelled, never followed as a road", async ({ page }) => {
  await installScriptedGps(page);
  await stubBackend(page, { routeSource: "FALLBACK_DEGRADED" });
  const nav = await openAr(page, "id");
  const onRoad = { ...at(100, 3), speed: 0 };
  await push(page, onRoad);
  await expect(nav).toHaveAttribute("data-route-mode", "straight");
  await expect(page.getByTestId("ar-route-mode")).toHaveAttribute("data-reason", "geometry");
  await expect(page.getByTestId("ar-route-mode")).toHaveText(
    "Garis lurus ke titik — rute ini tanpa geometri jalan",
  );
  await expect.poll(() => arrowAngle(page)).toBe(Math.round(initialBearing(onRoad, B)));
});

test("driving speed locks the AR view; standing or walking releases it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installScriptedGps(page);
  await stubBackend(page);
  const nav = await openAr(page);
  await push(page, { ...at(50, 0), speed: 0 });
  await expect(page.getByTestId("ar-arrow")).toBeVisible();

  // Two fast fixes are not yet sustained; the third locks.
  await push(page, { ...at(60, 0), speed: 8.4 });
  await push(page, { ...at(70, 0), speed: 8.4 });
  await expect(nav).toHaveAttribute("data-speed-locked", "false");
  await push(page, { ...at(80, 0), speed: 8.4 });
  await expect(nav).toHaveAttribute("data-speed-locked", "true");
  const lock = page.getByTestId("ar-speed-lock");
  await expect(lock).toBeVisible();
  await expect(lock.getByRole("alert")).toHaveText("Stop the vehicle to use AR");
  await expect(page.getByTestId("ar-speed-lock-speed")).toHaveText("Speed ~30 km/h");
  await expect(page.getByTestId("ar-arrow")).toHaveCount(0);
  await expect(page.getByTestId("ar-capture")).toHaveCount(0);
  // Close stays reachable while locked.
  await expect(page.getByTestId("ar-nav-close")).toBeVisible();
  // No animated lock: the global reduced-motion rule may leave 0.01 ms ("1e-05s"), never more.
  const lockDurationsMs = await lock.evaluate((el) =>
    getComputedStyle(el)
      .transitionDuration.split(",")
      .map((d) => parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000)),
  );
  expect(Math.max(...lockDurationsMs)).toBeLessThanOrEqual(0.01);

  // A short stop (two slow fixes) keeps the lock; a third slow fix releases it.
  await push(page, { ...at(80, 0), speed: 0 });
  await push(page, { ...at(80, 0), speed: 0.4 });
  await expect(nav).toHaveAttribute("data-speed-locked", "true");
  await push(page, { ...at(81, 0), speed: 1.1 });
  await expect(nav).toHaveAttribute("data-speed-locked", "false");
  await expect(page.getByTestId("ar-speed-lock")).toHaveCount(0);
  await expect(page.getByTestId("ar-arrow")).toBeVisible();
});

test("TPA spotter mode shows the SIMULATED queue and a sourced rain no-go banner", async ({ page }) => {
  await installScriptedGps(page);
  await stubBackend(page);
  const nav = await openAr(page);

  // Away from the TPA the spotter says so instead of showing queue data.
  await push(page, { ...at(100, 3), speed: 0 });
  const toggle = page.getByTestId("ar-spotter-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const box = await toggle.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(nav).toHaveAttribute("data-spotter", "true");
  await expect(page.getByTestId("ar-spotter-far")).toContainText("You are");
  await expect(page.getByTestId("ar-spotter-far")).toContainText("TPST Bantargebang");
  await expect(page.getByTestId("ar-spotter-sim")).toHaveCount(0);

  // On foot at the tipping area: simulated queue slot + rain no-go.
  await push(page, { lat: TPA.lat + 0.002, lng: TPA.lng, speed: 0.8 });
  await expect(page.getByTestId("ar-spotter-sim")).toHaveText("SIMULATED");
  const queue = page.getByTestId("ar-spotter-queue");
  await expect(queue).toContainText("14 trucks in the queue");
  await expect(page.getByTestId("ar-spotter-arrivals")).toHaveText("38 trucks arrive per hour (modelled)");
  await expect(queue).toContainText("Wait for a tipping slot ~21 min (p95 48 min)");
  const rain = page.getByTestId("ar-rain");
  await expect(rain).toHaveAttribute("data-no-go", "true");
  await expect(rain).toHaveAttribute("role", "alert");
  await expect(rain).toContainText("No-go: 42.5 mm rain forecast");
  await expect(page.getByTestId("ar-rain-source")).toHaveText(
    "Source: Open-Meteo daily forecast for Jakarta",
  );

  // A dry DEMO fallback forecast: no banner, and the source says DEMO.
  await page.unroute(/\/api\/weather$/);
  await page.route(/\/api\/weather$/, (route) =>
    route.fulfill({
      json: { source: "fallback-demo", forecast: [{ date: localIsoDate(), rainfall_mm: 3.4 }] },
    }),
  );
  await toggle.click();
  await expect(nav).toHaveAttribute("data-spotter", "false");
  await expect(page.getByTestId("ar-spotter")).toHaveCount(0);
  await toggle.click();
  await expect(page.getByTestId("ar-rain")).toHaveAttribute("data-no-go", "false");
  await expect(page.getByTestId("ar-rain")).not.toHaveAttribute("role", "alert");
  await expect(page.getByTestId("ar-rain-source")).toHaveText(
    "Source: DEMO fallback forecast (weather service unreachable)",
  );
});
