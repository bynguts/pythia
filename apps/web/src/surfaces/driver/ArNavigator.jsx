// AR navigation to the active SPJ stop for field crews.
//
// Camera passthrough (getUserMedia) + phone GPS (watchPosition) + compass
// (deviceorientationabsolute / iOS webkitCompassHeading) drive a floor arrow
// toward the stop. Inside ARRIVAL_RADIUS_M the driver captures the current
// camera frame, stamped with time + GPS + accuracy, and it is handed back to
// the stop's normal arrival-evidence flow — same validation, outbox and API.
//
// Fallbacks are explicit, never guessed: no camera or no live compass → 2D
// compass card (a north-up arrow, explained); a GPS fix older than
// FIX_STALE_MS → capture disabled until a fresh fix arrives; no stop
// coordinate → an honest "no coordinate" state with no arrow at all.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, CheckCircle2, Compass, LocateFixed, MapPinOff, X } from "lucide-react";
import { useLanguage } from "../../shared/i18n/index.jsx";
import {
  ARRIVAL_RADIUS_M,
  cardinal,
  formatDistance,
  hasCoordinate,
  haversineMeters,
  headingFromOrientation,
  initialBearing,
  pushHeadingSample,
  relativeAngle,
  unwrapAngle,
} from "./arMath.js";
import "./ar.css";

// Absolute-orientation events arrive within a few hundred ms on phones that
// have a magnetometer; after this window the device is treated as compass-less.
const HEADING_TIMEOUT_MS = 2500;
// Leave the arrived state only well outside the radius so GPS jitter at the
// boundary does not flicker the capture button.
const ARRIVAL_EXIT_M = ARRIVAL_RADIUS_M + 15;
const MAX_CAPTURE_SIDE = 1600;
// Evidence must describe where the phone is now: a fix older than this (GPS
// lost under a flyover, in a basement) no longer counts as arrived/capturable.
export const FIX_STALE_MS = 15000;
const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";

function pad(n) {
  return String(n).padStart(2, "0");
}

// Local wall-clock time with its UTC offset, e.g. "2026-10-14 09:31:05 UTC+07:00".
function stampTime(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function turnText(t, angle) {
  const abs = Math.abs(angle);
  if (abs <= 15) return t("drv_ar_turn_ahead");
  if (abs >= 150) return t("drv_ar_turn_back");
  return t(angle > 0 ? "drv_ar_turn_right" : "drv_ar_turn_left").replace("{n}", Math.round(abs));
}

// Floor compass: a ring lying on the ground plane, its N tick turned to true
// north, so the arrow reads as anchored in the street rather than on glass.
function FloorRing({ label, arrived }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle className="ar-floor-ring" cx="50" cy="50" r="46" />
      <circle className="ar-floor-inner" cx="50" cy="50" r="30" />
      <path className="ar-floor-tick" d="M50 0 L55 10 L45 10 Z" />
      <text className="ar-floor-label" x="50" y="21" textAnchor="middle">
        {label}
      </text>
      {arrived && (
        <g className="ar-floor-target">
          <circle cx="50" cy="50" r="20" />
          <path d="M40 50 L47 57 L61 43" />
        </g>
      )}
    </svg>
  );
}

function ArrowGlyph() {
  // One arrow drawn three times: the face, an extruded side a few px below it
  // in 3D space, and a soft ground shadow — enough depth without WebGL.
  const path = "M50 4 L92 88 L50 68 L8 88 Z";
  return (
    <>
      <svg className="ar-arrow-shadow" viewBox="0 0 100 100" aria-hidden="true">
        <path d={path} />
      </svg>
      <svg className="ar-arrow-side" viewBox="0 0 100 100" aria-hidden="true">
        <path d={path} />
      </svg>
      <svg className="ar-arrow-face" viewBox="0 0 100 100" aria-hidden="true">
        <path d={path} />
        {/* Right facet in shade: a bevel that reads as a lit, raised arrow. */}
        <path className="ar-arrow-facet" d="M50 4 L92 88 L50 68 Z" />
        <path className="ar-arrow-ridge" d="M50 4 L50 68" />
      </svg>
    </>
  );
}

