// gsc-2026 P1-11: route-following arrow, speed lock and TPA spotter math for AR on foot.
// Pure functions only: arMath.js is imported straight into the test runner,
// no page, so these run without a browser. Only the TPA spotter test reads
// the facility point the backend serves.
import { expect, test } from "@playwright/test";
import {
  LOOKAHEAD_MAX_M,
  LOOKAHEAD_MIN_M,
  OFF_ROUTE_M,
  RAIN_NO_GO_MM,
  SPEED_LOCK_FIXES,
  SPEED_LOCK_KMH,
  TPA_SPOTTER_RADIUS_M,
  cumulativeLengths,
  fixSpeed,
  haversineMeters,
  initialBearing,
  legToStop,
  pointAlong,
  projectToSegment,
  rainNoGo,
  routeTarget,
  snapToPath,
  stepSpeedLock,
  tpaSpotterRange,
} from "../src/surfaces/driver/arMath.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// An L-shaped planned leg in Jakarta: stop A, 400 m east to a corner C,
// 400 m north to stop B. Offsets are metres converted at this latitude.
const LAT0 = -6.25;
const LNG0 = 106.8;
const M_LAT = 1 / 111195;
const M_LNG = 1 / (111195 * Math.cos((LAT0 * Math.PI) / 180));
const at = (east, north) => ({ lat: LAT0 + north * M_LAT, lng: LNG0 + east * M_LNG });
const A = at(0, 0);
const C = at(400, 0);
const B = at(400, 400);
const PATH = [A, at(200, 0), C, at(400, 200), B];

test("segment projection, cumulative length and point-along", () => {
  const mid = projectToSegment(at(100, 10), A, C);
  expect(mid.t).toBeCloseTo(0.25, 3);
  expect(mid.distance).toBeCloseTo(10, 0);
  // Beyond the segment end the projection clamps to the vertex.
  const past = projectToSegment(at(500, 0), A, C);
  expect(past.t).toBe(1);
  expect(past.distance).toBeCloseTo(100, 0);
  // A zero-length segment projects onto its single point.
  expect(projectToSegment(at(30, 40), A, A).distance).toBeCloseTo(50, 0);

  const cum = cumulativeLengths(PATH);
  expect(cum[0]).toBe(0);
  expect(cum[2]).toBeCloseTo(400, 0);
  expect(cum[4]).toBeCloseTo(800, 0);
  expect(haversineMeters(pointAlong(PATH, 600, cum), at(400, 200))).toBeLessThan(0.5);
  expect(haversineMeters(pointAlong(PATH, 450, cum), at(400, 50))).toBeLessThan(0.5);
  expect(pointAlong(PATH, -10, cum)).toEqual(A);
  expect(pointAlong(PATH, 5000, cum)).toEqual(B);
});

test("snapping finds along-track position and cross-track offset", () => {
  const snap = snapToPath(PATH, at(410, 300));
  expect(snap.segment).toBe(3);
  expect(snap.along).toBeCloseTo(700, 0);
  expect(snap.offset).toBeCloseTo(10, 0);
  // Searching from a later segment ignores earlier parts of the path.
  const restricted = snapToPath(PATH, at(100, 0), { from: 2 });
  expect(restricted.segment).toBe(2);
  expect(restricted.offset).toBeGreaterThan(250);
  expect(snapToPath([A], at(1, 1))).toBeNull();
});

test("the leg to a stop runs from the previous stop's snap to this stop's snap", () => {
  const leg = legToStop(PATH, [A, B], 1);
  expect(leg.startAlong).toBeCloseTo(0, 3);
  expect(leg.endAlong).toBeCloseTo(800, 0);
  expect(leg.stopOffset).toBeCloseTo(0, 3);
  // The planned route starts at the first stop: no leg to follow there.
  expect(legToStop(PATH, [A, B], 0)).toBeNull();
  // Missing data and a stop without a coordinate never invent a leg.
  expect(legToStop(null, [A, B], 1)).toBeNull();
  expect(legToStop(PATH, [A, { lat: null, lng: null }], 1)).toBeNull();
  expect(legToStop(PATH, [A, B], 2)).toBeNull();

  // A loop that passes stop 2's position before reaching stop 1: stops are
  // snapped in visiting order, so stop 2 lands on the final pass.
  const loop = [A, at(0, 200), at(200, 200), at(200, 0), at(400, 0), at(400, 200), at(0, 200)];
  const leg2 = legToStop(loop, [A, at(200, 0), at(100, 200)], 2);
  expect(leg2.startAlong).toBeCloseTo(600, 0);
  expect(leg2.endAlong).toBeCloseTo(1300, 0);
});

