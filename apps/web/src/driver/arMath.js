// Pure geometry for the driver AR navigator (GSC-2026 WS-B).
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
