import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  MapPin,
  MessageSquareWarning,
  Navigation,
  PackageCheck,
  Route,
  Scale,
  ShieldCheck,
  Truck,
  User,
  WifiOff,
  ExternalLink,
  Flag,
  LogIn,
} from "lucide-react";
import {
  adoptFieldOutbox,
  dismissRejectedOperation,
  enqueueDriverOperation,
  flushDriverOutbox,
  markDriverSynced,
  OUTBOX_CHANGED_EVENT,
  OutboxStorageFullError,
  queuedStopKeys,
  readDriverOutbox,
  readLastSync,
  readRejectedOperations,
} from "./DriverOutbox.js";
import {
  announceSessionExpired,
  InstructionCard,
  NeedsActionList,
  SafetyBanner,
  SESSION_EXPIRED_EVENT,
  openInstructionCount,
  SyncStatus,
  useDispatchInstructions,
  useDriverSafety,
} from "./DriverPanels.jsx";
import { ExceptionPanel } from "./ExceptionPanel.jsx";
import { RouteOverview } from "./RouteOverview.jsx";
import { TpaGuide } from "./TpaGuide.jsx";
import { rememberRecentTruck, TruckPicker } from "./TruckPicker.jsx";
import {
  arCapable,
  boundDriverOf,
  clockTime,
  mapsDirectionsUrl,
  pretripQueuedFor,
  receiptWeightRows,
  receiptWeights,
  safetyBlocksNewWork,
  spjListPath,
  withQueuedStops,
} from "./driverHelpers.js";
import { formatBytes, shrinkPhoto } from "./photo.js";
import "./driver.css";
import { apiFetch, FIELD_ROLE_KEY, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { localeFor, translate, useLanguage } from "../../shared/i18n/index.jsx";

// the AR navigator is its own chunk; drivers who never open it
// do not download it.
const ArNavigator = lazy(() => import("./ArNavigator.jsx").then((m) => ({ default: m.ArNavigator })));

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

const PRETRIP_ITEMS = ["rem", "mesin", "ban", "bbm", "oli", "bak_compactor", "lampu"];
const FRACTIONS = ["Residu", "Organik", "Anorganik"];
const BERAT_COMPONENTS = new Set(["rem", "mesin", "ban"]);

const PHOTO_ERROR_KEYS = {
  photo_too_big: "drv6_photo_too_big",
  photo_unreadable: "drv6_photo_unreadable",
  photo_read_failed: "drv_photo_read_failed",
};

function currentLang() {
  try {
    return localStorage.getItem("pythia_lang") === "en" ? "en" : "id";
  } catch {
    return "id";
  }
}

// Audit gap 1: every evidence photo is shrunk on the phone (longest side
// 1280 px, JPEG 0.7) before it is queued or uploaded; the size is shown.
async function readPhoto(file) {
  try {
    return await shrinkPhoto(file);
  } catch (err) {
    throw new Error(translate(currentLang(), PHOTO_ERROR_KEYS[err?.code] || "drv_photo_read_failed"));
  }
}

function PhotoSize({ photo }) {
  const { t, lang } = useLanguage();
  if (!photo?.bytes) return null;
  const size = formatBytes(photo.bytes, lang);
  return (
    <p className="driver-photo-size" data-testid="photo-size">
      {photo.resized && photo.originalBytes > photo.bytes
        ? t("drv6_photo_size_from")
            .replace("{size}", size)
            .replace("{orig}", formatBytes(photo.originalBytes, lang))
        : t("drv6_photo_size").replace("{size}", size)}
    </p>
  );
}

// H1: a failed or missing GPS fix falls back to the stop's own coordinates,
// flagged approx, and the screen says so; it is never shown as GPS.
function getPosition(stop) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ lat: stop.lat, lng: stop.lng, approx: true });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
        }),
      () => resolve({ lat: stop.lat, lng: stop.lng, approx: true }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

function GeotagLabel({ fix }) {
  const { t } = useLanguage();
  if (!fix) {
    return (
      <p className="driver-geotag" data-testid="arrival-geotag" data-geotag="pending">
        <MapPin size={16} /> {t("drv6_geo_locating")}
      </p>
    );
  }
  if (fix.approx) {
    return (
      <p className="driver-geotag approx" data-testid="arrival-geotag" data-geotag="approx">
        <MapPin size={16} /> {t("drv6_geo_approx")}
      </p>
    );
  }
  return (
    <p className="driver-geotag" data-testid="arrival-geotag" data-geotag="gps">
      <MapPin size={16} /> {t("drv6_geo_gps").replace("{n}", fix.accuracy_m ?? "?")}
    </p>
  );
}

function MapsLink({ target, name, testId }) {
  const { t } = useLanguage();
  const href = mapsDirectionsUrl(target);
  if (!href) return null;
  return (
    <a
      className="driver-btn ghost driver-maps-link"
      data-testid={testId}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("drv6_maps_open_aria").replace("{name}", name)}
    >
      <ExternalLink size={18} /> {t("drv6_maps_open")}
    </a>
  );
}

// #45: a network-level failure (fetch rejected / no response) is queueable;
// an HTTP error response is a permanent failure the driver must act on. The
// message is Indonesian (or English) from the catalog, never the raw server
// detail alone; a 401 means the backend no longer knows this session.
async function post(path, data) {
  const res = await apiFetch(path, { method: "POST", body: data, tokenKey: FIELD_TOKEN_KEY });
  if (!res.ok) {
    const lang = currentLang();
    if (res.status === 401) {
      announceSessionExpired();
      const expired = new Error(translate(lang, "drv6_session_expired"));
      expired.status = 401;
      throw expired;
    }
    const body = await res.json().catch(() => ({}));
    const base = translate(lang, "drv6_request_failed").replace("{code}", res.status);
    const error = new Error(
      typeof body.detail === "string" && body.detail ? `${base}: ${body.detail}` : base,
    );
    error.status = res.status;
    throw error;
  }
  markDriverSynced();
  return res.json();
}

// #45: post() variant whose failures carry a `network` flag so callers can
// route them to the durable outbox instead of surfacing a dead error.
async function postQueueable(path, data) {
  try {
    return await post(path, data);
  } catch (err) {
    // post() only throws with a parsed message for HTTP responses; a raw
    // TypeError comes from fetch itself (offline / unreachable backend).
    if (err instanceof TypeError || !err.message) {
      const wrapped = new Error(err.message || "network");
      wrapped.network = true;
      throw wrapped;
    }
    throw err;
  }
}

function receiptDoneFor(spj) {
  // The server is the source of truth: a receipt recorded on another device (or
  // after this browser's storage was cleared) must still count as done, or the
  // driver is asked to submit a second receipt for the same handover.
  if (spj?.receipt) return true;
  try {
    return localStorage.getItem(`pythia_receipt_${spj?.spj_id}`) === "done";
  } catch {
    return false;
  }
}

function Toast({ message }) {
  if (!message) return null;
  return (
    <div className="driver-toast" role="status">
      <Check size={16} /> {message}
    </div>
  );
}

// ── Pre-trip inspection ───────────────────────────────────────────────────────