test("route target aims at the next vertex inside the look-ahead window", () => {
  expect(LOOKAHEAD_MIN_M).toBeGreaterThanOrEqual(25);
  expect(LOOKAHEAD_MAX_M).toBeLessThanOrEqual(40);
  const leg = legToStop(PATH, [A, B], 1);

  // Mid-straight, next vertex 100 m ahead: capped at the max look-ahead.
  const fix = at(100, 3);
  const mid = routeTarget(leg, fix, B);
  expect(haversineMeters(mid.target, at(100 + LOOKAHEAD_MAX_M, 0))).toBeLessThan(0.5);
  expect(mid.remaining).toBeCloseTo(700 + 0, 0);
  expect(initialBearing(fix, mid.target)).toBeGreaterThan(80); // east along the road …
  expect(initialBearing(fix, B)).toBeLessThan(50); // … not north-east through the block

  // 30 m before the corner the next vertex (the corner) is inside the window.
  const corner = routeTarget(leg, at(370, 0), B);
  expect(haversineMeters(corner.target, C)).toBeLessThan(0.5);
  // 10 m before the corner the window floor pushes the aim round the corner.
  const turning = routeTarget(leg, at(390, 0), B);
  expect(haversineMeters(turning.target, at(400, LOOKAHEAD_MIN_M - 10))).toBeLessThan(0.5);

  // On the final approach the aim is the stop itself.
  const final = routeTarget(leg, at(400, 380), B);
  expect(final.target).toEqual({ lat: B.lat, lng: B.lng });
  expect(final.remaining).toBeCloseTo(20, 0);

  // Remaining is never less than the straight-line distance.
  const beside = routeTarget(leg, at(400 - 40, 390), B);
  expect(beside.remaining).toBeGreaterThanOrEqual(haversineMeters(at(360, 390), B) - 1e-9);

  // Off the leg by more than OFF_ROUTE_M → null (the caller shows the straight bearing).
  expect(routeTarget(leg, at(200, OFF_ROUTE_M + 20), B)).toBeNull();
  expect(routeTarget(leg, at(200, OFF_ROUTE_M - 10), B)).not.toBeNull();
  expect(routeTarget(null, fix, B)).toBeNull();
  expect(routeTarget(leg, null, B)).toBeNull();
});

test("speed: device speed wins, derived speed ignores jitter and short intervals", () => {
  const p0 = { ...at(0, 0), at: 0 };
  expect(fixSpeed(p0, { ...at(0, 0), at: 1000, speed: 7.5 })).toBe(7.5);
  // 100 m in 10 s = 10 m/s, minus 5 m of GPS jitter → 9.5 m/s.
  expect(fixSpeed(p0, { ...at(100, 0), at: 10000, speed: null })).toBeCloseTo(9.5, 1);
  // A 4 m wobble while standing still reads as zero.
  expect(fixSpeed(p0, { ...at(4, 0), at: 2000 })).toBe(0);
  // Fixes less than a second apart cannot be judged.
  expect(fixSpeed(p0, { ...at(50, 0), at: 500 })).toBeNull();
  expect(fixSpeed(null, { ...at(50, 0), at: 500 })).toBeNull();
  // Negative device speed (unknown on some phones) falls back to derivation.
  expect(fixSpeed(p0, { ...at(0, 0), at: 2000, speed: -1 })).toBe(0);
});

