import { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, MessageCircle } from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";

const POLL_MS = 15000;
// Accidents first, then what takes a truck out of service, then curbside exceptions.
const KIND_RANK = { accident: 0, truck_breakdown: 1, road_closed: 2, tps_empty: 3 };
const DANGER_KINDS = new Set(["accident", "truck_breakdown"]);

// The follow-up log keys on any alert id; driver reports use their own prefix.
export function exceptionAlertId(exception) {
  return `driver-exception:${exception.exception_id}`;
}

// Quick reports from the driver app (GET /api/driver/exceptions), newest first.
export function useDriverExceptions() {
  const [exceptions, setExceptions] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiFetch("/driver/exceptions")
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (!cancelled && body) setExceptions(body.exceptions || []);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return exceptions;
}

export function exceptionTime(exception, lang) {
  const at = new Date(exception.reported_at || exception.created_at);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleTimeString(localeFor(lang), { hour: "2-digit", minute: "2-digit" });
}

function exceptionDetail(t, exception, lang) {
  return [
    t("w10fleet_exc_detail").replace("{time}", exceptionTime(exception, lang)),
    exception.stop_index != null && t("w10fleet_exc_stop").replace("{n}", exception.stop_index + 1),
    exception.note,
  ]
    .filter(Boolean)
    .join(" · ");
}

// The alert shape the WhatsApp sender and the decision helpers read.
export function exceptionAsAlert(exception) {
  return {
    id: exceptionAlertId(exception),
    type: "driver_exception",
    kind: exception.kind,
    truck_code: exception.truck_code,
    note: exception.note,
    recommended_routes: [],
  };
}

// Which driver reports an operator closed, from the existing alert follow-up log.
export function useHandledExceptions() {
  const [handled, setHandled] = useState({});
  useEffect(() => {
    let cancelled = false;
    apiFetch("/alert/follow-ups")
      .then((r) => (r.ok ? r.json() : []))
      .then((records) => {
        if (cancelled) return;
        const map = {};
        for (const rec of records) {
          const id = rec.payload?.alert_id || "";
          if (id.startsWith("driver-exception:") && rec.payload.status === "RESOLVED")
            map[id] = rec.payload.operator || "—";
        }
        setHandled(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const markHandled = (id, who) => setHandled((current) => ({ ...current, [id]: who }));
  return [handled, markHandled];
}

// Driver exceptions as an alert type in "Perlu tindakan": accident first and in danger
// tone; each row offers WhatsApp contact and closes through the existing follow-up log.
export function DriverExceptionAlerts({ exceptions, handled, onHandled, onWhatsApp }) {
  const { t, lang } = useLanguage();
  const [error, setError] = useState("");
  const operator = useRef(localStorage.getItem("pythia_role") || "dispatcher");

  if (!exceptions.length) return null;

  async function markHandled(exception) {
    const alertId = exceptionAlertId(exception);
    try {
      const res = await apiFetch("/alert/follow-up", {
        method: "POST",
        body: JSON.stringify({
          alert_id: alertId,
          status: "RESOLVED",
          operator: operator.current,
          note: exception.kind,
        }),
      });
      if (!res.ok)
        throw new Error(
          t(
            res.status === 401 || res.status === 403
              ? "w10fleet_followup_denied"
              : "w10fleet_followup_failed",
          ),
        );
      onHandled(alertId, operator.current);
      setError("");
    } catch (err) {
      setError(err.message || t("w10fleet_followup_unavailable"));
    }
  }

  const rows = [...exceptions].sort((a, b) => {
    const doneA = handled[exceptionAlertId(a)] ? 1 : 0;
    const doneB = handled[exceptionAlertId(b)] ? 1 : 0;
    return doneA - doneB || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
  });

  return (
    <ul className="action-list driver-exception-list" data-testid="driver-exceptions">
      {rows.map((exception) => {
        const who = handled[exceptionAlertId(exception)];
        const danger = DANGER_KINDS.has(exception.kind);
        return (
          <li
            key={exception.exception_id}
            className={`action-row driver-exception-row ${danger ? "is-danger" : ""}`}
            data-testid="driver-exception-row"
            data-kind={exception.kind}
          >
            <div className="action-row-head is-static">
              <span className={`status-dot ${who ? "success" : danger ? "danger" : "warning"}`} />
              <span className="action-row-text">
                <span>
                  <b className="mono-id">{exception.truck_code}</b> {t(`drv10_exc_${exception.kind}`)}
                </span>
                <small>
                  {exceptionDetail(t, exception, lang)}
                  {exception.has_photo && (
                    <span className="driver-exception-photo">
                      {" · "}
                      <Camera size={12} aria-hidden="true" /> {t("w10fleet_exc_photo")}
                    </span>
                  )}
                </small>
              </span>
              <span className={`pill ${who ? "success" : danger ? "danger" : "warning"}`}>
                {t(who ? "w10fleet_status_handled" : "w10fleet_exc_badge")}
              </span>
            </div>
            <div className="action-row-secondary">
              {who ? (
                <span className="action-row-resolved">
                  {t("w10fleet_exc_handled_by").replace("{who}", who)}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => onWhatsApp(exceptionAsAlert(exception))}
                  >
                    <MessageCircle size={15} /> {t("w10fleet_exc_contact")}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => markHandled(exception)}>
                    <CheckCircle2 size={15} /> {t("w10fleet_exc_handled_btn")}
                  </button>
                </>
              )}
            </div>
          </li>
        );
      })}
      {error && (
        <li className="action-card-warning" role="alert">
          {error}
        </li>
      )}
    </ul>
  );
}

// The truck drawer's read-only list of this truck's driver reports.
export function TruckExceptions({ exceptions }) {
  const { t, lang } = useLanguage();
  if (!exceptions.length) return <p className="drawer-muted">{t("w10fleet_exc_none")}</p>;
  return (
    <ul className="trip-list" data-testid="drawer-exception-list">
      {exceptions.map((exception) => (
        <li key={exception.exception_id}>
          <span>
            <b>{t(`drv10_exc_${exception.kind}`)}</b>
            <small>{exceptionDetail(t, exception, lang)}</small>
          </span>
          {exception.has_photo && <Camera size={14} aria-label={t("w10fleet_exc_photo")} />}
        </li>
      ))}
    </ul>
  );
}
