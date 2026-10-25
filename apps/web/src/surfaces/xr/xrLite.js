// Lite mode for budget Android phones (2–3 GB RAM, entry Mali/Adreno GPUs,
// slow or metered 4G). Pure decision helpers; the renderers read `LITE_RENDER`.
//
// Auto-on when the device reports little memory or few cores, or the user asked
// the browser to save data. `?lite=1` / `?lite=0` or the on-screen toggle
// (remembered per device) override the guess either way.

export const LITE_MAX_MEMORY_GB = 3;
export const LITE_MAX_CORES = 4;
export const LITE_STORAGE_KEY = "pythia_xr_lite";

// What lite mode changes in the renderers.
export const LITE_RENDER = {
  pixelRatio: 1,
  // Full mode still caps the pixel ratio: phones report 2.6–3.5.
  fullPixelRatio: 1.5,
  antialias: false,
  shadows: false,
  // Points per district outline (full outlines run to ~230).
  outlinePoints: 32,
  arcSegments: 10,
  // Rain particles per mm and their cap (full: 12 per mm, 3600).
  rainPerMm: 4,
  rainMax: 900,
  // A 512 px copy of the satellite plate instead of the 1536 px one.
  plateUrl: "/xr/jakarta-plate-lite.jpg",
  // Frame budget for the orbit viewer (an immersive session keeps the device rate).
  orbitFrameMs: 33,
  // WebXR framebuffer scale in an immersive session.
  xrFramebufferScale: 0.75,
};

/** Why this device looks low-end: a list of "memory" | "cpu" | "data" (empty: none). */
export function liteReasons({ deviceMemory, hardwareConcurrency, saveData, reducedData } = {}) {
  const reasons = [];
  if (typeof deviceMemory === "number" && deviceMemory > 0 && deviceMemory <= LITE_MAX_MEMORY_GB)
    reasons.push("memory");
  if (
    typeof hardwareConcurrency === "number" &&
    hardwareConcurrency > 0 &&
    hardwareConcurrency <= LITE_MAX_CORES
  )
    reasons.push("cpu");
  if (saveData === true || reducedData === true) reasons.push("data");
  return reasons;
}

/** "on" | "off" from a URL value or a stored choice; anything else is no override. */
export function liteOverride(value) {
  if (value === "1" || value === "on" || value === "true") return "on";
  if (value === "0" || value === "off" || value === "false") return "off";
  return null;
}

/** The decision: an explicit override wins, otherwise any low-end reason turns lite on. */
export function decideLite({ override = null, reasons = [] } = {}) {
  if (override === "on") return { lite: true, source: "manual" };
  if (override === "off") return { lite: false, source: "manual" };
  return reasons.length ? { lite: true, source: "auto" } : { lite: false, source: "auto" };
}

/** Read the device signals the browser exposes (all optional; Safari and Firefox expose few). */
export function readLiteSignals(nav = globalThis.navigator, win = globalThis.window) {
  let reducedData = false;
  try {
    reducedData = Boolean(win?.matchMedia?.("(prefers-reduced-data: reduce)").matches);
  } catch {
    reducedData = false;
  }
  return {
    deviceMemory: nav?.deviceMemory,
    hardwareConcurrency: nav?.hardwareConcurrency,
    saveData: nav?.connection?.saveData,
    reducedData,
  };
}

function storedOverride() {
  try {
    return liteOverride(window.localStorage.getItem(LITE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** The page's lite decision: URL override, then the stored toggle, then the device signals. */
export function detectLite(search = globalThis.location?.search || "") {
  const reasons = liteReasons(readLiteSignals());
  const override = liteOverride(new URLSearchParams(search).get("lite")) || storedOverride();
  return { ...decideLite({ override, reasons }), reasons };
}

/** Remember the manual toggle on this device (best effort: storage may be blocked). */
export function storeLite(lite) {
  try {
    window.localStorage.setItem(LITE_STORAGE_KEY, lite ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

/**
 * At most `maxPoints` points of a closed [lng, lat] ring, evenly strided, keeping
 * the first point. Rings already that small come back unchanged.
 */
export function simplifyRing(ring, maxPoints) {
  if (!Array.isArray(ring) || !(maxPoints >= 3) || ring.length <= maxPoints) return ring;
  const step = ring.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) out.push(ring[Math.floor(i * step)]);
  return out;
}
