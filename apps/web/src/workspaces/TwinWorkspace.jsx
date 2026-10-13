import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import {
  AlertTriangle,
  Box,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  CloudRain,
  Glasses,
  Pause,
  Play,
  RefreshCw,
  Square,
  Users,
} from "lucide-react";
import { MetricStrip } from "../ui/MetricStrip.jsx";
import { useLanguage } from "../i18n.jsx";
import {
  RISK_ORDER,
  TRUCK_PERIOD,
  buildTwinLayers,
  dayRow,
  daySummary,
  deltaPercent,
  prepareScene,
  prepareView,
} from "../twin/twinLayers.js";
import { buildTour, overviewCamera, runTour } from "../twin/tour.js";
import { TWIN_DAYS, useTwinScene } from "../twin/useTwinScene.js";
import "../styles/twin.css";

// Same determinism contract as LiveFleetMap: Playwright sets
// navigator.webdriver, so e2e gets an inline offline style and never waits on
// remote tiles. Presentation mode (?present=1, used for recorded footage) and
// ?basemap=streets opt back into the real 3D street basemap.
const IS_AUTOMATION = typeof navigator !== "undefined" && Boolean(navigator.webdriver);
const QUERY =
  typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
const PRESENT = QUERY.get("present") === "1";
const USE_STREETS = !IS_AUTOMATION || PRESENT || QUERY.get("basemap") === "streets";
const ANIMATE_UNDER_AUTOMATION = PRESENT || QUERY.get("motion") === "on";
const STREETS_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const OFFLINE_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "twin-offline-bg", type: "background", paint: { "background-color": "#e4e9e5" } }],
};
const CITIES = ["jakarta", "hcmc"];
const VENUES = {
  jakarta: { name: "GBK", lat: -6.2183, lng: 106.8022 },
  hcmc: { name: "District 1", lat: 10.7769, lng: 106.7009 },
};
const EVENT_PRESETS = [
  { id: "none", attendance: 0 },
  { id: "50k", attendance: 50000 },
  { id: "100k", attendance: 100000 },
];
const PLAY_STEP_MS = 1800;
// Keyboard path into the map: the panel lists this many districts by risk.
const RISK_LIST_SIZE = 5;
// Truck clock speed: one full ping-pong period every ~9 s.
const TRUCK_UNITS_PER_MS = TRUCK_PERIOD / 9000;
const DESKTOP_QUERY = "(min-width: 921px)";

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

function initialCity() {
  const city = QUERY.get("city");
  return CITIES.includes(city) ? city : "jakarta";
}

