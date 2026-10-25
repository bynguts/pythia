// Pythia Twin layer builders. Pure functions: scene + view state in, deck.gl
// layers out — no React, no map instance — so the twin, the tour and the XR
// tabletop can share one definition of what the city looks like.
import { ArcLayer, ColumnLayer, LineLayer, PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";

// Status colours follow tokens.css (--ui-success / --ui-warning / --ui-danger),
// lifted slightly so lit 3D faces stay readable over a light basemap. Mirrored
// as --twin-risk-* in styles/twin.css for the legend swatches.
export const RISK_COLORS = {
  normal: [79, 122, 108],
  elevated: [201, 145, 38],
  high: [214, 104, 32],
  critical: [180, 47, 43],
};
export const RISK_ORDER = ["normal", "elevated", "high", "critical"];
const ACCENT = [22, 97, 58];
const INK = [29, 35, 32];
const FLOW = [27, 111, 132];
const TRUCK_COLORS = { normal: [22, 97, 58], deviated: [180, 47, 43], damaged: [201, 145, 38] };
// Constant props hoisted so per-frame rebuilds pass the same references.
const DISTRICT_MATERIAL = { ambient: 0.5, diffuse: 0.62, shininess: 28, specularColor: [70, 74, 72] };
const BEACON_MATERIAL = { ambient: 0.55, diffuse: 0.55, shininess: 40, specularColor: [80, 80, 80] };
const NO_TRANSITIONS = {};
// Trucks drive inside the district blocks: draw them over the blocks, not hidden in them.
const ON_TOP = { depthCompare: "always" };
const HIGHLIGHT = [255, 255, 255, 80];
const COLUMN_TRANSITIONS = {
  getElevation: { duration: 750, easing: easeInOutCubic },
  getFillColor: { duration: 450 },
};
// The roof edge rises with its block: same duration and easing.
const ROOF_TRANSITIONS = { getPath: COLUMN_TRANSITIONS.getElevation };
// Landfill pulse: alphas at full opacity; the pulse scales them via `opacity`.
const PULSE_FILL = [...ACCENT, 58];
const PULSE_LINE = [...ACCENT, 220];

// Tallest normal-day district column, in metres. Scale is anchored on the
// normal day (no rain, no event), so scenarios visibly grow the columns
// instead of being re-normalised away.
const TARGET_MAX_HEIGHT_M = 3600;
// Extruded district outlines cover far more ground than a column, so they
// rise less to keep the landfill beacon and the haul arcs in view.
const OUTLINE_MAX_HEIGHT_M = 2200;
// Outlines shrink toward their centre so neighbouring districts read as
// separate blocks with a thin street of basemap between them.
const OUTLINE_INSET = 0.94;
// Picking: districts are outlines where the scene has them, columns otherwise.
export const DISTRICT_LAYER_IDS = ["twin-districts", "twin-district-columns"];
// Roof silhouette: one crisp line along each block's top edge. (An extruded
// wireframe draws a vertical edge at every outline vertex, hundreds per
// district, which reads as white "barcode" stripes on the walls.)
const ROOF_EDGE = [255, 255, 255, 170];
const ROOF_EDGE_LIFT_M = 6;
// Haul arcs: the heaviest districts of the selected day get their own arc,
// the rest ride one bundle arc, so 42 arcs never fan into spaghetti.
export const FLOW_TOP_N = 8;
const FLOW_SOURCE_ALPHA = 24;
const FLOW_TARGET_ALPHA = 105;
const FLOW_BUNDLE_ALPHA = 70;
// Districts named on the map: the same top-5 the risk list shows, plus the selection.
export const LABEL_COUNT = 5;
// Event venue pin: a stem rising out of the venue's block and a head above the
// roofs, plus a ground ring at the radius the forecast spreads the crowd over.
export const VENUE_PIN_HEIGHT_M = 3000;
// Rain overlay: streaks over the city, density follows the scenario rainfall.
const RAIN_MIN_DROPS = 120;
const RAIN_MAX_DROPS = 900;
const RAIN_MAX_MM = 150;
const RAIN_TOP_M = 5200;
const RAIN_STREAK_M = 520;
// Drops falling per truck-clock period: an integer, so the loop is seamless.
const RAIN_FALLS_PER_PERIOD = 12;
const RAIN_COLOR = [92, 128, 160, 78];
// Truck animation clock: one leg along the path, one back.
const TRUCK_LEG = 300;
export const TRUCK_PERIOD = TRUCK_LEG * 2;
const TRAIL_LENGTH = 140;

const EARTH_M_PER_DEG = 111_320;

function metresBetween([lng1, lat1], [lng2, lat2]) {
  const kx = Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180)) * EARTH_M_PER_DEG;
  return Math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * EARTH_M_PER_DEG);
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

