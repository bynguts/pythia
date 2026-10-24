// Pythia Twin layer builders. Pure functions: scene + view state in, deck.gl
// layers out — no React, no map instance — so the twin, the tour and the XR
// tabletop can share one definition of what the city looks like.
import { ArcLayer, ColumnLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
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
const LABEL_FONT = "Inter Tight, Inter, system-ui, sans-serif";
const NO_TRANSITIONS = {};
const HIGHLIGHT = [255, 255, 255, 80];
const COLUMN_TRANSITIONS = {
  getElevation: { duration: 750, easing: easeInOutCubic },
  getFillColor: { duration: 450 },
};
// Landfill pulse: alphas at full opacity; the pulse scales them via `opacity`.
const PULSE_FILL = [...ACCENT, 58];
const PULSE_LINE = [...ACCENT, 220];

// Tallest normal-day district column, in metres. Scale is anchored on the
// normal day (no rain, no event), so scenarios visibly grow the columns
// instead of being re-normalised away.
const TARGET_MAX_HEIGHT_M = 3600;
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
  const metersPerTon = TARGET_MAX_HEIGHT_M / maxNormal;

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
 * View-level data arrays for one (day, selection, event) combination. Memoise
 * the result on those inputs; animation frames reuse it unchanged.
 */
export function prepareView(scene, prepared, day, selectedId, event) {
  const districts = scene?.districts || [];
  const metersPerTon = prepared?.metersPerTon || 0;
  const selected = districts.find((d) => d.id === selectedId);
  // Name the districts that need attention on the selected day, plus the
  // selected one: labels for all 42 would bury the columns.
  const labelled = districts
    .map((d) => ({ d, row: dayRow(d, day) }))
    .filter(({ d, row }) => d.id === selectedId || isAtRisk(row.risk))
    .sort((a, b) => deltaPercent(b.row) - deltaPercent(a.row))
    .slice(0, 3)
    .map(({ d, row }) => ({ d, row, z: row.predicted_tons * metersPerTon }));
  return {
    day,
    selectedId,
    event: event || null,
    selectedData: selected ? [selected] : [],
    labelled,
    eventData: event ? [event] : [],
    flowTons: new Map(districts.map((d) => [d.id, dayRow(d, day).predicted_tons])),
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
 * @param {object} args.labels     pre-localised strings: { landfill }
 * @param {boolean} args.reducedMotion disables column easing
 */
export function buildTwinLayers({ scene, prepared, view, time, animate, labels = {}, reducedMotion }) {
  if (!scene || !prepared || !view) return [];
  const districts = scene.districts || [];
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

  if (landfill) {
    const { flowTons } = view;
    layers.push(
      new ArcLayer({
        id: "twin-flows",
        data: prepared.flows,
        getSourcePosition: (f) => f.from,
        getTargetPosition: (f) => f.to,
        getWidth: (f) => 0.5 + (flowTons.get(f.district) ?? f.tons) / 160,
        widthUnits: "pixels",
        widthMaxPixels: 5,
        getHeight: 0.28,
        getSourceColor: [...FLOW, 25],
        getTargetColor: [...FLOW, 150],
        updateTriggers: { getWidth: [day] },
        pickable: false,
      }),
    );
  }

  const { eventDistricts } = prepared;
  if (eventDistricts.length || event) {
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

  layers.push(
    new ColumnLayer({
      id: "twin-districts",
      data: districts,
      diskResolution: 28,
      radius,
      extruded: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: HIGHLIGHT,
      getPosition: (d) => [d.lng, d.lat],
      getElevation: elevationOf,
      getFillColor: (d) => {
        const color = RISK_COLORS[dayRow(d, day).risk] || RISK_COLORS.normal;
        return [...color, selectedId && selectedId !== d.id ? 200 : 245];
      },
      material: DISTRICT_MATERIAL,
      transitions: reducedMotion ? NO_TRANSITIONS : COLUMN_TRANSITIONS,
      updateTriggers: { getElevation: [day, metersPerTon], getFillColor: [day, selectedId] },
    }),
  );

  if (view.selectedData.length) {
    layers.push(
      new ScatterplotLayer({
        id: "twin-selected-ring",
        data: view.selectedData,
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

  layers.push(
    new TextLayer({
      id: "twin-district-labels",
      data: view.labelled,
      getPosition: ({ d, z }) => [d.lng, d.lat, z + 120],
      getText: ({ d, row }) => `${d.name}  ${Math.round(row.predicted_tons)} t`,
      getSize: 12,
      sizeMaxPixels: 12,
      getColor: [255, 255, 255, 255],
      background: true,
      getBackgroundColor: [...INK, 232],
      backgroundPadding: [6, 3],
      fontFamily: LABEL_FONT,
      fontWeight: 600,
      characterSet: "auto",
      getTextAnchor: "middle",
      getAlignmentBaseline: "bottom",
      billboard: true,
      updateTriggers: { getPosition: [day, metersPerTon], getText: [day] },
      pickable: false,
    }),
  );

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
      }),
    );
  }

  if (event) {
    layers.push(
      new ScatterplotLayer({
        id: "twin-event-marker",
        data: view.eventData,
        getPosition: (e) => [e.lng, e.lat],
        getRadius: 260,
        radiusMinPixels: 6,
        getFillColor: [...ACCENT, 255],
        stroked: true,
        getLineColor: [255, 255, 255, 255],
        lineWidthMinPixels: 2,
        pickable: false,
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
    if (labels.landfill) {
      layers.push(
        new TextLayer({
          id: "twin-landfill-label",
          data: prepared.landfillData,
          getPosition: (f) => [f.lng, f.lat, beaconHeight + 150],
          getText: () => labels.landfill,
          getSize: 12,
          sizeMaxPixels: 12,
          lineHeight: 1.35,
          getColor: [255, 255, 255, 255],
          background: true,
          getBackgroundColor: [...INK, 240],
          getBorderColor: [...ACCENT, 255],
          getBorderWidth: 2,
          backgroundPadding: [9, 6],
          fontFamily: LABEL_FONT,
          fontWeight: 650,
          characterSet: "auto",
          getTextAnchor: "middle",
          getAlignmentBaseline: "bottom",
          billboard: true,
          updateTriggers: { getText: [labels.landfill] },
          pickable: false,
        }),
      );
    }
  }

  return layers;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
