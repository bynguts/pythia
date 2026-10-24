// Pure geometry for the driver AR navigator.
// No DOM, no React: every function is deterministic so the e2e spec can
// exercise it directly through page.evaluate on the imported module.

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

// A stop counts as reached inside this radius. Phone GPS is typically good to
// 10–30 m in a dense city, so anything tighter would never trigger.
export const ARRIVAL_RADIUS_M = 35;

/** Degrees → [0, 360). */
export function wrap360(deg) {
  const value = ((deg % 360) + 360) % 360;
  // -1e-15 + 360 rounds to exactly 360 in floating point; that is north.
  return value >= 360 - 1e-9 ? 0 : value;
}

/** Degrees → (-180, 180]. */
export function normalizeAngle(deg) {
  const value = wrap360(deg);
  return value > 180 ? value - 360 : value;
}

export function hasCoordinate(point) {
  return (
    Boolean(point) &&
    Number.isFinite(Number(point.lat)) &&
    Number.isFinite(Number(point.lng)) &&
    point.lat !== null &&
    point.lng !== null &&
    Math.abs(Number(point.lat)) <= 90 &&
    Math.abs(Number(point.lng)) <= 180
  );
}

/** Great-circle distance in metres between two {lat, lng} points. */
export function haversineMeters(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from a to b, degrees clockwise from true north, [0, 360). */
export function initialBearing(a, b) {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return wrap360(Math.atan2(y, x) / DEG);
}

/** Where the target is relative to where the phone points: (-180, 180], + = turn right. */
export function relativeAngle(bearing, heading) {
  return normalizeAngle(bearing - heading);
}

/**
 * Circular mean of headings in degrees, [0, 360). A plain arithmetic mean of
 * 350° and 10° is 180° (due south); averaging unit vectors gives 0°.
 * Returns null for an empty list or vectors that cancel out.
 */
export function circularMean(angles) {
  if (!angles || angles.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const angle of angles) {
    sx += Math.sin(angle * DEG);
    sy += Math.cos(angle * DEG);
  }
  if (Math.hypot(sx, sy) < 1e-9) return null;
  return wrap360(Math.atan2(sx, sy) / DEG);
}

/** Keep the last `size` samples and return their circular mean. */
export function pushHeadingSample(samples, heading, size = 6) {
  const next = [...samples, wrap360(heading)];
  while (next.length > size) next.shift();
  return { samples: next, heading: circularMean(next) };
}

// Below this horizontal length of the camera axis (sin of ~24° tilt from
// flat) its direction is dominated by sensor noise and flips 180° as beta
// crosses zero, so the top-edge heading is used instead.
const FLAT_PROJECTION = 0.4;

/**
 * Compass heading of the back camera from W3C device orientation angles.
 * Projects the device's -Z axis (out of the back camera) onto the horizontal
 * plane, so the result stays right whether the phone is held upright or
 * tilted. Near flat that projection shrinks to noise, and the heading of the
 * top edge (360 − alpha, compass convention) is used instead.
 */
export function cameraHeading(alpha, beta, gamma) {
  const a = (alpha || 0) * DEG;
  const b = (beta || 0) * DEG;
  const g = (gamma || 0) * DEG;
  const vx = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
  const vy = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
  if (Math.hypot(vx, vy) < FLAT_PROJECTION) return wrap360(360 - (alpha || 0));
  return wrap360(Math.atan2(vx, vy) / DEG);
}

/**
 * Unwrapped angle for CSS rotation: `previous` plus the shortest signed step
 * to `next`, so a transition from 350° to 10° turns 20°, not 340° backwards.
 */
export function unwrapAngle(previous, next) {
  if (!Number.isFinite(previous)) return next;
  return previous + normalizeAngle(next - previous);
}

/**
 * Absolute heading from a deviceorientation(absolute) event, or null when the
 * event is relative-only (Chrome's plain `deviceorientation`) and cannot point
 * to true north. iOS Safari exposes `webkitCompassHeading` directly (ignored
 * while `webkitCompassAccuracy` is negative, i.e. uncalibrated).
 */
export function headingFromOrientation(event) {
  if (!event) return null;
  if (typeof event.webkitCompassHeading === "number" && Number.isFinite(event.webkitCompassHeading)) {
    // iOS reports accuracy −1 while the compass is uncalibrated: no heading.
    if (typeof event.webkitCompassAccuracy === "number" && event.webkitCompassAccuracy < 0) return null;
    return { heading: wrap360(event.webkitCompassHeading), source: "webkit-compass" };
  }
  const absolute = event.type === "deviceorientationabsolute" || event.absolute === true;
  if (!absolute || typeof event.alpha !== "number" || !Number.isFinite(event.alpha)) return null;
  return { heading: cameraHeading(event.alpha, event.beta, event.gamma), source: "absolute-orientation" };
}

/** "350 m", "1,2 km" (id) / "1.2 km" (en). */
export function formatDistance(meters, lang = "id") {
  if (!Number.isFinite(meters)) return "—";
  const locale = lang === "en" ? "en-GB" : "id-ID";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km.toLocaleString(locale, { maximumFractionDigits: km < 10 ? 1 : 0 })} km`;
}

/** 0° → "U"/"N", 90° → "T"/"E" … eight-point compass label. */
export function cardinal(deg, lang = "id") {
  const labels =
    lang === "en"
      ? ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
      : ["U", "TL", "T", "TG", "S", "BD", "B", "BL"];
  return labels[Math.round(wrap360(deg) / 45) % 8];
}

// ── Route following (gsc P1-11) ──
// The arrow follows the leg the plan actually routed instead of a straight
// line through buildings. Distances are local-equirectangular inside one
// segment (exact enough below a few km) and great-circle along the path.

/** The arrow aims at the next route vertex, kept inside this look-ahead window. */
export const LOOKAHEAD_MIN_M = 25;
export const LOOKAHEAD_MAX_M = 40;
/** Further than this from the planned leg the crew is off-route: straight bearing. */
export const OFF_ROUTE_M = 50;

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function lerpPoint(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Closest point to p on segment a–b: { t in [0, 1], point, distance (m) }. */
export function projectToSegment(p, a, b) {
  const kx = Math.cos(a.lat * DEG);
  const bx = (b.lng - a.lng) * kx;
  const by = b.lat - a.lat;
  const px = (p.lng - a.lng) * kx;
  const py = p.lat - a.lat;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : clamp((px * bx + py * by) / len2, 0, 1);
  const point = lerpPoint(a, b, t);
  return { t, point, distance: haversineMeters(p, point) };
}

/** Along-path distance (m) from the first vertex to each vertex. */
export function cumulativeLengths(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i += 1) cum.push(cum[i - 1] + haversineMeters(path[i - 1], path[i]));
  return cum;
}

/**
 * Snap p to the nearest point of the polyline, searching segments
 * [from, to]. Returns { segment, t, point, offset (cross-track m), along (m
 * from the path start) }, or null for a path without segments.
 */
export function snapToPath(path, p, { from = 0, to = path.length - 2, cum = cumulativeLengths(path) } = {}) {
  let best = null;
  for (let i = Math.max(0, from); i <= Math.min(to, path.length - 2); i += 1) {
    const proj = projectToSegment(p, path[i], path[i + 1]);
    if (best === null || proj.distance < best.offset) {
      best = {
        segment: i,
        t: proj.t,
        point: proj.point,
        offset: proj.distance,
        along: cum[i] + (cum[i + 1] - cum[i]) * proj.t,
      };
    }
  }
  return best;
}

/** The point `along` metres from the path start, clamped to its ends. */
export function pointAlong(path, along, cum = cumulativeLengths(path)) {
  if (along <= 0) return { lat: path[0].lat, lng: path[0].lng };
  const last = path.length - 1;
  if (along >= cum[last]) return { lat: path[last].lat, lng: path[last].lng };
  let i = 0;
  while (cum[i + 1] < along) i += 1;
  const seg = cum[i + 1] - cum[i];
  return lerpPoint(path[i], path[i + 1], seg === 0 ? 0 : (along - cum[i]) / seg);
}

/**
 * The planned leg to stop `index`: from the previous stop's snap to this
 * stop's snap on the SPJ path. Stops are snapped in visiting order, each no
 * earlier than the one before, so a road that passes a later stop early is
 * not mistaken for the leg. null when there is no leg to follow: the first
 * stop (the planned route starts there), a missing coordinate, or a leg
 * shorter than a metre.
 */
export function legToStop(path, stops, index) {
  if (!Array.isArray(path) || path.length < 2 || !Array.isArray(stops)) return null;
  if (!Number.isInteger(index) || index < 1 || index >= stops.length) return null;
  const cum = cumulativeLengths(path);
  let prev = null;
  for (let i = 0; i <= index; i += 1) {
    if (!hasCoordinate(stops[i])) return null;
    const point = { lat: Number(stops[i].lat), lng: Number(stops[i].lng) };
    const snap = snapToPath(path, point, { from: prev ? prev.segment : 0, cum });
    if (i === index) {
      if (snap.along - prev.along < 1) return null;
      return {
        path,
        cum,
        startSegment: prev.segment,
        endSegment: snap.segment,
        startAlong: prev.along,
        endAlong: snap.along,
        stopOffset: snap.offset,
      };
    }
    prev = snap;
  }
  return null;
}

/**
 * Where the AR arrow should aim on a planned leg, or null when the fix is
 * more than OFF_ROUTE_M from it (the caller falls back to the straight
 * bearing and says so). The aim is the next route vertex ahead, held inside
 * [LOOKAHEAD_MIN_M, LOOKAHEAD_MAX_M] along the path; once that window reaches
 * the stop the aim is the stop itself. `remaining` is the distance to the
 * stop along the path, never less than the straight-line distance.
 */
export function routeTarget(leg, fix, stop) {
  if (!leg || !fix) return null;
  const snap = snapToPath(leg.path, fix, { from: leg.startSegment, to: leg.endSegment, cum: leg.cum });
  if (!snap || snap.offset > OFF_ROUTE_M) return null;
  const along = clamp(snap.along, leg.startAlong, leg.endAlong);
  let next = leg.endAlong;
  for (let i = snap.segment + 1; i <= leg.endSegment; i += 1) {
    if (leg.cum[i] > along + 0.5) {
      next = Math.min(leg.cum[i], leg.endAlong);
      break;
    }
  }
  const aimAlong = clamp(next, along + LOOKAHEAD_MIN_M, along + LOOKAHEAD_MAX_M);
  const target =
    aimAlong >= leg.endAlong ? { lat: stop.lat, lng: stop.lng } : pointAlong(leg.path, aimAlong, leg.cum);
  const remaining = Math.max(leg.endAlong - along + leg.stopOffset, haversineMeters(fix, stop));
  return { target, remaining, offset: snap.offset, along };
}

// ── Safety lock (gsc P1-11) ──
// AR is for crews on foot. Moving faster than a brisk walk for several fixes
// in a row means the phone is in a vehicle, and the AR view locks.

/** Brisk walking tops out around 6 km/h; anything faster is a vehicle. */
export const SPEED_LOCK_KMH = 6;
/** Consecutive fixes needed to lock (and, at walking pace, to unlock). */
export const SPEED_LOCK_FIXES = 3;
// A derived speed needs at least this much time between fixes, and the
// first few metres of displacement are treated as GPS jitter.
const MIN_SPEED_DT_MS = 1000;
const GPS_JITTER_M = 5;

/**
 * Speed (m/s) of a new fix: the device's own `speed` when it reports one,
 * otherwise derived from the previous fix. null when it cannot be judged.
 * Fixes are { lat, lng, at (ms), speed? }.
 */
export function fixSpeed(prev, fix) {
  if (typeof fix?.speed === "number" && Number.isFinite(fix.speed) && fix.speed >= 0) return fix.speed;
  if (!prev || !fix) return null;
  const dt = fix.at - prev.at;
  if (!(dt >= MIN_SPEED_DT_MS)) return null;
  return Math.max(0, haversineMeters(prev, fix) - GPS_JITTER_M) / (dt / 1000);
}

/**
 * Advance the lock by one fix. State is { locked, fast, slow, ref, speed };
 * pass null to start. Locks after SPEED_LOCK_FIXES consecutive fixes above
 * SPEED_LOCK_KMH and releases after as many at or below it, so a single GPS
 * jump never locks and a red light never unlocks. The speed baseline `ref`
 * is kept until a speed can be measured, so 5 Hz fixes still span ≥ 1 s.
 */
export function stepSpeedLock(state, fix) {
  const s = state || { locked: false, fast: 0, slow: 0, ref: null, speed: null };
  const speed = fixSpeed(s.ref, fix);
  const age = s.ref ? fix.at - s.ref.at : null;
  const ref = speed === null && age !== null && age >= 0 && age < MIN_SPEED_DT_MS ? s.ref : fix;
  if (speed === null) return { ...s, ref, speed: null };
  if (speed * 3.6 > SPEED_LOCK_KMH) {
    const fast = s.fast + 1;
    return { locked: s.locked || fast >= SPEED_LOCK_FIXES, fast, slow: 0, ref, speed };
  }
  const slow = s.slow + 1;
  return { locked: s.locked && slow < SPEED_LOCK_FIXES, fast: 0, slow, ref, speed };
}

// ── TPA spotter mode (gsc P1-11) ──

/** Spotter mode applies within this distance of the TPA facility point. */
export const TPA_SPOTTER_RADIUS_M = 1500;

/**
 * Distance from the fix to the served TPA facility point (queue-status
 * lat/lng) and whether spotter mode applies there. Distance is null while
 * either point is missing; that is never "near".
 */
export function tpaSpotterRange(fix, tpaPoint, radius = TPA_SPOTTER_RADIUS_M) {
  if (!hasCoordinate(fix) || !hasCoordinate(tpaPoint)) return { distance: null, near: false };
  const distance = haversineMeters(
    { lat: Number(fix.lat), lng: Number(fix.lng) },
    { lat: Number(tpaPoint.lat), lng: Number(tpaPoint.lng) },
  );
  return { distance, near: distance <= radius };
}

/**
 * Daily rain above this is a no-go for crews on the tipping face: BMKG
 * classes 20–50 mm/day as moderate rain, when the waste slope turns slick.
 */
export const RAIN_NO_GO_MM = 20;

/** Today's forecast day (else the first one) and whether its rain is a no-go. */
export function rainNoGo(forecast, todayIso, threshold = RAIN_NO_GO_MM) {
  if (!Array.isArray(forecast) || forecast.length === 0) return null;
  const day = forecast.find((d) => d?.date === todayIso) || forecast[0];
  if (day?.rainfall_mm === null || day?.rainfall_mm === undefined) return null;
  const mm = Number(day.rainfall_mm);
  if (!Number.isFinite(mm)) return null;
  return { date: day.date ?? null, mm, noGo: mm > threshold };
}