export function dayRow(district, day) {
  return district.series[Math.min(day, district.series.length - 1)] || district.series[0];
}

export function deltaPercent(row) {
  if (!row?.normal_tons) return 0;
  return ((row.predicted_tons - row.normal_tons) / row.normal_tons) * 100;
}

export function isAtRisk(risk) {
  return risk === "high" || risk === "critical";
}

/** Day-level totals the metric strip and test hooks read. */
export function daySummary(scene, day) {
  const districts = scene?.districts || [];
  let tons = 0;
  let trucks = 0;
  let atRisk = 0;
  for (const district of districts) {
    const row = dayRow(district, day);
    tons += row.predicted_tons;
    trucks += row.trucks_required;
    if (isAtRisk(row.risk)) atRisk += 1;
  }
  return { tons, trucks, atRisk, date: scene?.horizon?.dates?.[day] || null };
}

/** District whose selected-day load spikes most against its normal day. */
export function hottestDistrict(scene, day) {
  let best = null;
  for (const district of scene?.districts || []) {
    const row = dayRow(district, day);
    const score = [deltaPercent(row), row.predicted_tons];
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) {
      best = { district, score };
    }
  }
  return best?.district || null;
}

/** The horizon day a scene's what-if (rain and/or event) applies to. */
export function whatIfDay(scenario) {
  const day = Number(scenario?.scenario_day ?? scenario?.day ?? 0);
  return Number.isInteger(day) && day >= 0 ? day : 0;
}

/** How many rain streaks the overlay draws for a rainfall: none when dry. */
export function rainDropCount(rainfallMm) {
  const rain = Number(rainfallMm) || 0;
  if (rain <= 0) return 0;
  return Math.round(
    RAIN_MIN_DROPS + (Math.min(rain, RAIN_MAX_MM) / RAIN_MAX_MM) * (RAIN_MAX_DROPS - RAIN_MIN_DROPS),
  );
}

function hasOutline(district) {
  return Array.isArray(district.outline) && district.outline.length >= 4;
}

/** The ring scaled toward its area centroid (shoelace), so blocks keep a gap. */
function insetRing(ring, factor) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (!area) return ring;
  cx /= 3 * area;
  cy /= 3 * area;
  return ring.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

// Deterministic pseudo-random stream (mulberry32): the rain falls the same way
// on every load and in every screenshot.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rainField(districts, count) {
  if (!count || !districts.length) return [];
  const lngs = districts.map((d) => d.lng);
  const lats = districts.map((d) => d.lat);
  const pad = 0.04;
  const [west, east] = [Math.min(...lngs) - pad, Math.max(...lngs) + pad];
  const [south, north] = [Math.min(...lats) - pad, Math.max(...lats) + pad];
  const random = seededRandom(20261028);
  return Array.from({ length: count }, () => [
    west + random() * (east - west),
    south + random() * (north - south),
    random(),
  ]);
}

export function landfillOf(scene) {
  return (scene?.facilities || []).find((facility) => facility.kind === "landfill") || null;
}

/**
 * Scene-level constants derived once per scene: column scale and radius,
 * synthesised truck timelines, landfill beacon height, and the static data
 * arrays the layers bind to (stable references, so deck.gl never re-uploads
 * their attributes on an animation frame).
 */
