// #AR-world: WebXR street path — world-anchored ground chevrons on immersive-ar phones, CSS overlay fallback elsewhere.
// #gsc-6: distance + stop name HUD, pin label, arrival banner, anchor lock with drift-only correction,
// "AR on the street" label and the DEMO stop's road leg from stop 1.
// The geometry (geoEnu.js) is pure and runs in the test runner. The UI tests
// stub navigator.xr: requestSession stays pending (no ARCore in headless
// Chromium), so the HUD, anchoring, align control, honesty labels and the
// stopped-only speed rule are exercised without a real XR frame loop.
import { expect, test } from "@playwright/test";
import { haversineMeters, initialBearing, legFollowsRoad, legToStop } from "../src/surfaces/driver/arMath.js";
import {
  ANCHOR_LOCK_ACCURACY_M,
  CHEVRON_STEP_M,
  CORRECTION_EASE_MS,
  DRIFT_FACTOR,
  PATH_AHEAD_M,
  REANCHOR_MOVE_M,
  WORLD_SPEED_FIXES,
  WORLD_SPEED_LOCK_KMH,
  YAW_MAX_DEG,
  alongOnPolyline,
  chevronsAhead,
  correctedOrigin,
  driftExceeds,
  easeOrigin,
  enuBearing,
  enuToScene,
  fromEnu,
  legPolyline,
  nextAnchor,
  nudgeYaw,
  referenceHeading,
  resamplePolyline,
  sceneToEnu,
  sceneYawForBearing,
  shouldReanchor,
  stepWorldSpeed,
  toEnu,
  viewerYawCw,
} from "../src/surfaces/driver/geoEnu.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const TRUCK = "T-247";

// An L-shaped planned leg in Jakarta: stop A, 400 m east, 400 m north to stop B.
const LAT0 = -6.25;
const LNG0 = 106.8;
const M_LAT = 1 / 111195;
const M_LNG = 1 / (111195 * Math.cos((LAT0 * Math.PI) / 180));
const at = (east, north) => ({ lat: LAT0 + north * M_LAT, lng: LNG0 + east * M_LNG });
const A = at(0, 0);
const B = at(400, 400);
const PATH = [A, at(200, 0), at(400, 0), at(400, 200), B];
const TPA = { lat: -6.331, lng: 106.991 };

// ── Pure geometry ──

test("WGS84 → ENU stays within 0.5 m of great-circle distance and bearing out to 2 km", () => {
  const anchor = { lat: -6.2, lng: 106.85 };
  for (const bearing of [0, 37, 90, 145, 180, 233, 270, 321]) {
    const rad = (bearing * Math.PI) / 180;
    const truth = { e: 2000 * Math.sin(rad), n: 2000 * Math.cos(rad) };
    const point = fromEnu(anchor, truth);
    const enu = toEnu(anchor, point);
    expect(enu.e).toBeCloseTo(truth.e, 6);
    expect(enu.n).toBeCloseTo(truth.n, 6);
    // Flat-earth error against the haversine distance and the true bearing.
    expect(Math.abs(Math.hypot(enu.e, enu.n) - haversineMeters(anchor, point))).toBeLessThan(0.5);
    const diff = Math.abs(((enuBearing(enu.e, enu.n) - initialBearing(anchor, point) + 540) % 360) - 180);
    expect(diff).toBeLessThan(0.05);
  }
  expect(toEnu(anchor, anchor)).toEqual({ e: 0, n: 0 });
});

test("polyline resampling every 4 m keeps the corner direction and the last vertex", () => {
  const enu = PATH.map((p) => toEnu(A, p));
  const samples = resamplePolyline(enu);
  expect(CHEVRON_STEP_M).toBe(4);
  expect(samples).toHaveLength(201); // 800 m / 4 m + the start
  expect(samples[0]).toMatchObject({ along: 0, bearing: 90 });
  for (let i = 1; i < samples.length; i += 1) {
    expect(samples[i].along - samples[i - 1].along).toBeCloseTo(4, 0);
  }
  const last = samples[samples.length - 1];
  expect(Math.hypot(last.e - enu[4].e, last.n - enu[4].n)).toBeLessThan(0.01);
  expect(last.bearing).toBeCloseTo(0, 6);
  // 3 m spacing on a 10 m line still ends exactly on the last vertex.
  const short = resamplePolyline(
    [
      { e: 0, n: 0 },
      { e: 0, n: 10 },
    ],
    3,
  );
  expect(short.map((s) => s.along)).toEqual([0, 3, 6, 9, 10]);
  expect(resamplePolyline([{ e: 0, n: 0 }])).toEqual([]);
});

