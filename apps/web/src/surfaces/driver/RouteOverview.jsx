import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  ExternalLink,
  Flag,
  LocateFixed,
  MapPinCheck,
  Navigation,
  Package,
  Phone,
  Route,
  ScanEye,
  ShieldCheck,
  Truck,
  Warehouse,
  X,
} from "lucide-react";
import { apiFetch, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import {
  clockTime,
  instructionSlotFromText,
  mapsDirectionsUrl,
  queuedDispatchIds,
  safetyNotices,
} from "./driverHelpers.js";
import { instructionText } from "./driverText.js";
import { stopText } from "../../shared/format/stopText.js";
import { SafetyLines, SyncChip } from "./DriverPanels.jsx";
import { StopProof } from "./StopProof.jsx";
import { etaLabelKey, haversineKm, readPhoto, straightLineEta, useDriverTrip } from "./tripApi.js";
import "./driver-trip.css";

const DriverRouteMap = lazy(() => import("./DriverRouteMap.jsx"));
const ArNavigator = lazy(() => import("./ArNavigator.jsx").then((m) => ({ default: m.ArNavigator })));

const W = 320;
const H = 132;
const PAD = 16;

function hasCoord(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && p.lat !== null;
}

// The stops (and the destination, when its coordinate is known) projected into
// a small box, north up, aspect kept. The no-WebGL stand-in for the map.
export function sketchPoints(points, w = W, h = H) {
  const known = points.filter(hasCoord);
  if (known.length < 2) return null;
  const lats = known.map((p) => Number(p.lat));
  const lngs = known.map((p) => Number(p.lng));
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const xs = lngs.map((v) => v * kx);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...lats), Math.max(...lats)];
  const scale = Math.min(
    (w - 2 * PAD) / Math.max(maxX - minX, 1e-6),
    (h - 2 * PAD) / Math.max(maxY - minY, 1e-6),
  );
  const offX = (w - (maxX - minX) * scale) / 2;
  const offY = (h - (maxY - minY) * scale) / 2;
  return points.map((p) =>
    hasCoord(p)
      ? {
          x: Math.round((offX + (Number(p.lng) * kx - minX) * scale) * 10) / 10,
          y: Math.round((h - offY - (Number(p.lat) - minY) * scale) * 10) / 10,
        }
      : null,
  );
}

// The disposal facility of an SPJ with its registry coordinate (null when the
// registry has none: the maps link then searches by name).
export function destinationTarget(spj, destinations) {
  const facility = (destinations || []).find(
    (d) => d?.destination === spj?.destination || d?.name === spj?.destination,
  );
  return { lat: facility?.lat ?? null, lng: facility?.lng ?? null, name: spj?.destination || "" };
}

// "DLH-DKI/SPJ/26-10-2026/0471" → "SPJ-0471"; anything else as sent.
export function shortSpjNumber(number) {
  const match = /\/(\d+)$/.exec(String(number || ""));
  return match ? `SPJ-${match[1]}` : String(number || "");
}

// The phone's own GPS, watched while the route is on screen. null without a
// fix (denied, no GPS, automation): no truck pin and no ETA, never a guess.
// Paused (`enabled` false) while AR runs its own GPS watch.
export function usePhonePosition(enabled = true) {
  const [position, setPosition] = useState(null);
  useEffect(() => {
    if (!enabled || !navigator.geolocation?.watchPosition) return undefined;
    const id = navigator.geolocation.watchPosition(
      (pos) =>
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
        }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);
  return position;
}

function pathCacheKey(spjId) {
  return `pythia_driver_path_${spjId}`;
}

// The SPJ's road geometry (resolved at activation), cached per SPJ for offline.
function useActivePath(truckCode, spjId) {
  const [path, setPath] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(pathCacheKey(spjId)) || "null");
      return Array.isArray(cached) ? cached : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!truckCode || !spjId) return undefined;
    let cancelled = false;
    apiFetch(`/spj/active-path/${encodeURIComponent(truckCode)}`, { tokenKey: FIELD_TOKEN_KEY })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body) => {
        if (cancelled) return;
        const next = body?.has_reference_path && Array.isArray(body.path) ? body.path : null;
        setPath(next);
        try {
          localStorage.setItem(pathCacheKey(spjId), JSON.stringify(next));
        } catch {
          // The cached copy only serves an offline reload.
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [truckCode, spjId]);
  return path;
}

