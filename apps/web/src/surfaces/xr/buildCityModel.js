// /api/twin/scene → a three.js tabletop city model.
//
// Pure scene → geometry: no renderer, no DOM. The model is built in metres at
// tabletop scale (~0.6 m across) so the same group works in the inline orbit
// viewer, a WebXR immersive-ar placement and an immersive-vr diorama.
//
// Districts are extruded from their outline (`district.outline`, [[lng, lat], …])
// when the scene sends one, and drawn as square bars otherwise (the simulated
// demo city). Height is proportional to forecast tonnes on the selected day
// against ONE fixed scale for the whole horizon, so scrubbing days compares
// honestly. Around them: an optional satellite plate, rain particles for the
// scenario's rainfall and truck-trip dots on arcs to the landfill.
//
// `lite` (xrLite.js, budget phones) trims the outlines, the arc segments and
// the rain; the plate image is the caller's choice and loads on `loadPlate()`.
import * as THREE from "three";
import { LITE_RENDER, simplifyRing } from "./xrLite.js";

export const MODEL_SPAN_M = 0.6;
export const MAX_BAR_M = 0.2;
// Extruded districts tile the whole city, so they stay lower than lone bars.
export const MAX_PRISM_M = 0.075;
const MIN_BAR_M = 0.003;
const PLATE_MARGIN_M = 0.035;
const PLATE_THICKNESS_M = 0.012;
// Each outline shrinks toward its centre, leaving a street-like gap of plate.
const PRISM_INSET = 0.9;

// One moving dot stands for this many trucks of the day's `trucks_required`.
export const TRUCKS_PER_DOT = 4;
// Rain particles per mm of scenario rainfall (0 mm → none).
export const RAIN_PER_MM = 12;
const RAIN_MAX = 3600;
const RAIN_TOP_M = 0.22;
const RAIN_SPEED_M_S = 0.32;
const FLOW_PERIOD_S = 4.5;
const ARC_SEGMENTS = 24;
// Haul arcs, as in the twin (twinLayers.js FLOW_TOP_N; not imported, that module
// pulls deck.gl): the day's heaviest districts get their own arc, coloured by
// tonnes, and every other district rides one bundle arc.
export const FLOW_TOP_N = 8;
// Growth animation: the first build rises from the plate, later changes ease.
const RISE_S = 0.9;
const RISE_STAGGER_S = 0.6;
const CHANGE_S = 0.6;
const CHANGE_STAGGER_S = 0.25;

/**
 * The satellite plate under the Jakarta tabletop: EOX Sentinel-2 cloudless 2016
 * (CC BY 4.0), rendered offline by `ml/scripts/render_xr_plate.py` for this box.
 */
export const JAKARTA_PLATE = {
  url: "/xr/jakarta-plate.jpg",
  west: 106.62,
  east: 107.06,
  south: -6.44,
  north: -6.02,
};

// Status hues are semantic (styles/tokens.css); the overlay legend carries text labels
// too, so colour is never the only signal.
export const RISK_COLORS = {
  normal: "#cec8bd",
  elevated: "#e0c48c",
  high: "#c45f27",
  critical: "#b42f2b",
};
export const RISK_LEVELS = ["normal", "elevated", "high", "critical"];

const LANDFILL_COLOR = "#16613a";
const PLATE_COLOR = "#1d2e28";
const PLATE_TOP_COLOR = "#24382f";
const GRID_COLOR = "#33493f";
const TPS_COLOR = "#b9cbc2";
const RAIN_COLOR = "#e4f2ff";
const FLOW_COLOR = "#ffffff";
// Arc ramp by tonnes (light → heavy), the bundle's fixed tone, and the selected arc.
const FLOW_LIGHT_COLOR = "#3f7f8c";
const FLOW_HEAVY_COLOR = "#c6eef7";
const FLOW_BUNDLE_COLOR = "#7fa9b3";
const FLOW_SELECTED_COLOR = "#ffffff";
// The arc's source end is dimmer than its landfill end (the twin's source → target fade).
const FLOW_SOURCE_SHADE = 0.4;
const HIGHLIGHT_COLOR = "#ffffff";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** A usable outline: at least three finite [lng, lat] points. */
export function districtOutline(district) {
  const ring = Array.isArray(district?.outline) ? district.outline : null;
  if (!ring || ring.length < 3) return null;
  return ring.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1])) ? ring : null;
}