test("chevrons ahead: a 150 m window at a fixed 4 m phase along the path", () => {
  const enu = PATH.map((p) => toEnu(A, p));
  const ahead = chevronsAhead(enu, 101);
  expect(PATH_AHEAD_M).toBe(150);
  expect(ahead[0].along).toBe(104);
  expect(ahead[ahead.length - 1].along).toBe(248);
  expect(ahead).toHaveLength(37);
  // Walking 2 m on does not move a single chevron on the street.
  const later = chevronsAhead(enu, 103);
  expect(later[0]).toEqual(ahead[0]);
  // Across the corner the chevrons turn north; near the stop the window ends there.
  const corner = chevronsAhead(enu, 380);
  expect(corner.find((c) => c.along === 396).bearing).toBe(90);
  expect(corner.find((c) => c.along === 404).bearing).toBeCloseTo(0, 6);
  expect(chevronsAhead(enu, 790).map((c) => c.along)).toEqual([792, 796, 800]);
  // The crew's position projects onto the path.
  expect(alongOnPolyline(enu, toEnu(A, at(100, 7)))).toBeCloseTo(100, 0);
  expect(alongOnPolyline(enu, toEnu(A, at(395, 250)))).toBeCloseTo(650, 0);
});

test("the planned leg becomes a WGS84 polyline from the previous stop to the stop", () => {
  const leg = legToStop(PATH, [A, B], 1);
  const line = legPolyline(leg, B);
  expect(line).toHaveLength(5);
  expect(haversineMeters(line[0], A)).toBeLessThan(0.01);
  expect(haversineMeters(line[2], at(400, 0))).toBeLessThan(0.01);
  expect(haversineMeters(line[line.length - 1], B)).toBeLessThan(0.01);
  // A stop 20 m off the road is appended after the leg's end on the road.
  const offRoad = at(420, 400);
  const offLeg = legToStop(PATH, [A, offRoad], 1);
  const withStop = legPolyline(offLeg, offRoad);
  expect(haversineMeters(withStop[withStop.length - 1], offRoad)).toBeLessThan(0.01);
  expect(haversineMeters(withStop[withStop.length - 2], B)).toBeLessThan(0.5);
  expect(legPolyline(null, B)).toEqual([]);
});

test("re-anchoring: first fix, a move beyond 25 m, or 5 m better accuracy", () => {
  const anchor = { ...A, accuracy: 20 };
  expect(REANCHOR_MOVE_M).toBe(25);
  expect(shouldReanchor(null, anchor)).toBe(true);
  expect(shouldReanchor(anchor, null)).toBe(false);
  expect(shouldReanchor(anchor, { ...at(20, 0), accuracy: 20 })).toBe(false);
  expect(shouldReanchor(anchor, { ...at(20, 16), accuracy: 20 })).toBe(true); // ~25.6 m
  expect(shouldReanchor(anchor, { ...A, accuracy: 17 })).toBe(false);
  expect(shouldReanchor(anchor, { ...A, accuracy: 15 })).toBe(true);
  expect(shouldReanchor(anchor, { ...A, accuracy: null })).toBe(false);
  expect(shouldReanchor({ ...A, accuracy: null }, { ...A, accuracy: 30 })).toBe(true);
});

test("anchor lock: the first fix within ±15 m locks the anchor, walking never re-anchors it", () => {
  expect(ANCHOR_LOCK_ACCURACY_M).toBe(15);
  expect(nextAnchor(null, null)).toBeNull();
  // A good first fix locks at once.
  const locked = nextAnchor(null, { ...A, accuracy: 12 });
  expect(locked).toMatchObject({ seq: 1, locked: true });
  // Locked: 30 m, 200 m, or a sharper fix never move the anchor (same object back).
  for (const fix of [
    { ...at(30, 0), accuracy: 12 },
    { ...at(200, 0), accuracy: 12 },
    { ...A, accuracy: 4 },
  ]) {
    expect(nextAnchor(locked, fix)).toBe(locked);
  }
  // A poor first fix stays provisional: it follows the old rules until a fix is good enough.
  let anchor = nextAnchor(null, { ...A, accuracy: 30 });
  expect(anchor).toMatchObject({ seq: 1, locked: false });
  expect(nextAnchor(anchor, { ...at(10, 0), accuracy: 28 })).toBe(anchor); // jitter: no change
  anchor = nextAnchor(anchor, { ...at(40, 0), accuracy: 30 }); // moved past 25 m
  expect(anchor).toMatchObject({ seq: 2, locked: false });
  anchor = nextAnchor(anchor, { ...at(42, 0), accuracy: 15 }); // good enough: lock here
  expect(anchor).toMatchObject({ seq: 3, locked: true });
  expect(anchor.fix.accuracy).toBe(15);
  expect(nextAnchor(anchor, { ...at(100, 0), accuracy: 15 })).toBe(anchor);
  // An unknown accuracy never locks.
  expect(nextAnchor(null, { ...A, accuracy: null })).toMatchObject({ locked: false });
});