function slotCacheKey(truckCode) {
  return `pythia_driver_gate_slot_${truckCode}`;
}

function localDay() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Today's gate slot as the approved plan's instruction states it (model output).
// The instruction leaves the feed once answered, so the slot is kept per day.
export function useGateSlot(truckCode, feedList) {
  const fromFeed = useMemo(() => {
    for (const item of [...(feedList || [])].reverse()) {
      const slot = instructionSlotFromText(item?.instruction);
      if (slot?.start) return slot;
    }
    return null;
  }, [feedList]);
  const stored = useMemo(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(slotCacheKey(truckCode)) || "null");
      return cached?.day === localDay() ? cached.slot : null;
    } catch {
      return null;
    }
  }, [truckCode]);
  useEffect(() => {
    if (!fromFeed || !truckCode) return;
    try {
      localStorage.setItem(slotCacheKey(truckCode), JSON.stringify({ day: localDay(), slot: fromFeed }));
    } catch {
      // Best effort.
    }
  }, [fromFeed, truckCode]);
  return fromFeed || stored;
}

// iOS Safari only exposes compass events after a permission prompt, and the
// prompt must come from the tap that opens AR. Other browsers need none.
async function requestOrientationPermission() {
  const Orientation = typeof window !== "undefined" ? window.DeviceOrientationEvent : undefined;
  if (!Orientation || typeof Orientation.requestPermission !== "function") return "not-required";
  try {
    return await Orientation.requestPermission();
  } catch {
    return "denied";
  }
}

const TIP_DISMISS_KEY = "pythia_driver_tip_dismissed";

