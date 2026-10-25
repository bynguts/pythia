import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Route, Send } from "lucide-react";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { apiFetch } from "../../shared/api/client.js";
import { createAlertDispatch } from "./alertDispatch.js";
import {
  alertDetail,
  alertTitle,
  decisionRoute,
  routeMeta,
  routeName,
  routeSource,
} from "./decisionRoute.js";

function pickAlert(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return null;
  return alerts.find((a) => (a.recommended_routes?.length || 0) > 0) || alerts[0];
}

// `alert` pins the card to one decision (the fleet rail); without it the card picks
// the first alert with a route (supervisor view). `onSent` fires once a dispatch is saved.
export function ActionCard({ snapshot, alert: pinnedAlert = null, targetTruck = null, onSent }) {
  const { t, lang } = useLanguage();
  const [phase, setPhase] = useState("idle"); // idle | sending | sent | confirmed | escalated | cancelled | error
  const [waConnected, setWaConnected] = useState(null);
  const [confirmedAt, setConfirmedAt] = useState("");
  const [fieldNote, setFieldNote] = useState("");
  const [statusError, setStatusError] = useState("");
  const [sendError, setSendError] = useState("");
  const pollRef = useRef(null);
  const inFlightRef = useRef(false);
  const requestGeneration = useRef(0);

  const alerts = Array.isArray(snapshot?.alerts) ? snapshot.alerts : [];
  const targetedAlert = targetTruck ? alerts.find((a) => a.truck_code === targetTruck) : null;
  const alert = pinnedAlert || targetedAlert || pickAlert(alerts);
  const truckCode = alert?.truck_code || "";
  const truck = (snapshot?.trucks || []).find((item) => item.truck_code === truckCode);
  const driverName = truck?.driver_name || t("ac_unknown_driver");
  const route = decisionRoute(alert);
  const issueText = alert ? `${alertTitle(t, alert)}. ${alertDetail(t, alert, lang)}` : "";
  // A map/table click on a truck with no active alert shows that truck as an
  // informational target; the action stays bound to the live alert flow.
  const targetOnly = !pinnedAlert && Boolean(targetTruck) && !targetedAlert;
  const infoTruck = targetOnly
    ? (snapshot?.trucks || []).find((item) => item.truck_code === targetTruck)
    : null;

  useEffect(() => {
    return () => {
      requestGeneration.current += 1;
      clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    // An old request must not update the card after the operator retargets it.
    requestGeneration.current += 1;
    inFlightRef.current = false;
    setPhase("idle");
    setConfirmedAt("");
    setFieldNote("");
    setStatusError("");
    setSendError("");
    setWaConnected(null);
    clearInterval(pollRef.current);
    pollRef.current = null;
  }, [alert?.id]);

  function startConfirmationPoll(dispatchId, generation) {
    clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const response = await apiFetch(`/dispatch/${encodeURIComponent(dispatchId)}/status`);
        if (generation !== requestGeneration.current) return;
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            setStatusError(
              t(response.status === 401 ? "w10fleet_err_session_status" : "w10fleet_err_denied_status"),
            );
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          return;
        }
        const dispatch = await response.json();
        if (generation !== requestGeneration.current || dispatch.id !== dispatchId) return;
        const status = dispatch.field_status?.toUpperCase();
        if (status === "PENDING") return;
        if (status === "READY" || status === "ISSUE" || status === "CANCELLED" || status === "CANCELED") {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setFieldNote(dispatch.confirmed_note || "");
          if (status === "READY") {
            setConfirmedAt(
              new Date(dispatch.confirmed_at || Date.now()).toLocaleTimeString(localeFor(lang), {
                hour: "2-digit",
                minute: "2-digit",
              }),
            );
            setPhase("confirmed");
          } else {
            setPhase(status === "ISSUE" ? "escalated" : "cancelled");
          }
        }
      } catch {
        // Retain pending status until a later poll can read an actual field response.
      }
    };
    poll();
    pollRef.current = setInterval(poll, 8000);
  }

  async function handleSend() {
    if (!alert || inFlightRef.current || (phase !== "idle" && phase !== "error")) return;
    inFlightRef.current = true;
    const generation = requestGeneration.current;
    setPhase("sending");
    setSendError("");

    try {
      const dispatchRes = await createAlertDispatch(alert, t, issueText);
      if (generation !== requestGeneration.current) return;
      if (!dispatchRes.ok) {
        setSendError(
          dispatchRes.status === 401
            ? t("w10fleet_err_session_dispatch")
            : dispatchRes.status === 403
              ? t("w10fleet_err_denied_dispatch")
              : t("ac_send_failed"),
        );
        setPhase("error");
        return;
      }
      const created = await dispatchRes.json();
      if (generation !== requestGeneration.current) return;
      setPhase("sent");
      onSent?.(alert, route);
      if (created.id) startConfirmationPoll(created.id, generation);

      // Notification failure does not undo an already persisted dispatch.
      try {
        const status = await apiFetch("/whatsapp/status");
        if (generation !== requestGeneration.current) return;
        const gateway = status.ok ? await status.json() : null;
        if (generation !== requestGeneration.current) return;
        setWaConnected(gateway?.connected === true);
        const notification = await apiFetch("/whatsapp/alert", {
          method: "POST",
          body: JSON.stringify({
            truck_code: truckCode,
            issue: issueText,
            recommendation: route
              ? `${routeName(t, route)} (${routeMeta(t, route, lang)})`
              : t("ac_instruction_handle"),
          }),
        });
        if (generation !== requestGeneration.current) return;
        if (notification.status === 401 || notification.status === 403) {
          setStatusError(
            t(notification.status === 401 ? "w10fleet_err_session_wa_after" : "w10fleet_err_denied_wa_after"),
          );
        } else if (!notification.ok) {
          setWaConnected(false);
        } else {
          const result = await notification.json();
          if (generation === requestGeneration.current && !result.sent) setWaConnected(false);
        }
      } catch {
        if (generation === requestGeneration.current) setWaConnected(false);
      }
    } catch {
      if (generation === requestGeneration.current) {
        setSendError(t("ac_send_failed"));
        setPhase("error");
      }
    } finally {
      if (generation === requestGeneration.current) inFlightRef.current = false;
    }
  }

  if (!alert && !infoTruck) {
    return (
      <section className="action-card" data-testid="action-card">
        <div className="action-card-head">
          <span className="action-card-icon ok">
            <Check size={22} />
          </span>
          <h2 className="action-card-title">{t("ac_no_alerts")}</h2>
        </div>
      </section>
    );
  }

  if (infoTruck) {
    const zone = infoTruck.assigned_zone || infoTruck.zone || "";
    return (
      <section className="action-card action-card-info" data-testid="action-card">
        <div className="action-card-head">
          <span className="action-card-icon ok">
            <Check size={22} />
          </span>
          <div>
            <h2 className="action-card-title">
              {infoTruck.truck_code} — {infoTruck.driver_name || t("ac_unknown_driver")}
            </h2>
            <p className="action-card-issue">
              {t("w10fleet_no_alert_for_unit")}
              {zone ? ` ${zone}` : ""}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const note = fieldNote ? ` ${t("w10fleet_note").replace("{note}", fieldNote)}` : "";

  return (
    <section className="action-card" data-testid="action-card">
      <div className="action-card-head">
        <span className="action-card-icon">
          <AlertTriangle size={22} />
        </span>
        <div>
          <h2 className="action-card-title">
            <span className="mono-id">{truckCode}</span> — {driverName}
          </h2>
          <p className="action-card-issue">{alertDetail(t, alert, lang)}</p>
        </div>
      </div>

      {route && (
        <div className="action-card-route" data-testid="decision-route">
          <Route size={18} />
          <div>
            <strong data-testid="decision-route-name">{routeName(t, route)}</strong>
            <span className="action-card-route-meta">
              <Clock size={14} />
              <span data-testid="decision-route-eta">{routeMeta(t, route, lang)}</span>
            </span>
            <span className="action-card-route-source">{routeSource(t, route)}</span>
          </div>
        </div>
      )}

      {waConnected === false && phase !== "confirmed" && (
        <p className="action-card-warning" role="alert" data-testid="wa-warning">
          {t("ac_wa_offline")}
        </p>
      )}
      {statusError && (
        <p className="action-card-warning" role="alert">
          {statusError}
        </p>
      )}

      {phase === "sent" && (
        <p className="action-card-issue" role="status" data-testid="action-card-sent">
          {t("ac_sent_waiting").replace("{driver}", driverName).replace("{truck}", truckCode)}
        </p>
      )}
      {phase === "confirmed" && (
        <p className="action-card-success" role="status" data-testid="action-card-confirmed">
          {t("ac_confirmed")} {confirmedAt}
        </p>
      )}
      {phase === "escalated" && (
        <p className="action-card-warning" role="alert" data-testid="action-card-escalated">
          {t("w10fleet_field_issue")}
          {note}
        </p>
      )}
      {phase === "cancelled" && (
        <p className="action-card-issue" role="status" data-testid="action-card-cancelled">
          {t("w10fleet_field_cancelled")}
          {note}
        </p>
      )}
      {phase === "error" && (
        <p className="action-card-warning" role="alert" data-testid="action-card-error">
          {sendError || t("ac_send_failed")}
        </p>
      )}

      {(phase === "idle" || phase === "sending" || phase === "error") && (
        <button
          type="button"
          className="action-card-button"
          data-testid="action-card-button"
          onClick={handleSend}
          disabled={phase === "sending"}
        >
          <Send size={18} />
          {route ? t("ac_send_route") : t("ac_handle_alert")}
        </button>
      )}
    </section>
  );
}
