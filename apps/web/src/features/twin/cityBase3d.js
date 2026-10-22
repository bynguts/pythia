// Pythia Twin city base: a free, keyless alternative to paid photoreal 3D
// tiles, built only from MapLibre-native sources (no new packages).
//
// - Streets (default, most robust): the OpenFreeMap street style with
//   height-tinted 3D buildings, a soft light and a sky at high pitch.
// - Satellite: Sentinel-2 cloudless 2016 imagery (EOX, CC BY 4.0 — the later
//   yearly mosaics are CC BY-NC-SA, so they are not used) under the street
//   lines and 3D buildings, plus hillshade relief from the AWS Open Data
//   Terrain Tiles. The relief is shading only: no terrain mesh and no height
//   exaggeration, so deck.gl ground layers stay visible and Jakarta's flat
//   ground is shown as flat.
//
// Pure map patches: callers decide when the map may use the network (never
// under automation, never on the offline base).

export const IMAGERY_SOURCE = "pythia-imagery";
export const DEM_SOURCE = "pythia-dem";
const IMAGERY_LAYER = "pythia-imagery";
const RELIEF_LAYER = "pythia-relief";

// Licence credits are legal text and stay untranslated; the UI adds the
// localized "Imagery" / "Relief" labels.
export const IMAGERY_CREDIT =
  "EOxCloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0";
export const RELIEF_CREDIT = "Terrain Tiles (Mapzen, AWS Open Data), SRTM & GMTED2010 courtesy of USGS";

const IMAGERY_TILES = ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg"];
const DEM_TILES = ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"];

const IMAGERY_SOURCE_SPEC = {
  type: "raster",
  tiles: IMAGERY_TILES,
  tileSize: 256,
  // Sentinel-2 is a 10 m product: deeper zooms only upscale, so MapLibre
  // over-zooms z14 instead of fetching more tiles.
  maxzoom: 14,
  attribution:
    '<a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless 2016</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>',
};
const DEM_SOURCE_SPEC = {
  type: "raster-dem",
  tiles: DEM_TILES,
  tileSize: 256,
  encoding: "terrarium",
  maxzoom: 14,
  attribution:
    '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles</a> (Mapzen) · SRTM &amp; GMTED2010 courtesy of USGS · ETOPO1 NOAA',
};

// Darkened, desaturated imagery so the risk-coloured columns and white
// labels keep their contrast over green and brown ground.
const IMAGERY_PAINT = {
  "raster-saturation": -0.35,
  "raster-contrast": 0.08,
  "raster-brightness-max": 0.78,
};
const RELIEF_PAINT = {
  "hillshade-exaggeration": 0.45,
  "hillshade-shadow-color": "rgba(8, 18, 14, 0.55)",
  "hillshade-highlight-color": "rgba(255, 255, 255, 0.12)",
  "hillshade-accent-color": "rgba(8, 18, 14, 0.25)",
};

const SKY = {
  streets: {
    "sky-color": "#bcd0d8",
    "horizon-color": "#eef2ef",
    "fog-color": "#eef2ef",
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.7,
  },
  satellite: {
    "sky-color": "#6f93a8",
    "horizon-color": "#cad8dc",
    "fog-color": "#cad8dc",
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.7,
  },
};

// Street layers over the imagery, toned down so they read as a hybrid map.
const SATELLITE_PATCHES = [
  {
    match: (layer) => layer.type === "line" && layer.sourceLayer === "transportation",
    prop: "line-opacity",
    value: 0.5,
  },
  { match: (layer) => layer.type === "fill" && layer.id === "building", prop: "fill-opacity", value: 0.12 },
  { match: (layer) => layer.type === "fill-extrusion", prop: "fill-extrusion-opacity", value: 0.72 },
];

// Original paint values per map, restored when the satellite base is removed.
const saved = new WeakMap();
// gsc n33: a style swap drops the imagery with the old style, so its saved
// paint values belong to layers that no longer exist; forget them then.
const watched = new WeakSet();
function forgetOnStyleSwap(map) {
  if (watched.has(map)) return;
  watched.add(map);
  map.on("style.load", () => {
    // A handler that re-applied the satellite base first saved fresh values.
    if (!map.getSource(IMAGERY_SOURCE)) saved.delete(map);
  });
}

function orderedLayers(map) {
  return map
    .getLayersOrder()
    .map((id) => map.getLayer(id))
    .filter(Boolean);
}

// Imagery and relief go above the land and water fills (which they replace)
// and below roads, buildings, labels and every deck.gl layer.
function insertionPoint(map) {
  return orderedLayers(map).find(
    (layer) =>
      layer.sourceLayer === "transportation" ||
      layer.type === "symbol" ||
      layer.type === "fill-extrusion" ||
      layer.type === "custom",
  )?.id;
}

/** Street-style polish: height-tinted 3D buildings, light and sky. A no-op on
 * styles without the OpenFreeMap 3D building layer (the offline base). */
export function enhanceStreets(map) {
  if (!map.getLayer("building-3d")) return false;
  // Building data starts at z13; showing it one zoom earlier lets the tour's
  // district close-ups read as a city.
  map.setLayerZoomRange("building-3d", 13, 24);
  map.setPaintProperty("building-3d", "fill-extrusion-color", [
    "interpolate",
    ["linear"],
    ["coalesce", ["get", "render_height"], 0],
    0,
    "hsl(35, 10%, 86%)",
    40,
    "hsl(32, 7%, 78%)",
    150,
    "hsl(205, 12%, 68%)",
  ]);
  map.setLight({ anchor: "map", position: [1.4, 200, 40], color: "#ffffff", intensity: 0.38 });
  map.setSky(SKY.streets);
  return true;
}

/** Switch the base between "streets" and "satellite"; idempotent. */
export function applyCityBase(map, base) {
  forgetOnStyleSwap(map);
  const satellite = base === "satellite";
  const has = Boolean(map.getSource(IMAGERY_SOURCE));
  if (satellite && !has) {
    const before = insertionPoint(map);
    map.addSource(IMAGERY_SOURCE, IMAGERY_SOURCE_SPEC);
    map.addSource(DEM_SOURCE, DEM_SOURCE_SPEC);
    map.addLayer({ id: IMAGERY_LAYER, type: "raster", source: IMAGERY_SOURCE, paint: IMAGERY_PAINT }, before);
    map.addLayer({ id: RELIEF_LAYER, type: "hillshade", source: DEM_SOURCE, paint: RELIEF_PAINT }, before);
    const originals = [];
    for (const layer of orderedLayers(map)) {
      for (const patch of SATELLITE_PATCHES) {
        if (!patch.match(layer)) continue;
        originals.push([layer.id, patch.prop, map.getPaintProperty(layer.id, patch.prop)]);
        map.setPaintProperty(layer.id, patch.prop, patch.value);
      }
    }
    saved.set(map, originals);
  } else if (!satellite && has) {
    map.removeLayer(RELIEF_LAYER);
    map.removeLayer(IMAGERY_LAYER);
    map.removeSource(DEM_SOURCE);
    map.removeSource(IMAGERY_SOURCE);
    // Undefined resets a property to the style default.
    for (const [id, prop, value] of saved.get(map) || []) {
      if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
    }
    saved.delete(map);
  }
  if (map.getLayer("building-3d")) map.setSky(SKY[satellite ? "satellite" : "streets"]);
}

export function isCityBaseSource(sourceId) {
  return sourceId === IMAGERY_SOURCE || sourceId === DEM_SOURCE;
}