function PreTripForm({ driver, done, onDone, say }) {
  const { t } = useLanguage();
  const [items, setItems] = useState({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const answered = Object.keys(items).length;
  const failures = PRETRIP_ITEMS.filter((key) => items[key] === false);
  const canSubmit = answered === PRETRIP_ITEMS.length && (failures.length === 0 || note.trim().length > 0);

  const markRestOk = () => {
    setItems((prev) => {
      const next = { ...prev };
      PRETRIP_ITEMS.forEach((key) => {
        if (!(key in next)) next[key] = true;
      });
      return next;
    });
  };

  const submit = async () => {
    setBusy(true);
    let pretripSaved = false;
    try {
      await postQueueable("/pretrip", {
        truck_code: driver.truck_code,
        driver_name: driver.driver_name,
        items,
        note,
      });
      pretripSaved = true;
      // A TIDAK item auto-creates a damage report (source: pretrip).
      for (const key of failures) {
        await post("/damage-reports", {
          truck_code: driver.truck_code,
          driver_name: driver.driver_name,
          component: key,
          severity: BERAT_COMPONENTS.has(key) ? "berat" : "ringan",
          note:
            note.trim() ||
            t("drv_pretrip_no_reason").replace(
              "{label}",
              t(`drv_pretrip_item_${key === "bak_compactor" ? "bak" : key}`),
            ),
          source: "pretrip",
        });
      }
      onDone();
    } catch (err) {
      if (pretripSaved) {
        onDone();
        say(t("drv_pretrip_damage_failed"));
      } else if (err?.network) {
        // #45: keep the inspection durably; it replays on reconnect.
        try {
          await enqueueDriverOperation({
            path: "/pretrip",
            data: { truck_code: driver.truck_code, driver_name: driver.driver_name, items, note },
            label: t("drv_pretrip_title"),
          });
          onDone();
          say(t("drv_queued_offline"));
        } catch (queueErr) {
          say(
            queueErr instanceof OutboxStorageFullError
              ? t("drv6_storage_full")
              : t("drv_pretrip_save_failed"),
            8000,
          );
        }
      } else {
        say(err.message || t("drv_pretrip_save_failed"));
      }
    } finally {
      setBusy(false);
    }
  };

  if (done === null) {
    return (
      <section className="driver-card" data-testid="pretrip-loading" aria-busy="true">
        <p className="driver-muted" role="status">
          {t("drv_pretrip_checking")}
        </p>
      </section>
    );
  }

  if (done) {
    return (
      <section className="driver-card" data-testid="pretrip-done">
        <div className="driver-card-head">
          <h2>
            <ClipboardCheck size={18} /> {t("drv_pretrip_title")}
          </h2>
          <span className="driver-badge done">{t("drv_pretrip_done_badge")}</span>
        </div>
        <p className="driver-muted">{t("drv_pretrip_done_desc")}</p>
      </section>
    );
  }

  return (
    <section className="driver-card" data-testid="pretrip-form">
      <div className="driver-card-head">
        <h2>
          <ClipboardCheck size={18} /> {t("drv_pretrip_title")}
        </h2>
        <span className="driver-badge">
          {answered}/{PRETRIP_ITEMS.length}
        </span>
      </div>
      <div className="driver-progress" aria-hidden="true">
        <div
          className="driver-progress-fill"
          style={{ transform: `scaleX(${answered / PRETRIP_ITEMS.length})` }}
        />
      </div>
      <ul className="pretrip-list">
        {PRETRIP_ITEMS.map((key) => (
          <li key={key} className="pretrip-item">
            <span>{t(`drv_pretrip_item_${key === "bak_compactor" ? "bak" : key}`)}</span>
            <div className="pretrip-choices">
              <button
                type="button"
                data-testid={`ok-${key}`}
                className={`pretrip-choice ok ${items[key] === true ? "active" : ""}`}
                onClick={() => setItems((p) => ({ ...p, [key]: true }))}
              >
                OK
              </button>
              <button
                type="button"
                data-testid={`tidak-${key}`}
                className={`pretrip-choice tidak ${items[key] === false ? "active" : ""}`}
                onClick={() => setItems((p) => ({ ...p, [key]: false }))}
              >
                {t("drv_no")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {failures.length > 0 && (
        <>
          <label className="driver-label" htmlFor="pretrip-note">
            {t("drv_pretrip_note_label")}
          </label>
          <textarea
            id="pretrip-note"
            className="driver-input"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("drv_pretrip_note_placeholder")}
          />
        </>
      )}
      <div className="driver-actions">
        <button
          type="button"
          className="driver-btn ghost"
          onClick={markRestOk}
          disabled={answered === PRETRIP_ITEMS.length}
        >
          {t("drv_pretrip_rest_ok")}
        </button>
        <button type="button" className="driver-btn primary" onClick={submit} disabled={!canSubmit || busy}>
          <Check size={16} /> {t("drv_pretrip_save")}
        </button>
      </div>
    </section>
  );
}

// ── Stop evidence (arrival → weighing → officer) ──────────────────────────────

function officerKey(stop) {
  return `pythia_officer_${stop.name}`;
}

function StopCard({ spj, stop, index, current, locked, blocked, arEnabled, onCompleted, say }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [arrival, setArrival] = useState(null);
  // H1: the arrival geotag is taken when the photo is attached and shown as
  // GPS (with accuracy) or as approximate; null while locating.
  const [arrivalFix, setArrivalFix] = useState(null);
  const [weighPhoto, setWeighPhoto] = useState(null);
  const [weighing, setWeighing] = useState([]);
  const [fraction, setFraction] = useState(FRACTIONS[0]);
  const [weight, setWeight] = useState("");
  const [officerPhoto, setOfficerPhoto] = useState(null);
  // R4: the officer at a TPS rarely changes; the last name used at this stop
  // is pre-filled on this phone so the critical path needs no typing.
  const [officerName, setOfficerName] = useState(() => {
    try {
      return localStorage.getItem(officerKey(stop)) || "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [ar, setAr] = useState(null);
  const [storageError, setStorageError] = useState(false);

  const completed = stop.status === "completed";
  // The server requires weighing only when the SPJ orders it (weigh_on_site),
  // so the step is asked only then; an SPJ without the flag skips it.
  const needsWeighing = spj.weigh_on_site === true;
  const stepLabels = needsWeighing
    ? [t("drv_step_arrival"), t("drv_step_weigh"), t("drv_step_officer")]
    : [t("drv_step_arrival"), t("drv_step_officer")];

  const step = useMemo(() => {
    if (!arrival) return 1;
    if (needsWeighing && weighing.length === 0) return 2;
    return needsWeighing ? 3 : 2;
  }, [arrival, weighing, needsWeighing]);
  const officerStep = needsWeighing ? 3 : 2;

  const handlePhoto = async (file, setter) => {
    if (!file) return;
    try {
      setter(await readPhoto(file));
    } catch (err) {
      say(err.message);
    }
  };

  const handleArrivalPhoto = async (file) => {
    if (!file) return;
    try {
      const photo = await readPhoto(file);
      setArrival(photo);
      setArrivalFix(null);
      setArrivalFix(await getPosition(stop));
    } catch (err) {
      say(err.message);
    }
  };

  // The AR dialog hands focus back to the button that opened it.
  const arOpenerRef = useRef(null);
  const openAr = async (event) => {
    arOpenerRef.current = event?.currentTarget || null;
    const orientationPermission = await requestOrientationPermission();
    setAr({ orientationPermission });
  };

  const closeAr = useCallback(() => setAr(null), []);

  useEffect(() => {
    if (ar || !arOpenerRef.current) return;
    const opener = arOpenerRef.current;
    arOpenerRef.current = null;
    if (opener.isConnected) opener.focus();
  }, [ar]);

  // an AR capture enters the same arrival step as a picked
  // photo (same size check via readPhoto); its GPS fix rides along so the
  // evidence records where the frame was actually taken.
  const captureFromAr = async (file, fix) => {
    setAr(null);
    setOpen(true);
    try {
      const photo = await readPhoto(file);
      setArrival({ ...photo, fix });
      if (Number.isFinite(fix?.lat) && Number.isFinite(fix?.lng)) {
        setArrivalFix({ lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracy_m });
      } else {
        setArrivalFix(await getPosition(stop));
      }
      say(t("drv_ar_captured"));
    } catch (err) {
      say(err.message);
    }
  };

  const openFormFromAr = () => {
    setAr(null);
    setOpen(true);
  };

  const addWeighing = () => {
    const kg = parseFloat(weight);
    if (!weighPhoto) {
      say(t("drv_weigh_missing"));
      return;
    }
    if (!Number.isFinite(kg) || kg <= 0) {
      say(t("drv_weigh_enter_weight"));
      return;
    }
    setWeighing((prev) => [
      ...prev,
      { fraction, weight_kg: kg, photo_name: weighPhoto.name, photo_b64: weighPhoto.b64 },
    ]);
    setWeighPhoto(null);
    setWeight("");
  };

  const submit = async () => {
    setBusy(true);
    setStorageError(false);
    try {
      localStorage.setItem(officerKey(stop), officerName.trim());
    } catch {
      // Pre-fill is a convenience only.
    }
    // #45: evidence is hoisted so the offline catch can queue it durably.
    let evidence = null;
    try {
      const pos = arrival.fix || arrivalFix || (await getPosition(stop));
      evidence = {
        arrival: {
          photo_name: arrival.name,
          photo_b64: arrival.b64,
          lat: pos.lat,
          lng: pos.lng,
          approx: Boolean(pos.approx),
          ...(!arrival.fix && !pos.approx && pos.accuracy_m != null ? { accuracy_m: pos.accuracy_m } : {}),
          ...(arrival.fix
            ? {
                source: "ar",
                accuracy_m: arrival.fix.accuracy_m,
                at: arrival.fix.at,
                fix_at: arrival.fix.fix_at,
              }
            : {}),
        },
        weighing: needsWeighing ? weighing : [],
        officer: { name: officerName.trim(), photo_name: officerPhoto.name, photo_b64: officerPhoto.b64 },
      };
      await postQueueable(`/spj/${spj.spj_id}/stops/${index}/complete`, { evidence });
      onCompleted();
    } catch (err) {
      if (err?.network && evidence) {
        // #45: queue durably; the outbox overlay marks the stop done locally
        // (the next stop unlocks) and replays the evidence on reconnect.
        try {
          await enqueueDriverOperation({
            path: `/spj/${spj.spj_id}/stops/${index}/complete`,
            data: { evidence },
            label: t("drv_stop_title")
              .replace("{n}", index + 1)
              .replace("{name}", stop.name),
          });
          onCompleted();
          say(t("drv_queued_offline"));
        } catch (queueErr) {
          // Never silent: the form stays filled and the driver is told why.
          if (queueErr instanceof OutboxStorageFullError) setStorageError(true);
          say(
            queueErr instanceof OutboxStorageFullError
              ? t("drv6_storage_full")
              : t("drv_stop_complete_failed"),
            8000,
          );
        }
      } else {
        say(err.message || t("drv_stop_complete_failed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    arrival && (!needsWeighing || weighing.length > 0) && officerPhoto && officerName.trim().length > 0;

  return (
    <article
      className={`driver-card stop-card ${completed ? "completed" : ""} ${locked ? "locked" : ""}`}
      data-testid={`stop-${index}`}
    >
      <div className="driver-card-head">
        <h2>
          <MapPin size={18} />{" "}
          {t("drv_stop_title")
            .replace("{n}", index + 1)
            .replace("{name}", stop.name)}
        </h2>
        {completed && (
          <span className={`driver-badge ${stop.queued ? "queued" : "done"}`}>
            {stop.queued ? t("drv6_stop_queued_badge") : t("drv_stop_selesai")}
          </span>
        )}
      </div>
      <p className="driver-muted">
        {stop.kecamatan} — {stop.address}
      </p>

      {completed && (
        <ul className="step-list">
          {stepLabels.map((label) => (
            <li key={label} className="step done">
              <CheckCircle2 size={15} /> {label}
            </li>
          ))}
        </ul>
      )}
      {completed && stop.queued && (
        <p className="driver-muted" data-testid="stop-queued-note">
          {t("drv6_stop_queued")}
        </p>
      )}

      {locked && !completed && <p className="driver-muted">{t("drv_stop_locked")}</p>}

      {!completed && (
        <div className="driver-actions">
          <MapsLink target={stop} name={stop.name} testId={`stop-maps-${index}`} />
        </div>
      )}

      {current && !completed && !open && blocked && (
        <p className="driver-held" data-testid="stop-held">
          {t("drv6_safety_held")}
        </p>
      )}

      {current && !completed && !open && (
        <div className="driver-actions">
          <button
            type="button"
            className="driver-btn primary"
            data-testid="stop-start"
            disabled={blocked}
            onClick={() => setOpen(true)}
          >
            <Camera size={18} /> {t("drv_stop_start")}
          </button>
        </div>
      )}

      {ar && (
        <Suspense fallback={null}>
          <ArNavigator
            spj={spj}
            stop={stop}
            index={index}
            orientationPermission={ar.orientationPermission}
            onClose={closeAr}
            onCapture={captureFromAr}
            onUseForm={openFormFromAr}
          />
        </Suspense>
      )}

      {current && !completed && open && (
        <div className="stop-form">
          <ol className="step-list">
            {stepLabels.map((label, i) => (
              <li key={label} className={`step ${step > i + 1 ? "done" : step === i + 1 ? "current" : ""}`}>
                {step > i + 1 ? <CheckCircle2 size={15} /> : <span className="step-num">{i + 1}</span>}
                {label}
              </li>
            ))}
          </ol>

          {/* Step 1: arrival photo (from the picker or the AR navigator). L4: AR
              is offered only here, after arrival, to find the TPS point on foot. */}
          {!arrival && arEnabled && (
            <div className="driver-actions">
              <button
                type="button"
                className="driver-btn ghost"
                data-testid="ar-nav-open"
                aria-label={t("drv_ar_open_aria").replace("{name}", stop.name)}
                onClick={openAr}
              >
                <Navigation size={16} /> {t("drv_ar_open")}
              </button>
            </div>
          )}
          <label className="driver-label" htmlFor={`arrival-${index}`}>
            {t("drv_arrival_label")}
          </label>
          <input
            id={`arrival-${index}`}
            data-testid="arrival-input"
            type="file"
            accept="image/*"
            capture="environment"
            className="driver-file"
            onChange={(e) => handleArrivalPhoto(e.target.files?.[0])}
          />
          {arrival && (
            <p className="driver-muted">{t("drv_photo_attached").replace("{name}", arrival.name)}</p>
          )}
          <PhotoSize photo={arrival} />
          {arrival && <GeotagLabel fix={arrivalFix} />}
          {arrival?.fix && (
            <figure className="arrival-ar" data-testid="arrival-ar-evidence">
              <img src={arrival.b64} alt={t("drv_ar_photo_alt")} />
              <figcaption>
                {t("drv_ar_photo_from_ar").replace("{n}", arrival.fix.accuracy_m ?? "?")}
              </figcaption>
            </figure>
          )}

          {/* Step 2: weighing (only when this SPJ weighs on site) */}
          {needsWeighing && step >= 2 && (
            <>
              <label className="driver-label" htmlFor={`weigh-${index}`}>
                {t("drv_weigh_label")}
              </label>
              <input
                id={`weigh-${index}`}
                data-testid="weigh-input"
                type="file"
                accept="image/*"
                capture="environment"
                className="driver-file"
                onChange={(e) => handlePhoto(e.target.files?.[0], setWeighPhoto)}
              />
              <PhotoSize photo={weighPhoto} />
              <div className="driver-row">
                <div>
                  <label className="driver-label" htmlFor={`fraction-${index}`}>
                    {t("drv_fraction")}
                  </label>
                  <select
                    id={`fraction-${index}`}
                    className="driver-input"
                    value={fraction}
                    onChange={(e) => setFraction(e.target.value)}
                  >
                    {FRACTIONS.map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="driver-label" htmlFor={`weight-${index}`}>
                    {t("drv_weight")}
                  </label>
                  <input
                    id={`weight-${index}`}
                    className="driver-input"
                    type="number"
                    min="0"
                    step="0.1"
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    placeholder="0"
                  />
                </div>
              </div>
              <div className="driver-actions">
                <button type="button" className="driver-btn ghost" onClick={addWeighing}>
                  <Scale size={16} /> {t("drv_weigh_add")}
                </button>
              </div>
              {weighing.length > 0 && (
                <ul className="weigh-list">
                  {weighing.map((w, i) => (
                    <li key={i}>
                      {w.fraction} — {w.weight_kg} kg
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {/* Last step: officer */}
          {step >= officerStep && (
            <>
              <label className="driver-label" htmlFor={`officer-${index}`}>
                {t("drv_officer_label")}
              </label>
              <input
                id={`officer-${index}`}
                data-testid="officer-input"
                type="file"
                accept="image/*"
                capture="environment"
                className="driver-file"
                onChange={(e) => handlePhoto(e.target.files?.[0], setOfficerPhoto)}
              />
              <PhotoSize photo={officerPhoto} />
              <label className="driver-label" htmlFor={`officer-name-${index}`}>
                {t("drv_officer_name_label")}
              </label>
              <input
                id={`officer-name-${index}`}
                className="driver-input"
                value={officerName}
                onChange={(e) => setOfficerName(e.target.value)}
                placeholder={t("drv_officer_name_placeholder")}
              />
              <div className="driver-actions">
                <button
                  type="button"
                  className="driver-btn primary"
                  onClick={submit}
                  disabled={!canSubmit || busy}
                >
                  <Check size={18} /> {t("drv_stop_complete")}
                </button>
              </div>
              {storageError && (
                <p className="driver-error" role="alert" data-testid="stop-storage-full">
                  {t("drv6_storage_full")}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}

// ── Delivery / receipt ────────────────────────────────────────────────────────

const WEIGHT_ROW_NAMES = { gross_weight_kg: "gross", tare_weight_kg: "tare", net_weight_kg: "net" };

// The receipt as the server recorded it: weights plus weight_labels. The POST
// answer carries it as `receipt`; without one the SPJ is read back.
async function recordedReceipt(spjId, body) {
  if (body?.receipt?.weight_labels) return body.receipt;
  try {
    const res = await apiFetch(`/spj/${encodeURIComponent(spjId)}`, { tokenKey: FIELD_TOKEN_KEY });
    return res.ok ? (await res.json()).receipt || null : null;
  } catch {
    return null;
  }
}

// H10: gross, tare and net exactly as recorded; one row per weight_labels key,
// and a weight the server did not record says so instead of showing a number.
function ReceiptWeights({ receipt }) {
  const { t, lang } = useLanguage();
  const rows = receiptWeightRows(receipt);
  if (rows.length === 0) return null;
  return (
    <dl className="receipt-weights" data-testid="receipt-weights">
      {rows.map((row) => {
        const name = WEIGHT_ROW_NAMES[row.key];
        return (
          <div key={row.key} className="receipt-weight" data-testid={`receipt-weight-${name}`}>
            <dt>{t(`drv7_weight_${name}`)}</dt>
            <dd>
              {row.kg === null
                ? t("drv7_weight_not_recorded")
                : `${row.kg.toLocaleString(localeFor(lang))} kg`}
            </dd>
            <dd className="receipt-weight-note">{t(`drv7_weight_${name}_desc`)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

// One tap opens the camera; the photo submits the receipt (or queues it
// offline). The ticket weights are optional and typed before the photo.
function DeliveryCard({ spj, say, onDone }) {
  const { t } = useLanguage();
  const [receipt, setReceipt] = useState(null);
  const [failed, setFailed] = useState(false);
  const [gross, setGross] = useState("");
  // The empty truck's weight rarely changes: the last tare used for this
  // truck is pre-filled on this phone.
  const tareKey = `pythia_driver_tare_${spj.truck_code}`;
  const [tare, setTare] = useState(() => {
    try {
      return localStorage.getItem(tareKey) || "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  // One id per submission attempt: a retry after a dropped response replays the
  // same id, so the server returns the original receipt instead of a conflict.
  const operationId = useRef(null);
  // R5: the gate wait starts when the driver reports arrival at the disposal
  // gate (device time, so an offline replay does not shorten the wait).
  const gateKey = `pythia_gate_${spj.spj_id}`;
  const [gateAt, setGateAt] = useState(() => {
    try {
      return localStorage.getItem(gateKey);
    } catch {
      return null;
    }
  });
  const weights = receiptWeights(gross, tare);

  const arriveAtGate = async () => {
    const at = new Date().toISOString();
    const path = "/safety/gate-arrival";
    const data = { spj_id: spj.spj_id, arrived_at: at };
    try {
      await postQueueable(path, data);
    } catch (err) {
      if (!err?.network) {
        say(err.message);
        return;
      }
      try {
        await enqueueDriverOperation({ path, data, label: t("drv6_gate_arrive") });
        say(t("drv_queued_offline"));
      } catch (queueErr) {
        say(
          queueErr instanceof OutboxStorageFullError ? t("drv6_storage_full") : t("drv6_gate_failed"),
          8000,
        );
        return;
      }
    }
    try {
      localStorage.setItem(gateKey, at);
    } catch {
      // The server (or the queue) holds the arrival; the flag is cosmetic.
    }
    setGateAt(at);
  };

  const markDone = () => {
    try {
      localStorage.setItem(`pythia_receipt_${spj.spj_id}`, "done");
    } catch {
      /* flag is best-effort; the server (or the queue) holds the receipt */
    }
  };

  const send = async (photo) => {
    if (!weights.ok) return;
    setBusy(true);
    setFailed(false);
    // Kept across a failed attempt so a retry is idempotent; a new photo or a
    // weight change starts a new operation.
    operationId.current = operationId.current || `${spj.spj_id}-${Date.now()}`;
    const path = `/spj/${spj.spj_id}/receipt`;
    const data = {
      photo_name: photo.name,
      photo_b64: photo.b64,
      ...weights.weights,
      operation_id: operationId.current,
    };
    if (data.tare_weight_kg) {
      try {
        localStorage.setItem(tareKey, String(data.tare_weight_kg));
      } catch {
        // Pre-fill is a convenience only.
      }
    }
    try {
      const body = await postQueueable(path, data);
      markDone();
      onDone(await recordedReceipt(spj.spj_id, body));
    } catch (err) {
      if (err?.network) {
        // #45: the receipt replays with its stable operation_id, so a
        // reconnect can never double-record the handover.
        try {
          await enqueueDriverOperation({ path, data, label: t("drv_receipt_title") });
        } catch (queueErr) {
          setFailed(true);
          say(
            queueErr instanceof OutboxStorageFullError ? t("drv6_storage_full") : t("drv_receipt_failed"),
            8000,
          );
          return;
        }
        markDone();
        onDone(null);
        say(t("drv_queued_offline"));
      } else {
        setFailed(true);
        say(err.message || t("drv_receipt_failed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePhoto = async (file) => {
    if (!file || busy || !weights.ok) return;
    setBusy(true);
    let photo;
    try {
      photo = await readPhoto(file);
    } catch (err) {
      setBusy(false);
      say(err.message);
      return;
    }
    operationId.current = null; // a new photo is a new submission
    setReceipt(photo);
    await send(photo);
  };

  const editWeight = (setter) => (e) => {
    setter(e.target.value);
    operationId.current = null; // edited weights are a new submission
  };

  const cameraDisabled = busy || !weights.ok;

  return (
    <section className="driver-card" data-testid="delivery-card" data-spj-id={spj.spj_id}>
      <div className="driver-card-head">
        <h2>
          <PackageCheck size={18} /> {t("drv_receipt_title")}
        </h2>
      </div>
      <p className="driver-muted">{t("drv_receipt_intro").replace("{destination}", spj.destination)}</p>
      <TpaGuide
        spj={spj}
        gateAt={gateAt}
        onArriveGate={arriveAtGate}
        fallback={
          gateAt ? (
            <p className="driver-geotag" data-testid="gate-arrived">
              <Flag size={16} />
              {t("drv6_gate_arrived").replace("{time}", clockTime(gateAt) || "—")}
            </p>
          ) : (
            <div className="driver-actions">
              <button
                type="button"
                className="driver-btn ghost"
                data-testid="gate-arrival"
                onClick={arriveAtGate}
              >
                <Flag size={18} /> {t("drv6_gate_arrive")}
              </button>
            </div>
          )
        }
      />
      <div className="driver-row">
        <div>
          <label className="driver-label" htmlFor="receipt-gross">
            {t("drv7_receipt_gross_label")}
          </label>
          <input
            id="receipt-gross"
            data-testid="receipt-gross"
            className="driver-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={gross}
            disabled={busy}
            onChange={editWeight(setGross)}
            placeholder={t("drv_receipt_weight_placeholder")}
          />
        </div>
        <div>
          <label className="driver-label" htmlFor="receipt-tare">
            {t("drv7_receipt_tare_label")}
          </label>
          <input
            id="receipt-tare"
            data-testid="receipt-tare"
            className="driver-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={tare}
            disabled={busy}
            onChange={editWeight(setTare)}
            placeholder={t("drv7_receipt_tare_placeholder")}
          />
        </div>
      </div>
      <p className="driver-muted">{t("drv7_receipt_weights_hint")}</p>
      {!weights.ok && (
        <p className="driver-error" role="alert" data-testid="receipt-weight-error">
          {t(`drv7_receipt_${weights.error}_invalid`)}
        </p>
      )}
      <div className="driver-actions">
        <label
          className={`driver-btn primary driver-camera${cameraDisabled ? " is-disabled" : ""}`}
          data-testid="receipt-camera"
        >
          <input
            id="receipt-photo"
            data-testid="receipt-input"
            type="file"
            accept="image/*"
            capture="environment"
            className="driver-camera-input"
            disabled={cameraDisabled}
            onChange={(e) => {
              handlePhoto(e.target.files?.[0]);
              e.target.value = ""; // permit choosing the same image again
            }}
          />
          <Camera size={20} /> {busy ? t("drv_receipt_sending") : t("drv7_receipt_camera")}
        </label>
      </div>
      {receipt && <p className="driver-muted">{t("drv_photo_attached").replace("{name}", receipt.name)}</p>}
      <PhotoSize photo={receipt} />
      {failed && receipt && (
        <div className="driver-actions">
          <button
            type="button"
            className="driver-btn ghost"
            data-testid="receipt-retry"
            onClick={() => send(receipt)}
            disabled={cameraDisabled}
          >
            <Check size={18} /> {t("drv_receipt_send")}
          </button>
        </div>
      )}
    </section>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

// R3: the last live SPJ list per truck survives a reload and a long offline
// shift. List items carry no route geometry (route_point_count only); the AR
// path is read from /spj/active-path/{truck}.
function spjCacheKey(truckCode) {
  return `pythia_driver_spj_${truckCode}`;
}

function readSpjCache(truckCode) {
  try {
    const cached = JSON.parse(localStorage.getItem(spjCacheKey(truckCode)) || "null");
    return cached && typeof cached === "object" ? cached : null;
  } catch {
    return null;
  }
}

function writeSpjCache(truckCode, patch) {
  const next = { ...(readSpjCache(truckCode) || {}), ...patch };
  try {
    localStorage.setItem(spjCacheKey(truckCode), JSON.stringify(next));
  } catch {
    // The cache is a fallback; the live list is already on screen.
  }
}

// The last GET /api/driver/session, so a bound driver keeps their truck offline.
const SESSION_CACHE_KEY = "pythia_driver_session";

function readDriverSession() {
  try {
    const cached = JSON.parse(localStorage.getItem(SESSION_CACHE_KEY) || "null");
    return cached && typeof cached === "object" ? cached : null;
  } catch {
    return null;
  }
}

function readPickedDriver() {
  try {
    return JSON.parse(localStorage.getItem("pythia_driver"));
  } catch {
    return null;
  }
}

function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pretripCacheKey(truckCode) {
  return `pythia_driver_pretrip_${truckCode}`;
}

function pretripDoneLocally(truckCode) {
  try {
    if (localStorage.getItem(pretripCacheKey(truckCode)) === localDay()) return true;
  } catch {
    // Storage blocked: fall through to the queue.
  }
  return pretripQueuedFor(readDriverOutbox(), truckCode);
}

function rememberPretrip(truckCode) {
  try {
    localStorage.setItem(pretripCacheKey(truckCode), localDay());
  } catch {
    // Best effort.
  }
}

function readDestinations() {
  try {
    const list = JSON.parse(localStorage.getItem("pythia_driver_destinations") || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// The installed driver app opens /driver, not the command-centre login.
function useDriverManifest(lang) {
  useEffect(() => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return undefined;
    const previous = link.getAttribute("href");
    link.setAttribute(
      "href",
      lang === "en" ? "/manifest.driver.webmanifest" : "/manifest.driver.id.webmanifest",
    );
    return () => {
      if (previous) link.setAttribute("href", previous);
    };
  }, [lang]);
}

function destinationTarget(spj, destinations) {
  const facility = destinations.find(
    (d) => d?.destination === spj.destination || d?.name === spj.destination,
  );
  return { lat: facility?.lat ?? null, lng: facility?.lng ?? null, name: spj.destination };
}

function DestinationCard({ spj, destinations }) {
  const { t } = useLanguage();
  const target = destinationTarget(spj, destinations);
  const hasCoord = Number.isFinite(Number(target.lat)) && target.lat !== null && target.lng !== null;
  return (
    <section className="driver-card" data-testid="destination-card">
      <h2>
        <Flag size={18} /> {t("drv6_dest_title").replace("{name}", spj.destination)}
      </h2>
      {!hasCoord && <p className="driver-muted">{t("drv6_dest_name_only")}</p>}
      <div className="driver-actions">
        <MapsLink target={target} name={spj.destination} testId="destination-maps" />
      </div>
    </section>
  );
}

// L3: one field app. The old /field instructions are the Instruksi tab and the
// exception buttons the Lapor tab; ?tab= keeps the choice in the URL so the
// back button and the /field redirect land on the right tab.
const TABS = [
  { id: "rute", icon: Route, label: "drv10_tab_route" },
  { id: "instruksi", icon: ClipboardList, label: "drv10_tab_instructions" },
  { id: "lapor", icon: MessageSquareWarning, label: "drv10_tab_report" },
];

export default function DriverApp() {
  const { t, lang } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = TABS.some((item) => item.id === searchParams.get("tab")) ? searchParams.get("tab") : "rute";
  const selectTab = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id === "rute") next.delete("tab");
    else next.set("tab", id);
    setSearchParams(next, { replace: true });
  };
  const [session, setSession] = useState(() => readDriverSession());
  const [pickedDriver, setPickedDriver] = useState(() => readPickedDriver());
  // A personal driver account is bound to its truck: no picker, no "change".
  const boundDriver = useMemo(() => boundDriverOf(session), [session]);
  const driver = boundDriver || pickedDriver;
  const [fleet, setFleet] = useState([]);
  const [spjAktif, setSpjAktif] = useState(() =>
    driver ? (readSpjCache(driver.truck_code)?.aktif ?? null) : null,
  );
  const [history, setHistory] = useState(() =>
    driver ? readSpjCache(driver.truck_code)?.selesai || [] : [],
  );
  // null = today's inspection status not known yet: show neither the form nor
  // the done card, so the form never flashes up for a truck already inspected.
  const [pretripDone, setPretripDone] = useState(null);
  const [screen, setScreen] = useState("gate");
  const [toast, setToast] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  // false, or { receipt, spjId } once the receipt is sent (receipt null when queued).
  const [doneScreen, setDoneScreen] = useState(false);
  // #45: durable outbox — queued driver mutations replay on reconnect.
  const [outboxItems, setOutboxItems] = useState(() => readDriverOutbox());
  const [rejected, setRejected] = useState(() => readRejectedOperations());
  const [lastSync, setLastSync] = useState(() => readLastSync());
  const [flushing, setFlushing] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [destinations, setDestinations] = useState(() => readDestinations());
  const queuedCount = outboxItems.length;
  const safety = useDriverSafety(driver?.truck_code);
  const instructionFeed = useDispatchInstructions(driver?.truck_code);
  const blocked = safetyBlocksNewWork(safety);
  const arEnabled = useMemo(
    () =>
      arCapable({
        isSecureContext: window.isSecureContext,
        mediaDevices: navigator.mediaDevices,
        deviceMemory: navigator.deviceMemory,
      }),
    [],
  );
  useDriverManifest(lang);

  const toastTimer = useRef(null);
  const say = useCallback((msg, ms = 4000) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), ms);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  useEffect(() => {
    let token = null;
    try {
      token = localStorage.getItem(FIELD_TOKEN_KEY);
    } catch {
      // Storage blocked: no session to ask about.
    }
    if (!token) return;
    apiFetch("/driver/session", { tokenKey: FIELD_TOKEN_KEY })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        const next = {
          username: body?.username ?? null,
          role: body?.role ?? null,
          truck_code: body?.truck_code ?? null,
          display_name: body?.display_name ?? null,
          shared_account: Boolean(body?.shared_account),
        };
        const text = JSON.stringify(next);
        try {
          localStorage.setItem(SESSION_CACHE_KEY, text);
        } catch {
          // The cached copy only serves offline starts.
        }
        setSession((prev) => (JSON.stringify(prev) === text ? prev : next));
      })
      // Offline: the cached session (if any) stays in force.
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiFetch("/fleet", { tokenKey: FIELD_TOKEN_KEY })
      .then((r) => r.json())
      .then((body) => setFleet(Array.isArray(body) ? body : body.trucks || []))
      .catch(() => setOnline(false));
    apiFetch("/spj/destinations", { tokenKey: FIELD_TOKEN_KEY })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        const list = Array.isArray(body?.destinations) ? body.destinations : [];
        setDestinations(list);
        try {
          localStorage.setItem("pythia_driver_destinations", JSON.stringify(list));
        } catch {
          // Cached copy is optional.
        }
      })
      .catch(() => {});
  }, []);

  const drivers = useMemo(
    () =>
      [...fleet]
        .map((t) => ({ name: t.driver_name, code: t.truck_code }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    [fleet],
  );

  const loadSpj = useCallback(() => {
    if (!driver) return;
    const truck = driver.truck_code;
    const cached = () => readSpjCache(truck) || {};
    // The server filters by truck (and always does for a bound driver); the
    // client-side match below stays as a guard.
    apiFetch(spjListPath("aktif", truck), { tokenKey: FIELD_TOKEN_KEY })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const body = await r.json();
        const mine = (body.spj || []).find((s) => s.truck_code === truck) || null;
        setSpjAktif(mine);
        if (r.headers.get("X-Pythia-Stale") === "1") {
          setOnline(false);
          return;
        }
        setOnline(true);
        markDriverSynced();
        setLastSync(readLastSync());
        writeSpjCache(truck, { aktif: mine });
      })
      .catch(() => {
        // Offline (or no service-worker copy): keep what is on screen, or the
        // last live copy saved on this phone.
        setOnline(false);
        setSpjAktif((prev) => prev || cached().aktif || null);
      });
    apiFetch(spjListPath("selesai", truck, 5), { tokenKey: FIELD_TOKEN_KEY })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const body = await r.json();
        // Newest first: the newest completed order is the one the driver is
        // working on now; receipt state comes from the server.
        const mine = (body.spj || [])
          .filter((s) => s.truck_code === truck)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        setHistory(mine);
        if (r.headers.get("X-Pythia-Stale") !== "1") {
          writeSpjCache(truck, { selesai: mine.slice(0, 5) });
        }
      })
      .catch(() => {
        setHistory((prev) => (prev.length > 0 ? prev : cached().selesai || []));
      });
  }, [driver]);

  useEffect(() => {
    loadSpj();
    const id = setInterval(loadSpj, 8000);
    return () => clearInterval(id);
  }, [loadSpj]);

  useEffect(() => {
    if (!driver) return;
    const truck = driver.truck_code;
    setPretripDone(pretripDoneLocally(truck) ? true : null);
    apiFetch(`/pretrip/today/${truck}`, { tokenKey: FIELD_TOKEN_KEY })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (body.done) rememberPretrip(truck);
        setPretripDone(Boolean(body.done) || pretripDoneLocally(truck));
      })
      // Offline or unreachable: an inspection done or queued on this phone
      // today counts; otherwise show the form (a submission queues).
      .catch(() => setPretripDone(pretripDoneLocally(truck)));
  }, [driver]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // Item 9: the backend restarted and forgot this session.
  useEffect(() => {
    const onExpired = () => setSessionExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const signInAgain = () => {
    try {
      localStorage.removeItem(FIELD_TOKEN_KEY);
      localStorage.removeItem(FIELD_ROLE_KEY);
      localStorage.removeItem(SESSION_CACHE_KEY);
    } catch {
      // Storage blocked: the gate still validates the token on load.
    }
    window.location.reload();
  };

  // #45: replay the durable queue when connectivity returns, a new operation
  // is queued, or the periodic retry fires. Never in a tight loop.
  const flushQueue = useCallback(async () => {
    if (readDriverOutbox().length === 0) {
      setOutboxItems([]);
      return;
    }
    setFlushing(true);
    try {
      const result = await flushDriverOutbox();
      setOutboxItems(readDriverOutbox());
      setRejected(readRejectedOperations());
      setLastSync(readLastSync());
      if (result.unauthorized) announceSessionExpired();
      if (result.rejected.length > 0) {
        say(t("drv6_rejected_toast").replace("{n}", result.rejected.length), 8000);
      } else if (result.flushed > 0) {
        say(t("drv_synced_n").replace("{n}", result.flushed));
      }
      if (result.flushed > 0 || result.rejected.length > 0) loadSpj();
    } finally {
      setFlushing(false);
    }
  }, [loadSpj, say, t]);

  useEffect(() => {
    adoptFieldOutbox().then((moved) => {
      if (moved > 0) setOutboxItems(readDriverOutbox());
    });
  }, []);

  useEffect(() => {
    const onChanged = () => {
      setOutboxItems(readDriverOutbox());
      setRejected(readRejectedOperations());
    };
    window.addEventListener(OUTBOX_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(OUTBOX_CHANGED_EVENT, onChanged);
  }, []);

  const flushRef = useRef(flushQueue);
  useEffect(() => {
    flushRef.current = flushQueue;
  }, [flushQueue]);
  const canFlush = queuedCount > 0 && !sessionExpired;

  // A newly queued item (or the queue found on load) is tried once at once.
  useEffect(() => {
    if (canFlush) flushRef.current();
  }, [canFlush, queuedCount]);

  useEffect(() => {
    if (!canFlush) return undefined;
    const onOnline = () => flushRef.current();
    window.addEventListener("online", onOnline);
    // Connectivity may return without an `online` event.
    const id = setInterval(() => flushRef.current(), 10000);
    return () => {
      window.removeEventListener("online", onOnline);
      clearInterval(id);
    };
  }, [canFlush]);

  useEffect(() => {
    setScreen(driver ? "home" : "gate");
  }, [driver]);

  // A new truck (picked, switched, or bound by the session on a personal
  // account's first start) starts from that truck's saved lists.
  const shownTruck = useRef(driver?.truck_code);
  useEffect(() => {
    const truck = driver?.truck_code;
    if (shownTruck.current === truck) return;
    shownTruck.current = truck;
    const cached = (truck && readSpjCache(truck)) || {};
    setSpjAktif(cached.aktif ?? null);
    setHistory(cached.selesai || []);
    setDoneScreen(false);
  }, [driver]);

  // A receipt queued offline: once the outbox no longer holds it, read the SPJ
  // once and show the stored weights in place of the pending note.
  const queuedReceiptSpj = doneScreen && !doneScreen.receipt ? doneScreen.spjId : null;
  const receiptStillQueued = Boolean(
    queuedReceiptSpj && outboxItems.some((item) => item.path === `/spj/${queuedReceiptSpj}/receipt`),
  );
  useEffect(() => {
    if (!queuedReceiptSpj || receiptStillQueued) return undefined;
    let cancelled = false;
    recordedReceipt(queuedReceiptSpj, null).then((receipt) => {
      if (cancelled || !receipt) return;
      setDoneScreen((prev) => (prev && prev.spjId === queuedReceiptSpj ? { ...prev, receipt } : prev));
    });
    return () => {
      cancelled = true;
    };
  }, [queuedReceiptSpj, receiptStillQueued]);

  const pickDriver = (d) => {
    const next = { driver_name: d.name, truck_code: d.code };
    rememberRecentTruck({ name: d.name, code: d.code });
    try {
      localStorage.setItem("pythia_driver", JSON.stringify(next));
    } catch {
      // The choice still applies for this session.
    }
    setPickedDriver(next);
  };

  const switchDriver = () => {
    try {
      localStorage.removeItem("pythia_driver");
    } catch {
      // Nothing stored.
    }
    setPickedDriver(null);
  };

  const dismissRejected = (opId) => {
    dismissRejectedOperation(opId);
    setRejected(readRejectedOperations());
  };

  const sessionCard = sessionExpired && (
    <section className="driver-card driver-session" data-testid="driver-session-expired" role="alert">
      <h2>
        <LogIn size={18} /> {t("drv6_session_expired")}
      </h2>
      <p className="driver-muted">{t("drv6_session_expired_desc")}</p>
      <div className="driver-actions">
        <button type="button" className="driver-btn primary" onClick={signInAgain}>
          <LogIn size={18} /> {t("drv6_sign_in_again")}
        </button>
      </div>
    </section>
  );

  // ── Gate ──
  if (screen === "gate" || !driver) {
    return (
      <main className="driver-shell" data-testid="driver-app">
        <header className="driver-header">
          <span className="driver-brand">
            <span className="driver-brand-mark">
              <Truck size={19} />
            </span>
            <span>
              <strong>Pythia Driver</strong>
              <small>{t("drv_subtitle")}</small>
            </span>
          </span>
          {!online && (
            <span className="driver-offline">
              <WifiOff size={14} /> {t("drv_offline")}
            </span>
          )}
        </header>
        {sessionCard}
        <section className="driver-card" data-testid="driver-truck-gate">
          <div className="driver-card-head">
            <h2>
              <User size={18} /> {t("drv10_pick_title")}
            </h2>
            {/* H3: the roster is the simulated fleet, not real personnel. */}
            <span className="driver-badge driver-provenance" data-testid="driver-roster-sim">
              {t("drv6_sim_badge")}
            </span>
          </div>
          <p className="driver-muted">{t("drv6_sim_roster")}</p>
          <TruckPicker drivers={drivers} onPick={pickDriver} />
        </section>
        <Toast message={toast} />
      </main>
    );
  }

  const spjView = withQueuedStops(spjAktif, queuedStopKeys(outboxItems));
  const stops = spjView?.stops || [];
  const pendingIndex = stops.findIndex((s) => s.status !== "completed");
  const allStopsDone = spjView && pendingIndex === -1 && stops.length > 0;
  // Newest completed SPJ still missing its receipt: `history` arrives newest
  // first, and receipt state comes from the server, so two browsers agree.
  const pendingReceipt = spjAktif ? null : history.find((s) => !s.receipt) || null;
  const openInstructions = openInstructionCount(instructionFeed.list, outboxItems);

  return (
    <main className="driver-shell" data-testid="driver-app">
      <header className="driver-header">
        <span className="driver-brand">
          <span className="driver-brand-mark">
            <Route size={19} />
          </span>
          <span>
            <strong>Pythia Driver</strong>
            <small>{driver.truck_code}</small>
          </span>
        </span>
        <span className="driver-header-right">
          {queuedCount > 0 && (
            <span className="driver-queued" data-testid="driver-queued-count">
              {flushing ? t("drv_syncing") : t("drv10_waiting_signal").replace("{n}", queuedCount)}
            </span>
          )}
          {!online && (
            <span className="driver-offline">
              <WifiOff size={14} /> {t("drv_offline")}
            </span>
          )}
          {!driver.bound && (
            <button type="button" className="driver-link" onClick={switchDriver}>
              {t("drv_switch")}
            </button>
          )}
        </span>
      </header>

      <nav className="driver-tabs" aria-label={t("drv10_tabs_label")}>
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            className={`driver-tab${tab === id ? " active" : ""}`}
            data-testid={`driver-tab-${id}`}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => selectTab(id)}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{t(label)}</span>
            {id === "instruksi" && openInstructions > 0 && (
              <span className="driver-tab-count" data-testid="driver-tab-instruksi-count">
                {openInstructions}
              </span>
            )}
          </button>
        ))}
      </nav>

      <SyncStatus
        lastSync={lastSync}
        pending={queuedCount}
        flushing={flushing}
        online={online}
        onRetry={canFlush ? flushQueue : undefined}
      />
      {sessionCard}
      <SafetyBanner safety={safety} />
      <NeedsActionList items={rejected} onDismiss={dismissRejected} />

      {tab === "instruksi" && (
        <InstructionCard
          feed={instructionFeed}
          blocked={blocked}
          outboxItems={outboxItems}
          say={say}
          showEmpty
        />
      )}

      {tab === "lapor" && (
        <ExceptionPanel
          driver={driver}
          spj={spjView}
          stopIndex={pendingIndex}
          outboxItems={outboxItems}
          say={say}
        />
      )}

      {tab === "rute" && (
        <>
          <section className="driver-card driver-identity">
            <p className="driver-kicker">{t("drv_kicker")}</p>
            <h1>
              {driver.driver_name}{" "}
              {/* H3: a picked name is from the simulated roster; a bound account names itself. */}
              {!driver.bound && (
                <span className="driver-badge driver-provenance" data-testid="driver-identity-sim">
                  {t("drv6_sim_badge")}
                </span>
              )}
            </h1>
            <p className="driver-muted">
              {driver.truck_code}
              {spjAktif ? ` — ${spjAktif.spj_number} → ${spjAktif.destination}` : t("drv_no_spj")}
            </p>
          </section>

          <InstructionCard feed={instructionFeed} blocked={blocked} outboxItems={outboxItems} say={say} />

          {doneScreen ? (
            <section className="driver-card driver-done" data-testid="done-screen">
              <ShieldCheck size={40} />
              <h1>{t("drv_done_title")}</h1>
              <p className="driver-muted">{t("drv_done_desc")}</p>
              {doneScreen.receipt ? (
                <ReceiptWeights receipt={doneScreen.receipt} />
              ) : (
                <p className="driver-muted" data-testid="receipt-weights-pending">
                  {t("drv7_receipt_weights_pending")}
                </p>
              )}
              <button type="button" className="driver-btn ghost" onClick={() => setDoneScreen(false)}>
                <ArrowLeft size={16} /> {t("drv_done_back")}
              </button>
            </section>
          ) : (
            <>
              <PreTripForm
                driver={driver}
                done={pretripDone}
                onDone={() => {
                  rememberPretrip(driver.truck_code);
                  setPretripDone(true);
                  say(t("drv_pretrip_saved"));
                }}
                say={say}
              />

              {spjView && (
                <RouteOverview spj={spjView} destination={destinationTarget(spjView, destinations)} />
              )}

              {spjView &&
                stops.map((stop, i) => (
                  <StopCard
                    key={`${spjView.spj_id}-${i}`}
                    spj={spjView}
                    stop={stop}
                    index={i}
                    current={i === pendingIndex}
                    locked={pendingIndex !== -1 && i > pendingIndex}
                    blocked={blocked}
                    arEnabled={arEnabled}
                    onCompleted={() => {
                      loadSpj();
                      say(t("drv_stop_done_toast"));
                    }}
                    say={say}
                  />
                ))}

              {spjView && <DestinationCard spj={spjView} destinations={destinations} />}

              {allStopsDone && (
                <DeliveryCard
                  spj={spjView}
                  say={say}
                  onDone={(receipt) => {
                    setDoneScreen({ receipt, spjId: spjView.spj_id });
                    loadSpj();
                  }}
                />
              )}

              {!spjAktif && history[0] && !receiptDoneFor(history[0]) && (
                <DeliveryCard
                  spj={pendingReceipt}
                  say={say}
                  onDone={(receipt) => {
                    setDoneScreen({ receipt, spjId: pendingReceipt.spj_id });
                    loadSpj();
                  }}
                />
              )}

              {!spjAktif && (
                <section className="driver-card">
                  <p className="driver-muted">
                    {t("drv_no_spj_desc")} {t("drv_no_spj_hint")}
                  </p>
                </section>
              )}

              {history.length > 0 && !doneScreen && (
                <section className="driver-card" data-testid="history-card">
                  <h2>
                    <ClipboardCheck size={18} /> {t("drv_history_title")}
                  </h2>
                  <ul className="history-list">
                    {history.slice(0, 5).map((s) => (
                      <li key={s.spj_id}>
                        <span>
                          <strong>{s.spj_number}</strong>
                          <small>
                            {s.date} — {s.destination}
                          </small>
                        </span>
                        <span className="driver-badge done">{t("drv_history_done")}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </>
      )}

      <Toast message={toast} />
    </main>
  );
}