export function TwinWorkspace({ onCityChange }) {
  const { t } = useLanguage();
  const locale = t("twin_locale");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const animate = !reducedMotion && (!IS_AUTOMATION || ANIMATE_UNDER_AUTOMATION);

  const [city, setCity] = useState(initialCity);
  // The shell header names the city, so it must follow the twin's city switch.
  useEffect(() => {
    onCityChange?.(city);
  }, [city, onCityChange]);
  const [rainfall, setRainfall] = useState(0);
  const [eventPreset, setEventPreset] = useState("none");
  const [day, setDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [hover, setHover] = useState(null);
  const [tour, setTour] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [basemapOffline, setBasemapOffline] = useState(false);

  const preset = EVENT_PRESETS.find((p) => p.id === eventPreset) || EVENT_PRESETS[0];
  const venue = VENUES[city];
  const request = {
    city,
    rainfall,
    attendance: preset.attendance,
    eventLat: preset.attendance ? venue.lat : null,
    eventLng: preset.attendance ? venue.lng : null,
  };
  const { scene, loading, error, settled, retry } = useTwinScene(request);
  const prepared = useMemo(() => (scene ? prepareScene(scene) : null), [scene]);
  const dayCount = scene?.horizon?.dates?.length || TWIN_DAYS;
  const safeDay = Math.min(day, dayCount - 1);
  // Mark the event the scene was computed for, not the pending preset.
  const sceneEvent = useMemo(
    () =>
      scene?.scenario?.event_attendance && scene.scenario.event_lat != null
        ? { lat: scene.scenario.event_lat, lng: scene.scenario.event_lng }
        : null,
    [scene],
  );
  // Data arrays for the layers, rebuilt only when the view changes — never
  // per animation frame.
  const view = useMemo(
    () => (prepared ? prepareView(scene, prepared, safeDay, selectedId, sceneEvent) : null),
    [scene, prepared, safeDay, selectedId, sceneEvent],
  );
  const summary = useMemo(() => daySummary(scene, safeDay), [scene, safeDay]);
  const ready = mapReady && settled && scene?.city?.id === city;

  const number = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), [locale]);
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
        if (info.layer?.id === "twin-districts" && info.object)
          setHover({ x: info.x, y: info.y, id: info.object.id });
        else setHover(null);
      },
      onClick: (info) => {
        if (info.layer?.id === "twin-districts" && info.object) setSelectedId(info.object.id);
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
      setMapReady(true);
    });
    // Attribution stays one tap away (the "i" control) instead of opening
    // over the bottom of small map windows.
    const collapseAttribution = () =>
      map
        .getContainer()
        .querySelector(".maplibregl-ctrl-attrib")
        ?.classList.remove("maplibregl-compact-show");
    map.once("load", collapseAttribution);
    map.once("idle", collapseAttribution);

    return () => {
      clearTimeout(styleTimer);
      tourRef.current?.abort();
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Keep the city centred in the part of the stage the panel leaves visible.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const sidePanel = desktop && !PRESENT;
    // Leave room for the legend (top-left), timeline (bottom) and panel (right).
    map.setPadding({
      top: sidePanel ? 40 : 0,
      left: 0,
      right: sidePanel ? 368 : 0,
      bottom: sidePanel ? 92 : 0,
    });
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
  const landfillLabel = landfillName
    ? [
        landfillName,
        queue
          ? `${t("twin_queue_trucks").replace("{n}", number.format(queue.trucks_in_queue ?? 0))} · ${t("twin_queue_wait").replace("{n}", number.format(queue.avg_wait_minutes ?? 0))}`
          : t("twin_queue_none"),
        queueClassText,
      ]
        .filter(Boolean)
        .join("\n")
    : null;

  const draw = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.setProps({ layers: buildTwinLayers({ ...frameRef.current, time: clockRef.current }) });
  }, []);

  useEffect(() => {
    frameRef.current = {
      scene,
      prepared,
      view,
      animate,
      reducedMotion,
      labels: { landfill: landfillLabel },
    };
    if (mapReady) draw();
  }, [scene, prepared, view, animate, reducedMotion, landfillLabel, mapReady, draw]);

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
      districtsAtRisk: summary.atRisk,
      totalTons: summary.tons,
      landfillLabel,
      tourActive: Boolean(tour),
      startTour,
      stopTour,
      setDay,
      setCity,
      setRainfall,
      setEventPreset,
    };
  }, [ready, scene, safeDay, summary, tour, startTour, stopTour, landfillLabel]);
  useEffect(
    () => () => {
      delete window.__pythiaTwin;
    },
    [],
  );

  // ---- derived copy ---------------------------------------------------------
  const truckCapacity = /([\d.]+)\s*t/.exec(scene?.units?.trucks_required || "")?.[1];
  const metrics = [
    {
      label: t("twin_metric_total"),
      value: scene ? `${number.format(summary.tons)} t` : "—",
      helper: t("twin_metric_total_helper").replace("{date}", formatDate(summary.date)),
    },
    {
      label: t("twin_metric_peak"),
      value: scene ? formatDate(scene.summary.peak_date) : "—",
      helper: scene
        ? t("twin_metric_peak_helper").replace("{n}", number.format(scene.summary.peak_total_tons))
        : "",
      tone: "warning",
    },
    {
      label: t("twin_metric_risk"),
      value: scene ? number.format(summary.atRisk) : "—",
      helper: t("twin_metric_risk_helper").replace("{n}", number.format(scene?.districts?.length ?? 0)),
      tone: summary.atRisk > 0 ? "danger" : "neutral",
    },
    {
      label: t("twin_metric_trucks"),
      value: scene ? number.format(summary.trucks) : "—",
      helper: truckCapacity ? t("twin_metric_trucks_helper").replace("{n}", truckCapacity) : "",
    },
  ];

  const hovered = hover && scene?.districts.find((d) => d.id === hover.id);
  const selected = selectedId && scene?.districts.find((d) => d.id === selectedId);
  const isDemoCity = scene?.city?.data_class === "SIMULATED_DEMO_CITY";
  const provenance = scene ? Object.entries(scene.provenance || {}) : [];
  const generatedAt = scene?.generated_at
    ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
        new Date(scene.generated_at),
      )
    : null;
  const riskList = useMemo(() => {
    if (!scene) return [];
    return scene.districts
      .map((district) => {
        const row = dayRow(district, safeDay);
        return { district, row, delta: deltaPercent(row), rank: RISK_ORDER.indexOf(row.risk) };
      })
      .sort((a, b) => b.rank - a.rank || b.delta - a.delta)
      .slice(0, RISK_LIST_SIZE);
  }, [scene, safeDay]);
  const formatDelta = (delta) => `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}%`;
  // The XR tabletop opens on the same scenario the twin shows.
  const xrHref = (() => {
    const params = new URLSearchParams({ city });
    if (rainfall > 0) params.set("rainfall_mm", String(rainfall));
    if (preset.attendance > 0) {
      params.set("event_attendance", String(preset.attendance));
      params.set("event_lat", String(venue.lat));
      params.set("event_lng", String(venue.lng));
    }
    return `/xr?${params}`;
  })();
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

  const status = !scene && loading ? "loading" : error ? "error" : loading ? "refreshing" : null;

  return (
    <section
      className={`twin-workspace workspace-page${PRESENT ? " is-present" : ""}`}
      data-testid="twin-workspace"
      aria-labelledby="twin-title"
    >
      <header className="workspace-heading twin-heading">
        <div>
          <span className="workspace-kicker">
            <Box size={14} /> {t("twin_kicker")}
          </span>
          <h1 id="twin-title">{t("twin_title")}</h1>
          <p>{t("twin_sub")}</p>
        </div>
        {generatedAt && (
          <div className="workspace-freshness" data-testid="twin-freshness">
            <span>{t("twin_generated").replace("{time}", generatedAt)}</span>
            <strong>{classLabel(scene.provenance?.districts?.class)}</strong>
          </div>
        )}
      </header>

      <MetricStrip metrics={metrics} />

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
          <div className="twin-viewport">
            <div
              ref={containerRef}
              className="twin-map"
              data-testid="twin-map"
              role="region"
              aria-label={t("twin_map_label").replace("{city}", scene?.city?.name || "")}
            />

            {PRESENT && scene && (
              <div className="twin-present-hud" aria-hidden="true">
                <strong>{scene.city.name}</strong>
                <span>{formatDate(summary.date)}</span>
                <span>{number.format(summary.tons)} t</span>
                <span>{t("twin_present_risk").replace("{n}", number.format(summary.atRisk))}</span>
                {queueClassText && <span data-testid="twin-present-queue">{queueClassText}</span>}
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
                <strong>{t(`twin_tour_${tour.step.key}`).replace("{name}", tour.step.name || "")}</strong>
                <button type="button" onClick={stopTour}>
                  <Square size={14} aria-hidden="true" /> {t("twin_tour_stop")}
                </button>
              </div>
            )}
          </div>

          <div className="twin-legend" data-testid="twin-legend">
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
            <ul className="twin-provenance" data-testid="twin-provenance" aria-label={t("twin_layers_title")}>
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
            {basemapOffline && <small className="twin-legend-note">{t("twin_offline_basemap")}</small>}
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
                    aria-label={`${formatDate(date)} · ${number.format(total)} t`}
                    tabIndex={index === safeDay ? 0 : -1}
                    onClick={() => setDay(index)}
                  >
                    <span className="twin-day-bar" aria-hidden="true">
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

          {!PRESENT && (
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
                  <div className="twin-choice" role="group" aria-labelledby="twin-city-label">
                    {CITIES.map((id) => (
                      <button
                        key={id}
                        type="button"
                        data-testid={`twin-city-${id}`}
                        aria-pressed={city === id}
                        onClick={() => {
                          setCity(id);
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
                    onChange={(e) => setRainfall(Number(e.target.value))}
                  />
                  <span className="twin-field-label" id="twin-event-label">
                    <Users size={15} aria-hidden="true" /> {t("twin_event")}
                  </span>
                  <div className="twin-choice twin-choice-3" role="group" aria-labelledby="twin-event-label">
                    {EVENT_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        data-testid={`twin-event-${p.id}`}
                        aria-pressed={eventPreset === p.id}
                        onClick={() => setEventPreset(p.id)}
                      >
                        {p.attendance
                          ? t("twin_event_preset")
                              .replace("{n}", number.format(p.attendance))
                              .replace("{venue}", venue.name)
                          : t("twin_event_none")}
                      </button>
                    ))}
                  </div>
                  <p className="twin-note">{t("twin_scenario_note")}</p>
                </section>

                <section className="twin-panel-section twin-actions">
                  <button
                    type="button"
                    className="twin-btn primary"
                    data-testid="twin-tour"
                    onClick={tour ? stopTour : startTour}
                    disabled={!ready && !tour}
                  >
                    {tour ? (
                      <Square size={16} aria-hidden="true" />
                    ) : (
                      <Clapperboard size={16} aria-hidden="true" />
                    )}
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

                <section
                  className="twin-panel-section"
                  aria-labelledby="twin-detail-title"
                  data-testid="twin-detail"
                >
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
          )}
        </div>
      </div>
    </section>
  );
}
