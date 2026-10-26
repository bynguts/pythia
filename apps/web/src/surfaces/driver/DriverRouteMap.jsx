import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Flag, Truck } from "lucide-react";

// Same two styles as the fleet map: a flat local style under automation (remote
// tiles make the load event wait on the network) and the OpenFreeMap streets
// style for people, falling back to the flat one when it cannot load (offline).
const FLAT_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "base-bg", type: "background", paint: { "background-color": "#e9e4d8" } }],
};
const STREETS_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const STREETS_TIMEOUT_MS = 8000;
const IS_AUTOMATION = typeof navigator !== "undefined" && Boolean(navigator.webdriver);
const JAKARTA = [106.8456, -6.2088];
// Room for the trip card on top and the stop sheet below.
const FIT_PADDING = { top: 190, bottom: 330, left: 40, right: 40 };

function coord(p) {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  return p && p.lat !== null && p.lng !== null && Number.isFinite(lat) && Number.isFinite(lng)
    ? [lng, lat]
    : null;
}

function pinElement(kind, done) {
  const el = document.createElement("div");
  if (kind === "dot") {
    el.className = `drt-pin-dot${done ? " is-done" : ""}`;
    return { el, root: null };
  }
  el.className = kind === "truck" ? "drt-pin-truck" : "drt-pin-stop";
  const root = createRoot(el);
  root.render(
    kind === "truck" ? <Truck size={20} aria-hidden="true" /> : <Flag size={15} aria-hidden="true" />,
  );
  return { el, root };
}

function lineData(coords) {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords },
  };
}

// The driver's route on a basemap: the SPJ's road geometry when the server has
// one (`path`), else a dashed straight line through the stops, the next stop as
// the orange flag and the phone's own GPS fix as the truck. `fitKey` refits.
export default function DriverRouteMap({
  path,
  stops,
  nextIndex,
  destination,
  position,
  fitKey,
  onFail,
  label,
}) {
  const container = useRef(null);
  const mapRef = useRef(null);
  const loadedRef = useRef(false);
  const markersRef = useRef([]);
  const truckRef = useRef(null);
  const latest = useRef({});
  latest.current = { path, stops, nextIndex, destination, position };

  const fit = () => {
    const map = mapRef.current;
    if (!map) return;
    const { stops: s = [], nextIndex: n, destination: d, position: pos, path: p } = latest.current;
    const target = n >= 0 ? coord(s[n]) : coord(d);
    const points = [coord(pos), target].filter(Boolean);
    if (points.length < 2) {
      (p || []).forEach((pt) => points.push(coord(pt)));
      s.forEach((st) => points.push(coord(st)));
    }
    const known = points.filter(Boolean);
    if (known.length === 0) return;
    if (known.length === 1) {
      map.jumpTo({ center: known[0], zoom: 14 });
      return;
    }
    const bounds = known.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(known[0], known[0]));
    map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: 15, duration: 0 });
  };

  const draw = () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const { path: p, stops: s = [], nextIndex: n, destination: d } = latest.current;
    const road = (p || []).map(coord).filter(Boolean);
    const straight = [...s.map(coord), coord(d)].filter(Boolean);
    const line = road.length >= 2 ? road : straight;
    const dashed = road.length < 2;
    const source = map.getSource("drt-route");
    if (source) source.setData(lineData(line));
    else {
      map.addSource("drt-route", { type: "geojson", data: lineData(line) });
      map.addLayer({
        id: "drt-route-casing",
        type: "line",
        source: "drt-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.85 },
      });
      map.addLayer({
        id: "drt-route-line",
        type: "line",
        source: "drt-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#1f6b45", "line-width": 5 },
      });
    }
    map.setPaintProperty("drt-route-line", "line-dasharray", dashed ? [0.4, 1.8] : [1, 0]);

    markersRef.current.forEach(({ marker, root }) => {
      marker.remove();
      if (root) setTimeout(() => root.unmount(), 0);
    });
    markersRef.current = [];
    s.forEach((stop, i) => {
      const c = coord(stop);
      if (!c) return;
      const closed = stop.status === "completed" || stop.status === "skipped";
      const { el, root } = pinElement(i === n ? "stop" : "dot", closed);
      markersRef.current.push({
        marker: new maplibregl.Marker({ element: el }).setLngLat(c).addTo(map),
        root,
      });
    });
    const dest = coord(d);
    if (dest && n < 0) {
      const { el, root } = pinElement("stop");
      markersRef.current.push({
        marker: new maplibregl.Marker({ element: el }).setLngLat(dest).addTo(map),
        root,
      });
    }
  };

  const placeTruck = () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const c = coord(latest.current.position);
    if (!c) {
      truckRef.current?.marker.remove();
      return;
    }
    if (!truckRef.current) {
      const { el, root } = pinElement("truck");
      truckRef.current = { marker: new maplibregl.Marker({ element: el }), root };
    }
    truckRef.current.marker.setLngLat(c).addTo(map);
  };

  useEffect(() => {
    let map;
    let fallbackTimer = null;
    const useStreets = !IS_AUTOMATION && navigator.onLine !== false;
    try {
      map = new maplibregl.Map({
        container: container.current,
        style: useStreets ? STREETS_STYLE_URL : FLAT_STYLE,
        center: JAKARTA,
        zoom: 12,
        attributionControl: false,
        pitchWithRotate: false,
        dragRotate: false,
        fadeDuration: 0,
      });
    } catch {
      onFail?.();
      return undefined;
    }
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    const onLoad = () => {
      clearTimeout(fallbackTimer);
      loadedRef.current = true;
      draw();
      placeTruck();
      fit();
    };
    map.on("load", onLoad);
    // The streets style document never came: draw on the flat style instead.
    if (useStreets) {
      fallbackTimer = setTimeout(() => {
        if (!loadedRef.current) map.setStyle(FLAT_STYLE);
      }, STREETS_TIMEOUT_MS);
    }
    map.on("error", (event) => {
      if (!loadedRef.current && useStreets && event?.error?.status !== 404) {
        clearTimeout(fallbackTimer);
        map.setStyle(FLAT_STYLE);
      }
    });
    return () => {
      clearTimeout(fallbackTimer);
      markersRef.current.forEach(({ root }) => root && setTimeout(() => root.unmount(), 0));
      if (truckRef.current?.root) {
        const { root } = truckRef.current;
        setTimeout(() => root.unmount(), 0);
      }
      markersRef.current = [];
      truckRef.current = null;
      loadedRef.current = false;
      mapRef.current = null;
      map.remove();
    };
    // The map is created once; data changes go through draw/placeTruck below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopsKey = (stops || []).map((s) => `${s.lat},${s.lng},${s.status}`).join("|");
  useEffect(() => {
    draw();
  }, [path, stopsKey, nextIndex, destination?.lat, destination?.lng]);

  useEffect(() => {
    placeTruck();
  }, [position?.lat, position?.lng]);

  useEffect(() => {
    if (loadedRef.current) fit();
  }, [fitKey, nextIndex]);

  return (
    <div ref={container} className="drt-map" role="img" aria-label={label} data-testid="driver-route-map" />
  );
}