export function ArNavigator({ spj, stop, index, orientationPermission, onClose, onCapture, onUseForm }) {
  const { t, lang } = useLanguage();
  const videoRef = useRef(null);
  const rootRef = useRef(null);
  const closeRef = useRef(null);
  // Unwrapped CSS rotations so 350° → 10° turns 20°, not 340° the long way.
  const ringTurnRef = useRef(null);
  const arrowTurnRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const target = hasCoordinate(stop) ? { lat: Number(stop.lat), lng: Number(stop.lng) } : null;
  const hasTarget = Boolean(target);

  const [camera, setCamera] = useState(hasTarget ? "starting" : "off");
  const [fix, setFix] = useState(null);
  const [geoError, setGeoError] = useState(null);
  const [heading, setHeading] = useState(null);
  const [headingState, setHeadingState] = useState(orientationPermission === "denied" ? "denied" : "waiting");
  const [arrived, setArrived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // Re-evaluate fix freshness even when no new position arrives.
  useEffect(() => {
    if (!hasTarget) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasTarget]);

  // ── Camera passthrough ──
  useEffect(() => {
    if (!hasTarget) return undefined;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera("unavailable");
      return undefined;
    }
    let cancelled = false;
    let stream = null;
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = s;
        const video = videoRef.current;
        if (video) {
          video.srcObject = s;
          video.play().catch(() => {});
        }
        setCamera("live");
      })
      .catch((err) => {
        if (cancelled) return;
        setCamera(
          err?.name === "NotAllowedError" || err?.name === "SecurityError" ? "denied" : "unavailable",
        );
      });
    const video = videoRef.current;
    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
  }, [hasTarget]);

  // ── GPS ──
  useEffect(() => {
    if (!hasTarget) return undefined;
    if (!navigator.geolocation) {
      setGeoError("unavailable");
      return undefined;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setGeoError(null);
        setNow(Date.now());
        setFix({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          at: pos.timestamp,
        });
      },
      (err) => {
        // A timeout keeps the watch alive; only a denial or a dead sensor is final.
        if (err.code === 1) setGeoError("denied");
        else if (err.code === 2) setGeoError("unavailable");
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [hasTarget]);

  // ── Compass ──
  useEffect(() => {
    if (!hasTarget || orientationPermission === "denied") return undefined;
    let samples = [];
    let received = false;
    const onOrientation = (event) => {
      const reading = headingFromOrientation(event);
      if (!reading) return;
      received = true;
      const next = pushHeadingSample(samples, reading.heading);
      samples = next.samples;
      if (next.heading !== null) {
        setHeading(next.heading);
        setHeadingState("live");
      }
    };
    window.addEventListener("deviceorientationabsolute", onOrientation);
    window.addEventListener("deviceorientation", onOrientation);
    const timer = window.setTimeout(() => {
      if (!received) setHeadingState("none");
    }, HEADING_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("deviceorientationabsolute", onOrientation);
      window.removeEventListener("deviceorientation", onOrientation);
    };
  }, [hasTarget, orientationPermission]);

  // ── Dialog behaviour: focus, Escape, Tab trapped inside, no background scroll ──
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;
      const items = [...rootRef.current.querySelectorAll(FOCUSABLE)].filter(
        (el) => el.getClientRects().length > 0,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = rootRef.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const distance = fix && target ? haversineMeters(fix, target) : null;
  const bearing = fix && target ? initialBearing(fix, target) : null;
  const fixFresh = Boolean(fix) && now - fix.at <= FIX_STALE_MS;
  const compassLive = headingState === "live" && heading !== null;
  // With a compass the arrow is relative to where the phone points; without
  // one it is a north-up map bearing and the copy says so.
  const arrowAngle = bearing === null ? null : compassLive ? relativeAngle(bearing, heading) : bearing;
  const ringTurn = unwrapAngle(ringTurnRef.current, compassLive ? -heading : 0);
  ringTurnRef.current = ringTurn;
  const arrowTurn =
    arrowAngle === null ? arrowTurnRef.current : unwrapAngle(arrowTurnRef.current, arrowAngle);
  arrowTurnRef.current = arrowTurn;

  // Arrival is decided by fresh fixes only; a stale fix neither enters nor
  // leaves the arrived state (capture is disabled meanwhile, see below).
  useEffect(() => {
    if (distance === null || !fixFresh) return;
    if (distance <= ARRIVAL_RADIUS_M) setArrived(true);
    else if (distance > ARRIVAL_EXIT_M) setArrived(false);
  }, [distance, fixFresh]);

  const view = camera === "live" ? "camera" : "compass";
  // The floor arrow reads as anchored in the street, so it is only drawn when
  // a live compass makes that true; otherwise the honest 2D compass card.
  const stageMode = view === "camera" && compassLive ? "floor" : "card";
  const headingMode = compassLive ? "compass" : headingState === "waiting" ? "waiting" : "north-up";
  const stopTitle = t("drv_stop_title")
    .replace("{n}", index + 1)
    .replace("{name}", stop.name);
  const total = spj?.stops?.length || index + 1;

  const capture = async () => {
    const video = videoRef.current;
    if (!fix || Date.now() - fix.at > FIX_STALE_MS) {
      setCaptureError(t("drv_ar_gps_stale"));
      return;
    }
    if (!video || camera !== "live" || !video.videoWidth) {
      setCaptureError(t("drv_ar_capture_failed"));
      return;
    }
    setBusy(true);
    setCaptureError("");
    try {
      const scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, width, height);

      // Evidence stamp: who/where/when burned into the pixels, so the photo
      // carries its context even when it is viewed outside Pythia.
      const takenAt = new Date();
      // The fix carries its own time: evidence records when the position was
      // measured, not just when the shutter fired.
      const fixAt = new Date(fix.at);
      const accuracy = fix.accuracy === null ? null : Math.round(fix.accuracy);
      const lines = [
        `PYTHIA AR · ${spj?.spj_number || spj?.spj_id || "SPJ"} · ${stopTitle}`,
        stampTime(takenAt),
        `GPS ${fix.lat.toFixed(6)}, ${fix.lng.toFixed(6)}${accuracy === null ? "" : ` ±${accuracy} m`}` +
          (distance === null ? "" : ` · ${t("drv_ar_stamp_distance").replace("{n}", Math.round(distance))}`),
        t("drv_ar_stamp_fix").replace("{time}", stampTime(fixAt)),
      ];
      const fontPx = Math.max(14, Math.round(height * 0.03));
      const lineH = Math.round(fontPx * 1.35);
      const band = lineH * lines.length + fontPx;
      ctx.fillStyle = "rgba(19, 33, 29, 0.78)";
      ctx.fillRect(0, height - band, width, band);
      ctx.fillStyle = "#ffffff";
      ctx.font = `600 ${fontPx}px "Plus Jakarta Sans", system-ui, sans-serif`;
      ctx.textBaseline = "top";
      lines.forEach((line, i) => {
        ctx.fillText(
          line,
          Math.round(fontPx * 0.8),
          height - band + Math.round(fontPx / 2) + i * lineH,
          width - fontPx * 1.6,
        );
      });

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (!blob) throw new Error("encode");
      const fileStamp = takenAt.toISOString().replace(/[:.]/g, "-");
      const file = new File([blob], `ar-stop${index + 1}-${fileStamp}.jpg`, {
        type: "image/jpeg",
        lastModified: takenAt.getTime(),
      });
      onCapture(file, {
        lat: fix.lat,
        lng: fix.lng,
        accuracy_m: accuracy,
        at: takenAt.toISOString(),
        fix_at: fixAt.toISOString(),
      });
    } catch {
      setCaptureError(t("drv_ar_capture_failed"));
      setBusy(false);
    }
  };

  let notice = null;
  if (geoError === "denied") notice = { tone: "warn", text: t("drv_ar_gps_denied") };
  else if (geoError === "unavailable" && !fix) notice = { tone: "warn", text: t("drv_ar_gps_unavailable") };
  else if (!fix) notice = { tone: "info", text: t("drv_ar_gps_waiting") };
  else if (headingState === "denied") notice = { tone: "info", text: t("drv_ar_heading_denied") };
  else if (headingState === "none") notice = { tone: "info", text: t("drv_ar_north_up") };
  else if (headingState === "waiting") notice = { tone: "info", text: t("drv_ar_heading_waiting") };

  const cameraNotice = camera === "denied" || camera === "unavailable" ? t("drv_ar_camera_off") : "";
  // Shown even while an old fix still drives the arrow and distance.
  const staleNotice = fix && !fixFresh && geoError !== "denied" ? t("drv_ar_gps_stale") : "";
  const guidance =
    arrowAngle === null
      ? ""
      : arrived
        ? t("drv_ar_at_stop")
        : compassLive
          ? turnText(t, arrowAngle)
          : t("drv_ar_heading_map")
              .replace("{dir}", cardinal(bearing, lang))
              .replace("{n}", Math.round(bearing));

  return (
    <div
      ref={rootRef}
      className={`ar-nav ar-view-${view}${arrived ? " is-arrived" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("drv_ar_dialog_label")}
      data-testid="ar-navigator"
      data-view={view}
      data-heading-mode={headingMode}
      data-arrived={arrived ? "true" : "false"}
      data-gps-fresh={fixFresh ? "true" : "false"}
    >
      <video
        ref={videoRef}
        className="ar-video"
        data-testid="ar-video"
        playsInline
        muted
        autoPlay
        aria-hidden="true"
        hidden={view !== "camera"}
      />

      <header className="ar-top">
        <button
          ref={closeRef}
          type="button"
          className="ar-icon-btn"
          data-testid="ar-nav-close"
          aria-label={t("drv_ar_close")}
          onClick={onClose}
        >
          <X size={22} />
        </button>
        <div className="ar-top-title">
          <span className="ar-top-kicker">
            {t("drv_ar_stop_of")
              .replace("{n}", index + 1)
              .replace("{total}", total)}
          </span>
          <strong>{stop.name}</strong>
        </div>
        <span
          className={`ar-chip${fix && (!fixFresh || (fix.accuracy !== null && fix.accuracy > 30)) ? " is-weak" : ""}`}
          data-testid="ar-accuracy"
        >
          <LocateFixed size={14} aria-hidden="true" />
          {fix && fix.accuracy !== null
            ? t("drv_ar_accuracy").replace("{n}", Math.round(fix.accuracy))
            : t("drv_ar_accuracy_unknown")}
        </span>
      </header>

      {!hasTarget ? (
        <section className="ar-empty" data-testid="ar-no-coordinate">
          <MapPinOff size={36} aria-hidden="true" />
          <h2>{t("drv_ar_no_coord_title")}</h2>
          <p>{t("drv_ar_no_coord_desc")}</p>
          <p className="ar-empty-address">
            {stop.kecamatan} — {stop.address}
          </p>
          <button type="button" className="ar-btn secondary" onClick={onUseForm}>
            <Camera size={18} /> {t("drv_ar_use_form")}
          </button>
        </section>
      ) : (
        <>
          <div className="ar-stage" aria-live="polite">
            {arrowAngle === null ? (
              <div className="ar-searching" data-testid="ar-searching">
                <LocateFixed size={34} aria-hidden="true" />
              </div>
            ) : stageMode === "floor" ? (
              <div
                className="ar-arrow-3d"
                role="img"
                aria-label={guidance}
                data-testid="ar-arrow"
                data-relative-angle={Math.round(arrowAngle)}
              >
                <div className="ar-floor" style={{ "--ar-ring": `${ringTurn}deg` }}>
                  <FloorRing label={cardinal(0, lang)} arrived={arrived} />
                </div>
                <div className="ar-arrow-plane" style={{ "--ar-angle": `${arrowTurn}deg` }}>
                  <ArrowGlyph />
                </div>
              </div>
            ) : (
              <div className="ar-compass" data-testid="ar-compass">
                <div className="ar-compass-ring" style={{ "--ar-ring": `${ringTurn}deg` }} aria-hidden="true">
                  {["N", "E", "S", "W"].map((dir, i) => (
                    <span key={dir} className={`ar-compass-mark m${i}`}>
                      {cardinal(i * 90, lang)}
                    </span>
                  ))}
                </div>
                <div
                  className="ar-compass-arrow"
                  role="img"
                  aria-label={guidance}
                  data-testid="ar-arrow"
                  data-relative-angle={Math.round(arrowAngle)}
                  style={{ "--ar-angle": `${arrowTurn}deg` }}
                >
                  <svg viewBox="0 0 100 100" aria-hidden="true">
                    <path d="M50 6 L86 86 L50 66 L14 86 Z" />
                  </svg>
                </div>
              </div>
            )}
            {distance !== null && (
              <div className="ar-readout">
                <span className="ar-distance" data-testid="ar-distance" data-meters={Math.round(distance)}>
                  {formatDistance(distance, lang)}
                </span>
                <span className="ar-guidance" data-testid="ar-guidance">
                  {guidance}
                </span>
              </div>
            )}
          </div>

          <section className="ar-sheet">
            {arrived ? (
              <div className="ar-arrived" data-testid="ar-arrived">
                <h2>
                  <CheckCircle2 size={20} aria-hidden="true" /> {t("drv_ar_arrived_title")}
                </h2>
                <p>{t("drv_ar_arrived_desc").replace("{n}", ARRIVAL_RADIUS_M)}</p>
                {view === "camera" ? (
                  <button
                    type="button"
                    className="ar-btn primary"
                    data-testid="ar-capture"
                    onClick={capture}
                    disabled={busy || !fixFresh}
                  >
                    <Camera size={18} /> {t("drv_ar_capture")}
                  </button>
                ) : (
                  <button type="button" className="ar-btn primary" onClick={onUseForm}>
                    <Camera size={18} /> {t("drv_ar_use_form")}
                  </button>
                )}
                {captureError && (
                  <p className="ar-error" role="alert">
                    {captureError}
                  </p>
                )}
              </div>
            ) : (
              <>
                <p className="ar-sheet-kicker">{stopTitle}</p>
                <p className="ar-sheet-address">
                  {stop.kecamatan} — {stop.address}
                </p>
              </>
            )}
            {(notice || cameraNotice || staleNotice) && (
              <ul className="ar-notices">
                {staleNotice && (
                  <li className="warn" role="alert" data-testid="ar-gps-stale">
                    <AlertTriangle size={14} aria-hidden="true" /> {staleNotice}
                  </li>
                )}
                {cameraNotice && (
                  <li className="warn" data-testid="ar-camera-off">
                    <AlertTriangle size={14} aria-hidden="true" /> {cameraNotice}
                  </li>
                )}
                {notice && (
                  <li className={notice.tone} data-testid="ar-notice">
                    {notice.tone === "warn" ? (
                      <AlertTriangle size={14} aria-hidden="true" />
                    ) : (
                      <Compass size={14} aria-hidden="true" />
                    )}{" "}
                    {notice.text}
                  </li>
                )}
              </ul>
            )}
            <p className="ar-honest" data-testid="ar-honest">
              {t("drv_ar_honest")}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