/** Local equirectangular projection fitted to the districts (+ outlines, landfill). */
export function makeProjection(scene) {
  const points = [
    ...(scene.districts || []),
    ...(scene.facilities || []).filter((f) => f.kind === "landfill"),
    ...(scene.districts || []).flatMap((d) => (districtOutline(d) || []).map(([lng, lat]) => ({ lat, lng }))),
  ].filter((p) => finite(p.lat) && finite(p.lng));
  if (points.length === 0) {
    return {
      project: () => ({ x: 0, z: 0 }),
      unproject: () => ({ lat: 0, lng: 0 }),
      width: MODEL_SPAN_M,
      depth: MODEL_SPAN_M,
      scale: 1,
    };
  }
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const lat0 = (minLat + maxLat) / 2;
  const lng0 = (minLng + maxLng) / 2;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const kz = 110540;
  const extentX = (maxLng - minLng) * kx;
  const extentZ = (maxLat - minLat) * kz;
  const scale = MODEL_SPAN_M / Math.max(extentX, extentZ, 1);
  return {
    // North is −Z so the default camera (looking toward −Z) reads like a map.
    project: (lat, lng) => ({ x: (lng - lng0) * kx * scale, z: -(lat - lat0) * kz * scale }),
    unproject: (x, z) => ({ lng: lng0 + x / (kx * scale), lat: lat0 - z / (kz * scale) }),
    width: extentX * scale,
    depth: extentZ * scale,
    scale,
  };
}

function medianNearestNeighbour(positions) {
  if (positions.length < 2) return MODEL_SPAN_M / 10;
  const nearest = positions.map((a, i) => {
    let best = Infinity;
    positions.forEach((b, j) => {
      if (i !== j) best = Math.min(best, Math.hypot(a.x - b.x, a.z - b.z));
    });
    return best;
  });
  nearest.sort((a, b) => a - b);
  return nearest[Math.floor(nearest.length / 2)];
}

function dayRow(district, dayIndex) {
  return district.series?.[dayIndex] || district.series?.[0];
}

export function dayTons(district, dayIndex) {
  const row = dayRow(district, dayIndex);
  return row && finite(row.predicted_tons) ? row.predicted_tons : 0;
}

export function dayRisk(district, dayIndex) {
  const row = dayRow(district, dayIndex);
  return RISK_LEVELS.includes(row?.risk) ? row.risk : "normal";
}

/** Truck-trip dots for one district and day: trucks_required / TRUCKS_PER_DOT, rounded. */
export function flowDots(district, dayIndex) {
  const trucks = dayRow(district, dayIndex)?.trucks_required;
  return finite(trucks) && trucks > 0 ? Math.round(trucks / TRUCKS_PER_DOT) : 0;
}

/** Rain particles for a scenario rainfall in mm: proportional, 0 at 0 mm, capped (fewer in lite mode). */
export function rainParticleCount(rainfallMm, lite = false) {
  const perMm = lite ? LITE_RENDER.rainPerMm : RAIN_PER_MM;
  const max = lite ? LITE_RENDER.rainMax : RAIN_MAX;
  return finite(rainfallMm) && rainfallMm > 0 ? Math.min(max, Math.round(rainfallMm * perMm)) : 0;
}

/**
 * The haul routes for one day: the `topN` heaviest districts (by that day's
 * forecast tonnes) plus the selected one each get their own route, and every
 * other district joins one bundle route. `members` are indices into `districts`.
 */