test("speed lock engages after sustained vehicle speed and releases on foot", () => {
  expect(SPEED_LOCK_KMH).toBeLessThanOrEqual(6);
  expect(SPEED_LOCK_FIXES).toBe(3);
  const drive = SPEED_LOCK_KMH / 3.6 + 3; // m/s, clearly a vehicle
  const walk = 1.2; // m/s, a walking crew
  let state = null;
  const push = (speed, t) => {
    state = stepSpeedLock(state, { ...at(0, 0), at: t, speed });
    return state.locked;
  };
  expect(push(walk, 0)).toBe(false);
  expect(push(drive, 1000)).toBe(false);
  expect(push(drive, 2000)).toBe(false);
  // A walking fix in between resets the count: one GPS jump never locks.
  expect(push(walk, 3000)).toBe(false);
  expect(push(drive, 4000)).toBe(false);
  expect(push(drive, 5000)).toBe(false);
  expect(push(drive, 6000)).toBe(true);
  // A single slow fix (a red light) does not unlock.
  expect(push(0, 7000)).toBe(true);
  expect(push(drive, 8000)).toBe(true);
  expect(push(0, 9000)).toBe(true);
  expect(push(walk, 10000)).toBe(true);
  expect(push(0, 11000)).toBe(false);

  // Without device speed, 5 Hz fixes still measure over ≥ 1 s: the
  // baseline is held until a second has passed.
  let derived = null;
  for (let i = 0; i <= 20; i += 1) {
    derived = stepSpeedLock(derived, { ...at(i * 2, 0), at: i * 200, speed: null }); // 10 m/s
  }
  expect(derived.locked).toBe(true);
  expect(derived.speed).toBeGreaterThan(SPEED_LOCK_KMH / 3.6);
});

test("TPA spotter triggers at the served Bantargebang point and not 3 km away", async ({ request }) => {
  // The spotter measures from the queue-status point, as ArNavigator does.
  const res = await request.get(`${API}/tpa/queue-status`);
  expect(res.ok()).toBeTruthy();
  const queue = await res.json();
  expect(queue.facility_name).toBe("TPST Bantargebang");
  const tpa = { lat: queue.lat, lng: queue.lng };

  expect(tpaSpotterRange(tpa, tpa)).toEqual({ distance: 0, near: true });
  const onSite = tpaSpotterRange({ lat: tpa.lat + 1000 / 111195, lng: tpa.lng }, tpa);
  expect(onSite.near).toBe(true);
  const away = tpaSpotterRange({ lat: tpa.lat + 3000 / 111195, lng: tpa.lng }, tpa);
  expect(away.distance).toBeCloseTo(3000, -1);
  expect(away.near).toBe(false);

  // The old point was the A* weighbridge-approach node outside the landfill:
  // measured from it, a crew at the facility was out of spotter range.
  const weighbridgeApproach = { lat: -6.331, lng: 106.991 };
  expect(tpaSpotterRange(tpa, weighbridgeApproach).near).toBe(false);
  expect(haversineMeters(tpa, weighbridgeApproach)).toBeGreaterThan(TPA_SPOTTER_RADIUS_M);

  // No fix or no served point is never "near".
  expect(tpaSpotterRange(null, tpa)).toEqual({ distance: null, near: false });
  expect(tpaSpotterRange(tpa, null)).toEqual({ distance: null, near: false });
});

test("rain no-go reads today's forecast against the threshold", () => {
  expect(RAIN_NO_GO_MM).toBe(20);
  const forecast = [
    { date: "2026-10-21", rainfall_mm: 2 },
    { date: "2026-10-22", rainfall_mm: 42.5 },
  ];
  expect(rainNoGo(forecast, "2026-10-22")).toEqual({ date: "2026-10-22", mm: 42.5, noGo: true });
  // No entry for today → the first forecast day, labelled with its date.
  expect(rainNoGo(forecast, "2026-10-30")).toEqual({ date: "2026-10-21", mm: 2, noGo: false });
  // Exactly at the threshold is not over it.
  expect(rainNoGo([{ date: "d", rainfall_mm: RAIN_NO_GO_MM }], "d").noGo).toBe(false);
  expect(rainNoGo([], "d")).toBeNull();
  expect(rainNoGo(null, "d")).toBeNull();
  expect(rainNoGo([{ date: "d", rainfall_mm: null }], "d")).toBeNull();
});