export function prepareScene(scene) {
  const districts = scene?.districts || [];
  const maxNormal = Math.max(
    1,
    ...districts.flatMap((d) => d.series.map((row) => row.normal_tons || row.predicted_tons)),
  );
  const outlined = districts.filter(hasOutline);
  const metersPerTon = (outlined.length ? OUTLINE_MAX_HEIGHT_M : TARGET_MAX_HEIGHT_M) / maxNormal;
  const outlines = new Map(outlined.map((d) => [d.id, insetRing(d.outline, OUTLINE_INSET)]));

  // Column radius follows how tightly the city's districts are packed.
  const nearest = districts
    .map((d, i) => {
      let min = Infinity;
      districts.forEach((other, j) => {
        if (i !== j) min = Math.min(min, metresBetween([d.lng, d.lat], [other.lng, other.lat]));
      });
      return min;
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const median = nearest.length ? nearest[Math.floor(nearest.length / 2)] : 3000;
  const radius = Math.min(1700, Math.max(420, median * 0.34));

  const trips = (scene?.trucks || [])
    .filter((truck) => (truck.path || []).length >= 2)
    .map((truck) => {
      const forward = truck.path;
      const cumulative = [0];
      for (let i = 1; i < forward.length; i += 1)
        cumulative.push(cumulative[i - 1] + metresBetween(forward[i - 1], forward[i]));
      const total = cumulative[cumulative.length - 1] || 1;
      const fractions = cumulative.map((value) => value / total);
      const phase = hash(truck.code) % TRUCK_PERIOD;
      // Three ping-pong cycles starting a full period before t=0 cover any
      // clock value in [0, PERIOD) plus its trail, so trails never clip.
      const path = [];
      const timestamps = [];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const base = (cycle - 1) * TRUCK_PERIOD - phase;
        forward.forEach((point, i) => {
          if (cycle > 0 && i === 0) return;
          path.push(point);
          timestamps.push(base + fractions[i] * TRUCK_LEG);
        });
        for (let i = forward.length - 2; i >= 0; i -= 1) {
          path.push(forward[i]);
          timestamps.push(base + TRUCK_LEG + (1 - fractions[i]) * TRUCK_LEG);
        }
      }
      const status = truck.deviated ? "deviated" : truck.damaged ? "damaged" : "normal";
      return { code: truck.code, status, forward, fractions, phase, path, timestamps };
    });

  const landfill = landfillOf(scene);
  return {
    metersPerTon,
    radius,
    outlined,
    outlines,
    columnDistricts: districts.filter((d) => !hasOutline(d)),
    rain: rainField(districts, rainDropCount(scene?.scenario?.rainfall_mm)),
    // The what-if rain falls on its own day only (every other day keeps the base week).
    rainDay: whatIfDay(scene?.scenario),
    trips,
    landfill,
    beaconHeight: TARGET_MAX_HEIGHT_M * 1.35,
    tps: scene?.tps || [],
    flows: scene?.flows || [],
    eventDistricts: districts.filter((d) => d.event_localized),
    otherFacilities: (scene?.facilities || []).filter((f) => f.kind !== "landfill"),
    landfillData: landfill ? [landfill] : [],
  };
}

/**
 * Districts ordered by how much attention they need on `day`: risk level
 * first, then the change against a normal day. The panel's risk list and the
 * map labels both read this, so they always name the same districts.
 */
export function rankDistricts(scene, day) {
  return (scene?.districts || [])
    .map((district) => {
      const row = dayRow(district, day);
      return { district, row, delta: deltaPercent(row), rank: RISK_ORDER.indexOf(row.risk) };
    })
    .sort((a, b) => b.rank - a.rank || b.delta - a.delta);
}

function weightedCentre(items) {
  const total = items.reduce((sum, item) => sum + item.tons, 0) || 1;
  return [
    items.reduce((sum, item) => sum + item.flow.from[0] * item.tons, 0) / total,
    items.reduce((sum, item) => sum + item.flow.from[1] * item.tons, 0) / total,
  ];
}

/**
 * The haul arcs for one day: the FLOW_TOP_N heaviest districts (by that day's
 * forecast, not the scene's first day) plus the selected one, each on its own
 * arc, and every other district merged into one bundle arc leaving from their
 * tonnage-weighted centre.
 */
export function flowArcs(scene, flows, day, selectedId) {
  const tonsOf = new Map((scene?.districts || []).map((d) => [d.id, dayRow(d, day).predicted_tons]));
  const ranked = (flows || [])
    .filter((flow) => Array.isArray(flow?.from) && Array.isArray(flow?.to))
    .map((flow) => ({ flow, tons: tonsOf.get(flow.district) ?? flow.tons ?? 0 }))
    .sort((a, b) => b.tons - a.tons);
  const own = ranked.filter((item, index) => index < FLOW_TOP_N || item.flow.district === selectedId);
  const rest = ranked.filter((item) => !own.includes(item));
  const arcs = own.map(({ flow, tons }) => ({
    from: flow.from,
    to: flow.to,
    district: flow.district,
    tons,
    selected: flow.district === selectedId,
    bundle: false,
  }));
  if (rest.length) {
    arcs.push({
      from: weightedCentre(rest),
      to: rest[0].flow.to,
      district: null,
      tons: rest.reduce((sum, item) => sum + item.tons, 0),
      count: rest.length,
      selected: false,
      bundle: true,
    });
  }
  return arcs;
}

/**
 * View-level data arrays for one (day, selection, event) combination. Memoise
 * the result on those inputs; animation frames reuse it unchanged.
 * `event` is `{lat, lng, radiusM?}`: the venue the scene was computed for.
 */
export function prepareView(scene, prepared, day, selectedId, event) {
  const districts = scene?.districts || [];
  const metersPerTon = prepared?.metersPerTon || 0;
  const selected = districts.find((d) => d.id === selectedId);
  // Name the districts the risk list names, plus the selected one: labels for
  // all 42 would bury the blocks. The labels themselves are DOM chips placed
  // by the workspace (always on top, never overlapping each other).
  const ranked = rankDistricts(scene, day);
  const labelled = [
    ...ranked.filter(({ district }) => district.id === selectedId),
    ...ranked.slice(0, LABEL_COUNT).filter(({ district }) => district.id !== selectedId),
  ].map(({ district, row }) => ({
    d: district,
    row,
    z: row.predicted_tons * metersPerTon,
    selected: district.id === selectedId,
  }));
  const venue =
    event && Number.isFinite(event.lat) && Number.isFinite(event.lng)
      ? { ...event, radiusM: Number.isFinite(event.radiusM) && event.radiusM > 0 ? event.radiusM : null }
      : null;
  return {
    day,
    selectedId,
    event: venue,
    selectedData: selected ? [selected] : [],
    labelled,
    eventData: venue ? [venue] : [],
    ringData: venue?.radiusM ? [venue] : [],
    flowData: flowArcs(scene, prepared?.flows, day, selectedId),
  };
}

/** Where a truck's head is at clock `time` (same ping-pong as its trail). */
export function truckPosition(trip, time) {
  const t = (((time + trip.phase) % TRUCK_PERIOD) + TRUCK_PERIOD) % TRUCK_PERIOD;
  const f = t < TRUCK_LEG ? t / TRUCK_LEG : 2 - t / TRUCK_LEG;
  const { forward, fractions } = trip;
  for (let i = 1; i < forward.length; i += 1) {
    if (f <= fractions[i]) {
      const span = fractions[i] - fractions[i - 1] || 1;
      const k = (f - fractions[i - 1]) / span;
      return [
        forward[i - 1][0] + (forward[i][0] - forward[i - 1][0]) * k,
        forward[i - 1][1] + (forward[i][1] - forward[i - 1][1]) * k,
      ];
    }
  }
  return forward[forward.length - 1];
}

/**
 * Build every twin layer for one frame. Layer instances are cheap; what costs
 * is attribute regeneration, which deck.gl only does when `data` changes
 * reference or an updateTrigger changes. All data arrays come from
 * prepareScene/prepareView, so per frame only the trips clock, the truck
 * heads and the landfill pulse (uniform props) change.
 * @param {object} args
 * @param {object} args.scene      /api/twin/scene payload
 * @param {object} args.prepared   prepareScene(scene)
 * @param {object} args.view       prepareView(scene, prepared, day, selectedId, event)
 * @param {number} args.time       truck clock in [0, TRUCK_PERIOD)
 * @param {boolean} args.animate   false freezes trails into full static paths
 * @param {boolean} args.reducedMotion disables column easing
 */
export function buildTwinLayers({ scene, prepared, view, time, animate, reducedMotion }) {
  if (!scene || !prepared || !view) return [];
  const { metersPerTon, radius, trips, landfill, beaconHeight } = prepared;
  const { day, selectedId, event } = view;
  const elevationOf = (d) => dayRow(d, day).predicted_tons * metersPerTon;
  const layers = [];

  layers.push(
    new ScatterplotLayer({
      id: "twin-tps",
      data: prepared.tps,
      getPosition: (p) => [p.lng, p.lat],
      getRadius: 45,
      radiusMinPixels: 1.4,
      radiusMaxPixels: 4,
      getFillColor: [...INK, 120],
      pickable: false,
    }),
  );

  if (landfill && view.flowData.length) {
    layers.push(
      new ArcLayer({
        id: "twin-flows",
        data: view.flowData,
        getSourcePosition: (f) => f.from,
        getTargetPosition: (f) => f.to,
        // The bundle carries many districts' tonnes: a fixed width, so it
        // never outweighs the named arcs it stands behind.
        getWidth: (f) => (f.bundle ? 2.5 : Math.min(4, 0.6 + f.tons / 140)),
        widthUnits: "pixels",
        widthMaxPixels: 5,
        getHeight: (f) => (f.bundle ? 0.2 : 0.28),
        getSourceColor: (f) => (f.selected ? [...INK, 60] : [...FLOW, FLOW_SOURCE_ALPHA]),
        getTargetColor: (f) =>
          f.selected ? [...INK, 210] : [...FLOW, f.bundle ? FLOW_BUNDLE_ALPHA : FLOW_TARGET_ALPHA],
        pickable: false,
      }),
    );
  }

  const { outlines } = prepared;
  // Outlined districts mark the event on their block tops instead (below).
  const eventDistricts = prepared.eventDistricts.filter((d) => !outlines.has(d.id));
  if (eventDistricts.length) {
    layers.push(
      new ScatterplotLayer({
        id: "twin-event-rings",
        data: eventDistricts,
        getPosition: (d) => [d.lng, d.lat],
        getRadius: radius * 1.55,
        stroked: true,
        filled: false,
        getLineColor: [...ACCENT, 230],
        lineWidthMinPixels: 2,
        pickable: false,
      }),
    );
  }

  const districtColor = (d) => {
    const color = RISK_COLORS[dayRow(d, day).risk] || RISK_COLORS.normal;
    return [...color, selectedId && selectedId !== d.id ? 200 : 245];
  };
  const transitions = reducedMotion ? NO_TRANSITIONS : COLUMN_TRANSITIONS;
  if (prepared.outlined.length) {
    layers.push(
      new PolygonLayer({
        id: "twin-districts",
        data: prepared.outlined,
        getPolygon: (d) => outlines.get(d.id),
        extruded: true,
        wireframe: false,
        pickable: true,
        autoHighlight: true,
        highlightColor: HIGHLIGHT,
        getElevation: elevationOf,
        getFillColor: districtColor,
        material: DISTRICT_MATERIAL,
        transitions,
        updateTriggers: { getElevation: [day, metersPerTon], getFillColor: [day, selectedId] },
      }),
    );
    // The silhouette: each roof's edge at the block's height, easing with it.
    layers.push(
      new PathLayer({
        id: "twin-district-roofs",
        data: prepared.outlined,
        getPath: (d) => {
          const z = elevationOf(d) + ROOF_EDGE_LIFT_M;
          return outlines.get(d.id).map(([x, y]) => [x, y, z]);
        },
        getColor: ROOF_EDGE,
        getWidth: 1,
        widthUnits: "pixels",
        jointRounded: true,
        transitions: reducedMotion ? NO_TRANSITIONS : ROOF_TRANSITIONS,
        updateTriggers: { getPath: [day, metersPerTon] },
        pickable: false,
      }),
    );
    // Event and selection marks ride the block tops (a ground ring would hide under them).
    const tops = [
      ...prepared.eventDistricts
        .filter((d) => outlines.has(d.id) && d.id !== selectedId)
        .map((d) => ({ d, color: [...ACCENT, 255], width: 3 })),
      ...view.selectedData
        .filter((d) => outlines.has(d.id))
        .map((d) => ({ d, color: [...INK, 255], width: 4 })),
    ];
    if (tops.length) {
      layers.push(
        new PathLayer({
          id: "twin-district-tops",
          data: tops,
          getPath: ({ d }) => {
            const z = elevationOf(d) + 25;
            return outlines.get(d.id).map(([x, y]) => [x, y, z]);
          },
          getColor: ({ color }) => color,
          getWidth: ({ width }) => width,
          widthUnits: "pixels",
          jointRounded: true,
          updateTriggers: { getPath: [day, metersPerTon] },
          pickable: false,
        }),
      );
    }
  }

  layers.push(
    new ColumnLayer({
      id: "twin-district-columns",
      data: prepared.columnDistricts,
      diskResolution: 28,
      radius,
      extruded: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: HIGHLIGHT,
      getPosition: (d) => [d.lng, d.lat],
      getElevation: elevationOf,
      getFillColor: districtColor,
      material: DISTRICT_MATERIAL,
      transitions,
      updateTriggers: { getElevation: [day, metersPerTon], getFillColor: [day, selectedId] },
    }),
  );

  const selectedColumns = view.selectedData.filter((d) => !outlines.has(d.id));
  if (selectedColumns.length) {
    layers.push(
      new ScatterplotLayer({
        id: "twin-selected-ring",
        data: selectedColumns,
        getPosition: (d) => [d.lng, d.lat],
        getRadius: radius * 1.3,
        stroked: true,
        filled: false,
        getLineColor: [...INK, 255],
        lineWidthMinPixels: 3,
        pickable: false,
      }),
    );
  }

  if (trips.length) {
    layers.push(
      new TripsLayer({
        id: "twin-truck-trails",
        data: trips,
        getPath: (trip) => trip.path,
        getTimestamps: (trip) => trip.timestamps,
        getColor: (trip) => TRUCK_COLORS[trip.status],
        widthMinPixels: 3,
        widthMaxPixels: 6,
        capRounded: true,
        jointRounded: true,
        fadeTrail: animate,
        trailLength: animate ? TRAIL_LENGTH : TRUCK_PERIOD * 3,
        currentTime: animate ? time : TRUCK_PERIOD,
        pickable: false,
        parameters: ON_TOP,
      }),
    );
    layers.push(
      new ScatterplotLayer({
        id: "twin-truck-heads",
        data: trips,
        getPosition: (trip) => truckPosition(trip, animate ? time : 0),
        getRadius: 60,
        radiusMinPixels: 3.5,
        radiusMaxPixels: 8,
        getFillColor: (trip) => TRUCK_COLORS[trip.status],
        stroked: true,
        getLineColor: [255, 255, 255, 255],
        lineWidthMinPixels: 1.5,
        updateTriggers: { getPosition: [animate ? time : 0] },
        pickable: false,
        parameters: ON_TOP,
      }),
    );
  }

  if (event) {
    // The venue: a ring at the radius the forecast spreads the crowd over,
    // drawn over the blocks (on the ground it would hide under them), and a
    // pin whose stem rises out of the venue's block to a head above the roofs.
    if (view.ringData.length) {
      layers.push(
        new ScatterplotLayer({
          id: "twin-venue-ring",
          data: view.ringData,
          getPosition: (e) => [e.lng, e.lat],
          getRadius: (e) => e.radiusM,
          stroked: true,
          filled: true,
          getFillColor: [...ACCENT, 38],
          getLineColor: [...ACCENT, 240],
          lineWidthMinPixels: 3,
          updateTriggers: { getRadius: [view.ringData[0].radiusM] },
          pickable: false,
          parameters: ON_TOP,
        }),
      );
    }
    layers.push(
      new LineLayer({
        id: "twin-venue-stem",
        data: view.eventData,
        getSourcePosition: (e) => [e.lng, e.lat, 0],
        getTargetPosition: (e) => [e.lng, e.lat, VENUE_PIN_HEIGHT_M],
        getColor: [...INK, 235],
        getWidth: 3,
        widthUnits: "pixels",
        pickable: false,
      }),
    );
    layers.push(
      new ScatterplotLayer({
        id: "twin-venue-pin",
        data: view.eventData,
        getPosition: (e) => [e.lng, e.lat, VENUE_PIN_HEIGHT_M],
        getRadius: 8,
        radiusUnits: "pixels",
        billboard: true,
        getFillColor: [...ACCENT, 255],
        stroked: true,
        getLineColor: [255, 255, 255, 255],
        lineWidthUnits: "pixels",
        getLineWidth: 2.5,
        pickable: false,
        parameters: ON_TOP,
      }),
    );
  }

  const { otherFacilities } = prepared;
  if (otherFacilities.length) {
    layers.push(
      new ColumnLayer({
        id: "twin-facilities",
        data: otherFacilities,
        diskResolution: 6,
        radius: radius * 0.45,
        extruded: true,
        getPosition: (f) => [f.lng, f.lat],
        getElevation: beaconHeight * 0.22,
        getFillColor: [...INK, 210],
        pickable: false,
      }),
    );
  }

  if (landfill) {
    const pulse = animate ? 0.5 + 0.5 * Math.sin((time / TRUCK_PERIOD) * Math.PI * 4) : 0.6;
    // The pulse rides on uniforms (radiusScale, opacity): no attribute is
    // regenerated per frame.
    layers.push(
      new ScatterplotLayer({
        id: "twin-landfill-ring",
        data: prepared.landfillData,
        getPosition: (f) => [f.lng, f.lat],
        getRadius: radius,
        radiusScale: 1.6 + pulse * 0.9,
        stroked: true,
        filled: true,
        getFillColor: PULSE_FILL,
        getLineColor: PULSE_LINE,
        opacity: (120 + 100 * (1 - pulse)) / 220,
        lineWidthMinPixels: 2,
        updateTriggers: { getRadius: [radius] },
        pickable: false,
      }),
    );
    layers.push(
      new ColumnLayer({
        id: "twin-landfill-beacon",
        data: prepared.landfillData,
        diskResolution: 6,
        radius: radius * 0.55,
        extruded: true,
        getPosition: (f) => [f.lng, f.lat],
        getElevation: beaconHeight,
        getFillColor: [...INK, 240],
        material: BEACON_MATERIAL,
        pickable: false,
      }),
    );
  }

  if (prepared.rain.length && day === prepared.rainDay) {
    // Streaks fall on the truck clock; frozen (still visible) without animation.
    const clock = animate ? time : 0;
    const fall = (drop) => {
      const progress = (drop[2] + (clock / TRUCK_PERIOD) * RAIN_FALLS_PER_PERIOD) % 1;
      return RAIN_TOP_M * (1 - progress);
    };
    layers.push(
      new LineLayer({
        id: "twin-rain",
        data: prepared.rain,
        getSourcePosition: (drop) => [drop[0], drop[1], fall(drop) + RAIN_STREAK_M],
        getTargetPosition: (drop) => [drop[0] - 0.0012, drop[1], fall(drop)],
        getColor: RAIN_COLOR,
        getWidth: 1.2,
        widthUnits: "pixels",
        updateTriggers: { getSourcePosition: [clock], getTargetPosition: [clock] },
        pickable: false,
      }),
    );
  }

  return layers;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
