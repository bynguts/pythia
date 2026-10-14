// /api/twin/scene → a three.js tabletop city model.
//
// Pure scene → geometry: no renderer, no DOM. The model is built in metres at
// tabletop scale (~0.6 m across) so the same group works in the inline orbit
// viewer, a WebXR immersive-ar placement and an immersive-vr diorama.
//
// Bar height is proportional to forecast tonnes on the selected day against
// ONE fixed scale for the whole horizon, so scrubbing days compares honestly.
import * as THREE from "three";

export const MODEL_SPAN_M = 0.6;
export const MAX_BAR_M = 0.2;
const MIN_BAR_M = 0.003;
const PLATE_MARGIN_M = 0.035;
const PLATE_THICKNESS_M = 0.012;

// Status hues are semantic (DESIGN.md); the overlay legend carries text labels
// too, so colour is never the only signal.
export const RISK_COLORS = {
  normal: "#86a497",
  elevated: "#d39b35",
  high: "#c45f27",
  critical: "#b42f2b",
};
export const RISK_LEVELS = ["normal", "elevated", "high", "critical"];

const LANDFILL_COLOR = "#b53b1a";
const PLATE_COLOR = "#1d2e28";
const PLATE_TOP_COLOR = "#24382f";
const GRID_COLOR = "#33493f";
const TPS_COLOR = "#b9cbc2";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Local equirectangular projection fitted to the districts (+ landfill). */
export function makeProjection(scene) {
  const points = [
    ...(scene.districts || []),
    ...(scene.facilities || []).filter((f) => f.kind === "landfill"),
  ].filter((p) => finite(p.lat) && finite(p.lng));
  if (points.length === 0) {
    return { project: () => ({ x: 0, z: 0 }), width: MODEL_SPAN_M, depth: MODEL_SPAN_M, scale: 1 };
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

export function dayTons(district, dayIndex) {
  const row = district.series?.[dayIndex] || district.series?.[0];
  return row && finite(row.predicted_tons) ? row.predicted_tons : 0;
}

export function dayRisk(district, dayIndex) {
  const row = district.series?.[dayIndex] || district.series?.[0];
  return RISK_LEVELS.includes(row?.risk) ? row.risk : "normal";
}

/**
 * Build the tabletop model. Returns the root group plus handles the viewer
 * uses: `bars` (one mesh per district, userData.district), `setDay(i, {instant})`
 * to retarget heights/colours, `tick(dt)` to ease toward them, and `dispose()`.
 */
export function buildCityModel(scene, { dayIndex = 0, reducedMotion = false } = {}) {
  const geometries = [];
  const materials = [];
  const track = (thing, list) => {
    list.push(thing);
    return thing;
  };

  const root = new THREE.Group();
  root.name = "pythia-city";
  const projection = makeProjection(scene);
  const districts = (scene.districts || []).filter((d) => finite(d.lat) && finite(d.lng));
  const positions = districts.map((d) => projection.project(d.lat, d.lng));

  // ── Plate ──
  const plateW = projection.width + PLATE_MARGIN_M * 2;
  const plateD = projection.depth + PLATE_MARGIN_M * 2;
  const plate = new THREE.Mesh(
    track(new THREE.BoxGeometry(plateW, PLATE_THICKNESS_M, plateD), geometries),
    track(new THREE.MeshStandardMaterial({ color: PLATE_COLOR, roughness: 0.92, metalness: 0 }), materials),
  );
  plate.position.y = -PLATE_THICKNESS_M / 2;
  plate.receiveShadow = true;
  plate.name = "plate";
  root.add(plate);

  const top = new THREE.Mesh(
    track(new THREE.PlaneGeometry(plateW - 0.008, plateD - 0.008), geometries),
    track(new THREE.MeshStandardMaterial({ color: PLATE_TOP_COLOR, roughness: 0.95 }), materials),
  );
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
  const grid = new THREE.LineSegments(
    gridGeometry,
    track(new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: 0.8 }), materials),
  );
  root.add(grid);

  // ── District bars ──
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
  const heightFor = (tons) => Math.max(MIN_BAR_M, (tons / maxTons) * MAX_BAR_M);

  const bars = districts.map((district, i) => {
    const mesh = new THREE.Mesh(barGeometry, riskMaterials[dayRisk(district, dayIndex)]);
    mesh.position.set(positions[i].x, 0, positions[i].z);
    const h = heightFor(dayTons(district, dayIndex));
    mesh.scale.set(barWidth, h, barWidth);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `district-${district.id}`;
    mesh.userData = { district, targetHeight: h };
    root.add(mesh);
    return mesh;
  });

  // ── Landfill marker: a pin and a ground ring, in the product accent ──
  const landfill = (scene.facilities || []).find(
    (f) => f.kind === "landfill" && finite(f.lat) && finite(f.lng),
  );
  let landfillMarker = null;
  if (landfill) {
    const p = projection.project(landfill.lat, landfill.lng);
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
    landfillMarker.position.set(p.x, 0, p.z);
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

  function setDay(nextDay, { instant = false } = {}) {
    bars.forEach((mesh) => {
      const { district } = mesh.userData;
      mesh.userData.targetHeight = heightFor(dayTons(district, nextDay));
      mesh.material = riskMaterials[dayRisk(district, nextDay)];
      if (instant || reducedMotion) mesh.scale.y = mesh.userData.targetHeight;
    });
  }

  // Ease bar heights toward their targets (~250 ms); a no-op once settled.
  function tick(dt) {
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 12);
    let moving = false;
    bars.forEach((mesh) => {
      const diff = mesh.userData.targetHeight - mesh.scale.y;
      if (Math.abs(diff) > 1e-5) {
        mesh.scale.y += diff * k;
        moving = true;
      }
    });
    return moving;
  }

  function dispose() {
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
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
    tick,
    dispose,
  };
}
