// Pure geometry for the WebXR street path (ArWorldPath).
// No DOM, no three.js: e2e imports this module straight into the test runner.
//
// Frames used here:
// - WGS84 {lat, lng} from the phone GPS and the SPJ route.
// - Local ENU {e, n} in metres (east, north) around an anchor fix.
// - XR scene {x, z} in metres: three.js / WebXR, +x right, -z forward, as
//   seen from the reference space the session started in.

import { cumulativeLengths, pointAlong, wrap360 } from "./arMath.js";

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** Chevron spacing along the path, metres. */
export const CHEVRON_STEP_M = 4;
/** How far ahead of the crew the street path is drawn, metres. */
export const PATH_AHEAD_M = 150;
/** Before the anchor locks: re-anchor when the fix has moved further than this… */
export const REANCHOR_MOVE_M = 25;
/** …or when the GPS accuracy improved by at least this much. */
export const REANCHOR_ACCURACY_GAIN_M = 5;
/** The first fix at or better than this accuracy locks the anchor for the walk. */
export const ANCHOR_LOCK_ACCURACY_M = 15;
/** Once locked, the path is corrected only when GPS and WebXR tracking disagree by more than this × the fix accuracy. */
export const DRIFT_FACTOR = 2;
/** A drift correction glides the path over about this long instead of jumping. */
export const CORRECTION_EASE_MS = 1200;
/** One "Align to street" press turns the path by this many degrees. */
export const YAW_STEP_DEG = 5;
/** The manual yaw offset is clamped to ± this. */
export const YAW_MAX_DEG = 90;
/** The camera AR closes above this speed: street path is a stopped-only view. */
export const WORLD_SPEED_LOCK_KMH = 10;
/** Consecutive fixes above WORLD_SPEED_LOCK_KMH that close the street path. */
export const WORLD_SPEED_FIXES = 2;
// Below this horizontal length of the camera's forward axis (looking almost
// straight down or up) its yaw is noise; the same cut-off as arMath's compass.
const FLAT_FORWARD = 0.4;

/**
 * WGS84 → local ENU metres around `anchor` (local flat-earth / equirectangular).
 *
 * Error budget: the only approximation is using cos(anchor.lat) for the whole
 * area. Over d metres north–south the east scale drifts by tan(lat)·d/R, so at
 * Jakarta (6° S) and 2 km the position error is under 0.1 m, and well under
 * 1 m at 45° latitude. Phone GPS is good to 5–30 m, so the projection never
 * dominates; above ~2 km from the anchor, re-anchor rather than extend it.
 */
export function toEnu(anchor, point) {
  const k = EARTH_RADIUS_M * DEG;
  return {
    e: (point.lng - anchor.lng) * k * Math.cos(anchor.lat * DEG),
    n: (point.lat - anchor.lat) * k,
  };
}

/** Inverse of toEnu (same approximation). */
export function fromEnu(anchor, { e, n }) {
  const k = EARTH_RADIUS_M * DEG;
  return { lat: anchor.lat + n / k, lng: anchor.lng + e / (k * Math.cos(anchor.lat * DEG)) };
}

function segmentLengths(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(points[i].e - points[i - 1].e, points[i].n - points[i - 1].n));
  }
  return cum;
}

/** Bearing of an ENU direction, degrees clockwise from north, [0, 360). */
export function enuBearing(de, dn) {
  return wrap360(Math.atan2(de, dn) / DEG);
}

/**
 * Resample an ENU polyline every `step` metres, starting at its first vertex
 * and always keeping its last one. Each sample carries `along` (metres from
 * the start) and `bearing` (direction of travel on its segment).
 */
export function resamplePolyline(points, step = CHEVRON_STEP_M) {
  return samplesBetween(points, 0, Infinity, step, true);
}

/**
 * Chevrons on the stretch [fromAlong, fromAlong + ahead] of an ENU polyline.
 * Samples sit at whole multiples of `step` from the polyline start, so they
 * stay put on the street while the crew walks (only the window moves).
 */
export function chevronsAhead(points, fromAlong, { step = CHEVRON_STEP_M, ahead = PATH_AHEAD_M } = {}) {
  return samplesBetween(points, Math.max(0, fromAlong), Math.max(0, fromAlong) + ahead, step, false);
}