test("drift correction: only beyond 2× the GPS accuracy, gliding to where GPS puts the phone", () => {
  expect(DRIFT_FACTOR).toBe(2);
  // sceneToEnu inverts enuToScene for any heading and origin.
  for (const heading of [0, 37, 90, 211, 333]) {
    const origin = { x: 1.5, z: -2 };
    const back = sceneToEnu(enuToScene({ e: 12, n: -7 }, heading, origin), heading, origin);
    expect(back.e).toBeCloseTo(12, 9);
    expect(back.n).toBeCloseTo(-7, 9);
  }
  // Tracking says 50 m north; GPS (±8 m) says 50 m north and 12 m east: within 16 m, no correction.
  const tracked = { e: 0, n: 50 };
  expect(driftExceeds({ e: 12, n: 50 }, tracked, 8)).toBe(false);
  expect(driftExceeds({ e: 17, n: 50 }, tracked, 8)).toBe(true);
  expect(driftExceeds({ e: 17, n: 50 }, tracked, null)).toBe(false); // unknown accuracy never corrects
  expect(driftExceeds(null, tracked, 8)).toBe(false);

  // The corrected origin puts the GPS fix exactly where the phone stands.
  for (const heading of [0, 90, 200]) {
    const phone = { x: 3, z: -48 };
    const gps = { e: 20, n: 50 };
    const origin = correctedOrigin(phone, gps, heading);
    const placed = enuToScene(gps, heading, origin);
    expect(placed.x).toBeCloseTo(phone.x, 9);
    expect(placed.z).toBeCloseTo(phone.z, 9);
  }

  // The correction glides: no jump in one frame, settled within CORRECTION_EASE_MS.
  const from = { x: 0, z: 0 };
  const to = { x: 20, z: 0 };
  const firstFrame = easeOrigin(from, to, 16);
  expect(firstFrame.x).toBeGreaterThan(0);
  expect(firstFrame.x).toBeLessThan(2);
  let origin = from;
  let ms = 0;
  while (origin !== to && ms < 5000) {
    origin = easeOrigin(origin, to, 16);
    ms += 16;
  }
  expect(origin).toBe(to);
  expect(ms).toBeLessThanOrEqual(CORRECTION_EASE_MS * 2);
  expect(ms).toBeGreaterThan(CORRECTION_EASE_MS / 4);
});

test("a DEMO SPJ leg follows the road only when it has road vertices, not the bare stop-to-stop segment", () => {
  // Stitched DEMO geometry: stop A → B on the road (corner vertices), then B → C straight.
  const C = at(400, 900);
  const stitched = [...PATH, C];
  expect(legFollowsRoad(legToStop(stitched, [A, B, C], 1))).toBe(true);
  expect(legFollowsRoad(legToStop(stitched, [A, B, C], 2))).toBe(false);
  // A fully straight fallback: no leg follows a road.
  expect(legFollowsRoad(legToStop([A, B, C], [A, B, C], 1))).toBe(false);
  expect(legFollowsRoad(null)).toBe(false);
});

test("heading alignment: north-aligned forward, yaw from the XR pose, chevron rotation", () => {
  // Reference -Z facing north: north is forward (-Z), east is right (+X).
  expect(enuToScene({ e: 0, n: 10 }, 0)).toEqual({ x: 0, z: -10 });
  const east = enuToScene({ e: 10, n: 0 }, 0);
  expect(east.x).toBeCloseTo(10, 9);
  expect(east.z).toBeCloseTo(0, 9);
  // Reference -Z facing east: east is forward and north is to the left.
  const fwd = enuToScene({ e: 10, n: 0 }, 90);
  expect(fwd.x).toBeCloseTo(0, 9);
  expect(fwd.z).toBeCloseTo(-10, 9);
  const left = enuToScene({ e: 0, n: 10 }, 90, { x: 1, z: 2 });
  expect(left.x).toBeCloseTo(-9, 9);
  expect(left.z).toBeCloseTo(2, 9);

  // Viewer yaw from a pose quaternion, clockwise seen from above.
  expect(viewerYawCw({ x: 0, y: 0, z: 0, w: 1 })).toBeCloseTo(0, 9);
  const half = Math.SQRT1_2;
  expect(viewerYawCw({ x: 0, y: -half, z: 0, w: half })).toBeCloseTo(90, 9); // turned right
  expect(viewerYawCw({ x: 0, y: half, z: 0, w: half })).toBeCloseTo(270, 9); // turned left
  expect(viewerYawCw({ x: -half, y: 0, z: 0, w: half })).toBeNull(); // looking at the floor
  // The camera points 120° by compass after turning 30° right in the space:
  // the space's -Z points 90°, east.
  expect(referenceHeading(120, 30)).toBeCloseTo(90, 9);
  expect(referenceHeading(10, 30)).toBeCloseTo(340, 9);
  expect(referenceHeading(null, 30)).toBeNull();

  // A -Z-pointing chevron turned by sceneYawForBearing faces the bearing in the scene.
  for (const [bearing, heading] of [
    [0, 0],
    [90, 0],
    [200, 90],
    [45, 300],
  ]) {
    const yaw = sceneYawForBearing(bearing, heading);
    const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const rad = (bearing * Math.PI) / 180;
    const expected = enuToScene({ e: Math.sin(rad), n: Math.cos(rad) }, heading);
    expect(dir.x).toBeCloseTo(expected.x, 9);
    expect(dir.z).toBeCloseTo(expected.z, 9);
  }
});

