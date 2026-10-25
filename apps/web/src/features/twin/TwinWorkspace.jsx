import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { WebMercatorViewport } from "@deck.gl/core";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  CloudRain,
  Glasses,
  MapPin,
  Pause,
  Play,
  QrCode,
  RefreshCw,
  Square,
  Satellite,
  Sparkles,
  Users,
} from "lucide-react";
import { MetricStrip } from "../../shared/ui/MetricStrip.jsx";
import { Provenance } from "../../shared/ui/Provenance.jsx";
import { useLanguage } from "../../shared/i18n/index.jsx";
import {
  DISTRICT_LAYER_IDS,
  RISK_ORDER,
  TRUCK_PERIOD,
  VENUE_PIN_HEIGHT_M,
  buildTwinLayers,
  dayRow,
  daySummary,
  deltaPercent,
  prepareScene,
  prepareView,
  rankDistricts,
  whatIfDay,
} from "./twinLayers.js";
import { buildTour, overviewCamera, runTour } from "./tour.js";
import { TwinAskRail } from "./TwinAskRail.jsx";
import { ScenarioBriefing } from "./ScenarioBriefing.jsx";
import { TWIN_DAYS, useTwinScene } from "./useTwinScene.js";
import { tablePresenceText, useTableSession } from "./useTableSession.js";
import {
  TWIN_CITIES,
  TWIN_EVENT_PRESETS,
  TWIN_VENUES,
  dailyRisk,
  twinScenario,
  carriedRainMm,
  rainHeldText,
  rainResponseText,
  readTwinParams,
  twinVenues,
  withTwinParams,
} from "./twinLinks.js";
import {
  IMAGERY_CREDIT,
  RELIEF_CREDIT,
  applyCityBase,
  enhanceStreets,
  isCityBaseSource,
} from "./cityBase3d.js";
import "./twin.css";

// "Put this on the table": the QR dialog (and its encoder) loads only when opened.
const TwinTableHandoff = lazy(() =>
  import("./TwinTableHandoff.jsx").then((module) => ({ default: module.TwinTableHandoff })),
);

// Same determinism contract as LiveFleetMap: Playwright sets
// navigator.webdriver, so e2e gets an inline offline style and never waits on
// remote tiles. Presentation mode (?present=1, used for recorded footage) and
// ?basemap=streets opt back into the real 3D street basemap.
const IS_AUTOMATION = typeof navigator !== "undefined" && Boolean(navigator.webdriver);
const QUERY =
  typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
const PRESENT = QUERY.get("present") === "1";
// ?basemap=satellite also opens on the satellite base (recorded footage).
const SATELLITE_FIRST = QUERY.get("basemap") === "satellite";
const USE_STREETS = !IS_AUTOMATION || PRESENT || QUERY.get("basemap") === "streets" || SATELLITE_FIRST;
// Imagery or relief tile failures before the satellite base gives up.
const CITY_BASE_ERROR_LIMIT = 8;
const ANIMATE_UNDER_AUTOMATION = PRESENT || QUERY.get("motion") === "on";
const STREETS_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const OFFLINE_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "twin-offline-bg", type: "background", paint: { "background-color": "#f4ede3" } }],
};
const CITIES = TWIN_CITIES;
// A scene's data class as the one provenance-chip tone.
const PROV_KINDS = {
  REAL: "real",
  MODEL_OUTPUT: "model",
  SIMULATED: "sim",
  APPROXIMATE: "sim",
  SIMULATED_DEMO_CITY: "demo",
  UNAVAILABLE: "stale",
};
const provKind = (value) => PROV_KINDS[value] || "proxy";
const EVENT_PRESETS = TWIN_EVENT_PRESETS;
const PLAY_STEP_MS = 1800;
// Keyboard path into the map: the panel lists this many districts by risk.
const RISK_LIST_SIZE = 5;
// Truck clock speed: one full ping-pong period every ~9 s.
const TRUCK_UNITS_PER_MS = TRUCK_PERIOD / 9000;
const DESKTOP_QUERY = "(min-width: 921px)";
// Gap kept between floating map labels and the canvas edge.
const CANVAS_MARGIN = 8;
const RAIN_STEP_MM = 5;
const RAIN_MAX_MM = 150;
// Map padding: the camera frames the city in the part of the canvas the
// floating instruments leave clear (legend bar on top, timeline below, zoom
// column on the right; in footage mode the HUD stack and the legend card).
const NO_PADDING = { top: 0, left: 0, right: 0, bottom: 0 };
const WORKSPACE_PADDING = { top: 64, left: 0, right: 56, bottom: 96 };
const PRESENT_PADDING = { top: 120, left: 0, right: 0, bottom: 88 };
// Gap between the landfill beacon and its tag, and what the tag must not cover.
const TAG_GAP = 14;
const TAG_OBSTACLES = [
  ".twin-legend-bar",
  ".twin-provenance-bar",
  ".twin-tools",
  ".twin-timeline",
  ".twin-rain-label",
  ".twin-present-hud",
  ".twin-present-scenario",
  ".twin-imagery-credit",
  ".maplibregl-ctrl-top-right",
].join(",");
// Map labels (venue, then districts by priority) also keep clear of the landfill tag.
const LABEL_OBSTACLES = `${TAG_OBSTACLES},.twin-landfill-tag,.twin-tour-caption,.twin-status`;
const LABEL_GAP = 8;

/** deck.gl's viewport for the map's current camera, so DOM tags project like the layers. */
function mapViewport(map) {
  const container = map.getContainer();
  const center = map.getCenter();
  return new WebMercatorViewport({
    width: container.clientWidth,
    height: container.clientHeight,
    longitude: center.lng,
    latitude: center.lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
    padding: map.getPadding(),
  });
}

/** Rects (relative to the map box) of the visible elements matching `selector` in the stage. */
function obstacleRects(map, selector) {
  const box = map.getContainer().getBoundingClientRect();
  const stage = map.getContainer().closest(".twin-stage");
  return [...(stage?.querySelectorAll(selector) || [])]
    .filter((el) => getComputedStyle(el).visibility !== "hidden")
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => [r.left - box.left, r.top - box.top, r.right - box.left, r.bottom - box.top]);
}

function overlaps([l, t, r, b], rects) {
  return rects.some(([ol, ot, or, ob]) => !(r <= ol || l >= or || b <= ot || t >= ob));
}

/**
 * The scene's event venue (what the scene was computed for), with the reach the
 * forecast used: `scenario.event.radius_m` (kecamatan whose real boundary lies
 * within it share the crowd) and how many districts it reached. The demo city
 * puts the whole crowd in its nearest district, so it states no radius and
 * gets no ring.
 */
