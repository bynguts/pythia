import { useMemo, useState } from "react";
import { ArrowLeft, Camera, Check, CloudOff, Scale } from "lucide-react";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { stopText } from "../../shared/format/stopText.js";
import { enqueueDriverOperation, OutboxStorageFullError } from "./DriverOutbox.js";
import { SyncChip } from "./DriverPanels.jsx";
import { clockTime } from "./driverHelpers.js";
import { formatBytes } from "./photo.js";
import { getPosition, postQueueable, readPhoto } from "./tripApi.js";

export const FRACTIONS = ["Residu", "Organik", "Anorganik"];
// The server's per-entry bound (MAX_STOP_WEIGHT_KG in app/field/spj.py).
export const MAX_FRACTION_KG = 60000;

function officerKey(stop) {
  return `pythia_officer_${stop.name}`;
}

export function PhotoSize({ photo }) {
  const { t, lang } = useLanguage();
  if (!photo?.bytes) return null;
  const size = formatBytes(photo.bytes, lang);
  return (
    <p className="drt-size" data-testid="photo-size">
      {photo.resized && photo.originalBytes > photo.bytes
        ? t("drv6_photo_size_from")
            .replace("{size}", size)
            .replace("{orig}", formatBytes(photo.originalBytes, lang))
        : t("drv6_photo_size").replace("{size}", size)}
    </p>
  );
}

// H1: GPS (with accuracy), approximate (the stop's own point), or still locating.
function GeotagLabel({ fix }) {
  const { t } = useLanguage();
  if (!fix) {
    return (
      <p className="drt-dot-label is-pending" data-testid="arrival-geotag" data-geotag="pending">
        {t("drv6_geo_locating")}
      </p>
    );
  }
  if (fix.approx) {
    return (
      <p className="drt-dot-label is-approx" data-testid="arrival-geotag" data-geotag="approx">
        {t("drv6_geo_approx")}
      </p>
    );
  }
  return (
    <p
      className="drt-dot-label"
      data-testid="arrival-geotag"
      data-geotag="gps"
      title={t("drv6_geo_gps").replace("{n}", fix.accuracy_m ?? "?")}
    >
      {t("d2_proof_location_attached")}
    </p>
  );
}

// One kg field per fraction: blank is "not weighed", otherwise 0 < kg <= 60,000.
export function fractionWeights(values) {
  const entries = [];
  const invalid = [];
  FRACTIONS.forEach((fraction) => {
    const text = String(values[fraction] ?? "").trim();
    if (!text) return;
    const kg = Number(text);
    if (!Number.isFinite(kg) || kg <= 0 || kg > MAX_FRACTION_KG) invalid.push(fraction);
    else entries.push({ fraction, weight_kg: kg });
  });
  return { entries, invalid };
}