function samplesBetween(points, from, to, step, keepLast) {
  if (!Array.isArray(points) || points.length < 2 || !(step > 0)) return [];
  const cum = segmentLengths(points);
  const total = cum[cum.length - 1];
  if (total <= 0) return [];
  const end = Math.min(to, total);
  const out = [];
  let seg = 0;
  const sampleAt = (along) => {
    while (seg < points.length - 2 && cum[seg + 1] < along) seg += 1;
    const a = points[seg];
    const b = points[seg + 1];
    const len = cum[seg + 1] - cum[seg];
    const t = len === 0 ? 0 : (along - cum[seg]) / len;
    return {
      e: a.e + (b.e - a.e) * t,
      n: a.n + (b.n - a.n) * t,
      along,
      bearing: enuBearing(b.e - a.e, b.n - a.n),
    };
  };
  for (let along = Math.max(0, Math.ceil(from / step - 1e-9) * step); along <= end + 1e-9; along += step) {
    out.push(sampleAt(Math.min(along, total)));
  }
  // Keep the last vertex unless a sample already sits within a millimetre of it.
  if (keepLast && (out.length === 0 || total - out[out.length - 1].along > 1e-3)) out.push(sampleAt(total));
  return out;
}

/** Along-polyline distance (m) of the point of an ENU polyline nearest to p. */
export function alongOnPolyline(points, p) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const cum = segmentLengths(points);
  let best = { d: Infinity, along: 0 };
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const de = b.e - a.e;
    const dn = b.n - a.n;
    const len2 = de * de + dn * dn;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.e - a.e) * de + (p.n - a.n) * dn) / len2));
    const d = Math.hypot(a.e + de * t - p.e, a.n + dn * t - p.n);
    if (d < best.d) best = { d, along: cum[i] + (cum[i + 1] - cum[i]) * t };
  }
  return best.along;
}

/**
 * The planned leg (arMath legToStop) as a WGS84 polyline from the previous
 * stop to this stop: the leg's start point, the route vertices inside it, its
 * end point and finally the stop itself when it sits off the road.
 */
export function legPolyline(leg, stop) {
  if (!leg) return [];
  const cum = leg.cum || cumulativeLengths(leg.path);
  const out = [pointAlong(leg.path, leg.startAlong, cum)];
  for (let i = leg.startSegment + 1; i <= leg.endSegment; i += 1) {
    if (cum[i] > leg.startAlong && cum[i] < leg.endAlong)
      out.push({ lat: leg.path[i].lat, lng: leg.path[i].lng });
  }
  out.push(pointAlong(leg.path, leg.endAlong, cum));
  if (stop && leg.stopOffset > 1) out.push({ lat: stop.lat, lng: stop.lng });
  return out;
}

/**
 * Re-anchor the ENU origin on a new fix? Yes with no anchor yet, when the fix
 * has moved more than REANCHOR_MOVE_M from the anchor fix, or when its
 * accuracy improved by REANCHOR_ACCURACY_GAIN_M or more.
 */
export function shouldReanchor(anchorFix, fix) {
  if (!fix) return false;
  if (!anchorFix) return true;
  const { e, n } = toEnu(anchorFix, fix);
  if (Math.hypot(e, n) > REANCHOR_MOVE_M) return true;
  const was = Number.isFinite(anchorFix.accuracy) ? anchorFix.accuracy : null;
  const now = Number.isFinite(fix.accuracy) ? fix.accuracy : null;
  if (now === null) return false;
  return was === null || was - now >= REANCHOR_ACCURACY_GAIN_M;
}

/**
 * Anchor for the next fix: { fix, seq, locked } (pass null to start).
 *
 * Re-anchoring on every 25 m walked put the origin where the phone stood at
 * each new fix, so the chevrons jumped by the GPS error mid-walk. Instead the
 * anchor follows the fix only until a fix is good enough
 * (≤ ANCHOR_LOCK_ACCURACY_M); then it locks and WebXR tracking, which is
 * centimetre-smooth over a walk, carries the path. Large drift is handled in
 * the scene (driftExceeds / correctedOrigin), never by a new anchor.
 */
export function nextAnchor(anchor, fix) {
  if (!fix) return anchor;
  const lockable = Number.isFinite(fix.accuracy) && fix.accuracy <= ANCHOR_LOCK_ACCURACY_M;
  if (!anchor) return { fix, seq: 1, locked: lockable };
  if (anchor.locked) return anchor;
  if (lockable || shouldReanchor(anchor.fix, fix)) return { fix, seq: anchor.seq + 1, locked: lockable };
  return anchor;
}

/** Inverse of enuToScene: a scene {x, z} back to ENU metres around the anchor. */
export function sceneToEnu({ x, z }, heading, origin = { x: 0, z: 0 }) {
  const h = heading * DEG;
  const c = Math.cos(h);
  const s = Math.sin(h);
  const dx = x - origin.x;
  const dz = z - origin.z;
  return { e: dx * c - dz * s, n: -dx * s - dz * c };
}