function sceneVenue(scene) {
  const scenario = scene?.scenario;
  if (!scenario?.event_attendance || scenario.event_lat == null || scenario.event_lng == null) return null;
  const lat = Number(scenario.event_lat);
  const lng = Number(scenario.event_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const stated = Number(scenario.event?.radius_m ?? NaN);
  const radiusM = Number.isFinite(stated) && stated > 0 ? stated : null;
  const reached = Array.isArray(scenario.event?.districts) ? scenario.event.districts.length : null;
  // The scene names its preset only when asked by id; the twin asks by coordinates.
  const venues = scene.venues || [];
  const preset =
    venues.find((v) => v.id === scenario.venue) ||
    venues.find((v) => Math.abs(v.lat - lat) < 1e-4 && Math.abs(v.lng - lng) < 1e-4);
  return { lat, lng, radiusM, reached, name: preset?.name || null };
}

/**
 * Top-left for a w×h box near (x, y), clamped inside a width×height canvas
 * minus `inset` (the map padding the floating panels cover).
 */
function clampBox(x, y, w, h, width, height, inset = {}) {
  const left = (inset.left || 0) + CANVAS_MARGIN;
  const top = (inset.top || 0) + CANVAS_MARGIN;
  const right = width - (inset.right || 0) - w - CANVAS_MARGIN;
  const bottom = height - (inset.bottom || 0) - h - CANVAS_MARGIN;
  return [Math.round(Math.max(left, Math.min(x, right))), Math.round(Math.max(top, Math.min(y, bottom)))];
}

/** Attribution stays one tap away (the "i" control) instead of opening over the map. */
function collapseAttribution(map) {
  map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
}

/**
 * MapLibre opens its compact credit the moment sources first bring one (the
 * street style or the satellite base, after load). Fold it at that transition
 * only; the reader's own taps on the "i" control are left alone.
 */
function keepAttributionFolded(map) {
  const control = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
  if (!control || typeof MutationObserver === "undefined") return () => {};
  let compact = control.classList.contains("maplibregl-compact");
  const observer = new MutationObserver(() => {
    const now = control.classList.contains("maplibregl-compact");
    if (now && !compact) control.classList.remove("maplibregl-compact-show");
    compact = now;
  });
  observer.observe(control, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function TwinWorkspace({ onCityChange }) {
  const { t } = useLanguage();
  const locale = t("twin_locale");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const animate = !reducedMotion && (!IS_AUTOMATION || ANIMATE_UNDER_AUTOMATION);

  // Deep link (/twin?city=&rain=&event=&venue=&day=): read once, on mount.
  const [initial] = useState(() =>
    readTwinParams(typeof window !== "undefined" ? window.location.search : ""),
  );
  const [city, setCity] = useState(initial.city);
  // The shell header names the city, so it must follow the twin's city switch.
  useEffect(() => {
    onCityChange?.(city);
  }, [city, onCityChange]);
  const [rainfall, setRainfall] = useState(initial.rain);
  const [eventPreset, setEventPreset] = useState(initial.event);
  const [venueId, setVenueId] = useState(initial.venue);
  const [day, setDay] = useState(initial.day);
  // The day the what-if (rain and/or event) applies to: the selected day when the
  // scenario was last edited. Stepping or playing the timeline never moves it.
  const [scenarioDay, setScenarioDay] = useState(initial.scenarioDay);
  const [playing, setPlaying] = useState(false);
  // The decision room's briefing scenario on the map (twinLinks TWIN_SCENARIOS), or
  // null once the what-if is edited by hand or asked of Pythia.
  const [scenarioId, setScenarioId] = useState(initial.scenario);
  // The briefing's last answer: today's canonical baseline, for the KPI strip's delta.
  const [briefingBody, setBriefingBody] = useState(null);
  // The TPA beacon's queue detail opens on tap only (footage mode keeps it open).
  const [landfillOpen, setLandfillOpen] = useState(PRESENT);
  // The scene's queue metric follows the selected day, but not every step of
  // timeline playback (that would refetch the scene once per animation frame).
  const [queueDay, setQueueDay] = useState(initial.day);
  useEffect(() => {
    if (!playing) setQueueDay(day);
  }, [day, playing]);
  const [selectedId, setSelectedId] = useState(null);
  const [hover, setHover] = useState(null);
  const [tour, setTour] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [basemapOffline, setBasemapOffline] = useState(false);
  const [satellite, setSatellite] = useState(SATELLITE_FIRST);
  const [cityBaseFailed, setCityBaseFailed] = useState(false);
  // Ask Pythia rail: always open in the workspace, collapsed in footage mode.
  const [askOpen, setAskOpen] = useState(!PRESENT);
  // Provenance: a one-line summary over the map, the full list one tap away.
  // Footage mode opens it, so every layer's class stays on screen.
  const [provenanceOpen, setProvenanceOpen] = useState(PRESENT);
  // The satellite base needs the online street style: never under automation
  // (unless opted in) and never on the offline fallback.
  const cityBaseAvailable = USE_STREETS && !basemapOffline && !cityBaseFailed;
  const satelliteOn = satellite && cityBaseAvailable;

  const preset = EVENT_PRESETS.find((p) => p.id === eventPreset) || EVENT_PRESETS[0];
  // The scene's venue list wins when it has one; ids are shared with TWIN_VENUES.
  const [sceneVenues, setSceneVenues] = useState(null);
  const venues = twinVenues(city, sceneVenues?.city === city ? sceneVenues.list : null);
  const venue = venues.find((v) => v.id === venueId) || venues[0];
  const whatIf = rainfall > 0 || preset.attendance > 0;
  const request = {
    city,
    rainfall,
    attendance: preset.attendance,
    eventLat: preset.attendance ? venue.lat : null,
    eventLng: preset.attendance ? venue.lng : null,
    venue: preset.attendance ? venue.id : null,
    day: queueDay,
    scenarioDay: whatIf ? scenarioDay : null,
  };
  const { scene, loading, error, settled, retry } = useTwinScene(request);
  useEffect(() => {
    if (Array.isArray(scene?.venues) && scene.venues.length && scene.city?.id)
      setSceneVenues({ city: scene.city.id, list: scene.venues });
  }, [scene]);
  const prepared = useMemo(() => (scene ? prepareScene(scene) : null), [scene]);
  const dayCount = scene?.horizon?.dates?.length || TWIN_DAYS;
  const safeDay = Math.min(day, dayCount - 1);
  // "Put this on the table": once started, every scenario change here is written
  // to the shared XR session that the phones on the table follow.
  const table = useTableSession({
    city,
    rainfall_mm: rainfall,
    event_preset: eventPreset,
    venue_id: venue.id,
    day: Math.max(0, Math.min(TWIN_DAYS - 1, safeDay)),
    scenario_day: Math.max(0, Math.min(TWIN_DAYS - 1, scenarioDay)),
    selected_id: selectedId,
    scenario_id: scenarioId,
  });
  const [tableOpen, setTableOpen] = useState(false);
  const tableTriggerRef = useRef(null);
  // Focus returns to whichever control opened the table dialog.
  const tableReturnRef = useRef(null);
  const openTable = (event) => {
    tableReturnRef.current = event.currentTarget;
    setTableOpen(true);
  };
  // Mark the event the scene was computed for, not the pending preset.
  const sceneEvent = useMemo(() => sceneVenue(scene), [scene]);
  // Data arrays for the layers, rebuilt only when the view changes — never
  // per animation frame.
  const view = useMemo(
    () => (prepared ? prepareView(scene, prepared, safeDay, selectedId, sceneEvent) : null),
    [scene, prepared, safeDay, selectedId, sceneEvent],
  );
  const summary = useMemo(() => daySummary(scene, safeDay), [scene, safeDay]);
  // Each day's at-risk count (horizon.daily_districts_at_risk), so a dry today
  // never reads as a calm week (teardown v3 fix 6).
  const weekRisk = useMemo(() => dailyRisk(scene), [scene]);
  const ready = mapReady && settled && scene?.city?.id === city;

  const number = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), [locale]);
  const compactNumber = useMemo(
    () => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 0 }),
    [locale],
  );
  const minutesNumber = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" }),
    [locale],
  );
  const weekdayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short" }), [locale]);
  const formatDate = useCallback(
    (iso, format = dateFormat) => (iso ? format.format(new Date(`${iso}T00:00:00`)) : "—"),
    [dateFormat],
  );
  const classLabel = useCallback((value) => t(`twin_class_${value}`), [t]);

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const overlayRef = useRef(null);
  const frameRef = useRef({});
  const clockRef = useRef(0);
  const framedCityRef = useRef(null);
  const tourRef = useRef(null);
  const dayButtonsRef = useRef([]);

  // ---- map + deck overlay (once) -------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: USE_STREETS ? STREETS_STYLE_URL : OFFLINE_STYLE,
      center: [106.8456, -6.2088],
      zoom: 10.4,
      pitch: 58,
      bearing: -20,
      maxPitch: 75,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      onHover: (info) => {
        if (DISTRICT_LAYER_IDS.includes(info.layer?.id) && info.object)
          setHover({ x: info.x, y: info.y, id: info.object.id });
        else setHover(null);
      },
      onClick: (info) => {
        if (DISTRICT_LAYER_IDS.includes(info.layer?.id) && info.object) setSelectedId(info.object.id);
        else setSelectedId(null);
      },
      getCursor: ({ isHovering, isDragging }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
    });
    overlayRef.current = overlay;
    map.addControl(overlay);

    let fellBack = false;
    let styleLoaded = false;
    const fallBack = () => {
      if (fellBack || styleLoaded || !USE_STREETS) return;
      fellBack = true;
      setBasemapOffline(true);
      map.setStyle(OFFLINE_STYLE);
    };
    // Venue wifi safety net: degrade once to the offline base instead of a
    // blank canvas, but only when the style document itself fails. Tile,
    // source, sprite or glyph errors are transient and handled by MapLibre.
    const styleTimer = setTimeout(fallBack, 9000);
    map.on("error", (event) => {
      if (styleLoaded || event?.sourceId || event?.tile) return;
      const url = event?.error?.url;
      if (url && url !== STREETS_STYLE_URL) return;
      fallBack();
    });
    map.on("style.load", () => {
      styleLoaded = true;
      clearTimeout(styleTimer);
      // Quiet the basemap so the data columns carry the colour: hide points
      // of interest and wash out parks and land cover.
      for (const layer of map.getStyle().layers || []) {
        if (layer.type === "symbol" && /^poi/.test(layer.id))
          map.setLayoutProperty(layer.id, "visibility", "none");
        if (layer.type === "fill" && /park|landuse|landcover|wood|grass|forest/.test(layer.id))
          map.setPaintProperty(layer.id, "fill-opacity", 0.35);
      }
      enhanceStreets(map);
      setMapReady(true);
    });
    // Satellite imagery or relief host down: drop back to the street base
    // once instead of leaving holes under the columns.
    let cityBaseErrors = 0;
    map.on("error", (event) => {
      if (isCityBaseSource(event?.sourceId) && ++cityBaseErrors === CITY_BASE_ERROR_LIMIT)
        setCityBaseFailed(true);
    });
    // Attribution stays one tap away (the "i" control) instead of opening
    // over the bottom of small map windows.
    map.once("load", () => collapseAttribution(map));
    map.once("idle", () => collapseAttribution(map));
    const releaseAttribution = keepAttributionFolded(map);

    return () => {
      clearTimeout(styleTimer);
      releaseAttribution();
      tourRef.current?.abort();
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // ---- city base: streets or satellite + relief -----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !USE_STREETS || basemapOffline) return;
    applyCityBase(map, satelliteOn ? "satellite" : "streets");
  }, [satelliteOn, mapReady, basemapOffline]);

  // Keep the city centred in the part of the canvas the instruments leave clear.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setPadding(!desktop ? NO_PADDING : PRESENT ? PRESENT_PADDING : WORKSPACE_PADDING);
  }, [desktop, mapReady]);

  // ---- camera follows the city ----------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !scene || framedCityRef.current === scene.city.id) return;
    const first = framedCityRef.current === null;
    framedCityRef.current = scene.city.id;
    const camera = overviewCamera(scene, map);
    if (first || reducedMotion) map.jumpTo(camera);
    else map.flyTo({ ...camera, duration: 2400, essential: true });
  }, [scene, mapReady, reducedMotion]);

  // ---- layers ---------------------------------------------------------------
  const queue = scene?.landfill_queue;
  const queueClass = scene?.provenance?.landfill_queue?.class;
  // Data honesty: the queue figures are a simulation, and the label says so.
  const queueClassText =
    queue && queueClass ? t("twin_queue_class").replace("{class}", classLabel(queueClass)) : null;
  const landfillName = prepared?.landfill?.name;
  // The beacon describes the hour the payload names (the modelled peak hour of
  // the selected day), never the wall clock, and says so.
  const queueHour = Number.isInteger(queue?.modelled_hour)
    ? t("twin_queue_peak_hour").replace("{hour}", `${String(queue.modelled_hour).padStart(2, "0")}:00`)
    : queue?.hour_label || null;
  // Optional field: only Jakarta scenes carry the simulated per-truck queue time.
  const queueMetric = queue?.minutes_per_truck;
  const queueMetricOk =
    Number.isFinite(queueMetric?.baseline_mean) && Number.isFinite(queueMetric?.staggered_mean);
  // The beacon's peak hour is the current-practice (unstaggered) arm, and says so.
  const queuePeakLine = queueHour
    ? t("twr_queue_peak_unstaggered")
        .replace("{peak}", queueHour)
        .replace("{trucks}", number.format(queue.trucks_in_queue ?? 0))
        .replace("{wait}", number.format(queue.avg_wait_minutes ?? 0))
    : null;
  // The same clock hour with Pythia's stagger (landfill_queue.peak_hour.staggered,
  // the same seeded simulated day as the beacon), when it is that hour.
  const staggeredPeak = queue?.peak_hour?.staggered;
  const staggeredPeakLine =
    queuePeakLine &&
    staggeredPeak?.hour === queue.modelled_hour &&
    Number.isFinite(staggeredPeak?.mean_wait_minutes)
      ? t("twr_queue_peak_staggered")
          .replace("{trucks}", number.format(staggeredPeak.queue_trucks_max ?? 0))
          .replace("{wait}", number.format(staggeredPeak.mean_wait_minutes))
      : null;
  // The day mean, unstaggered next to staggered: the peak-hour wait and the
  // headline then read as peak vs day and before vs after, not as a contradiction.
  const queueDayLine = queueMetricOk
    ? t("twr_queue_day_mean")
        .replace("{from}", minutesNumber.format(queueMetric.baseline_mean))
        .replace("{to}", minutesNumber.format(queueMetric.staggered_mean))
    : null;
  // Teardown v3 N6: the Fleet KPI queue is the unscaled normal day; this beacon is
  // scaled to the selected day (landfill_queue.day_basis). Say which, and why.
  const dayBasis = queue?.day_basis;
  const basisTrips = dayBasis?.trucks_per_day;
  const basisNormalTrips = dayBasis?.normal_trucks_per_day;
  const basisHasTrips = Number.isFinite(basisTrips) && Number.isFinite(basisNormalTrips);
  const queueScaledDay = basisHasTrips
    ? basisTrips !== basisNormalTrips
    : queueMetric?.scenario_scaled === true;
  const queueBasisLine =
    queue && (queueMetric || dayBasis)
      ? [
          t(
            !queueScaledDay
              ? "ufx_queue_basis_normal"
              : dayBasis?.id === "forecast_weather"
                ? "ufx_queue_basis_forecast"
                : "ufx_queue_basis_scenario",
          ),
          queueScaledDay && basisHasTrips
            ? t("ufx_queue_basis_trips")
                .replace("{n}", number.format(basisTrips))
                .replace("{normal}", number.format(basisNormalTrips))
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  const landfillLines = landfillName
    ? [
        landfillName,
        queue ? queuePeakLine : t("twin_queue_none"),
        staggeredPeakLine,
        queueDayLine,
        queueBasisLine,
        queueClassText,
      ].filter(Boolean)
    : [];
  const queueHourLine = queue ? queueHour : null;
  const landfillLabel = landfillLines.length ? landfillLines.join("\n") : null;

  // The last layer list drawn, for the test hook's layer inspector.
  const layersRef = useRef([]);
  const draw = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    layersRef.current = buildTwinLayers({ ...frameRef.current, time: clockRef.current });
    overlay.setProps({ layers: layersRef.current });
  }, []);

  useEffect(() => {
    frameRef.current = {
      scene,
      prepared,
      view,
      animate,
      reducedMotion,
      // wave11 twin: the simulated fleet only in footage mode; the room shows risk.
      showTrucks: PRESENT,
    };
    if (mapReady) draw();
  }, [scene, prepared, view, animate, reducedMotion, mapReady, draw]);

  // ---- floating labels, clamped inside the canvas ---------------------------
  // The landfill tag follows the beacon top; deck's own viewport math projects
  // the 3D point exactly as the overlay draws it.
  const landfillTagRef = useRef(null);
  const placeLandfillTag = useCallback(() => {
    const map = mapRef.current;
    const tag = landfillTagRef.current;
    const prep = frameRef.current.prepared;
    if (!map || !tag || !prep?.landfill) return;
    const viewport = mapViewport(map);
    const { width, height } = viewport;
    const [x, y] = viewport.project([prep.landfill.lng, prep.landfill.lat, prep.beaconHeight]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      tag.style.visibility = "hidden";
      return;
    }
    // The landfill sits outside the city, so the tag hangs off the beacon away
    // from the districts: beside its top, else under its base or above it, and
    // only then towards the city. A spot must stay inside the canvas and clear of the
    // instruments floating on it (legend, tools, timeline, HUD, zoom column).
    const [bx, by] = viewport.project([prep.landfill.lng, prep.landfill.lat, 0]);
    const w = tag.offsetWidth;
    const h = tag.offsetHeight;
    const obstacles = obstacleRects(map, TAG_OBSTACLES);
    const fits = ([l, t]) =>
      l >= CANVAS_MARGIN &&
      t >= CANVAS_MARGIN &&
      l + w <= width - CANVAS_MARGIN &&
      t + h <= height - CANVAS_MARGIN &&
      !overlaps([l, t, l + w, t + h], obstacles);
    const below = by + TAG_GAP / 2;
    const candidates = [
      ["right", [x + TAG_GAP, y - h / 2]],
      ["below", [bx - TAG_GAP, below]],
      ["below", [bx - w + TAG_GAP, below]],
      // Over the haul arcs, pulled in from the right edge, before it may cover districts.
      ["above", [Math.min(x - w / 2, width - CANVAS_MARGIN - w), y - h - TAG_GAP]],
      ["left", [x - TAG_GAP - w, y - h / 2]],
    ];
    const [side, spot] = candidates.find(([, spot]) => fits(spot)) || candidates[0];
    const [left, top] = clampBox(spot[0], spot[1], w, h, width, height);
    tag.dataset.side = side;
    tag.style.visibility = "visible";
    tag.style.transform = `translate(${left}px, ${top}px)`;
  }, []);

  // Map labels are DOM chips, so they always sit on top of the 3D blocks and
  // the arcs. They are placed in priority order (venue, selection, then the
  // risk ranking); a chip that cannot find a free spot beside its anchor is
  // hidden rather than drawn over another label or an instrument.
  const labelsRef = useRef(null);
  const placeLabels = useCallback(() => {
    const map = mapRef.current;
    const layer = labelsRef.current;
    if (!map || !layer) return;
    const chips = [...layer.querySelectorAll(".twin-label")];
    if (!chips.length) return;
    const viewport = mapViewport(map);
    const { width, height } = viewport;
    const taken = obstacleRects(map, LABEL_OBSTACLES);
    for (const chip of chips) {
      const [x, y] = viewport.project([
        Number(chip.dataset.lng),
        Number(chip.dataset.lat),
        Number(chip.dataset.z) || 0,
      ]);
      const w = chip.offsetWidth;
      const h = chip.offsetHeight;
      const spots = [
        ["above", [x - w / 2, y - h - LABEL_GAP]],
        ["right", [x + LABEL_GAP, y - h / 2]],
        ["left", [x - LABEL_GAP - w, y - h / 2]],
        ["below", [x - w / 2, y + LABEL_GAP]],
      ];
      const found =
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        spots.find(
          ([, [l, t]]) =>
            l >= CANVAS_MARGIN &&
            t >= CANVAS_MARGIN &&
            l + w <= width - CANVAS_MARGIN &&
            t + h <= height - CANVAS_MARGIN &&
            !overlaps([l, t, l + w, t + h], taken),
        );
      if (!found) {
        chip.dataset.placed = "false";
        chip.style.visibility = "hidden";
        continue;
      }
      const [side, [l, t]] = found;
      taken.push([l, t, l + w, t + h]);
      chip.dataset.placed = "true";
      chip.dataset.side = side;
      chip.style.visibility = "visible";
      chip.style.transform = `translate(${Math.round(l)}px, ${Math.round(t)}px)`;
    }
  }, []);

  // The landfill tag first: the labels then keep clear of it.
  const placeOverlays = useCallback(() => {
    placeLandfillTag();
    placeLabels();
  }, [placeLandfillTag, placeLabels]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return undefined;
    map.on("move", placeOverlays);
    map.on("resize", placeOverlays);
    return () => {
      map.off("move", placeOverlays);
      map.off("resize", placeOverlays);
    };
  }, [mapReady, placeOverlays]);
  // A passive effect, so it runs after the frame effect above has stored `prepared`.
  useEffect(() => {
    placeOverlays();
  }, [landfillLabel, landfillOpen, prepared, view, mapReady, placeOverlays]);

  // The district tooltip flips to the other side of the cursor near an edge.
  const tooltipRef = useRef(null);
  useLayoutEffect(() => {
    const tip = tooltipRef.current;
    const box = containerRef.current;
    if (!tip || !box || !hover) return;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const x = hover.x + 14 + w > box.clientWidth ? hover.x - 14 - w : hover.x + 14;
    const y = hover.y + 14 + h > box.clientHeight ? hover.y - 14 - h : hover.y + 14;
    const [left, top] = clampBox(x, y, w, h, box.clientWidth, box.clientHeight);
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }, [hover]);

  useEffect(() => {
    if (!animate || !mapReady || !prepared) return undefined;
    let frame = 0;
    let last = performance.now();
    const tick = (now) => {
      clockRef.current = (clockRef.current + (now - last) * TRUCK_UNITS_PER_MS) % TRUCK_PERIOD;
      last = now;
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animate, mapReady, prepared, draw]);

  // ---- playback -------------------------------------------------------------
  useEffect(() => {
    if (!playing) return undefined;
    const id = setInterval(() => setDay((d) => (d + 1) % dayCount), PLAY_STEP_MS);
    return () => clearInterval(id);
  }, [playing, dayCount]);

  useEffect(() => {
    if (selectedId && scene && !scene.districts.some((d) => d.id === selectedId)) setSelectedId(null);
  }, [scene, selectedId]);

  // ---- shareable URL --------------------------------------------------------
  // Once the scenario moves off what the page opened with, mirror it into the
  // query string (replace, not push) so the address bar is always a deep link.
  const navigate = useNavigate();
  const urlScenarioRef = useRef(initial);
  useEffect(() => {
    const scenario = {
      city,
      rain: rainfall,
      event: eventPreset,
      venue: venue.id,
      day,
      scenarioDay,
      scenario: scenarioId,
    };
    const last = urlScenarioRef.current;
    if (
      last.scenario === scenarioId &&
      last.city === city &&
      last.rain === rainfall &&
      last.event === eventPreset &&
      last.venue === venue.id &&
      last.day === day &&
      last.scenarioDay === scenarioDay
    )
      return undefined;
    const timer = setTimeout(() => {
      urlScenarioRef.current = scenario;
      const search = withTwinParams(window.location.search, scenario);
      if (search !== window.location.search)
        navigate({ pathname: window.location.pathname, search }, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [city, rainfall, eventPreset, venue.id, day, scenarioDay, scenarioId, navigate]);

  // ---- decision room: a briefing scenario onto the map, then to Rencana ------
  const chooseScenario = useCallback((id) => {
    const picked = twinScenario(id);
    tourRef.current?.abort();
    setPlaying(false);
    setSelectedId(null);
    setScenarioId(picked ? picked.id : null);
    if (picked) setCity("jakarta");
    setRainfall(picked ? picked.rain : 0);
    setEventPreset(picked ? picked.event : "none");
    if (picked?.venue) setVenueId(picked.venue);
    // A briefing scenario is about today, the day the canonical baseline describes.
    setDay(0);
    setScenarioDay(0);
  }, []);
  // Rencana's handoff contract: the scenario id plus the inputs it ran on, so the
  // plan recomputes the same day (venue only with a crowd, lanes only when closed).
  const applyToPlan = useCallback(
    (id, date) => {
      const picked = twinScenario(id);
      if (!picked) return;
      const attendance = EVENT_PRESETS.find((p) => p.id === picked.event)?.attendance || 0;
      const params = new URLSearchParams({ scenario: id, rain_mm: String(picked.rain) });
      params.set("attendance", String(attendance));
      if (attendance && picked.venue) params.set("venue", picked.venue);
      if (picked.lanes) params.set("lanes", String(picked.lanes));
      params.set("date", date);
      navigate(`/planning?${params}`);
    },
    [navigate],
  );

  // ---- Ask Pythia: apply the scenario Ana ran, in place ----------------------
  const applyScenario = useCallback(
    (result) => {
      const asked = result.scenario || {};
      const nextCity = CITIES.includes(result.city) ? result.city : city;
      const attendance = asked.event_attendance || 0;
      const nextPreset =
        EVENT_PRESETS.find((p) => p.attendance === attendance) ||
        EVENT_PRESETS.reduce((best, p) =>
          Math.abs(p.attendance - attendance) < Math.abs(best.attendance - attendance) ? p : best,
        );
      const cityVenues = TWIN_VENUES[nextCity];
      const nextVenue = cityVenues.some((v) => v.id === asked.venue_id)
        ? asked.venue_id
        : nextCity === city
          ? venueId
          : cityVenues[0].id;
      const rain = Math.round((Number(asked.rainfall_mm) || 0) / RAIN_STEP_MM) * RAIN_STEP_MM;
      tourRef.current?.abort();
      setPlaying(false);
      setSelectedId(null);
      setScenarioId(null);
      setCity(nextCity);
      setRainfall(Math.max(0, Math.min(RAIN_MAX_MM, rain)));
      setEventPreset(nextPreset.id);
      setVenueId(nextVenue);
      const askedDay = Math.max(0, Math.min(TWIN_DAYS - 1, Number(asked.day) || 0));
      setDay(askedDay);
      setScenarioDay(askedDay);
    },
    [city, venueId],
  );

  // ---- tour -----------------------------------------------------------------
  const stopTour = useCallback(() => {
    tourRef.current?.abort();
  }, []);

  const startTour = useCallback(() => {
    const map = mapRef.current;
    if (!map || !scene) return false;
    tourRef.current?.abort();
    const controller = new AbortController();
    tourRef.current = controller;
    setPlaying(false);
    const steps = buildTour(scene, safeDay, map);
    setTour({ index: 0, total: steps.length, step: steps[0] });
    runTour(map, steps, {
      reducedMotion,
      signal: controller.signal,
      onStep: (step, index) => {
        setTour({ index, total: steps.length, step });
        if (step.districtId) setSelectedId(step.districtId);
      },
    }).finally(() => {
      if (tourRef.current === controller) {
        tourRef.current = null;
        setTour(null);
      }
    });
    return true;
  }, [scene, safeDay, reducedMotion]);

  // A tour is scripted for one city; switching city ends it.
  useEffect(() => {
    tourRef.current?.abort();
  }, [city]);

  useEffect(() => {
    if (!tour) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") stopTour();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tour, stopTour]);

  // ---- test / recording hook -----------------------------------------------
  useEffect(() => {
    window.__pythiaTwin = {
      ready,
      city: scene?.city?.id ?? null,
      districtCount: scene?.districts?.length ?? 0,
      selectedDay: safeDay,
      selectedDate: summary.date,
      scenario: scene?.scenario ?? null,
      venue: venue.id,
      districtsAtRisk: summary.atRisk,
      dailyAtRisk: weekRisk.map((entry) => entry.count),
      totalTons: summary.tons,
      landfillLabel,
      outlinedDistricts: prepared?.outlined.length ?? 0,
      rainDrops: prepared?.rain.length ?? 0,
      // Haul arcs drawn (named + one bundle) and how many districts the bundle carries.
      flowArcs: view?.flowData.length ?? 0,
      flowBundled: view?.flowData.find((f) => f.bundle)?.count ?? 0,
      labelledDistricts: view?.labelled.map(({ d }) => d.id) ?? [],
      venuePin: view?.event ? { ...view.event } : null,
      tourActive: Boolean(tour),
      /** Props of a drawn layer by id, or null: what the GPU is actually told to draw. */
      inspectLayer: (id) => {
        const layer = layersRef.current.find((candidate) => candidate.id === id);
        if (!layer) return null;
        const { data, wireframe, extruded, parameters } = layer.props;
        return {
          count: Array.isArray(data) ? data.length : null,
          wireframe: Boolean(wireframe),
          extruded: Boolean(extruded),
          depthCompare: parameters?.depthCompare ?? null,
        };
      },
      startTour,
      stopTour,
      setDay,
      setCity,
      setRainfall,
      setEventPreset,
      setVenue: setVenueId,
    };
  }, [
    ready,
    scene,
    prepared,
    view,
    safeDay,
    summary,
    weekRisk,
    tour,
    startTour,
    stopTour,
    landfillLabel,
    venue.id,
  ]);
  useEffect(
    () => () => {
      delete window.__pythiaTwin;
    },
    [],
  );

  // ---- derived copy ---------------------------------------------------------
  const truckCapacity = /([\d.]+)\s*t/.exec(scene?.units?.trucks_required || "")?.[1];
  // Trucks required (tonnes / capacity per shift) and the queue model's gate
  // trips per day are different counts: say how they relate, and where the
  // trip count comes from (the real median when unscaled, else scaled from it).
  const gateTrips = queueMetric?.trucks_per_day;
  const trucksHelper =
    Number.isFinite(gateTrips) && summary.trucks > 0
      ? t("twr_trucks_helper_trips")
          .replace("{n}", truckCapacity)
          .replace("{trips}", number.format(gateTrips))
          .replace("{per}", minutesNumber.format(gateTrips / summary.trucks))
          .replace(
            "{basis}",
            t(queueMetric.scenario_scaled ? "twr_trips_basis_scaled" : "twr_trips_basis_median"),
          )
      : t("twin_metric_trucks_helper").replace("{n}", truckCapacity);
  // The week's busiest day by at-risk count (first one on a tie).
  const weekPeakRisk = weekRisk.reduce(
    (best, entry, day) => (!best || entry.count > best.count ? { ...entry, day } : best),
    null,
  );
  // Data honesty: on the what-if's own day the strip shows scenario values, so every
  // tile says "Scenario: <name>" with its change against today (the briefing's
  // canonical baseline) or, for a hand-made what-if, against the normal day. The
  // caption never calls a scenario value a forecast.
  const kpiWhatIf = scene?.scenario?.rainfall_mm > 0 || scene?.scenario?.event_attendance > 0;
  const kpiScenario = Boolean(scene) && kpiWhatIf && whatIfDay(scene.scenario) === safeDay;
  const kpiName = scenarioId ? t(`dr_scn_${scenarioId}`) : t("dr_kpi_custom");
  const kpiBase =
    kpiScenario && scenarioId && safeDay === 0 && briefingBody?.scenario?.id === scenarioId
      ? briefingBody.before
      : null;
  const signedPercent = (value, base) =>
    Number.isFinite(value) && Number.isFinite(base) && base > 0
      ? `${value >= base ? "+" : "−"}${minutesNumber.format(Math.abs(((value - base) / base) * 100))}%`
      : null;
  const signedCount = (value, base) =>
    Number.isFinite(value) && Number.isFinite(base)
      ? `${value >= base ? "+" : "−"}${number.format(Math.abs(value - base))}`
      : null;
  const vsToday = (delta, base) =>
    delta ? t("dr_kpi_vs_today").replace("{delta}", delta).replace("{n}", base) : null;
  const normalTons = kpiScenario
    ? (scene.districts || []).reduce((sum, d) => sum + (dayRow(d, safeDay).normal_tons || 0), 0)
    : null;
  const scenarioHelper = (...parts) =>
    [t("dr_kpi_scenario").replace("{name}", kpiName), ...parts].filter(Boolean).join(" · ");
  const peakIsScenario = kpiWhatIf && scene?.summary?.peak_date === summary.date && kpiScenario;
  // wave11 twin: every number in the strip carries the scene's class as its bare label.
  const metricClass = scene?.provenance?.districts?.class;
  const metricSource =
    scene && metricClass ? { source: classLabel(metricClass), sourceKind: provKind(metricClass) } : {};
  const metrics = [
    {
      ...metricSource,
      label: t("twin_metric_total"),
      value: scene ? `${number.format(summary.tons)} t` : "—",
      helper: kpiScenario
        ? scenarioHelper(
            t("dr_kpi_not_forecast").replace("{date}", formatDate(summary.date)),
            kpiBase
              ? vsToday(
                  signedPercent(summary.tons, kpiBase.total_tonnage_t),
                  `${number.format(kpiBase.total_tonnage_t)} t`,
                )
              : normalTons > 0
                ? t("dr_kpi_vs_normal")
                    .replace("{delta}", signedPercent(summary.tons, normalTons))
                    .replace("{n}", `${number.format(normalTons)} t`)
                : null,
          )
        : t("twin_metric_total_helper").replace("{date}", formatDate(summary.date)),
    },
    {
      ...metricSource,
      label: t("twin_metric_peak"),
      value: scene ? formatDate(scene.summary.peak_date) : "—",
      helper: scene
        ? [
            t("twin_metric_peak_helper").replace("{n}", number.format(scene.summary.peak_total_tons)),
            peakIsScenario ? t("dr_kpi_peak_scenario") : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "",
    },
    {
      ...metricSource,
      label: t("twin_metric_risk"),
      value: scene ? number.format(summary.atRisk) : "—",
      helper: kpiScenario
        ? scenarioHelper(
            kpiBase
              ? vsToday(signedCount(summary.atRisk, kpiBase.kecamatan_at_risk), kpiBase.kecamatan_at_risk)
              : t("twin_metric_risk_helper").replace("{n}", number.format(scene?.districts?.length ?? 0)),
          )
        : [
            t("twin_metric_risk_helper").replace("{n}", number.format(scene?.districts?.length ?? 0)),
            weekPeakRisk && weekPeakRisk.count > summary.atRisk
              ? t("ufx_twin_risk_week_peak")
                  .replace("{n}", number.format(weekPeakRisk.count))
                  .replace("{date}", formatDate(scene?.horizon?.dates?.[weekPeakRisk.day]))
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
      tone: summary.atRisk > 0 ? "danger" : undefined,
    },
    {
      ...metricSource,
      label: t("twin_metric_trucks"),
      value: scene ? number.format(summary.trucks) : "—",
      helper: kpiScenario
        ? scenarioHelper(
            kpiBase
              ? vsToday(
                  signedCount(summary.trucks, kpiBase.trucks_needed),
                  number.format(kpiBase.trucks_needed),
                )
              : truckCapacity
                ? trucksHelper
                : null,
          )
        : truckCapacity
          ? trucksHelper
          : "",
    },
  ];

  const hovered = hover && scene?.districts.find((d) => d.id === hover.id);
  const selected = selectedId && scene?.districts.find((d) => d.id === selectedId);
  const isDemoCity = scene?.city?.data_class === "SIMULATED_DEMO_CITY";
  const provenance = scene ? Object.entries(scene.provenance || {}) : [];
  const provenanceClasses = [...new Set(provenance.map(([, info]) => String(info.class)))];
  const generatedAt = scene?.generated_at
    ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
        new Date(scene.generated_at),
      )
    : null;
  const riskList = useMemo(() => rankDistricts(scene, safeDay).slice(0, RISK_LIST_SIZE), [scene, safeDay]);
  const formatDelta = (delta) => `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}%`;
  // The XR tabletop opens on the same scenario the twin shows.
  const xrHref = (() => {
    const params = new URLSearchParams({ city });
    if (scenarioId) params.set("scenario", scenarioId);
    if (rainfall > 0) params.set("rainfall_mm", String(rainfall));
    if (preset.attendance > 0) {
      params.set("event_attendance", String(preset.attendance));
      params.set("event_lat", String(venue.lat));
      params.set("event_lng", String(venue.lng));
    }
    // The tabletop opens on the twin's selected day, and the what-if on its own day.
    if (safeDay > 0) params.set("day", String(safeDay));
    if (whatIf && scenarioDay !== safeDay) params.set("scenario_day", String(scenarioDay));
    return `/xr?${params}`;
  })();
  // Data honesty: the selected day's rain says where it comes from (scene.weather):
  // the what-if, the Open-Meteo forecast (a forecast, never observed weather), or
  // assumed dry because no forecast was available. [chip copy, map label copy].
  const weather = scene?.weather;
  const weatherDay = weather?.days?.[safeDay] || null;
  const weatherRain = Number(weatherDay?.rainfall_mm) || 0;
  const [rainHudKey, rainLabelKey] = !weatherDay
    ? [rainfall > 0 ? "twin_hud_rain" : "twin_hud_no_rain", null]
    : weatherDay.input === "scenario"
      ? ["twin_hud_rain", "twin_rain_label"]
      : weatherDay.input === "forecast"
        ? weatherRain > 0
          ? ["twin_hud_rain_forecast", "twin_rain_forecast_label"]
          : ["twin_hud_rain_forecast_dry", "twin_rain_forecast_dry_label"]
        : weather.class === "UNAVAILABLE"
          ? weather.source === "not_applicable"
            ? ["twin_hud_rain_assumed_dry", "twin_rain_demo_city_label"]
            : ["twin_hud_rain_unavailable", "twin_rain_unavailable_label"]
          : ["twin_hud_no_rain", null];
  const rainMm = number.format(weatherDay ? weatherRain : rainfall);
  const dayText = (index) =>
    index === 0 ? t("twin_today") : t("twin_hud_day").replace("{n}", number.format(index));
  // A dry day still carries the previous days' forecast rain in its 3-day sum.
  const carriedMm = carriedRainMm(weather, safeDay);
  const carryText =
    carriedMm === null ? null : t("ufx_twin_rain_carry").replace("{n}", number.format(carriedMm));
  // Rain beyond the training range: the effect is held at the training maximum.
  const heldText = rainHeldText(t, weather, safeDay, minutesNumber.format);
  const rainResponse = rainResponseText(t, weather, minutesNumber.format);
  const rainLabel =
    [rainLabelKey ? t(rainLabelKey).replace("{n}", rainMm) : null, heldText, carryText]
      .filter(Boolean)
      .join(" · ") || null;
  // The what-if sits on its own day; say so when the timeline shows another one.
  const sceneScenario = scene?.scenario;
  const sceneWhatIfDay = whatIfDay(sceneScenario);
  const whatIfElsewhere =
    Boolean(sceneScenario?.rainfall_mm > 0 || sceneScenario?.event_attendance > 0) &&
    sceneWhatIfDay !== safeDay;
  // Presentation HUD: the scenario (cause) next to the queue headline (effect).
  const rainHud = t(rainHudKey).replace("{n}", rainMm);
  const scenarioTail = [
    carryText,
    preset.attendance
      ? t("twin_hud_event")
          .replace("{n}", compactNumber.format(preset.attendance))
          .replace("{venue}", venue.name)
      : t("twin_hud_no_event"),
    dayText(safeDay),
    whatIfElsewhere ? t("twin_hud_whatif_day").replace("{day}", dayText(sceneWhatIfDay)) : null,
  ];
  const scenarioText = [rainHud, heldText, ...scenarioTail].filter(Boolean).join(" · ");
  // The present chip stays one short line: a held rain effect is marked there and
  // spelled out in full on the map's rain label (and the chip's title / screen-reader text).
  const scenarioChipText = [heldText ? t("w8_twin_hud_rain_held").replace("{rain}", rainHud) : rainHud]
    .concat(scenarioTail)
    .filter(Boolean)
    .join(" · ");
  // When the backend scaled the queue to the scenario/day, the normal day sits next to it.
  const normalDay = queueMetric?.normal_day;
  const queueScaled =
    queueMetric?.scenario_scaled === true &&
    Number.isFinite(normalDay?.baseline_mean) &&
    Number.isFinite(normalDay?.staggered_mean);
  // The unstaggered figure's band is a sensitivity range over assumed departure
  // spreads (the same simulated day re-run per spread), not a confidence interval.
  const baselineBand = queueMetric?.sensitivity?.baseline_band;
  const spreads = (queueMetric?.assumptions?.sensitivity_departure_sd_minutes || []).filter(Number.isFinite);
  const bandText =
    Array.isArray(baselineBand) && baselineBand.length === 2 && baselineBand.every(Number.isFinite)
      ? ` ${t(spreads.length >= 2 ? "twr_queue_band" : "twr_queue_band_generic")
          .replace("{low}", minutesNumber.format(baselineBand[0]))
          .replace("{high}", minutesNumber.format(baselineBand[1]))
          .replace("{min}", number.format(Math.min(...spreads)))
          .replace("{max}", number.format(Math.max(...spreads)))}`
      : "";
  const queueMetricText = queueMetricOk
    ? t(queueScaled ? "twr_hud_queue_scenario" : "twr_hud_queue")
        .replace("{from}", minutesNumber.format(queueMetric.baseline_mean))
        .replace("{band}", bandText)
        .replace("{to}", minutesNumber.format(queueMetric.staggered_mean))
        .replace("{normal_from}", queueScaled ? minutesNumber.format(normalDay.baseline_mean) : "")
        .replace("{normal_to}", queueScaled ? minutesNumber.format(normalDay.staggered_mean) : "")
        .replace("{class}", classLabel(queueMetric.classification || queueClass || "SIMULATED"))
    : null;
  const totals = scene?.horizon?.daily_total_tons || [];
  const maxTotal = Math.max(1, ...totals);
  const minTotal = Math.min(...totals, maxTotal);

  function onTimelineKey(event) {
    if (
      event.key !== "ArrowRight" &&
      event.key !== "ArrowLeft" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? dayCount - 1
          : (safeDay + (event.key === "ArrowRight" ? 1 : -1) + dayCount) % dayCount;
    setDay(next);
    dayButtonsRef.current[next]?.focus();
  }

  const districtFacts = (district) => {
    const row = dayRow(district, safeDay);
    const delta = deltaPercent(row);
    return [
      [t("twin_tt_tons"), `${number.format(row.predicted_tons)} t`],
      [t("twin_tt_normal"), `${number.format(row.normal_tons)} t`],
      [t("twin_tt_delta"), formatDelta(delta)],
      [
        t("twin_tt_risk"),
        <span className={`twin-risk-tag risk-${row.risk}`} key="risk">
          <i aria-hidden="true" />
          {t(`twin_risk_${row.risk}`)}
        </span>,
      ],
      [t("twin_tt_trucks"), number.format(row.trucks_required)],
      [t("twin_tt_source"), classLabel(scene.provenance?.districts?.class)],
    ];
  };

  // Scenario controls: under Ask Pythia in the side column, a sheet on phones.
  const controlPanel = (
    <aside
      className={`twin-panel${sheetOpen ? " is-open" : ""}`}
      aria-label={t("twin_panel_label")}
      data-testid="twin-panel"
    >
      <button
        type="button"
        className="twin-sheet-toggle"
        data-testid="twin-sheet-toggle"
        aria-expanded={sheetOpen}
        aria-controls="twin-panel-body"
        onClick={() => setSheetOpen((open) => !open)}
      >
        <span>{t("twin_panel_toggle")}</span>
        <small>{`${number.format(rainfall)} mm · ${preset.attendance ? number.format(preset.attendance) : t("twin_event_none")}`}</small>
        {sheetOpen ? (
          <ChevronDown size={18} aria-hidden="true" />
        ) : (
          <ChevronUp size={18} aria-hidden="true" />
        )}
      </button>

      <div className="twin-panel-body" id="twin-panel-body" hidden={!desktop && !sheetOpen}>
        <section className="twin-panel-section" aria-labelledby="twin-city-label">
          <h2 id="twin-city-label" className="twin-panel-title">
            {t("twin_city_label")}
          </h2>
          <div className="twin-choice twin-segmented" role="group" aria-labelledby="twin-city-label">
            {CITIES.map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`twin-city-${id}`}
                aria-pressed={city === id}
                onClick={() => {
                  setScenarioId(null);
                  setCity(id);
                  setVenueId(TWIN_VENUES[id][0].id);
                  setScenarioDay(day);
                  setSelectedId(null);
                }}
              >
                {t(`twin_city_${id}`)}
              </button>
            ))}
          </div>
        </section>

        <section className="twin-panel-section" aria-labelledby="twin-scenario-title">
          <h2 id="twin-scenario-title" className="twin-panel-title">
            {t("twin_scenario_title")}
          </h2>
          <label className="twin-slider" htmlFor="twin-rainfall">
            <span>
              <CloudRain size={15} aria-hidden="true" /> {t("twin_rainfall")}
            </span>
            <output htmlFor="twin-rainfall" data-testid="twin-rainfall-value">
              {number.format(rainfall)} mm
            </output>
          </label>
          <input
            id="twin-rainfall"
            data-testid="twin-rainfall"
            type="range"
            min="0"
            max="150"
            step="5"
            value={rainfall}
            aria-valuetext={`${rainfall} mm`}
            onChange={(e) => {
              setScenarioId(null);
              setRainfall(Number(e.target.value));
              setScenarioDay(day);
            }}
          />
          <span className="twin-field-label" id="twin-event-label">
            <Users size={15} aria-hidden="true" /> {t("twin_event")}
          </span>
          <div className="twin-choice" role="group" aria-labelledby="twin-event-label">
            {EVENT_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                data-testid={`twin-event-${p.id}`}
                aria-pressed={eventPreset === p.id}
                onClick={() => {
                  setScenarioId(null);
                  setEventPreset(p.id);
                  setScenarioDay(day);
                }}
              >
                {p.attendance
                  ? t("twin_event_preset")
                      .replace("{n}", number.format(p.attendance))
                      .replace("{venue}", venue.name)
                  : t("twin_event_none")}
              </button>
            ))}
          </div>
          <span className="twin-field-label" id="twin-venue-label">
            <MapPin size={15} aria-hidden="true" /> {t("twin_venue")}
          </span>
          <div
            className="twin-choice"
            role="group"
            aria-labelledby="twin-venue-label"
            data-testid="twin-venues"
          >
            {venues.map((v) => (
              <button
                key={v.id}
                type="button"
                data-testid={`twin-venue-${v.id}`}
                aria-pressed={venue.id === v.id}
                onClick={() => {
                  setScenarioId(null);
                  setVenueId(v.id);
                  setScenarioDay(day);
                }}
              >
                {v.name}
              </button>
            ))}
          </div>
          {/* T3: the controls first, how the model forms the effect one tap away. */}
          <details className="twin-method" data-testid="twin-method">
            <summary>{t("dr_method")}</summary>
            {rainResponse && (
              <p className="twin-note" data-testid="twin-rain-response">
                {rainResponse}
              </p>
            )}
            <p className="twin-note">{t("twin_scenario_note")}</p>
          </details>
        </section>

        <section className="twin-panel-section twin-actions">
          <button
            type="button"
            className="twin-btn quiet"
            data-testid="twin-tour"
            onClick={tour ? stopTour : startTour}
            disabled={!ready && !tour}
          >
            {tour ? <Square size={16} aria-hidden="true" /> : <Clapperboard size={16} aria-hidden="true" />}
            {tour ? t("twin_tour_stop") : t("twin_tour")}
          </button>
          <a className="twin-btn secondary" data-testid="twin-xr-link" href={xrHref}>
            <Glasses size={16} aria-hidden="true" /> {t("twin_xr")}
          </a>
        </section>

        <section className="twin-panel-section" aria-labelledby="twin-risk-list-title">
          <h2 id="twin-risk-list-title" className="twin-panel-title">
            {t("twin_risk_list_title")}
          </h2>
          <ul className="twin-risk-list" data-testid="twin-risk-list">
            {riskList.map(({ district, row, delta }) => (
              <li key={district.id}>
                <button
                  type="button"
                  data-testid={`twin-risk-item-${district.id}`}
                  aria-pressed={selectedId === district.id}
                  onClick={() => setSelectedId(district.id)}
                >
                  <span className="twin-risk-name">{district.name}</span>
                  <span className="twin-risk-delta">{formatDelta(delta)}</span>
                  <span className={`twin-risk-tag risk-${row.risk}`}>
                    <i aria-hidden="true" />
                    {t(`twin_risk_${row.risk}`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="twin-panel-section" aria-labelledby="twin-detail-title" data-testid="twin-detail">
          <h2 id="twin-detail-title" className="twin-panel-title">
            {t("twin_selected_title")}
          </h2>
          {selected ? (
            <div className="twin-detail">
              <div className="twin-detail-head">
                <strong>{selected.name}</strong>
                {selected.admin_area && <small>{selected.admin_area}</small>}
              </div>
              <dl>
                {districtFacts(selected).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="twin-detail-series" aria-hidden="true">
                {selected.series.map((row, index) => {
                  const max = Math.max(...selected.series.map((r) => r.predicted_tons));
                  return (
                    <span
                      key={row.date}
                      className={`risk-${row.risk}${index === safeDay ? " is-current" : ""}`}
                    >
                      <i style={{ height: `${Math.max(12, (row.predicted_tons / max) * 100)}%` }} />
                    </span>
                  );
                })}
              </div>
              {selected.event_localized && <p className="twin-note">{t("twin_tt_event")}</p>}
            </div>
          ) : (
            <p className="twin-note">{t("twin_selected_hint")}</p>
          )}
        </section>
      </div>
    </aside>
  );

  const status = !scene && loading ? "loading" : error ? "error" : loading ? "refreshing" : null;
  // The what-if rain the overlay draws: the scene's, on its own day only.
  const sceneRain = sceneWhatIfDay === safeDay ? sceneScenario?.rainfall_mm || 0 : 0;

  return (
    <section
      className={`twin-workspace workspace-page ui-bleed-page${PRESENT ? " is-present" : ""}${askOpen ? " has-ask" : ""}`}
      data-testid="twin-workspace"
      aria-labelledby="twin-title"
    >
      {/* wave11 twin: the title sits in the strip's band, above the decision rail. */}
      <header className="twin-heading">
        <h1 id="twin-title">{t("twin_title")}</h1>
        <p className="sr-only">{t("twin_sub")}</p>
        {generatedAt && (
          <p className="twin-freshness" data-testid="twin-freshness">
            <span>{t("twin_generated").replace("{time}", generatedAt)}</span>
            <Provenance kind={provKind(scene.provenance?.districts?.class)}>
              {classLabel(scene.provenance?.districts?.class)}
            </Provenance>
          </p>
        )}
      </header>

      <MetricStrip metrics={metrics} bleed label={t("twin_title")} />

      <div className="twin-deck" data-testid="twin-deck">
        {isDemoCity && (
          <div className="twin-demo-banner" role="note" data-testid="twin-demo-banner">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <strong>{t("twin_demo_banner_title")}</strong>
              <span>{t("twin_demo_banner_body")}</span>
            </div>
          </div>
        )}

        <div className="twin-stage">
          {(askOpen || !PRESENT) && (
            // wave11 twin: one decision room beside the map. Ask Pythia leads, the
            // scenario briefing (numbers, approve, the table) follows, then the
            // what-if controls.
            <div className="twin-side" data-testid="twin-side">
              {askOpen && (
                <TwinAskRail
                  onApply={applyScenario}
                  appliedText={scenarioText}
                  queueText={queueMetricText}
                  collapsible={PRESENT}
                  onCollapse={() => setAskOpen(false)}
                />
              )}
              {/* The briefing compares against Jakarta's baseline; the demo city has none. */}
              {!PRESENT && city === "jakarta" && (
                <ScenarioBriefing
                  scenarioId={scenarioId}
                  onSelect={chooseScenario}
                  onApply={applyToPlan}
                  onOpenTable={openTable}
                  onBody={setBriefingBody}
                />
              )}
              {!PRESENT && controlPanel}
            </div>
          )}
          <div className={`twin-viewport${sceneRain > 0 ? " is-raining" : ""}`}>
            <div
              ref={containerRef}
              className="twin-map"
              data-testid="twin-map"
              data-city-base={
                !USE_STREETS || basemapOffline ? "offline" : satelliteOn ? "satellite" : "streets"
              }
              role="region"
              aria-label={t("twin_map_label").replace("{city}", scene?.city?.name || "")}
            />

            {rainLabel && (
              <p
                className="twin-rain-label"
                data-testid="twin-rain-label"
                data-input={weatherDay?.input || ""}
                data-carried-mm={carriedMm === null ? undefined : String(carriedMm)}
                title={weather?.label || undefined}
              >
                <CloudRain size={14} aria-hidden="true" />
                {rainLabel}
              </p>
            )}

            {view && mapReady && (
              // Names on the map, always above the blocks: placed (or hidden on
              // collision) by placeLabels, venue first, then the risk ranking.
              <div className="twin-labels" ref={labelsRef} aria-hidden="true" data-testid="twin-labels">
                {view.event && (
                  <span
                    className="twin-label is-venue"
                    data-testid="twin-venue-label"
                    data-lng={view.event.lng}
                    data-lat={view.event.lat}
                    data-z={VENUE_PIN_HEIGHT_M}
                  >
                    <MapPin size={13} aria-hidden="true" />
                    <span>{view.event.name || t("twr_venue_unnamed")}</span>
                    {view.event.radiusM && (
                      <small>
                        {t("twr_venue_radius")
                          .replace("{km}", minutesNumber.format(view.event.radiusM / 1000))
                          .replace("{n}", number.format(view.event.reached ?? 0))}
                      </small>
                    )}
                  </span>
                )}
                {view.labelled.map(({ d, row, z, selected: isSelected }) => (
                  <span
                    key={d.id}
                    className={`twin-label risk-${row.risk}${isSelected ? " is-selected" : ""}`}
                    data-testid="twin-label"
                    data-district={d.id}
                    data-lng={d.lng}
                    data-lat={d.lat}
                    data-z={z}
                  >
                    <i aria-hidden="true" />
                    <span>{d.name}</span>
                    <b>{number.format(row.predicted_tons)} t</b>
                  </span>
                ))}
              </div>
            )}

            {landfillLabel && (
              // T2: the beacon's queue detail opens on tap only; folded, it keeps the
              // landfill's name and the queue's class (Simulated).
              <button
                type="button"
                ref={landfillTagRef}
                className={`twin-landfill-tag${landfillOpen ? " is-open" : ""}`}
                data-testid="twin-landfill-tag"
                aria-expanded={landfillOpen}
                aria-label={t("dr_tpa_toggle").replace("{name}", landfillName)}
                onClick={() => setLandfillOpen((open) => !open)}
              >
                {/* wave11 twin: folded, the card reads like the comp: the queue before → after. */}
                {!landfillOpen && queueMetricOk && (
                  <span className="is-metric" data-testid="twin-landfill-metric">
                    <small>{t("w11twin_queue_card")}</small>
                    <span>
                      <i>{minutesNumber.format(queueMetric.baseline_mean)}</i>
                      <ArrowRight size={14} aria-hidden="true" />
                      <b>{minutesNumber.format(queueMetric.staggered_mean)}</b>
                    </span>
                    <em>{t("w11twin_queue_card_pair")}</em>
                  </span>
                )}
                {(landfillOpen
                  ? landfillLines
                  : landfillLines.filter((line, i) => i === 0 || line === queueClassText)
                ).map((line, index) => (
                  <span
                    key={line}
                    className={
                      index === 0
                        ? "is-name"
                        : line === queuePeakLine
                          ? "is-hour"
                          : line === staggeredPeakLine || line === queueDayLine
                            ? "is-staggered"
                            : line === queueClassText || line === queueBasisLine
                              ? "is-class"
                              : undefined
                    }
                  >
                    {line}
                  </span>
                ))}
              </button>
            )}

            {satelliteOn && (
              <p className="twin-imagery-credit" data-testid="twin-imagery-credit">
                <strong>{t("twin_base_imagery_note")}</strong> {t("twin_base_imagery")}: {IMAGERY_CREDIT} ·{" "}
                {t("twin_base_relief")}: {RELIEF_CREDIT}
              </p>
            )}

            {PRESENT && scene && (
              <div className="twin-present-hud" aria-hidden="true">
                <strong>{scene.city.name}</strong>
                <span>{formatDate(summary.date)}</span>
                <span>{number.format(summary.tons)} t</span>
                <span>{t("twin_present_risk").replace("{n}", number.format(summary.atRisk))}</span>
                {queueHourLine && <span data-testid="twin-present-queue-hour">{queueHourLine}</span>}
                {queueClassText && <span data-testid="twin-present-queue">{queueClassText}</span>}
              </div>
            )}

            {PRESENT && scene && (
              <div
                className="twin-present-scenario"
                role="note"
                aria-label={t("twin_hud_scenario_label")}
                data-testid="twin-scenario-chip"
              >
                <span data-testid="twin-scenario-text" title={heldText || undefined}>
                  {scenarioChipText}
                </span>
                {heldText && (
                  <span className="sr-only" data-testid="twin-scenario-held">
                    {heldText}
                  </span>
                )}
                {queueMetricText && (
                  <strong data-testid="twin-present-queue-metric" title={queueMetric.source || undefined}>
                    {queueMetricText}
                  </strong>
                )}
              </div>
            )}

            {status && (
              <div
                className={`twin-status twin-status-${status}`}
                role={status === "error" ? "alert" : "status"}
                data-testid="twin-status"
              >
                {status === "error" ? (
                  <AlertTriangle size={15} aria-hidden="true" />
                ) : (
                  <RefreshCw size={15} aria-hidden="true" className="twin-spin" />
                )}
                <span>
                  {status === "error"
                    ? t("twin_error")
                    : status === "loading"
                      ? t("twin_loading")
                      : t("twin_refreshing")}
                </span>
                {status === "error" && (
                  <button type="button" onClick={retry}>
                    {t("twin_retry")}
                  </button>
                )}
              </div>
            )}

            {hovered && !tour && (
              <div
                ref={tooltipRef}
                className="twin-tooltip"
                data-testid="twin-tooltip"
                style={{
                  transform: `translate(${Math.round(hover.x + 14)}px, ${Math.round(hover.y + 14)}px)`,
                }}
              >
                <strong>{hovered.name}</strong>
                {hovered.admin_area && <small>{hovered.admin_area}</small>}
                <dl>
                  {districtFacts(hovered).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                {hovered.event_localized && <em>{t("twin_tt_event")}</em>}
              </div>
            )}

            {tour && (
              <div
                className="twin-tour-caption"
                role="status"
                aria-live="polite"
                data-testid="twin-tour-caption"
              >
                <span>
                  {tour.index + 1} / {tour.total}
                </span>
                <strong>
                  {t(tour.step.key === "venue" ? "twr_tour_venue" : `twin_tour_${tour.step.key}`).replace(
                    "{name}",
                    tour.step.name || (tour.step.key === "venue" ? t("twr_venue_unnamed") : ""),
                  )}
                </strong>
                <button type="button" onClick={stopTour}>
                  <Square size={14} aria-hidden="true" /> {t("twin_tour_stop")}
                </button>
              </div>
            )}
          </div>

          <div className="twin-legend" data-testid="twin-legend">
            <div className="twin-legend-bar">
              <div
                className="twin-legend-risk"
                aria-label={t("twin_risk_legend")}
                title={t("twin_risk_legend")}
                role="group"
              >
                {RISK_ORDER.map((risk) => (
                  <span key={risk} className={`twin-risk-tag risk-${risk}`}>
                    <i aria-hidden="true" />
                    {t(`twin_risk_${risk}`)}
                  </span>
                ))}
              </div>
              {basemapOffline && <small className="twin-legend-note">{t("twin_offline_basemap")}</small>}
            </div>
            {/* wave11 twin: the layers' provenance is the map's mono footer chip. */}
            <div className="twin-provenance-bar">
              {provenance.length > 0 && (
                <button
                  type="button"
                  className="twin-provenance-toggle"
                  data-testid="twin-provenance-toggle"
                  aria-expanded={provenanceOpen}
                  aria-controls="twin-provenance-list"
                  title={t("twin_layers_title")}
                  onClick={() => setProvenanceOpen((open) => !open)}
                >
                  <span className="twin-provenance-summary">
                    {provenanceClasses.map((value) => (
                      <b key={value} className={`class-${value.toLowerCase()}`}>
                        {classLabel(value)}
                      </b>
                    ))}
                  </span>
                  <small>
                    {t("twin_provenance_layers").replace("{n}", number.format(provenance.length))}
                  </small>
                  <ChevronDown size={16} aria-hidden="true" className="twin-provenance-chevron" />
                </button>
              )}
              <ul
                id="twin-provenance-list"
                className="twin-provenance"
                data-testid="twin-provenance"
                aria-label={t("twin_layers_title")}
                hidden={!provenanceOpen}
              >
                {provenance.map(([layer, info]) => (
                  <li
                    key={layer}
                    className={`twin-chip class-${String(info.class).toLowerCase()}`}
                    title={info.source}
                    data-testid={`twin-provenance-${layer}`}
                  >
                    <span>{t(`twin_layer_${layer}`)}</span>
                    <b>{classLabel(info.class)}</b>
                  </li>
                ))}
              </ul>
            </div>
            <div className="twin-tools">
              {!askOpen && (
                <button
                  type="button"
                  className="twin-ask-toggle"
                  data-testid="twin-ask-toggle"
                  onClick={() => setAskOpen(true)}
                >
                  <Sparkles size={16} aria-hidden="true" /> {t("twin_ask_show")}
                </button>
              )}
              <button
                ref={tableTriggerRef}
                type="button"
                className="twin-table-toggle"
                data-testid="twin-table-open"
                aria-haspopup="dialog"
                aria-expanded={tableOpen}
                onClick={openTable}
              >
                <QrCode size={16} aria-hidden="true" />
                {table.code ? (
                  <span data-testid="twin-table-presence" data-count={table.participants}>
                    {tablePresenceText(t, table.participants, (n) => number.format(n))}
                  </span>
                ) : (
                  t("ho_open")
                )}
              </button>
              <button
                type="button"
                className="twin-base-toggle"
                data-testid="twin-base-toggle"
                aria-pressed={satelliteOn}
                disabled={!cityBaseAvailable}
                title={cityBaseAvailable ? t("twin_base_satellite_hint") : t("twin_base_needs_online")}
                onClick={() => setSatellite((on) => !on)}
              >
                <Satellite size={16} aria-hidden="true" />
                {t("twin_base_satellite")}
              </button>
              {cityBaseFailed && <small className="twin-legend-note">{t("twin_base_unavailable")}</small>}
            </div>
          </div>

          <div className="twin-timeline" data-testid="twin-timeline">
            <button
              type="button"
              className="twin-play"
              data-testid="twin-play"
              aria-pressed={playing}
              aria-label={playing ? t("twin_pause") : t("twin_play")}
              title={playing ? t("twin_pause") : t("twin_play")}
              onClick={() => setPlaying((p) => !p)}
              disabled={!scene}
            >
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <div
              className="twin-days"
              role="group"
              aria-label={t("twin_timeline_label")}
              onKeyDown={onTimelineKey}
            >
              {(scene?.horizon?.dates || []).map((date, index) => {
                const total = totals[index] || 0;
                const height = 22 + ((total - minTotal) / Math.max(1, maxTotal - minTotal)) * 78;
                const risk = weekRisk[index] || { count: 0, worst: "normal" };
                return (
                  <button
                    key={date}
                    type="button"
                    ref={(el) => {
                      dayButtonsRef.current[index] = el;
                    }}
                    className="twin-day"
                    data-testid={`twin-day-${index}`}
                    aria-pressed={index === safeDay}
                    data-at-risk={risk.count}
                    aria-label={[
                      formatDate(date),
                      `${number.format(total)} t`,
                      t("ufx_twin_day_at_risk").replace("{n}", number.format(risk.count)),
                    ].join(" · ")}
                    tabIndex={index === safeDay ? 0 : -1}
                    onClick={() => setDay(index)}
                  >
                    <span className="twin-day-bar" aria-hidden="true">
                      {risk.count > 0 && (
                        <b
                          className="twin-day-risk"
                          data-level={risk.worst}
                          data-testid={`twin-day-risk-${index}`}
                        >
                          {number.format(risk.count)}
                        </b>
                      )}
                      <i style={{ height: `${height}%` }} />
                    </span>
                    <span className="twin-day-label" aria-hidden="true">
                      {index === 0 ? t("twin_today") : formatDate(date, weekdayFormat)}
                      <small>{new Date(`${date}T00:00:00`).getDate()}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {tableOpen && (
        <Suspense fallback={null}>
          <TwinTableHandoff
            session={table}
            city={city}
            onClose={() => setTableOpen(false)}
            returnFocusRef={tableReturnRef}
          />
        </Suspense>
      )}
    </section>
  );
}
