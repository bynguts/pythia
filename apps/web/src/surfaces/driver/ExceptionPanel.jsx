import { useRef, useState } from "react";
import { Ban, Camera, CarFront, PackageX, Phone, Wrench, X } from "lucide-react";
import { apiFetch, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { enqueueDriverOperation, markDriverSynced, OutboxStorageFullError } from "./DriverOutbox.js";
import { announceSessionExpired } from "./DriverPanels.jsx";
import { clockTime } from "./driverHelpers.js";
import { formatBytes, shrinkPhoto } from "./photo.js";

export const EXCEPTION_PATH = "/driver/exceptions";

const KINDS = [
  { kind: "tps_empty", icon: PackageX },
  { kind: "road_closed", icon: Ban },
  { kind: "truck_breakdown", icon: Wrench },
  { kind: "accident", icon: CarFront },
];

const LOG_KEY = "pythia_driver_exception_log";

function readLog() {
  try {
    const list = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeLog(list) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(0, 5)));
  } catch {
    // The list on this phone is informational; the server holds the reports.
  }
}

function newOperationId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `exc-${crypto.randomUUID()}`;
  return `exc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// A fix within 5 s (or a recent one), else none: a report never waits long on GPS.
function quickPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 },
    );
  });
}

// P1-3: four quick buttons for what stops the work at the curb or on the road.
// A tap opens one short sheet (optional photo and note); the report goes out
// at once or waits in the driver outbox until there is signal. The report
// does not complete the current stop: the supervisor decides.
export function ExceptionPanel({ driver, spj, stopIndex, outboxItems, say }) {
  const { t, lang } = useLanguage();
  const [kind, setKind] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState(() => readLog());
  const operationId = useRef(null);

  const open = (next) => {
    setKind(next);
    setPhoto(null);
    setNote("");
    operationId.current = newOperationId();
  };

  const record = (entry) => {
    const next = [entry, ...readLog().filter((e) => e.op !== entry.op)];
    writeLog(next);
    setLog(next.slice(0, 5));
  };

  const handlePhoto = async (file) => {
    if (!file) return;
    try {
      setPhoto(await shrinkPhoto(file));
    } catch {
      say(t("drv_photo_read_failed"));
    }
  };

  const send = async () => {
    if (!kind || busy) return;
    setBusy(true);
    const fix = await quickPosition();
    const data = {
      kind,
      truck_code: driver.truck_code,
      driver_name: driver.driver_name || "",
      spj_id: spj?.spj_id || null,
      stop_index: spj && stopIndex >= 0 ? stopIndex : null,
      note: note.trim(),
      photo_name: photo?.name || null,
      photo_b64: photo?.b64 || null,
      lat: fix?.lat ?? null,
      lng: fix?.lng ?? null,
      approx: false,
      reported_at: new Date().toISOString(),
      operation_id: operationId.current,
    };
    const entry = { op: operationId.current, kind, at: data.reported_at };
    try {
      let res = null;
      try {
        res = await apiFetch(EXCEPTION_PATH, { method: "POST", body: data, tokenKey: FIELD_TOKEN_KEY });
      } catch {
        res = null; // No signal: the outbox keeps it.
      }
      if (res && res.status === 401) {
        announceSessionExpired();
        res = null;
      }
      if (res && !res.ok && res.status < 500) {
        say(t("drv6_request_failed").replace("{code}", res.status), 8000);
        return;
      }
      if (res && res.ok) {
        markDriverSynced();
        record(entry);
        say(t("drv10_exc_sent"));
      } else {
        await enqueueDriverOperation({ path: EXCEPTION_PATH, data, label: t(`drv10_exc_${kind}`) });
        record(entry);
        say(t("drv_queued_offline"));
      }
      setKind(null);
    } catch (error) {
      say(error instanceof OutboxStorageFullError ? t("drv6_storage_full") : t("drv10_exc_failed"), 8000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="driver-card driver-exceptions" data-testid="driver-exceptions">
      <div className="driver-card-head">
        <h2>{t("drv10_exc_title")}</h2>
      </div>
      <p className="driver-muted">{t("drv10_exc_intro")}</p>
      <div className="driver-exception-grid">
        {KINDS.map(({ kind: k, icon: Icon }) => (
          <button
            key={k}
            type="button"
            className={`driver-exception-btn${k === "accident" ? " is-danger" : ""}`}
            data-testid={`exc-${k}`}
            aria-pressed={kind === k}
            onClick={() => open(k)}
          >
            <Icon size={26} aria-hidden="true" />
            <span>{t(`drv10_exc_${k}`)}</span>
          </button>
        ))}
      </div>

      {kind && (
        <div
          className="driver-exception-sheet"
          data-testid="exc-sheet"
          role="group"
          aria-label={t(`drv10_exc_${kind}`)}
        >
          <p className="driver-exception-kind">
            <strong>{t(`drv10_exc_${kind}`)}</strong>
          </p>
          {kind === "accident" && (
            <a className="driver-btn danger" href="tel:112" data-testid="exc-call-112">
              <Phone size={18} /> {t("drv10_exc_call_112")}
            </a>
          )}
          {spj && stopIndex >= 0 && (kind === "tps_empty" || kind === "road_closed") && (
            <p className="driver-muted">{t("drv10_exc_stop_note").replace("{n}", stopIndex + 1)}</p>
          )}
          {(kind === "truck_breakdown" || kind === "accident") && (
            <p className="driver-muted">{t("drv10_exc_vehicle_note")}</p>
          )}
          <label className="driver-btn ghost driver-camera" data-testid="exc-photo">
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="driver-camera-input"
              data-testid="exc-photo-input"
              onChange={(e) => {
                handlePhoto(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Camera size={18} /> {t("drv10_exc_photo_label")}
          </label>
          {photo && (
            <p className="driver-photo-size" data-testid="exc-photo-size">
              {t("drv6_photo_size").replace("{size}", formatBytes(photo.bytes, lang))}
            </p>
          )}
          <label className="driver-label" htmlFor="exc-note">
            {t("drv10_exc_note_label")}
          </label>
          <input
            id="exc-note"
            className="driver-input"
            data-testid="exc-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="driver-actions">
            <button type="button" className="driver-btn ghost" onClick={() => setKind(null)} disabled={busy}>
              <X size={18} /> {t("drv10_exc_cancel")}
            </button>
            <button
              type="button"
              className="driver-btn primary"
              data-testid="exc-send"
              onClick={send}
              disabled={busy}
            >
              {busy ? t("drv_syncing") : t("drv10_exc_send")}
            </button>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="driver-exception-log">
          <p className="driver-label">{t("drv10_exc_history")}</p>
          <ul className="history-list" data-testid="exc-log">
            {log.map((entry) => {
              // Still in the outbox = waiting for signal; otherwise delivered
              // (a server rejection shows in the needs-action list instead).
              const queued = outboxItems.some((item) => item.data?.operation_id === entry.op);
              return (
                <li key={entry.op}>
                  <span>
                    <strong>{t(`drv10_exc_${entry.kind}`)}</strong>
                    <small>{clockTime(entry.at)}</small>
                  </span>
                  <span className={`driver-badge ${queued ? "queued" : "done"}`}>
                    {queued ? t("drv10_exc_state_queued") : t("drv10_exc_state_sent")}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