test("align-to-street offset and the stopped-only speed rule", () => {
  expect(nudgeYaw(0, 5)).toBe(5);
  expect(nudgeYaw(undefined, -5)).toBe(-5);
  expect(nudgeYaw(YAW_MAX_DEG, 5)).toBe(YAW_MAX_DEG);
  expect(nudgeYaw(-YAW_MAX_DEG, -5)).toBe(-YAW_MAX_DEG);

  expect(WORLD_SPEED_LOCK_KMH).toBe(10);
  expect(WORLD_SPEED_FIXES).toBe(2);
  const fast = 12 / 3.6;
  let s = stepWorldSpeed(null, fast);
  expect(s.locked).toBe(false); // one GPS jump never closes the view
  s = stepWorldSpeed(s, null);
  expect(s.locked).toBe(false); // unknown speed keeps the state
  s = stepWorldSpeed(s, fast);
  expect(s.locked).toBe(true);
  s = stepWorldSpeed(s, 10 / 3.6);
  expect(s).toEqual({ fast: 0, locked: false }); // at the limit is not above it
});

// ── UI: entry point, HUD, fallbacks ──

function spjFixture(routeSource, { demo = false } = {}) {
  const demoStop = demo ? { location_type: "DEMO" } : {};
  return {
    spj_id: "SPJ-AR-WORLD",
    spj_number: "DLH-DKI/SPJ/E2E-AR-WORLD",
    truck_code: TRUCK,
    driver_name: "E2E AR",
    destination: "TPST Bantargebang",
    status: "aktif",
    route_source: routeSource,
    stops: [
      {
        name: demo ? "DEMO · Lokasi A" : "TPS Dunia A",
        kecamatan: "Cilandak",
        address: "Jl. Dunia E2E 1",
        ...A,
        ...demoStop,
        status: "completed",
        evidence_summary: { has_evidence: true, weighing_count: 1, total_weight_kg: 80 },
      },
      {
        name: demo ? "DEMO · Lokasi B" : "TPS Dunia B",
        kecamatan: "Cilandak",
        address: "Jl. Dunia E2E 2",
        ...B,
        ...demoStop,
        status: "pending",
      },
    ],
  };
}

const QUEUE = {
  queue_trucks_max: 14,
  arrivals_per_hour: 38,
  trucks_in_queue: 14,
  lat: TPA.lat,
  lng: TPA.lng,
  facility_name: "TPST Bantargebang",
  avg_wait_minutes: 21.4,
  p95_wait_minutes: 48.2,
  weighbridge_status: "OPERATIONAL",
  modelled_hour: 14,
  hour_label: "modelled peak hour 14:00",
  classification: "SIMULATED",
};

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "driver", password: "driver-demo-pass" }),
  });
  expect(res.ok).toBeTruthy();
  return res.json();
}

// Scripted GPS (explicit position, accuracy and device speed per fix) plus a
// navigator.xr stub: "absent", "unsupported", "pending" (session never
// resolves) or "reject". requestSession calls are recorded on window.__xrCalls.
async function installStubs(page, { xr = "pending", camera = false } = {}) {
  await page.addInitScript(
    ({ xr, camera }) => {
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
      if (!camera) {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("none", "NotFoundError"));
      }
      window.__pushFix = (fix) => {
        last = fix;
        for (const cb of watchers.values()) deliver(cb, fix);
      };

      window.__xrCalls = [];
      const stub =
        xr === "absent"
          ? undefined
          : {
              isSessionSupported: (mode) => Promise.resolve(xr !== "unsupported" && mode === "immersive-ar"),
              requestSession: (mode, init) => {
                window.__xrCalls.push({
                  mode,
                  required: init?.requiredFeatures || [],
                  optional: init?.optionalFeatures || [],
                  root: init?.domOverlay?.root?.getAttribute("data-testid") || null,
                });
                if (xr === "reject") return Promise.reject(new DOMException("no AR", "NotSupportedError"));
                return new Promise(() => {});
              },
            };
      Object.defineProperty(navigator, "xr", { configurable: true, get: () => stub });
    },
    { xr, camera },
  );
}