export function flowRoutes(districts, dayIndex, selectedId = null, topN = FLOW_TOP_N) {
  const ranked = (districts || [])
    .map((district, i) => ({ i, tons: dayTons(district, dayIndex) }))
    .sort((a, b) => b.tons - a.tons || a.i - b.i);
  const own = ranked.filter((item, rank) => rank < topN || districts[item.i].id === selectedId);
  const rest = ranked.filter((item) => !own.includes(item));
  const routes = own.map(({ i, tons }) => ({
    members: [i],
    tons,
    bundle: false,
    selected: selectedId !== null && districts[i].id === selectedId,
  }));
  if (rest.length) {
    routes.push({
      members: rest.map((item) => item.i),
      tons: rest.reduce((sum, item) => sum + item.tons, 0),
      bundle: true,
      selected: false,
    });
  }
  return routes;
}

/**
 * The rain (mm) that fell on one horizon day of a scene (teardown v3 N4): the
 * per-day source in `scene.weather.days` (the what-if on its own day, forecast
 * rain on the others), else the what-if rain on `scenario.scenario_day` only.
 */
export function dayRainfall(scene, dayIndex) {
  const weatherDay = scene?.weather?.days?.[dayIndex];
  if (weatherDay) return finite(weatherDay.rainfall_mm) ? weatherDay.rainfall_mm : 0;
  const scenario = scene?.scenario;
  const whatIfDay = Number.isInteger(scenario?.scenario_day) ? scenario.scenario_day : scenario?.day;
  return dayIndex === whatIfDay && finite(scenario?.rainfall_mm) ? scenario.rainfall_mm : 0;
}

const easeOutCubic = (p) => 1 - (1 - p) ** 3;

// One district outline → a unit-height prism centred on the origin, base on y=0.
function prismGeometry(ring, projection) {
  const pts = ring.map(([lng, lat]) => projection.project(lat, lng));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length > 3 && Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.z - last.z) < 1e-9) pts.pop();
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  // Shape space (x, y) = (x, −z); after rotateX(−π/2) the extrusion (0..1) is +y.
  const shape = new THREE.Shape(
    pts.map((p) => new THREE.Vector2((p.x - cx) * PRISM_INSET, -(p.z - cz) * PRISM_INSET)),
  );
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2);
  return { geometry, centre: { x: cx, z: cz } };
}

/**
 * Build the tabletop model. Returns the root group plus handles the viewer
 * uses: `bars` (one mesh per district, userData.district), `setDay(i, {instant})`
 * to retarget heights/colours/flows, `setScene(scene, i)` for a new scenario of
 * the same city, `setHighlight(id)`, `tick(dt)` to animate, `stats()` for the
 * test hooks, and `dispose()`. `plate` (e.g. JAKARTA_PLATE) textures the plate
 * once `loadPlate()` is called (after the first frame, so it never delays it).
 */