// rq5U9: the proof of one stop: arrival photo (geotagged), weight by type when
// the SPJ weighs on site, and the TPS officer. Offline it queues like before:
// the stop shows done on the phone and the evidence replays on reconnect.
export function StopProof({
  spj,
  stop,
  index,
  online,
  pending,
  flushing,
  initialArrival = null,
  onClose,
  onCompleted,
  say,
}) {
  const { t } = useLanguage();
  const [arrival, setArrival] = useState(initialArrival?.photo || null);
  const [arrivalFix, setArrivalFix] = useState(initialArrival?.fix || null);
  const [arrivalAt, setArrivalAt] = useState(() => (initialArrival ? new Date().toISOString() : null));
  const [scalePhoto, setScalePhoto] = useState(null);
  const [weights, setWeights] = useState({});
  const [officerPhoto, setOfficerPhoto] = useState(null);
  // R4: the officer at a TPS rarely changes; the last name used here is pre-filled.
  const [officerName, setOfficerName] = useState(() => {
    try {
      return localStorage.getItem(officerKey(stop)) || "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [storageError, setStorageError] = useState(false);

  // The server requires weighing only when the SPJ orders it (weigh_on_site).
  const needsWeighing = spj.weigh_on_site === true;
  const { entries, invalid } = useMemo(() => fractionWeights(weights), [weights]);
  const steps = [
    Boolean(arrival),
    ...(needsWeighing ? [Boolean(scalePhoto) && entries.length > 0 && invalid.length === 0] : []),
    Boolean(officerPhoto) && officerName.trim().length > 0,
  ];
  const left = steps.filter((done) => !done).length;
  const canSubmit = left === 0 && !busy;

  const handleArrivalPhoto = async (file) => {
    if (!file) return;
    try {
      const photo = await readPhoto(file);
      setArrival(photo);
      setArrivalAt(new Date().toISOString());
      setArrivalFix(null);
      setArrivalFix(await getPosition(stop));
    } catch (err) {
      say(err.message);
    }
  };

  const handlePhoto = async (file, setter) => {
    if (!file) return;
    try {
      setter(await readPhoto(file));
    } catch (err) {
      say(err.message);
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setStorageError(false);
    try {
      localStorage.setItem(officerKey(stop), officerName.trim());
    } catch {
      // Pre-fill is a convenience only.
    }
    // #45: evidence is hoisted so the offline catch can queue it durably.
    let evidence = null;
    const path = `/spj/${spj.spj_id}/stops/${index}/complete`;
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
        // One scale photo backs every fraction weighed at this stop.
        weighing: needsWeighing
          ? entries.map((entry) => ({ ...entry, photo_name: scalePhoto.name, photo_b64: scalePhoto.b64 }))
          : [],
        officer: { name: officerName.trim(), photo_name: officerPhoto.name, photo_b64: officerPhoto.b64 },
      };
      await postQueueable(path, { evidence });
      onCompleted();
    } catch (err) {
      if (err?.network && evidence) {
        // #45: queue durably; the outbox overlay marks the stop done locally
        // (the next stop unlocks) and replays the evidence on reconnect.
        try {
          await enqueueDriverOperation({
            path,
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

  const stepNum = (n, done) => (
    <span className={`drt-step-num${done ? "" : " is-todo"}`} aria-hidden="true">
      {done ? <Check size={14} strokeWidth={2.5} /> : n}
    </span>
  );
  const officerStep = needsWeighing ? 3 : 2;

  return (
    <div
      className="drt-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`drt-proof-title-${index}`}
      data-testid="stop-proof"
    >
      <header className="drt-head">
        <button
          type="button"
          className="drt-icon-btn drt-back"
          onClick={onClose}
          aria-label={t("d2_back")}
          data-testid="stop-proof-back"
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 className="drt-head-title" id={`drt-proof-title-${index}`}>
          <span className="drt-sr">{t("drv11_stop_prefix").replace("{n}", index + 1)} </span>
          {stopText(stop.name, t)}
        </h2>
        <SyncChip online={online} pending={pending} flushing={flushing} />
      </header>

      <div className="drt-layer-body">
        {!online && (
          <p className="drt-banner" role="status" data-testid="stop-proof-offline">
            <CloudOff size={16} aria-hidden="true" /> {t("d2_proof_offline")}
          </p>
        )}

        {/* Step 1: arrival photo, geotagged when it is attached. */}
        <section className="drt-card" aria-labelledby={`drt-step1-${index}`}>
          <div className="drt-step-head">
            {stepNum(1, Boolean(arrival))}
            <h3 className="drt-step-title" id={`drt-step1-${index}`}>
              {t("d2_proof_arrival")}
            </h3>
            {arrival && <span className="drt-step-state">{t("d2_proof_done")}</span>}
          </div>
          {arrival ? (
            <div className="drt-proof-row" data-testid={arrival.fix ? "arrival-ar-evidence" : undefined}>
              <img className="drt-thumb" src={arrival.b64} alt={t("d2_proof_arrival_alt")} />
              <div className="drt-proof-meta">
                <GeotagLabel fix={arrivalFix} />
                <p className="drt-faint">
                  {clockTime(arrivalAt) || "—"} ·{" "}
                  <label className="drt-link drt-camera">
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="drt-file"
                      data-testid="arrival-input"
                      aria-label={t("d2_proof_retake_aria")}
                      onChange={(e) => {
                        handleArrivalPhoto(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    {t("d2_proof_retake")}
                  </label>
                </p>
                {arrival.fix && (
                  <p>{t("drv_ar_photo_from_ar").replace("{n}", arrival.fix.accuracy_m ?? "?")}</p>
                )}
                <PhotoSize photo={arrival} />
              </div>
            </div>
          ) : (
            <label className="drt-cam-wide drt-camera">
              <input
                id={`arrival-${index}`}
                type="file"
                accept="image/*"
                capture="environment"
                className="drt-file"
                data-testid="arrival-input"
                onChange={(e) => {
                  handleArrivalPhoto(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <Camera size={20} aria-hidden="true" /> {t("d2_proof_arrival_take")}
            </label>
          )}
        </section>

        {/* Step 2: weight by type, only when this SPJ weighs on site. */}
        {needsWeighing && (
          <section className="drt-card" aria-labelledby={`drt-step2-${index}`}>
            <div className="drt-step-head">
              {stepNum(2, steps[1])}
              <h3 className="drt-step-title" id={`drt-step2-${index}`}>
                {t("d2_proof_weight")}
              </h3>
            </div>
            <label className={`drt-cam-wide drt-camera${scalePhoto ? " is-done" : ""}`}>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="drt-file"
                data-testid="weigh-input"
                onChange={(e) => {
                  handlePhoto(e.target.files?.[0], setScalePhoto);
                  e.target.value = "";
                }}
              />
              {scalePhoto ? <Check size={18} aria-hidden="true" /> : <Scale size={18} aria-hidden="true" />}
              {scalePhoto ? t("d2_proof_scale_done") : t("d2_proof_scale_take")}
            </label>
            <PhotoSize photo={scalePhoto} />
            {FRACTIONS.map((fraction) => {
              const id = `weight-${index}-${fraction}`;
              const bad = invalid.includes(fraction);
              return (
                <div className="drt-field-row" key={fraction}>
                  <label className="drt-field-label" htmlFor={id}>
                    {t(`s4_wo_fraction_${fraction.toLowerCase()}`)}
                  </label>
                  <div className={`drt-input-wrap${bad ? " is-invalid" : ""}`}>
                    <input
                      id={id}
                      className="drt-input"
                      data-testid={`weigh-kg-${fraction}`}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max={MAX_FRACTION_KG}
                      step="any"
                      placeholder="0"
                      value={weights[fraction] ?? ""}
                      aria-invalid={bad || undefined}
                      onChange={(e) => setWeights((prev) => ({ ...prev, [fraction]: e.target.value }))}
                    />
                    <span className="drt-unit" aria-hidden="true">
                      kg
                    </span>
                  </div>
                </div>
              );
            })}
            {invalid.length > 0 && (
              <p className="drt-error" role="alert" data-testid="weigh-invalid">
                {t("d2_proof_weight_invalid")}
              </p>
            )}
          </section>
        )}

        {/* Last step: the TPS officer's name and photo. */}
        <section className="drt-card" aria-labelledby={`drt-step3-${index}`}>
          <div className="drt-step-head">
            {stepNum(officerStep, steps[steps.length - 1])}
            <h3 className="drt-step-title" id={`drt-step3-${index}`}>
              {t("d2_proof_officer")}
            </h3>
          </div>
          <div className="drt-field-row">
            <label className="drt-sr" htmlFor={`officer-name-${index}`}>
              {t("d2_proof_officer_name")}
            </label>
            <div className="drt-input-wrap">
              <input
                id={`officer-name-${index}`}
                className="drt-input is-text"
                data-testid="officer-name"
                autoComplete="off"
                value={officerName}
                onChange={(e) => setOfficerName(e.target.value)}
                placeholder={t("d2_proof_officer_name")}
              />
            </div>
            <label className="drt-square-cam drt-camera" aria-label={t("d2_proof_officer_photo")}>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="drt-file"
                data-testid="officer-input"
                aria-label={t("d2_proof_officer_photo")}
                onChange={(e) => {
                  handlePhoto(e.target.files?.[0], setOfficerPhoto);
                  e.target.value = "";
                }}
              />
              {officerPhoto ? <img src={officerPhoto.b64} alt="" /> : <Camera size={20} aria-hidden="true" />}
            </label>
          </div>
          <PhotoSize photo={officerPhoto} />
        </section>

        {storageError && (
          <p className="drt-banner is-error" role="alert" data-testid="stop-storage-full">
            {t("drv6_storage_full")}
          </p>
        )}
      </div>

      <div className="drt-layer-foot">
        <button
          type="button"
          className="drt-btn is-primary"
          data-testid="stop-finish"
          onClick={submit}
          disabled={!canSubmit}
        >
          {busy
            ? t("drv_syncing")
            : left > 0
              ? t("d2_proof_finish_left").replace("{n}", left).replace("{total}", steps.length)
              : t("d2_proof_finish")}
        </button>
      </div>
    </div>
  );
}
