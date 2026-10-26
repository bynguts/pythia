import { useEffect, useRef, useState } from "react";
import {
  Camera,
  ChevronRight,
  Construction,
  MapPin,
  PackageX,
  PhoneCall,
  Send,
  Siren,
  Truck,
} from "lucide-react";
import { apiFetch, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { enqueueDriverOperation, markDriverSynced, OutboxStorageFullError } from "./DriverOutbox.js";
import { announceSessionExpired } from "./DriverPanels.jsx";
import { clockTime } from "./driverHelpers.js";
import { formatBytes, shrinkPhoto } from "./photo.js";
import "./driver-trip.css";

export const EXCEPTION_PATH = "/driver/exceptions";

const KINDS = [
  { kind: "tps_empty", icon: PackageX },
  { kind: "road_closed", icon: Construction },
  { kind: "truck_breakdown", icon: Truck },
  { kind: "accident", icon: Siren },
];

const REPORT_POLL_MS = 60000;

// What dispatch did with this truck's reports (GET /driver/exceptions, own
// truck only): operation id -> "sent" | "seen" | "handled". Empty offline.
function useReportStatus(truckCode, refreshKey) {
  const [byOp, setByOp] = useState({});
  useEffect(() => {
    if (!truckCode) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch(`${EXCEPTION_PATH}?truck_code=${encodeURIComponent(truckCode)}`, {
          tokenKey: FIELD_TOKEN_KEY,
        });
        if (!res.ok || cancelled) return;
        const next = {};
        for (const row of (await res.json()).exceptions || []) {
          if (row.operation_id) next[row.operation_id] = row.report_status;
        }
        if (!cancelled) setByOp(next);
      } catch {
        // Offline: the phone's own queued/sent state still shows.
      }
    };
    load();
    const id = setInterval(load, REPORT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [truckCode, refreshKey]);
  return byOp;
}

const REPORT_STATE = {
  sent: { key: "drv10_exc_state_sent", tone: "" },
  seen: { key: "d2_exc_state_seen", tone: "" },
  handled: { key: "d2_exc_state_handled", tone: " is-done" },
};

// Quick reasons the design offers per kind; a tap adds the word to the note.
const QUICK = { road_closed: ["flooded", "works", "event"] };

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
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 },
    );
  });
}