function readDismissed() {
  try {
    const list = JSON.parse(sessionStorage.getItem(TIP_DISMISS_KEY) || "[]");
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function MapsLink({ target, name, testId }) {
  const { t } = useLanguage();
  const href = mapsDirectionsUrl(target);
  if (!href) return null;
  return (
    <a
      className="drt-icon-btn drt-maps"
      data-testid={testId}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("drv6_maps_open_aria").replace("{name}", name)}
    >
      <ExternalLink size={20} aria-hidden="true" />
    </a>
  );
}

function StopsSheet({ spj, stops, pendingIndex, target, onClose }) {
  const { t } = useLanguage();
  const closeRef = useRef(null);
  // A stop dispatch skipped is closed too: it is never the next stop.
  const done = stops.filter((s) => s.status === "completed" || s.status === "skipped").length;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const hasDestCoord = hasCoord(target);
  return (
    <>
      <div className="drt-scrim" onClick={onClose} aria-hidden="true" />
      <section
        className="drt-stops"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drt-stops-title"
        data-testid="driver-stops-sheet"
      >
        <span className="drt-handle" aria-hidden="true" />
        <div className="drt-stops-head">
          <div>
            <h2 id="drt-stops-title">{t("d2_route_all_stops")}</h2>
            <span className="drt-count" data-testid="driver-route-progress">
              {t("drv10_route_progress").replace("{done}", done).replace("{total}", stops.length)}
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="drt-icon-btn drt-back"
            onClick={onClose}
            aria-label={t("d2_close")}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <ol className="drt-stop-list">
          {stops.map((stop, i) => {
            const skipped = stop.status === "skipped";
            const completed = stop.status === "completed" || skipped;
            const isNext = i === pendingIndex;
            return (
              <li
                key={`${spj.spj_id}-${i}`}
                className={`drt-stop${completed ? " is-done" : ""}${isNext ? " is-next" : ""}${
                  !completed && !isNext && pendingIndex !== -1 && i > pendingIndex ? " is-locked" : ""
                }`}
                data-testid={isNext ? "stop-row-next" : `stop-${i}`}
                aria-current={isNext ? "step" : undefined}
              >
                <span className="drt-stop-num" aria-hidden="true">
                  {completed ? <Check size={16} strokeWidth={2.5} /> : i + 1}
                </span>
                <div className="drt-stop-body">
                  <h3>
                    <span className="drt-sr">{t("drv11_stop_prefix").replace("{n}", i + 1)} </span>
                    {stopText(stop.name, t)}
                  </h3>
                  <p>{[stop.kecamatan, stopText(stop.address, t)].filter(Boolean).join(" — ")}</p>
                  {completed && stop.queued && <p data-testid="stop-queued-note">{t("drv6_stop_queued")}</p>}
                </div>
                {completed ? (
                  <span className={`drt-state${stop.queued ? " is-queued" : ""}`}>
                    {stop.queued
                      ? t("drv6_stop_queued_badge")
                      : skipped
                        ? t("d2_stop_skipped")
                        : t("drv_stop_selesai")}
                  </span>
                ) : (
                  <MapsLink target={stop} name={stop.name} testId={`stop-maps-${i}`} />
                )}
              </li>
            );
          })}
          <li className="drt-stop" data-testid="destination-card">
            <span className="drt-stop-num" aria-hidden="true">
              <Flag size={15} />
            </span>
            <div className="drt-stop-body">
              <h3>{t("drv6_dest_title").replace("{name}", spj.destination)}</h3>
              <p>{hasDestCoord ? t("drv10_route_dest") : t("drv6_dest_name_only")}</p>
            </div>
            <MapsLink target={target} name={spj.destination} testId="destination-maps" />
          </li>
        </ol>
      </section>
    </>
  );
}

// sY4R6: the route as a full-bleed map. Trip card on top (you → next stop, all
// stops), the newest dispatch instruction as a tip, and the stop sheet at the
// bottom (ETA, stop facts, call/message/AR, "I've arrived" → stop proof).
export function RouteScreen({
  driver,
  spj,
  pendingIndex,
  destinations,
  blocked,
  arEnabled,
  instructionFeed,
  outboxItems,
  safety,
  online,
  pending,
  flushing,
  onStopCompleted,
  onOpenInstructions,
  say,
}) {
  const { t, lang } = useLanguage();
  const stops = spj?.stops || [];
  const path = useActivePath(driver?.truck_code, spj?.spj_id);
  const planSlot = useGateSlot(driver?.truck_code, instructionFeed?.list);
  const target = destinationTarget(spj, destinations);
  const stop = pendingIndex >= 0 ? stops[pendingIndex] : null;
  const next = stop || target;
  const [proof, setProof] = useState(null);
  const [allStops, setAllStops] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [ar, setAr] = useState(null);
  const position = usePhonePosition(!ar);
  const trip = useDriverTrip(driver?.truck_code, position);
  const gateSlot = trip.gateSlot || planSlot;
  const [dismissed, setDismissed] = useState(() => readDismissed());
  const arOpenerRef = useRef(null);
  const arriveRef = useRef(null);
  const routeRef = useRef(null);
  const bottomRef = useRef(null);
  const hasRoute = Boolean(spj && stops.length);

  // The map attribution sits just above the bottom panel, whose height varies.
  useEffect(() => {
    const bottom = bottomRef.current;
    const route = routeRef.current;
    if (!bottom || !route || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() =>
      route.style.setProperty("--drt-bottom-h", `${Math.round(bottom.offsetHeight)}px`),
    );
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [hasRoute]);

  // The newest unanswered instruction from dispatch (not the plan's own).
  const tip = useMemo(() => {
    const hidden = queuedDispatchIds(outboxItems);
    const list = (instructionFeed?.list || []).filter(
      (d) =>
        d?.instruction &&
        d.manager_id !== "operations_optimizer" &&
        !hidden.has(d.id) &&
        !dismissed.has(d.id) &&
        (!d.field_status || d.field_status === "PENDING"),
    );
    return list.length ? list[list.length - 1] : null;
  }, [instructionFeed, outboxItems, dismissed]);

  const dismissTip = (id) => {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    try {
      sessionStorage.setItem(TIP_DISMISS_KEY, JSON.stringify([...next]));
    } catch {
      // Dismissal is per screen session only.
    }
  };

  // The server's road ETA when it is for this very stop, else the labelled
  // straight-line estimate from the phone's GPS.
  const serverEta = stop ? (trip.stopEta?.index === pendingIndex ? trip.stopEta : null) : trip.tpaEta;
  const eta = serverEta || straightLineEta(position, next);
  const loadTons = stop ? trip.stopTons[pendingIndex] : undefined;
  const arriveAt = eta ? clockTime(new Date(Date.now() + eta.minutes * 60000).toISOString()) : null;
  const km = serverEta?.km ?? haversineKm(position, next);
  const notices = safetyNotices(safety);

  const closeAr = useCallback(() => setAr(null), []);
  useEffect(() => {
    if (ar || !arOpenerRef.current) return;
    const opener = arOpenerRef.current;
    arOpenerRef.current = null;
    if (opener.isConnected) opener.focus();
  }, [ar]);

  const closeProof = useCallback(() => {
    setProof(null);
    setTimeout(() => arriveRef.current?.focus(), 0);
  }, []);

  if (!spj || stops.length === 0) return null;

  const openAr = async (event) => {
    arOpenerRef.current = event?.currentTarget || null;
    const orientationPermission = await requestOrientationPermission();
    setAr({ orientationPermission });
  };

  // An AR capture enters the stop proof with the arrival photo and its fix.
  const captureFromAr = async (file, fix) => {
    setAr(null);
    try {
      const photo = await readPhoto(file);
      const gps =
        Number.isFinite(fix?.lat) && Number.isFinite(fix?.lng)
          ? { lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracy_m }
          : null;
      setProof({ initialArrival: { photo: { ...photo, fix }, fix: gps } });
      say(t("drv_ar_captured"));
    } catch (err) {
      say(err.message);
    }
  };

  const nextLabel = stop
    ? t("d2_route_stop_of")
        .replace("{n}", pendingIndex + 1)
        .replace("{total}", stops.length)
    : t("d2_route_destination");
  const subParts = [
    shortSpjNumber(spj.spj_number),
    stop
      ? t("d2_route_stop_n_of")
          .replace("{n}", pendingIndex + 1)
          .replace("{total}", stops.length)
      : null,
    km !== null ? `${km.toLocaleString(localeFor(lang), { maximumFractionDigits: 1 })} km` : null,
  ].filter(Boolean);

  return (
    <section
      ref={routeRef}
      className="drt-route"
      data-testid="driver-route-overview"
      aria-label={t("drv10_route_title")}
    >
      {mapFailed ? (
        <RouteSketch stops={stops} destination={target} />
      ) : (
        <Suspense fallback={<RouteSketch stops={stops} destination={target} />}>
          <DriverRouteMap
            path={path}
            stops={stops}
            nextIndex={pendingIndex}
            destination={target}
            position={position}
            fitKey={fitKey}
            onFail={() => setMapFailed(true)}
            label={t("drv10_route_sketch_aria")
              .replace("{n}", stops.length)
              .replace("{dest}", spj.destination || "")}
          />
        </Suspense>
      )}

      <div className="drt-top">
        <div className="drt-trip" data-testid="driver-trip-card">
          <div className="drt-trip-row">
            <span className="drt-trip-dot" aria-hidden="true">
              <Truck size={12} />
            </span>
            <p className="drt-trip-text">
              <strong>{driver?.truck_code}</strong>
              <span>{position ? t("d2_route_you") : t("d2_route_you_no_gps")}</span>
            </p>
            {/* Not in sY4R6 (drawn online and synced): offline or with work
                still on the phone, the route says so like the proof screen. */}
            {(!online || pending > 0 || flushing) && (
              <SyncChip online={online} pending={pending} flushing={flushing} />
            )}
          </div>
          <div className="drt-trip-row">
            <span className="drt-trip-dot is-stop" aria-hidden="true">
              <Flag size={12} />
            </span>
            <p className="drt-trip-text">
              <strong>{stopText(next.name, t)}</strong>
              <span>{nextLabel}</span>
            </p>
            <button
              type="button"
              className="drt-chip-btn"
              data-testid="driver-all-stops"
              aria-haspopup="dialog"
              onClick={() => setAllStops(true)}
            >
              <span>{t("d2_route_all_stops")}</span>
            </button>
          </div>
        </div>

        {tip && (
          <div className="drt-tip" data-testid="driver-route-tip">
            <span className="drt-tip-ic" aria-hidden="true">
              <Route size={14} />
            </span>
            <button type="button" className="drt-tip-text" onClick={onOpenInstructions}>
              {t("d2_route_tip")
                .replace("{time}", clockTime(tip.created_at) || "—")
                .replace("{text}", instructionText(tip.instruction, t))}
            </button>
            <button
              type="button"
              className="drt-icon-btn drt-tip-close"
              aria-label={t("d2_route_tip_dismiss")}
              onClick={() => dismissTip(tip.id)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <div ref={bottomRef} className="drt-bottom">
        {safetyOpen && (
          <div className="drt-safety-pop" role="status" data-testid="driver-route-safety">
            {notices.length === 0 ? <p>{t("d2_route_safety_ok")}</p> : <SafetyLines safety={safety} />}
          </div>
        )}
        <div className="drt-fabs">
          <button
            type="button"
            className="drt-icon-btn drt-fab"
            data-testid="driver-recenter"
            aria-label={t("d2_route_recenter")}
            onClick={() => setFitKey((k) => k + 1)}
          >
            <LocateFixed size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`drt-icon-btn drt-fab${safetyOpen ? " is-on" : ""}${notices.length ? " is-alert" : ""}`}
            data-testid="driver-safety-toggle"
            aria-label={t("d2_route_safety")}
            aria-expanded={safetyOpen}
            onClick={() => setSafetyOpen((open) => !open)}
          >
            <ShieldCheck size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="drt-panel">
          <p
            className="drt-eta"
            data-testid="driver-eta"
            data-eta-source={eta ? eta.source : "none"}
            title={eta ? t(etaLabelKey(eta.source)) : undefined}
          >
            <span className="drt-eta-ic" aria-hidden="true">
              <Navigation size={14} />
            </span>
            <span className="drt-eta-text">
              {eta
                ? t("d2_route_eta").replace("{name}", next.name)
                : t("d2_route_head_to").replace("{name}", next.name)}
            </span>
            {eta && (
              <span className="drt-eta-pill">
                {t("d2_route_eta_min").replace("{n}", eta.minutes)}
                <span className="drt-sr"> ({t(etaLabelKey(eta.source))})</span>
              </span>
            )}
          </p>

          <article className="drt-sheet" data-testid={stop ? `stop-${pendingIndex}` : "driver-route-dest"}>
            <span className="drt-handle" aria-hidden="true" />
            <div className="drt-sheet-head">
              <div className="drt-sheet-title">
                <h2>
                  {stop && (
                    <span className="drt-sr">{t("drv11_stop_prefix").replace("{n}", pendingIndex + 1)} </span>
                  )}
                  {stopText(next.name, t)}
                </h2>
                <p title={spj.spj_number}>{subParts.join(" · ")}</p>
              </div>
              {arriveAt && (
                <p className="drt-arrive" title={t(etaLabelKey(eta.source))}>
                  <strong>~{arriveAt}</strong>
                  <span>{t("d2_route_arrive")}</span>
                </p>
              )}
            </div>

            <div className="drt-facts">
              {loadTons !== undefined && (
                <span className="drt-fact" data-testid="driver-load" title={t("d2_model_output")}>
                  <Package size={14} aria-hidden="true" />
                  {t("d2_route_load").replace(
                    "{n}",
                    loadTons.toLocaleString(localeFor(lang), { maximumFractionDigits: 1 }),
                  )}
                </span>
              )}
              <span
                className="drt-fact"
                data-testid="driver-gate-slot"
                title={gateSlot ? t("d2_model_output") : undefined}
              >
                <Warehouse size={14} aria-hidden="true" />
                {t("d2_route_gate_slot").replace("{time}", gateSlot?.start || "—")}
              </span>
            </div>

            <div className="drt-contact">
              {trip.dispatchTel && (
                <a
                  className="drt-icon-btn drt-call"
                  href={trip.dispatchTel}
                  aria-label={t("d2_route_call")}
                  data-testid="driver-call-dispatch"
                >
                  <Phone size={18} aria-hidden="true" />
                </a>
              )}
              <button
                type="button"
                className="drt-message"
                data-testid="driver-message-dispatch"
                onClick={onOpenInstructions}
              >
                <span>{t("d2_route_message")}</span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              {arEnabled && stop && (
                <button
                  type="button"
                  className="drt-icon-btn drt-ar"
                  data-testid="ar-nav-open"
                  aria-label={t("drv_ar_open_aria").replace("{name}", stop.name)}
                  onClick={openAr}
                >
                  <ScanEye size={18} aria-hidden="true" />
                </button>
              )}
            </div>

            {stop && blocked && (
              <p className="drt-held" data-testid="stop-held">
                {t("drv6_safety_held")}
              </p>
            )}
            {stop ? (
              <button
                ref={arriveRef}
                type="button"
                className="drt-btn is-primary"
                data-testid="stop-start"
                disabled={blocked}
                onClick={() => setProof({})}
              >
                <MapPinCheck size={18} aria-hidden="true" /> {t("d2_route_arrived")}
              </button>
            ) : (
              <p className="drt-note" data-testid="driver-route-all-done">
                {t("d2_route_all_done")}
              </p>
            )}

            {stop && proof && (
              <StopProof
                key={`${spj.spj_id}-${pendingIndex}`}
                spj={spj}
                stop={stop}
                index={pendingIndex}
                online={online}
                pending={pending}
                flushing={flushing}
                initialArrival={proof.initialArrival || null}
                onClose={closeProof}
                onCompleted={() => {
                  setProof(null);
                  onStopCompleted();
                }}
                say={say}
              />
            )}
          </article>
        </div>
      </div>

      {allStops && (
        <StopsSheet
          spj={spj}
          stops={stops}
          pendingIndex={pendingIndex}
          target={target}
          onClose={() => setAllStops(false)}
        />
      )}

      {ar && stop && (
        <Suspense fallback={null}>
          <ArNavigator
            spj={spj}
            stop={stop}
            index={pendingIndex}
            orientationPermission={ar.orientationPermission}
            onClose={closeAr}
            onCapture={captureFromAr}
            onUseForm={() => {
              setAr(null);
              setProof({});
            }}
          />
        </Suspense>
      )}
    </section>
  );
}

// No WebGL (or the map chunk still loading): the stops in order, no basemap.
function RouteSketch({ stops, destination }) {
  const { t } = useLanguage();
  const box = { w: 390, h: 520 };
  const points = sketchPoints([...stops, destination || {}], box.w, box.h);
  if (!points) return null;
  const nextIndex = stops.findIndex((s) => s.status !== "completed" && s.status !== "skipped");
  return (
    <svg
      className="drt-map-sketch"
      viewBox={`0 0 ${box.w} ${box.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={t("drv10_route_sketch_label")}
      data-testid="driver-route-sketch"
    >
      <polyline
        className="drt-sketch-line is-straight"
        points={points
          .filter(Boolean)
          .map((p) => `${p.x},${p.y}`)
          .join(" ")}
      />
      {points.map((p, i) =>
        p ? (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={i === nextIndex ? 10 : 6}
            fill={i === nextIndex || i === stops.length ? "var(--f-orange)" : "var(--f-green)"}
            stroke="var(--f-white)"
            strokeWidth="3"
          />
        ) : null,
      )}
    </svg>
  );
}