async function stubBackend(
  page,
  { routeSource = "LIVE_EXTERNAL", queue = QUEUE, demo = false, path = PATH } = {},
) {
  await page.route(/\/api\/spj\?status=aktif(&|$)/, (route) =>
    route.fulfill({ json: { spj: [spjFixture(routeSource, { demo })], count: 1 } }),
  );
  await page.route(/\/api\/spj\?status=selesai(&|$)/, (route) =>
    route.fulfill({ json: { spj: [], count: 0 } }),
  );
  await page.route(/\/api\/pretrip\/today\//, (route) => route.fulfill({ json: { done: true } }));
  // The duty banner is not under test here. Unstubbed, an empty server answers with the
  // seeded SIMULATED scenario, which puts T-247 past the 12 h cap on some days and
  // holds the stop start (driver-safety-banner covers that).
  await page.route(/\/api\/safety\/driver\//, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(/\/api\/spj\/active-path\//, (route) =>
    route.fulfill({
      json: {
        truck_code: TRUCK,
        has_active_spj: true,
        has_reference_path: true,
        destination: "TPST Bantargebang",
        path,
      },
    }),
  );
  await page.route(/\/api\/tpa\/queue-status/, (route) => route.fulfill({ json: queue }));
  await page.route(/\/api\/weather$/, (route) =>
    route.fulfill({ json: { source: "open-meteo", forecast: [{ date: "2099-01-01", rainfall_mm: 1 }] } }),
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
  // AR is a button on the route screen's stop sheet, next to "Saya sudah tiba".
  const open = page.getByTestId("stop-1").getByTestId("ar-nav-open");
  await expect(open).toBeVisible({ timeout: 20000 });
  await open.click();
  const nav = page.getByTestId("ar-navigator");
  await expect(nav).toBeVisible();
  return nav;
}

const push = (page, fix) => page.evaluate((f) => window.__pushFix(f), fix);

async function expectTapTarget(locator) {
  const box = await locator.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

test.use({
  viewport: { width: 390, height: 844 },
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

for (const xr of ["absent", "unsupported"]) {
  test(`without immersive-ar (${xr}) there is no street path button and the CSS overlay works`, async ({
    page,
  }) => {
    await installStubs(page, { xr });
    await stubBackend(page);
    const nav = await openAr(page);
    await push(page, { ...at(100, 3), speed: 0 });
    await expect(page.getByTestId("ar-arrow")).toBeVisible();
    await expect(page.getByTestId("ar-spotter-toggle")).toBeVisible();
    await expect(page.getByTestId("ar-world-open")).toHaveCount(0);
    await expect(page.getByTestId("ar-world")).toHaveCount(0);
    await expect(nav).toHaveAttribute("data-world", "off");
  });
}

test("street path: immersive-ar session request, HUD, anchor lock and align-to-street", async ({ page }) => {
  test.setTimeout(90000);
  await installStubs(page, { xr: "pending" });
  await stubBackend(page);
  const nav = await openAr(page);
  await push(page, { ...at(100, 3), speed: 0, accuracy: 12 });
  await expect(page.getByTestId("ar-route-mode")).toHaveAttribute("data-mode", "route");

  const open = page.getByTestId("ar-world-open");
  await expect(open).toHaveText("AR on the street");
  await expectTapTarget(open);
  await open.click();

  // One immersive-ar request from the click: floor + DOM overlay optional,
  // the overlay rooted on the street-path element, nothing hard-required.
  const calls = await page.evaluate(() => window.__xrCalls);
  expect(calls).toEqual([
    { mode: "immersive-ar", required: [], optional: ["local-floor", "dom-overlay"], root: "ar-world" },
  ]);

  await expect(nav).toHaveAttribute("data-world", "on");
  const hud = page.getByTestId("ar-world-hud");
  await expect(hud).toBeVisible();
  await expect(hud).toHaveAttribute("data-status", "starting");
  await expect(page.getByTestId("ar-world-status")).toHaveText("Starting the AR session…");
  // The camera overlay steps aside while the XR session owns the camera.
  await expect(page.getByTestId("ar-arrow")).toHaveCount(0);
  await expect(page.getByTestId("ar-video")).toBeHidden();

  // The distance along the leg and the stop name lead the HUD; the 3D pin carries both.
  const distance = page.getByTestId("ar-world-distance");
  await expect(distance).toHaveText("700 m");
  await expect(distance).toHaveAttribute("data-meters", "700");
  await expect(hud).toHaveAttribute("data-meters", "700");
  await expect(page.getByTestId("ar-world-stop")).toHaveText("to TPS Dunia B");
  await expect(hud).toHaveAttribute("data-pin-label", "TPS Dunia B · 700 m");
  await expect(page.getByTestId("ar-world-arrived")).toHaveCount(0);

  // Honest labels: road route, and every caveat folded into one chip.
  await expect(page.getByTestId("ar-world-route")).toHaveAttribute("data-mode", "route");
  await expect(page.getByTestId("ar-world-route")).toHaveText("Following the planned road route");
  await expect(page.getByTestId("ar-world-accuracy")).toHaveText("GPS ±12 m");
  await expect(page.getByTestId("ar-world-caveats")).toHaveText("GPS ±12 m · not lane-level");
  // ~150 m of chevrons every 4 m ahead on the leg.
  await expect(hud).toHaveAttribute("data-anchors", "1");
  await expect(hud).toHaveAttribute("data-anchor-locked", "true");
  await expect(page.getByTestId("ar-world-settling")).toHaveCount(0);
  const count = Number(await hud.getAttribute("data-chevrons"));
  expect(count).toBeGreaterThanOrEqual(36);
  expect(count).toBeLessThanOrEqual(39);

  // A ±12 m first fix locked the anchor: walking 30 m or a sharper fix no
  // longer re-anchors (the old 25 m rule made the chevrons jump mid-walk).
  await push(page, { ...at(115, 3), speed: 0, accuracy: 12 });
  await push(page, { ...at(130, 3), speed: 0, accuracy: 12 });
  await expect(distance).toHaveAttribute("data-meters", "670");
  await push(page, { ...at(130, 3), speed: 0, accuracy: 6 });
  await expect(page.getByTestId("ar-world-accuracy")).toHaveText("GPS ±6 m");
  await expect(hud).toHaveAttribute("data-anchors", "1");
  await expect(hud).toHaveAttribute("data-anchor-locked", "true");
  // Close to the stop the window ends at the stop.
  await push(page, { ...at(400, 360), speed: 0, accuracy: 6 });
  await expect.poll(async () => Number(await hud.getAttribute("data-chevrons"))).toBeLessThanOrEqual(11);
  await expect(hud).toHaveAttribute("data-anchors", "1");

  // Align to street: ±5° steps, persisted for this tab session.
  const right = page.getByTestId("ar-world-yaw-right");
  const left = page.getByTestId("ar-world-yaw-left");
  await expectTapTarget(right);
  await expectTapTarget(left);
  await expectTapTarget(page.getByTestId("ar-world-exit"));
  await expect(right).toHaveAccessibleName("Turn the path 5° right");
  await right.click();
  await right.click();
  await left.click();
  await right.click();
  await expect(hud).toHaveAttribute("data-yaw-offset", "10");
  await expect(page.getByTestId("ar-world-yaw")).toHaveText("Align to street · +10°");
  expect(await page.evaluate(() => sessionStorage.getItem("pythia_ar_world_yaw"))).toBe("10");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // Leaving returns to the CSS overlay; reopening keeps the offset.
  await page.getByTestId("ar-world-exit").click();
  await expect(nav).toHaveAttribute("data-world", "off");
  await expect(page.getByTestId("ar-world-hud")).toHaveCount(0);
  await expect(page.getByTestId("ar-arrow")).toBeVisible();
  await page.getByTestId("ar-world-open").click();
  await expect(page.getByTestId("ar-world-hud")).toHaveAttribute("data-yaw-offset", "10");
  expect(await page.evaluate(() => window.__xrCalls.length)).toBe(2);
});

test("street path labels a straight-line fallback route and fits a 320 px phone (id)", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await installStubs(page, { xr: "pending" });
  await stubBackend(page, { routeSource: "STRAIGHT_FALLBACK" });
  await openAr(page, "id");
  await push(page, { ...at(100, 3), speed: 0, accuracy: 9 });
  await expect(page.getByTestId("ar-route-mode")).toHaveAttribute("data-mode", "straight");
  await expect(page.getByTestId("ar-world-open")).toHaveText("AR di jalan");
  await page.getByTestId("ar-world-open").click();
  const route = page.getByTestId("ar-world-route");
  await expect(route).toHaveAttribute("data-mode", "straight");
  await expect(route).toHaveText("Garis lurus, bukan rute jalan — rute ini tanpa geometri jalan");
  await expect(page.getByTestId("ar-world-caveats")).toHaveText("GPS ±9 m · bukan setingkat lajur");
  await expect(page.getByTestId("ar-world-stop")).toHaveText("ke TPS Dunia B");
  // The straight line from the anchor fix still gets 150 m of chevrons.
  await expect(page.getByTestId("ar-world-hud")).toHaveAttribute("data-chevrons", "38");
  await expect(page.getByTestId("ar-world-exit")).toHaveText("Tampilan kamera");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("a refused WebXR session falls back to the camera overlay and says so", async ({ page }) => {
  await installStubs(page, { xr: "reject" });
  await stubBackend(page);
  const nav = await openAr(page);
  await push(page, { ...at(100, 3), speed: 0 });
  await page.getByTestId("ar-world-open").click();
  await expect(page.getByTestId("ar-world-error")).toHaveText(
    "The street path could not start on this phone — showing the camera view.",
  );
  await expect(nav).toHaveAttribute("data-world", "off");
  await expect(page.getByTestId("ar-arrow")).toBeVisible();
  await expect(page.getByTestId("ar-world-open")).toBeEnabled();
});

test("stopped-only AR: moving closes the street path and hides the camera behind the arrow card", async ({
  page,
}) => {
  test.setTimeout(90000);
  await installStubs(page, { xr: "pending", camera: true });
  await stubBackend(page);
  const nav = await openAr(page);
  await push(page, { ...at(100, 3), speed: 0 });
  await expect(nav).toHaveAttribute("data-view", "camera");
  await page.getByTestId("ar-world-open").click();
  await expect(page.getByTestId("ar-world-hud")).toBeVisible();

  // One fast fix is a GPS jump, not driving: the street path stays.
  await push(page, { ...at(110, 3), speed: 4 }); // 14.4 km/h
  await expect(nav).toHaveAttribute("data-world", "on");
  // The second closes it: plain arrow card, camera hidden, localized note.
  await push(page, { ...at(120, 3), speed: 4 });
  await expect(nav).toHaveAttribute("data-world", "off");
  await expect(nav).toHaveAttribute("data-speed-locked", "false");
  await expect(nav).toHaveAttribute("data-view", "compass");
  await expect(page.getByTestId("ar-video")).toBeHidden();
  await expect(page.getByTestId("ar-compass")).toBeVisible();
  await expect(page.getByTestId("ar-arrow")).toBeVisible();
  await expect(page.getByTestId("ar-world-stopped-only")).toHaveText(
    "Stopped-only AR: the street path closed above 10 km/h. Stop to use it again.",
  );
  await expect(page.getByTestId("ar-world-open")).toBeDisabled();

  // Sustained speed still trips the existing full lock (no arrow at all).
  await push(page, { ...at(130, 3), speed: 4 });
  await expect(nav).toHaveAttribute("data-speed-locked", "true");
  await expect(page.getByTestId("ar-speed-lock")).toBeVisible();
  await expect(page.getByTestId("ar-arrow")).toHaveCount(0);

  // Standing still releases both: the camera view and the button come back.
  for (let i = 0; i < 3; i += 1) await push(page, { ...at(130, 3), speed: 0 });
  await expect(nav).toHaveAttribute("data-speed-locked", "false");
  await expect(nav).toHaveAttribute("data-view", "camera");
  await expect(page.getByTestId("ar-video")).toBeVisible();
  await expect(page.getByTestId("ar-world-open")).toBeEnabled();
});

test("a poor first fix keeps the anchor provisional and says so until GPS is within ±15 m", async ({
  page,
}) => {
  await installStubs(page, { xr: "pending" });
  await stubBackend(page);
  await openAr(page);
  await push(page, { ...at(100, 3), speed: 0, accuracy: 30 });
  await page.getByTestId("ar-world-open").click();
  const hud = page.getByTestId("ar-world-hud");
  await expect(hud).toHaveAttribute("data-anchors", "1");
  await expect(hud).toHaveAttribute("data-anchor-locked", "false");
  await expect(page.getByTestId("ar-world-settling")).toContainText(
    "path may shift until GPS is within ±15 m",
  );
  // Provisional: a 40 m move still re-anchors.
  await push(page, { ...at(140, 3), speed: 0, accuracy: 30 });
  await expect(hud).toHaveAttribute("data-anchors", "2");
  // A ±10 m fix locks it; from then on walking never re-anchors.
  await push(page, { ...at(142, 3), speed: 0, accuracy: 10 });
  await expect(hud).toHaveAttribute("data-anchors", "3");
  await expect(hud).toHaveAttribute("data-anchor-locked", "true");
  await expect(page.getByTestId("ar-world-settling")).toHaveCount(0);
  await push(page, { ...at(200, 3), speed: 0, accuracy: 10 });
  await push(page, { ...at(260, 3), speed: 0, accuracy: 10 });
  await expect(page.getByTestId("ar-world-distance")).toHaveAttribute("data-meters", "540");
  await expect(hud).toHaveAttribute("data-anchors", "3");
});

test("arrival in the street path shows a banner whose button returns to the camera to take the photo", async ({
  page,
}) => {
  await installStubs(page, { xr: "pending", camera: true });
  await stubBackend(page);
  const nav = await openAr(page);
  await push(page, { ...at(400, 300), speed: 0, accuracy: 8 });
  await page.getByTestId("ar-world-open").click();
  await expect(page.getByTestId("ar-world-distance")).toHaveText("100 m");
  await push(page, { ...at(400, 395), speed: 0, accuracy: 8 });
  await expect(nav).toHaveAttribute("data-arrived", "true");
  const banner = page.getByTestId("ar-world-arrived");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("You are at TPS Dunia B");
  await expect(page.getByTestId("ar-world-distance")).toHaveCount(0);
  await expect(page.getByTestId("ar-world-hud")).toHaveAttribute("data-arrived", "true");
  const capture = page.getByTestId("ar-world-capture");
  await expect(capture).toHaveText("Take the arrival photo");
  await expectTapTarget(capture);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await capture.click();
  // The XR session ends; the camera view's own capture (same evidence flow) takes over.
  await expect(nav).toHaveAttribute("data-world", "off");
  await expect(nav).toHaveAttribute("data-view", "camera");
  await expect(page.getByTestId("ar-arrived")).toBeVisible();
  await expect(page.getByTestId("ar-capture")).toBeVisible();
});

test("DEMO stop: the leg from stop 1 follows its stitched road geometry", async ({ page }) => {
  // Stitched DEMO geometry (backend activate): stop 1 → stop 2 on the road
  // (the corner), the unresolved hop to the destination a straight segment.
  const C = at(400, 5000);
  await installStubs(page, { xr: "pending" });
  await stubBackend(page, { routeSource: "FALLBACK_DEGRADED", demo: true, path: [...PATH, C] });
  await openAr(page);
  await push(page, { ...at(100, 3), speed: 0, accuracy: 9 });
  const mode = page.getByTestId("ar-route-mode");
  await expect(mode).toHaveAttribute("data-mode", "route");
  await expect(page.getByTestId("ar-distance")).toHaveAttribute("data-meters", "700");
  await page.getByTestId("ar-world-open").click();
  await expect(page.getByTestId("ar-world-route")).toHaveAttribute("data-mode", "route");
  await expect(page.getByTestId("ar-world-hud")).toHaveAttribute("data-pin-label", "DEMO · Lokasi B · 700 m");
});

test("DEMO stop without a road leg keeps the straight-line label and names the DEMO cause (id)", async ({
  page,
}) => {
  await installStubs(page, { xr: "pending" });
  await stubBackend(page, { routeSource: "FALLBACK_DEGRADED", demo: true, path: [A, B, at(400, 5000)] });
  await openAr(page, "id");
  await push(page, { ...at(100, 3), speed: 0, accuracy: 9 });
  const mode = page.getByTestId("ar-route-mode");
  await expect(mode).toHaveAttribute("data-mode", "straight");
  await expect(mode).toHaveAttribute("data-reason", "demo");
  await page.getByTestId("ar-world-open").click();
  await expect(page.getByTestId("ar-world-route")).toHaveText(
    "Garis lurus, bukan rute jalan — tidak ada rute jalan menuju titik DEMO ini",
  );
});

test("TPA spotter shows the modelled peak hour from queue-status", async ({ page }) => {
  // The backend contract this relies on: modelled_hour + hour_label, SIMULATED.
  const live = await (await fetch(`${API}/tpa/queue-status`)).json();
  expect(live.classification).toBe("SIMULATED");
  expect("hour_label" in live && "modelled_hour" in live).toBe(true);
  if (live.modelled_hour !== null) expect(live.hour_label).toContain(String(live.modelled_hour));

  await installStubs(page, { xr: "absent" });
  await stubBackend(page);
  await openAr(page);
  await push(page, { lat: TPA.lat + 0.002, lng: TPA.lng, speed: 0.5 });
  const toggle = page.getByTestId("ar-spotter-toggle");
  await toggle.click();
  await expect(page.getByTestId("ar-spotter-sim")).toHaveText("SIMULATED");
  await expect(page.getByTestId("ar-spotter-peak-hour")).toHaveText(
    "Modelled peak hour 14:00 WIB (simulated)",
  );

  // Only the backend label (older payload): shown as served.
  await page.unroute(/\/api\/tpa\/queue-status/);
  await page.route(/\/api\/tpa\/queue-status/, (route) =>
    route.fulfill({ json: { ...QUEUE, modelled_hour: undefined, hour_label: "modelled peak hour 09:00" } }),
  );
  await toggle.click();
  await toggle.click();
  await expect(page.getByTestId("ar-spotter-peak-hour")).toHaveText("modelled peak hour 09:00");

  // Neither field: no peak-hour line.
  await page.unroute(/\/api\/tpa\/queue-status/);
  await page.route(/\/api\/tpa\/queue-status/, (route) =>
    route.fulfill({ json: { ...QUEUE, modelled_hour: null, hour_label: null } }),
  );
  await toggle.click();
  await toggle.click();
  await expect(page.getByTestId("ar-spotter-queue")).toBeVisible();
  await expect(page.getByTestId("ar-spotter-peak-hour")).toHaveCount(0);
});