// "09:28" today, "Fri 14:02" on another day.
function reportTime(iso, lang) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const time = clockTime(iso);
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(localeFor(lang), { weekday: "short" })} ${time}`;
}

function ReportSheet({ kind, driver, spj, stopIndex, say, onSent, onClose }) {
  const { t, lang } = useLanguage();
  const [photo, setPhoto] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // undefined while locating, null without a fix.
  const [fix, setFix] = useState(undefined);
  const operationId = useRef(newOperationId());
  const titleRef = useRef(null);
  const Icon = KINDS.find((k) => k.kind === kind)?.icon || PackageX;
  const stop = spj && stopIndex >= 0 ? spj.stops?.[stopIndex] : null;

  useEffect(() => {
    titleRef.current?.focus();
    let cancelled = false;
    quickPosition().then((pos) => {
      if (!cancelled) setFix(pos);
    });
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, busy]);

  const handlePhoto = async (file) => {
    if (!file) return;
    try {
      setPhoto(await shrinkPhoto(file));
    } catch {
      say(t("drv_photo_read_failed"));
    }
  };

  const addQuick = (word) => {
    setNote((prev) => (prev.trim() ? `${prev.trim()}, ${word}` : word));
  };

  const send = async () => {
    if (busy) return;
    setBusy(true);
    const pos = fix === undefined ? await quickPosition() : fix;
    const data = {
      kind,
      truck_code: driver.truck_code,
      driver_name: driver.driver_name || "",
      spj_id: spj?.spj_id || null,
      stop_index: spj && stopIndex >= 0 ? stopIndex : null,
      note: note.trim(),
      photo_name: photo?.name || null,
      photo_b64: photo?.b64 || null,
      lat: pos?.lat ?? null,
      lng: pos?.lng ?? null,
      approx: false,
      reported_at: new Date().toISOString(),
      operation_id: operationId.current,
    };
    const entry = { op: operationId.current, kind, at: data.reported_at, stop: stop?.name || null };
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
        onSent(entry);
        say(t("drv10_exc_sent"));
      } else {
        await enqueueDriverOperation({ path: EXCEPTION_PATH, data, label: t(`drv10_exc_${kind}`) });
        onSent(entry);
        say(t("drv_queued_offline"));
      }
    } catch (error) {
      say(error instanceof OutboxStorageFullError ? t("drv6_storage_full") : t("drv10_exc_failed"), 8000);
    } finally {
      setBusy(false);
    }
  };

  const vehicle = kind === "truck_breakdown" || kind === "accident";
  const locTitle =
    fix === undefined
      ? t("drv6_geo_locating")
      : fix
        ? stop
          ? t("d2_exc_loc_near").replace("{name}", stop.name)
          : t("d2_exc_loc_gps").replace("{n}", fix.accuracy_m ?? "?")
        : t("d2_exc_loc_none");

  return (
    <>
      <div className="drt-sheet-scrim" onClick={busy ? undefined : onClose} aria-hidden="true" />
      <section
        className="drt-report-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drt-rs-title"
        data-testid="exc-sheet"
      >
        <span className="drt-handle" aria-hidden="true" />
        <div className="drt-rs-head">
          <span className="drt-kind-ic" aria-hidden="true">
            <Icon size={22} />
          </span>
          <div>
            <h2 id="drt-rs-title" ref={titleRef} tabIndex={-1}>
              {t(`d2_exc_${kind}`)}
            </h2>
            <p>{t(`d2_exc_${kind}_sheet`)}</p>
          </div>
        </div>

        {kind === "accident" && (
          <a className="drt-112" href="tel:112" data-testid="exc-call-112-sheet">
            <PhoneCall size={20} aria-hidden="true" />
            <span>{t("d2_exc_112")}</span>
            <ChevronRight size={18} aria-hidden="true" />
          </a>
        )}

        <div className="drt-loc" data-testid="exc-location">
          <MapPin size={17} aria-hidden="true" />
          <div>
            <strong>{locTitle}</strong>
            <small>{fix ? t("d2_exc_loc_auto") : t("d2_exc_loc_auto_none")}</small>
          </div>
        </div>

        <label className="drt-photo-drop drt-camera" data-testid="exc-photo">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="drt-file"
            data-testid="exc-photo-input"
            onChange={(e) => {
              handlePhoto(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {photo ? (
            <img src={photo.b64} alt={t("d2_exc_photo_alt")} />
          ) : (
            <Camera size={24} aria-hidden="true" />
          )}
          {photo ? t("d2_exc_photo_retake") : t("d2_exc_photo")}
        </label>
        {photo && (
          <p className="drt-size" data-testid="exc-photo-size">
            {t("drv6_photo_size").replace("{size}", formatBytes(photo.bytes, lang))}
          </p>
        )}

        <label className="drt-sr" htmlFor="exc-note">
          {t("drv10_exc_note_label")}
        </label>
        <textarea
          id="exc-note"
          className="drt-textarea"
          data-testid="exc-note"
          rows={2}
          value={note}
          placeholder={t(`d2_exc_note_${vehicle ? "vehicle" : kind}`)}
          onChange={(e) => setNote(e.target.value)}
        />

        {QUICK[kind] && (
          <div className="drt-quick">
            {QUICK[kind].map((word) => (
              <button key={word} type="button" onClick={() => addQuick(t(`d2_exc_quick_${word}`))}>
                {t(`d2_exc_quick_${word}`)}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          className="drt-btn is-primary"
          data-testid="exc-send"
          onClick={send}
          disabled={busy}
        >
          <Send size={18} aria-hidden="true" /> {busy ? t("drv_syncing") : t("d2_exc_send")}
        </button>
        <p className="drt-note is-small">{vehicle ? t("drv10_exc_vehicle_note") : t("d2_exc_stop_stays")}</p>
      </section>
    </>
  );
}

// cZ8Ki / I5KyDA: four buttons for what stops the work at the curb or on the
// road, each opening one short sheet (location, optional photo and note). The
// report goes out at once or waits in the driver outbox until there is signal.
// It never completes the current stop: dispatch decides. A breakdown or an
// accident also files a damage report on the server.
export function ExceptionPanel({ driver, spj, stopIndex, outboxItems, say }) {
  const { t, lang } = useLanguage();
  const [kind, setKind] = useState(null);
  const [log, setLog] = useState(() => readLog());
  const openerRef = useRef(null);
  const reportStatus = useReportStatus(driver?.truck_code, `${log.length}:${outboxItems.length}`);

  const record = (entry) => {
    const next = [entry, ...readLog().filter((e) => e.op !== entry.op)];
    writeLog(next);
    setLog(next.slice(0, 5));
  };

  const close = () => {
    setKind(null);
    setTimeout(() => openerRef.current?.focus(), 0);
  };

  return (
    <section className="drt-screen" data-testid="driver-exceptions" aria-labelledby="drt-exc-title">
      <h1 className="drt-h1" id="drt-exc-title">
        {t("d2_exc_title")}
      </h1>
      <a className="drt-112" href="tel:112" data-testid="exc-call-112">
        <PhoneCall size={20} aria-hidden="true" />
        <span>{t("d2_exc_112")}</span>
        <ChevronRight size={18} aria-hidden="true" />
      </a>

      <div className="drt-kinds">
        {KINDS.map(({ kind: k, icon: Icon }) => (
          <button
            key={k}
            type="button"
            className={`drt-kind${k === "accident" ? " is-danger" : ""}`}
            data-testid={`exc-${k}`}
            aria-pressed={kind === k}
            aria-haspopup="dialog"
            onClick={(e) => {
              openerRef.current = e.currentTarget;
              setKind(k);
            }}
          >
            <span className="drt-kind-ic" aria-hidden="true">
              <Icon size={18} />
            </span>
            <span>
              <strong>{t(`d2_exc_${k}`)}</strong>
              <small>{t(`d2_exc_${k}_desc`)}</small>
            </span>
          </button>
        ))}
      </div>

      {log.length > 0 && (
        <div className="drt-list">
          <p className="drt-list-head">{t("d2_exc_recent")}</p>
          <ul data-testid="exc-log">
            {log.map((entry) => {
              // Still in the outbox = waiting for signal; otherwise delivered
              // (a server rejection shows in the needs-action list instead).
              const queued = outboxItems.some((item) => item.data?.operation_id === entry.op);
              const state = REPORT_STATE[reportStatus[entry.op]] || REPORT_STATE.sent;
              return (
                <li key={entry.op}>
                  <span className="drt-list-text">
                    <strong>
                      {entry.stop && entry.kind === "tps_empty"
                        ? t("d2_exc_log_tps_empty").replace("{name}", entry.stop)
                        : t(`d2_exc_${entry.kind}`)}
                    </strong>
                    <small>{reportTime(entry.at, lang)}</small>
                  </span>
                  <span
                    className={`drt-list-status drt-dot-label${queued ? " is-approx" : state.tone}`}
                    data-status={queued ? "queued" : reportStatus[entry.op] || "sent"}
                  >
                    {queued ? t("drv10_exc_state_queued") : t(state.key)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {kind && (
        <ReportSheet
          key={kind}
          kind={kind}
          driver={driver}
          spj={spj}
          stopIndex={stopIndex}
          say={say}
          onSent={(entry) => {
            record(entry);
            close();
          }}
          onClose={close}
        />
      )}
    </section>
  );
}