export function buildCityModel(
  scene,
  { dayIndex = 0, reducedMotion = false, plate = null, lite = false } = {},
) {
  const geometries = [];
  const materials = [];
  const textures = [];
  const track = (thing, list) => {
    list.push(thing);
    return thing;
  };
  let disposed = false;
  let clock = 0;

  const root = new THREE.Group();
  root.name = "pythia-city";
  const projection = makeProjection(scene);
  const districts = (scene.districts || []).filter((d) => finite(d.lat) && finite(d.lng));
  const positions = districts.map((d) => projection.project(d.lat, d.lng));

  // ── Plate ──
  const plateW = projection.width + PLATE_MARGIN_M * 2;
  const plateD = projection.depth + PLATE_MARGIN_M * 2;
  const plateMesh = new THREE.Mesh(
    track(new THREE.BoxGeometry(plateW, PLATE_THICKNESS_M, plateD), geometries),
    track(new THREE.MeshStandardMaterial({ color: PLATE_COLOR, roughness: 0.92, metalness: 0 }), materials),
  );
  plateMesh.position.y = -PLATE_THICKNESS_M / 2;
  plateMesh.receiveShadow = true;
  plateMesh.name = "plate";
  root.add(plateMesh);

  const topGeometry = track(new THREE.PlaneGeometry(plateW - 0.008, plateD - 0.008), geometries);
  const topMaterial = track(
    new THREE.MeshStandardMaterial({ color: PLATE_TOP_COLOR, roughness: 0.95 }),
    materials,
  );
  const top = new THREE.Mesh(topGeometry, topMaterial);
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.0005;
  top.receiveShadow = true;
  root.add(top);

  // 5 cm survey grid: a quiet scale reference on the table.
  const gridPoints = [];
  const step = 0.05;
  for (let x = -plateW / 2 + step; x < plateW / 2; x += step) {
    gridPoints.push(x, 0.001, -plateD / 2 + 0.006, x, 0.001, plateD / 2 - 0.006);
  }
  for (let z = -plateD / 2 + step; z < plateD / 2; z += step) {
    gridPoints.push(-plateW / 2 + 0.006, 0.001, z, plateW / 2 - 0.006, 0.001, z);
  }
  const gridGeometry = track(new THREE.BufferGeometry(), geometries);
  gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(gridPoints, 3));
  const gridMaterial = track(
    new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: 0.8 }),
    materials,
  );
  root.add(new THREE.LineSegments(gridGeometry, gridMaterial));

  // Satellite plate: each corner of the top maps to its own lat/lng in the image box.
  let plateState = "none";
  if (plate?.url) {
    plateState = "deferred";
    const uv = topGeometry.attributes.uv;
    const pos = topGeometry.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      // Plane (x, y) lies on the table as (x, −z) once rotated.
      const { lat, lng } = projection.unproject(pos.getX(i), -pos.getY(i));
      uv.setXY(
        i,
        (lng - plate.west) / (plate.east - plate.west),
        (lat - plate.south) / (plate.north - plate.south),
      );
    }
    uv.needsUpdate = true;
  }
  function loadPlate() {
    if (plateState !== "deferred" || disposed) return;
    plateState = "loading";
    new THREE.TextureLoader().load(
      plate.url,
      (texture) => {
        if (disposed) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        track(texture, textures);
        topMaterial.map = texture;
        topMaterial.color.set("#ffffff");
        topMaterial.needsUpdate = true;
        gridMaterial.opacity = 0.25;
        plateState = "loaded";
      },
      undefined,
      () => {
        plateState = "error";
      },
    );
  }

  // ── Districts: extruded outlines, or bars without one ──
  const outlines = districts.map((d) => {
    const ring = districtOutline(d);
    return ring && lite ? simplifyRing(ring, LITE_RENDER.outlinePoints) : ring;
  });
  const prismCount = outlines.filter(Boolean).length;
  const districtShape = prismCount === 0 ? "bar" : prismCount === districts.length ? "prism" : "mixed";
  const maxHeight = prismCount > 0 ? MAX_PRISM_M : MAX_BAR_M;
  const allTons = districts.flatMap((d) => (d.series || []).map((row) => row.predicted_tons).filter(finite));
  const maxTons = Math.max(...allTons, 1);
  const barWidth = Math.min(0.03, Math.max(0.008, medianNearestNeighbour(positions) * 0.55));
  const barGeometry = track(new THREE.BoxGeometry(1, 1, 1), geometries);
  barGeometry.translate(0, 0.5, 0); // base sits on the plate
  const riskMaterials = Object.fromEntries(
    RISK_LEVELS.map((level) => [
      level,
      track(
        new THREE.MeshStandardMaterial({ color: RISK_COLORS[level], roughness: 0.55, metalness: 0.05 }),
        materials,
      ),
    ]),
  );
  const heightFor = (tons) => Math.max(MIN_BAR_M, (tons / maxTons) * maxHeight);
  const maxRadius = Math.max(...positions.map((p) => Math.hypot(p.x, p.z)), 1e-6);

  const bars = districts.map((district, i) => {
    let mesh;
    if (outlines[i]) {
      const prism = prismGeometry(outlines[i], projection);
      mesh = new THREE.Mesh(track(prism.geometry, geometries), riskMaterials[dayRisk(district, dayIndex)]);
      mesh.position.set(prism.centre.x, 0, prism.centre.z);
    } else {
      mesh = new THREE.Mesh(barGeometry, riskMaterials[dayRisk(district, dayIndex)]);
      mesh.position.set(positions[i].x, 0, positions[i].z);
      mesh.scale.set(barWidth, 1, barWidth);
    }
    const h = heightFor(dayTons(district, dayIndex));
    const stagger = Math.hypot(positions[i].x, positions[i].z) / maxRadius;
    mesh.scale.y = reducedMotion ? h : MIN_BAR_M;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `district-${district.id}`;
    mesh.userData = {
      district,
      stagger,
      anchor: positions[i],
      from: mesh.scale.y,
      to: h,
      start: stagger * RISE_STAGGER_S,
      duration: reducedMotion ? 0 : RISE_S,
    };
    root.add(mesh);
    return mesh;
  });

  // ── Landfill marker: a pin and a ground ring, in the product accent ──
  const landfill = (scene.facilities || []).find(
    (f) => f.kind === "landfill" && finite(f.lat) && finite(f.lng),
  );
  let landfillMarker = null;
  const landfillAt = landfill ? projection.project(landfill.lat, landfill.lng) : null;
  if (landfill) {
    const accent = track(
      new THREE.MeshStandardMaterial({ color: LANDFILL_COLOR, roughness: 0.4, metalness: 0.1 }),
      materials,
    );
    landfillMarker = new THREE.Group();
    landfillMarker.name = "landfill";
    landfillMarker.userData = { facility: landfill };
    const stem = new THREE.Mesh(
      track(new THREE.CylinderGeometry(0.0025, 0.0025, 0.07, 12), geometries),
      accent,
    );
    stem.position.y = 0.035;
    const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.011, 20, 14), geometries), accent);
    head.position.y = 0.078;
    const ring = new THREE.Mesh(track(new THREE.RingGeometry(0.014, 0.019, 40), geometries), accent);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.0015;
    [stem, head].forEach((m) => {
      m.castShadow = true;
    });
    landfillMarker.add(stem, head, ring);
    landfillMarker.position.set(landfillAt.x, 0, landfillAt.z);
    root.add(landfillMarker);
  }

  // ── TPS collection points (optional; clipped to the plate) ──
  const tps = (scene.tps || [])
    .filter((t) => finite(t.lat) && finite(t.lng))
    .map((t) => projection.project(t.lat, t.lng))
    .filter((p) => Math.abs(p.x) < plateW / 2 - 0.006 && Math.abs(p.z) < plateD / 2 - 0.006);
  let tpsMesh = null;
  if (tps.length > 0) {
    const dotGeometry = track(new THREE.CircleGeometry(0.0018, 8), geometries);
    dotGeometry.rotateX(-Math.PI / 2);
    tpsMesh = new THREE.InstancedMesh(
      dotGeometry,
      track(new THREE.MeshBasicMaterial({ color: TPS_COLOR, transparent: true, opacity: 0.55 }), materials),
      tps.length,
    );
    const m = new THREE.Matrix4();
    tps.forEach((p, i) => {
      m.makeTranslation(p.x, 0.0012, p.z);
      tpsMesh.setMatrixAt(i, m);
    });
    tpsMesh.instanceMatrix.needsUpdate = true;
    tpsMesh.name = "tps";
    root.add(tpsMesh);
  }

  // ── Rain: THREE.Points falling over the plate, count ∝ scenario rainfall ──
  const rainMaterial = track(
    new THREE.PointsMaterial({
      color: RAIN_COLOR,
      size: 0.0042,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
    materials,
  );
  let rain = null;
  let rainCount = 0;
  function setRain(mm) {
    const count = rainParticleCount(mm, lite);
    if (count === rainCount) return;
    if (rain) {
      root.remove(rain);
      rain.geometry.dispose();
      rain = null;
    }
    rainCount = count;
    if (!count) return;
    const xyz = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      xyz[i * 3] = (Math.random() - 0.5) * (plateW - 0.02);
      xyz[i * 3 + 1] = Math.random() * RAIN_TOP_M;
      xyz[i * 3 + 2] = (Math.random() - 0.5) * (plateD - 0.02);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(xyz, 3));
    rain = new THREE.Points(geometry, rainMaterial);
    rain.name = "rain";
    root.add(rain);
  }

  // ── Truck flows: the day's heaviest districts on their own arcs to the
  // landfill, coloured by tonnes, the rest on one bundle arc (flowRoutes).
  // Every district's truck-trip dots ride the arc it belongs to. ──
  const arcSegments = lite ? LITE_RENDER.arcSegments : ARC_SEGMENTS;
  const flowGeometry = track(new THREE.SphereGeometry(0.0024, 8, 6), geometries);
  const flowMaterial = track(new THREE.MeshBasicMaterial({ color: FLOW_COLOR }), materials);
  const flowLineMaterial = track(
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
    materials,
  );
  let flowMesh = null;
  let flowDotsList = []; // { r: route index, phase }
  let routes = [];
  let selectedId = null;
  let flowDay = dayIndex;
  let arcGeometry = null;
  if (landfillAt && bars.length) {
    // Own arcs (top N, plus a selected district outside them) and the bundle.
    const vertices = (FLOW_TOP_N + 2) * arcSegments * 2;
    arcGeometry = track(new THREE.BufferGeometry(), geometries);
    arcGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    arcGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    arcGeometry.setDrawRange(0, 0);
    const arcs = new THREE.LineSegments(arcGeometry, flowLineMaterial);
    arcs.name = "flow-arcs";
    arcs.frustumCulled = false;
    root.add(arcs);
  }
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  // A route leaves from its district's top or, for the bundle, from its members'
  // tonnage-weighted centre above the tallest of them.
  function arcControl(route) {
    const tons = route.members.map((i) => Math.max(dayTons(bars[i].userData.district, flowDay), 0));
    const total = tons.reduce((sum, value) => sum + value, 0);
    let x = 0;
    let z = 0;
    let topY = 0;
    route.members.forEach((i, k) => {
      const { anchor } = bars[i].userData;
      const w = total > 0 ? tons[k] / total : 1 / route.members.length;
      x += anchor.x * w;
      z += anchor.z * w;
      topY = Math.max(topY, bars[i].scale.y);
    });
    const dist = Math.hypot(landfillAt.x - x, landfillAt.z - z);
    p0.set(x, topY, z);
    p2.set(landfillAt.x, 0.012, landfillAt.z);
    p1.set((x + landfillAt.x) / 2, Math.max(topY, 0.012) + dist * 0.45 + 0.02, (z + landfillAt.z) / 2);
  }
  function arcPoint(t, out) {
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    return out.set(
      a * p0.x + b * p1.x + c * p2.x,
      a * p0.y + b * p1.y + c * p2.y,
      a * p0.z + b * p1.z + c * p2.z,
    );
  }
  const lightColor = new THREE.Color(FLOW_LIGHT_COLOR);
  const heavyColor = new THREE.Color(FLOW_HEAVY_COLOR);
  const bundleColor = new THREE.Color(FLOW_BUNDLE_COLOR);
  const selectedColor = new THREE.Color(FLOW_SELECTED_COLOR);
  const tint = new THREE.Color();
  const shade = new THREE.Color();
  function routeTint(route, heaviest) {
    if (route.selected) return tint.copy(selectedColor);
    if (route.bundle) return tint.copy(bundleColor);
    return tint.copy(lightColor).lerp(heavyColor, heaviest > 0 ? Math.min(1, route.tons / heaviest) : 0);
  }
  function updateArcs() {
    if (!arcGeometry) return;
    const pos = arcGeometry.attributes.position.array;
    const col = arcGeometry.attributes.color.array;
    const heaviest = Math.max(0, ...routes.filter((route) => !route.bundle).map((route) => route.tons));
    let k = 0;
    const put = (t) => {
      arcPoint(t, tmp);
      shade.copy(tint).multiplyScalar(FLOW_SOURCE_SHADE + (1 - FLOW_SOURCE_SHADE) * t);
      pos[k] = tmp.x;
      pos[k + 1] = tmp.y;
      pos[k + 2] = tmp.z;
      col[k] = shade.r;
      col[k + 1] = shade.g;
      col[k + 2] = shade.b;
      k += 3;
    };
    routes.forEach((route) => {
      arcControl(route);
      routeTint(route, heaviest);
      for (let s = 0; s < arcSegments; s += 1) {
        put(s / arcSegments);
        put((s + 1) / arcSegments);
      }
    });
    arcGeometry.setDrawRange(0, k / 3);
    arcGeometry.attributes.position.needsUpdate = true;
    arcGeometry.attributes.color.needsUpdate = true;
  }
  const flowMatrix = new THREE.Matrix4();
  function updateFlowDots() {
    if (!flowMesh) return;
    const travel = reducedMotion ? 0 : clock / FLOW_PERIOD_S;
    let current = -1;
    flowDotsList.forEach((dot, k) => {
      if (dot.r !== current) {
        current = dot.r;
        arcControl(routes[dot.r]);
      }
      arcPoint((dot.phase + travel) % 1, tmp);
      flowMatrix.makeTranslation(tmp.x, tmp.y, tmp.z);
      flowMesh.setMatrixAt(k, flowMatrix);
    });
    flowMesh.count = flowDotsList.length;
    flowMesh.instanceMatrix.needsUpdate = true;
  }
  function setFlows(day) {
    if (!landfillAt) return;
    flowDay = day;
    routes = flowRoutes(
      bars.map((mesh) => mesh.userData.district),
      day,
      selectedId,
    );
    flowDotsList = [];
    routes.forEach((route, r) => {
      const n = route.members.reduce((sum, i) => sum + flowDots(bars[i].userData.district, day), 0);
      // A per-route offset so neighbouring arcs do not pulse in step.
      const offset = (r * 0.137) % 1;
      for (let j = 0; j < n; j += 1) flowDotsList.push({ r, phase: (offset + j / n) % 1 });
    });
    if (!flowMesh || flowMesh.instanceMatrix.count < flowDotsList.length) {
      if (flowMesh) {
        root.remove(flowMesh);
        flowMesh.dispose();
      }
      flowMesh = new THREE.InstancedMesh(flowGeometry, flowMaterial, Math.max(64, flowDotsList.length * 2));
      flowMesh.name = "flows";
      flowMesh.frustumCulled = false;
      root.add(flowMesh);
    }
    updateFlowDots();
  }

  // ── Highlight: a ring on the selected district's top and a pointer above it ──
  const highlightMaterial = track(new THREE.MeshBasicMaterial({ color: HIGHLIGHT_COLOR }), materials);
  const highlight = new THREE.Group();
  highlight.name = "highlight";
  highlight.visible = false;
  const hlRing = new THREE.Mesh(
    track(new THREE.RingGeometry(0.009, 0.0135, 36), geometries),
    highlightMaterial,
  );
  hlRing.rotation.x = -Math.PI / 2;
  hlRing.position.y = 0.0015;
  const hlCone = new THREE.Mesh(
    track(new THREE.ConeGeometry(0.007, 0.018, 16), geometries),
    highlightMaterial,
  );
  hlCone.rotation.x = Math.PI; // tip down, toward the district
  highlight.add(hlRing, hlCone);
  root.add(highlight);
  let highlighted = null;
  function placeHighlight() {
    if (!highlighted) return;
    const { anchor } = highlighted.userData;
    highlight.position.set(anchor.x, highlighted.scale.y, anchor.z);
    hlCone.position.y = 0.03 + (reducedMotion ? 0 : Math.sin(clock * 3) * 0.004);
  }
  function setHighlight(id) {
    highlighted = (id && bars.find((mesh) => mesh.userData.district.id === id)) || null;
    highlight.visible = Boolean(highlighted);
    placeHighlight();
    // The selected district gets its own (white) arc, as in the twin.
    const nextId = highlighted ? id : null;
    if (nextId !== selectedId) {
      selectedId = nextId;
      setFlows(flowDay);
      updateArcs();
    }
  }

  let currentScene = scene;
  function setDay(nextDay, { instant = false } = {}) {
    // Rain falls on the day that has it, not on every day of the horizon.
    setRain(dayRainfall(currentScene, nextDay));
    bars.forEach((mesh) => {
      const ud = mesh.userData;
      const to = heightFor(dayTons(ud.district, nextDay));
      mesh.material = riskMaterials[dayRisk(ud.district, nextDay)];
      if (instant || reducedMotion) {
        mesh.scale.y = to;
        Object.assign(ud, { from: to, to, start: clock, duration: 0 });
      } else if (Math.abs(to - ud.to) > 1e-7) {
        // A short staggered wave from the centre outward.
        Object.assign(ud, {
          from: mesh.scale.y,
          to,
          start: clock + ud.stagger * CHANGE_STAGGER_S,
          duration: CHANGE_S,
        });
      }
    });
    setFlows(nextDay);
    updateArcs();
    placeHighlight();
  }

  // A re-fetched scenario (rain / event) for the same city: swap each district's
  // data and retarget. The height scale stays the one this model was built
  // with, so a heavier scenario visibly grows the columns.
  function setScene(nextScene, nextDay, options) {
    const byId = new Map((nextScene.districts || []).map((d) => [d.id, d]));
    bars.forEach((mesh) => {
      const district = byId.get(mesh.userData.district.id);
      if (district) mesh.userData.district = district;
    });
    currentScene = nextScene;
    setDay(nextDay, options);
  }

  // Advance the animations; returns whether district heights are still moving.
  function tick(dt) {
    const step = Math.min(Math.max(dt, 0), 0.1);
    clock += step;
    let moving = false;
    bars.forEach((mesh) => {
      const ud = mesh.userData;
      if (mesh.scale.y === ud.to) return;
      const p = ud.duration > 0 ? Math.min(1, Math.max(0, (clock - ud.start) / ud.duration)) : 1;
      mesh.scale.y = p >= 1 ? ud.to : ud.from + (ud.to - ud.from) * easeOutCubic(p);
      moving = true;
    });
    if (moving) updateArcs();
    if (rain && !reducedMotion) {
      const arr = rain.geometry.attributes.position.array;
      const fall = RAIN_SPEED_M_S * step;
      for (let i = 1; i < arr.length; i += 3) {
        arr[i] -= fall;
        if (arr[i] < 0) arr[i] += RAIN_TOP_M;
      }
      rain.geometry.attributes.position.needsUpdate = true;
    }
    if (!reducedMotion || moving) updateFlowDots();
    placeHighlight();
    return moving;
  }

  setRain(dayRainfall(scene, dayIndex));
  setFlows(dayIndex);
  updateArcs();

  function dispose() {
    disposed = true;
    rain?.geometry.dispose();
    flowMesh?.dispose();
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
    tpsMesh?.dispose();
  }

  return {
    root,
    bars,
    landfill: landfillMarker,
    tpsCount: tps.length,
    footprint: { width: plateW, depth: plateD },
    maxTons,
    setDay,
    setScene,
    setHighlight,
    tick,
    stats: () => ({
      rainParticles: rainCount,
      flowCount: flowDotsList.length,
      districtShape,
      highlightId: highlighted?.userData.district.id || null,
      plate: plateState,
      // The arcs drawn: an own route names its district, the bundle its size.
      flowArcs: routes.map((route) => ({
        district: route.bundle ? null : bars[route.members[0]].userData.district.id,
        bundle: route.bundle,
        size: route.members.length,
        tons: route.tons,
        selected: route.selected,
      })),
      arcSegments,
      districtVertices: bars.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0),
    }),
    loadPlate,
    dispose,
  };
}
