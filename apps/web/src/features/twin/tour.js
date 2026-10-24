// Cinematic tour for the Pythia Twin: a scripted camera path used live in
// demos and for recorded footage. city overview -> highest-risk district ->
// landfill beacon -> overview, ~20 s. Under prefers-reduced-motion the same
// stops are shown as jump cuts with holds instead of camera flights.
import { hottestDistrict, landfillOf } from "./twinLayers.js";

export const OVERVIEW_PITCH = 58;
export const OVERVIEW_BEARING = -20;

/**
 * [[west, south], [east, north]] around the districts (5th–95th percentile,
 * so one far-flung rural district does not shrink the whole city) and the
 * landfill.
 */
export function sceneBounds(scene) {
  const districts = scene.districts || [];
  if (!districts.length) return null;
  const trim = Math.floor(districts.length * 0.05);
  const range = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return [sorted[trim], sorted[sorted.length - 1 - trim]];
  };
  let [west, east] = range(districts.map((d) => d.lng));
  let [south, north] = range(districts.map((d) => d.lat));
  const landfill = landfillOf(scene);
  if (landfill) {
    west = Math.min(west, landfill.lng);
    east = Math.max(east, landfill.lng);
    south = Math.min(south, landfill.lat);
    north = Math.max(north, landfill.lat);
  }
  return [
    [west, south],
    [east, north],
  ];
}

/**
 * City overview: frames every district plus the landfill when a map is given
 * (respecting its padding), else falls back to the registry centre/zoom.
 */
export function overviewCamera(scene, map) {
  const camera = {
    center: scene.city.center,
    zoom: scene.city.zoom,
    pitch: OVERVIEW_PITCH,
    bearing: OVERVIEW_BEARING,
  };
  const bounds = map && sceneBounds(scene);
  const fit = bounds && map.cameraForBounds(bounds, { padding: 40, bearing: OVERVIEW_BEARING });
  if (!fit) return camera;
  // The fit is computed flat; pitching foreshortens the north-south extent,
  // so step in to keep the city filling the frame (more when side panels
  // pad the view, less in the unpadded full-screen presentation view).
  const padded = map.getPadding?.().right > 0;
  return { ...camera, center: [fit.center.lng, fit.center.lat], zoom: fit.zoom + (padded ? 0.65 : 0.45) };
}

/** Tour stops for a scene. Durations are milliseconds. */
export function buildTour(scene, day, map) {
  const overview = overviewCamera(scene, map);
  const steps = [
    {
      key: "overview",
      camera: { ...overview, bearing: 12, zoom: overview.zoom + 0.15 },
      duration: 5000,
      hold: 0,
    },
  ];
  const hot = hottestDistrict(scene, day);
  if (hot) {
    steps.push({
      key: "hotspot",
      districtId: hot.id,
      name: hot.name,
      camera: { center: [hot.lng, hot.lat], zoom: 13.1, pitch: 64, bearing: 28 },
      duration: 4500,
      hold: 1500,
    });
  }
  const landfill = landfillOf(scene);
  if (landfill) {
    steps.push({
      key: "landfill",
      name: landfill.name,
      camera: { center: [landfill.lng, landfill.lat], zoom: 12.2, pitch: 62, bearing: -38 },
      duration: 4500,
      hold: 1500,
    });
  }
  steps.push({ key: "return", camera: overview, duration: 3000, hold: 0 });
  return steps;
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function moveEnd(map, ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      map.off("moveend", done);
      resolve();
    };
    const timer = setTimeout(done, ms + 400);
    map.once("moveend", done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Play `steps` on a maplibre map. Resolves when the tour ends or `signal`
 * aborts; `onStep(step, index)` fires as each stop begins.
 */
export async function runTour(map, steps, { reducedMotion = false, signal, onStep } = {}) {
  for (let i = 0; i < steps.length; i += 1) {
    if (signal?.aborted) break;
    const step = steps[i];
    onStep?.(step, i);
    if (reducedMotion) {
      map.jumpTo(step.camera);
      await wait(3000, signal);
      continue;
    }
    const arrived = moveEnd(map, step.duration, signal);
    if (step.key === "overview") {
      map.easeTo({ ...step.camera, duration: step.duration, easing: (t) => t, essential: true });
    } else {
      map.flyTo({ ...step.camera, duration: step.duration, curve: 1.3, essential: true });
    }
    await arrived;
    if (step.hold) await wait(step.hold, signal);
  }
  if (signal?.aborted) map.stop();
}
