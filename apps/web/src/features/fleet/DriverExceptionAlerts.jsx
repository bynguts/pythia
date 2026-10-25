import { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Construction, PackageX, Siren, TriangleAlert, Truck } from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { AttentionAction, AttentionRow } from "./AttentionRow.jsx";

const POLL_MS = 15000;
// Accidents first, then what takes a truck out of service, then curbside exceptions.
const KIND_RANK = { accident: 0, truck_breakdown: 1, road_closed: 2, tps_empty: 3 };
const DANGER_KINDS = new Set(["accident", "truck_breakdown"]);
const EXCEPTION_ICONS = {
  accident: Siren,
  truck_breakdown: Truck,
  road_closed: Construction,
  tps_empty: PackageX,
};

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

function reportedAt(exception) {
  const at = new Date(exception.reported_at || exception.created_at).getTime();
  return Number.isNaN(at) ? 0 : at;
}

// wave11 fleet: repeat reports (same truck, same kind, same open/handled state) are one row
// carrying a count; the row shows the latest report's words and time.
export function groupExceptions(exceptions, handled) {
  const groups = new Map();
  for (const exception of exceptions) {
    const who = handled[exceptionAlertId(exception)];
    const key = `${exception.truck_code}|${exception.kind}|${who ? "done" : "open"}`;
    const group = groups.get(key) || { reports: [], who };
    group.reports.push(exception);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      group.reports.sort((a, b) => reportedAt(b) - reportedAt(a));
      return { ...group, latest: group.reports[0] };
    })
    .sort(
      (a, b) =>
        (a.who ? 1 : 0) - (b.who ? 1 : 0) ||
        (KIND_RANK[a.latest.kind] ?? 9) - (KIND_RANK[b.latest.kind] ?? 9) ||
        reportedAt(b.latest) - reportedAt(a.latest),
    );
}

// Driver exceptions as an alert type in "Perlu tindakan": accident first and in danger
// tone; each row offers WhatsApp contact and closes through the existing follow-up log.
export function DriverExceptionAlerts({ exceptions, handled, onHandled, onWhatsApp }) {
  const { t, lang } = useLanguage();
  const [error, setError] = useState("");
  const operator = useRef(localStorage.getItem("pythia_role") || "dispatcher");

  if (!exceptions.length) return null;

  // wave11 fleet: one follow-up per report, so closing a grouped row closes every report in it.
  async function markHandled(group) {
    try {
      for (const exception of group) {
        const alertId = exceptionAlertId(exception);
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
      }
      setError("");
    } catch (err) {
      setError(err.message || t("w10fleet_followup_unavailable"));
    }
  }

  const rows = groupExceptions(exceptions, handled);

  return (
    <ul className="ui-list action-list driver-exception-list" data-testid="driver-exceptions">
      {rows.map(({ latest: exception, reports, who }) => {
        const danger = DANGER_KINDS.has(exception.kind);
        const time = exceptionTime(exception, lang);
        // wave11 fleet: the meta is the driver's own words; ids never reach the operator.
        const meta = [
          exception.note || t("w11fleet_exc_no_note"),
          exception.stop_index != null && t("w10fleet_exc_stop").replace("{n}", exception.stop_index + 1),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <AttentionRow
            key={exception.exception_id}
            className={`driver-exception-row ${danger ? "is-danger" : ""} ${who ? "is-done" : ""}`}
            data-testid="driver-exception-row"
            data-exception-id={exception.exception_id}
            data-exception-ids={reports.map((report) => report.exception_id).join(" ")}
            data-kind={exception.kind}
            tone={who ? "success" : danger ? "danger" : "warning"}
            icon={EXCEPTION_ICONS[exception.kind] || TriangleAlert}
            title={
              <>
                <b className="mono-id">{exception.truck_code}</b> {t(`drv10_exc_${exception.kind}`)}
                {reports.length > 1 && (
                  <span
                    className="attn-repeat"
                    title={t("w11fleet_exc_repeat").replace("{n}", reports.length)}
                  >
                    {` ×${reports.length}`}
                  </span>
                )}
              </>
            }
            meta={
              <>
                {meta}
                {exception.has_photo && (
                  <span className="driver-exception-photo">
                    {" · "}
                    <Camera size={12} aria-hidden="true" /> {t("w10fleet_exc_photo")}
                  </span>
                )}
              </>
            }
            aside={
              <time className="ui-row-time" title={t("w10fleet_exc_detail").replace("{time}", time)}>
                {time}
              </time>
            }
          >
            <div className="attn-actions">
              {who ? (
                <span className="action-row-resolved">
                  <CheckCircle2 size={14} aria-hidden="true" />{" "}
                  {t("w10fleet_exc_handled_by").replace("{who}", who)}
                </span>
              ) : (
                <>
                  <AttentionAction onClick={() => onWhatsApp(exceptionAsAlert(exception))}>
                    {t("w10fleet_exc_contact")}
                  </AttentionAction>
                  <AttentionAction quiet onClick={() => markHandled(reports)}>
                    {t("w10fleet_exc_handled_btn")}
                  </AttentionAction>
                </>
              )}
            </div>
          </AttentionRow>
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
        <li key={exception.exception_id} data-exception-id={exception.exception_id}>
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