/**
 * Does WebXR tracking (`tracked`, ENU of the phone's pose) disagree with GPS
 * (`gps`, ENU of the fix) by more than DRIFT_FACTOR × the fix accuracy?
 * An unknown accuracy never triggers a correction.
 */
export function driftExceeds(gps, tracked, accuracy) {
  if (!gps || !tracked || !Number.isFinite(accuracy) || accuracy <= 0) return false;
  return Math.hypot(gps.e - tracked.e, gps.n - tracked.n) > DRIFT_FACTOR * accuracy;
}

/** Scene origin that puts the GPS fix (`gpsEnu`) where the phone stands now (`phone`, scene {x, z}). */
export function correctedOrigin(phone, gpsEnu, heading) {
  const offset = enuToScene(gpsEnu, heading);
  return { x: phone.x - offset.x, z: phone.z - offset.z };
}

/**
 * One frame of a drift correction: move `from` toward `to` (scene {x, z})
 * with an exponential ease of time constant CORRECTION_EASE_MS / 6, so the
 * path glides and is over 99 % of the way after CORRECTION_EASE_MS.
 * Returns `to` itself once closer than 1 cm.
 */
export function easeOrigin(from, to, dtMs) {
  const k = 1 - Math.exp((-6 * Math.max(0, dtMs)) / CORRECTION_EASE_MS);
  const next = { x: from.x + (to.x - from.x) * k, z: from.z + (to.z - from.z) * k };
  return Math.hypot(to.x - next.x, to.z - next.z) < 0.01 ? to : next;
}

/**
 * Yaw of the camera's forward axis (-Z) in the XR reference space, degrees
 * clockwise seen from above, [0, 360), from a pose orientation quaternion
 * {x, y, z, w}. null when the camera looks almost straight down or up.
 */
export function viewerYawCw(q) {
  if (!q) return null;
  const { x, y, z, w } = q;
  const fx = -2 * (x * z + w * y);
  const fz = -(1 - 2 * (x * x + y * y));
  if (Math.hypot(fx, fz) < FLAT_FORWARD) return null;
  return wrap360(Math.atan2(fx, -fz) / DEG);
}

/**
 * Compass heading of the reference space's -Z axis: the camera's compass
 * heading minus how far the camera has turned (clockwise) inside the space.
 */
export function referenceHeading(compassHeading, cameraYawCw) {
  if (!Number.isFinite(compassHeading) || !Number.isFinite(cameraYawCw)) return null;
  return wrap360(compassHeading - cameraYawCw);
}

/**
 * ENU → XR scene. `heading` is the compass heading of the reference space's
 * -Z axis (plus the driver's manual yaw offset); `origin` is the scene {x, z}
 * where the anchor fix was taken. North-aligned forward: with heading 0,
 * north is -Z and east is +X.
 */
export function enuToScene({ e, n }, heading, origin = { x: 0, z: 0 }) {
  const h = heading * DEG;
  const c = Math.cos(h);
  const s = Math.sin(h);
  return { x: origin.x + e * c - n * s, z: origin.z - (e * s + n * c) };
}

/** three.js rotation.y (radians) that turns a -Z-pointing mesh to a compass bearing. */
export function sceneYawForBearing(bearing, heading) {
  return -((bearing - heading) * DEG);
}

/** Manual "Align to street" offset: add `delta`, clamp to ±YAW_MAX_DEG. */
export function nudgeYaw(offset, delta) {
  const base = Number.isFinite(offset) ? offset : 0;
  return Math.max(-YAW_MAX_DEG, Math.min(YAW_MAX_DEG, base + delta));
}

/**
 * Advance the street-path speed check by one fix speed (m/s or null).
 * State { fast, locked }; pass null to start. Locks after WORLD_SPEED_FIXES
 * consecutive fixes above WORLD_SPEED_LOCK_KMH (one GPS jump never closes
 * the view) and releases on the first fix at or below it. An unknown speed
 * keeps the state.
 */
export function stepWorldSpeed(state, speed) {
  const s = state || { fast: 0, locked: false };
  if (typeof speed !== "number" || !Number.isFinite(speed)) return s;
  if (speed * 3.6 > WORLD_SPEED_LOCK_KMH) {
    const fast = s.fast + 1;
    return { fast, locked: s.locked || fast >= WORLD_SPEED_FIXES };
  }
  return { fast: 0, locked: false };
}
