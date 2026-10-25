import { useEffect, useRef, useState } from "react";
import { MessageCircle, Route, Wrench } from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { ActionCard } from "./ActionCard.jsx";
import { AttentionAction, AttentionRow } from "./AttentionRow.jsx";
import { alertDetail, alertTitle, decisionRoute } from "./decisionRoute.js";

const SEVERITY_RANK = { critical: 0, warning: 1 };
const STATUS_TONE = { OPEN: "danger", DISPATCHED: "warning", RESOLVED: "success" };

export function sortAlerts(alerts) {
  return [...(alerts || [])].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2),
  );
}

// Teardown v4 F2: the dispatcher's work queue. One row per alert; the selected row is
// expanded with its decision card (the one primary action), the rest stay one line.
export function AlertQueue({ alerts, snapshot, selectedId, onSelect, onWhatsApp }) {
  const { t, lang } = useLanguage();
  const [followUps, setFollowUps] = useState({});
  const [notes, setNotes] = useState({});
  const [errors, setErrors] = useState({});
  const operator = useRef(localStorage.getItem("pythia_role") || "dispatcher");

  useEffect(() => {
    let cancelled = false;
    apiFetch("/alert/follow-ups")
      .then((r) => (r.ok ? r.json() : []))
      .then((records) => {
        if (cancelled) return;
        const map = {};
        for (const rec of records) {
          if (rec.payload?.alert_id)
            map[rec.payload.alert_id] = { ...rec.payload, updated_at: rec.created_at };
        }
        setFollowUps(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function recordFollowUp(alert, status, noteOverride) {
    const note = noteOverride !== undefined ? noteOverride : (notes[alert.id] || "").trim();
    const payload = { alert_id: alert.id, status, operator: operator.current, note };
    try {
      const response = await apiFetch("/alert/follow-up", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!response.ok)
        throw new Error(
          t(
            response.status === 401 || response.status === 403
              ? "w10fleet_followup_denied"
              : "w10fleet_followup_failed",
          ),
        );
      setFollowUps((current) => ({
        ...current,
        [alert.id]: { ...payload, updated_at: new Date().toISOString() },
      }));
      setNotes((current) => ({ ...current, [alert.id]: "" }));
      setErrors((current) => ({ ...current, [alert.id]: "" }));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [alert.id]: error.message || t("w10fleet_followup_unavailable"),
      }));
    }
  }

  function markSent(alert, route) {
    // The persisted dispatch stays sent even if optional follow-up logging fails.
    setFollowUps((current) => ({
      ...current,
      [alert.id]: { status: "DISPATCHED", operator: operator.current, note: "" },
    }));
    recordFollowUp(alert, "DISPATCHED", `Routed via ${route?.name || "backup route"}`);
  }

  if (!alerts.length) return null;

  return (
    <ul className="ui-list action-list" data-testid="action-queue">
      {sortAlerts(alerts).map((alert) => {
        const status = followUps[alert.id]?.status || "OPEN";
        const tone = STATUS_TONE[status] || "danger";
        const expanded = alert.id === selectedId;
        const toggle = () => onSelect(expanded ? null : alert);
        const link =
          status === "DISPATCHED"
            ? t("w11fleet_link_dispatched")
            : status === "RESOLVED"
              ? t("w11fleet_link_resolved")
              : decisionRoute(alert)
                ? t("w11fleet_link_route")
                : t("w11fleet_link_review");
        return (
          <AttentionRow
            key={alert.id}
            className={expanded ? "is-selected" : ""}
            data-testid="action-row"
            data-alert-id={alert.id}
            tone={status === "OPEN" ? (alert.severity === "critical" ? "danger" : "warning") : tone}
            icon={alert.type === "fleet_damage" ? Wrench : Route}
            title={
              <button type="button" className="action-row-head" aria-expanded={expanded} onClick={toggle}>
                <b className="mono-id">{alert.truck_code}</b> {alertTitle(t, alert)}
              </button>
            }
            meta={alertDetail(t, alert, lang)}
            aside={
              <span className={`ui-row-time tone-${tone}`} data-testid="action-row-status">
                {t(`w10fleet_status_${status.toLowerCase()}`)}
              </span>
            }
          >
            {!expanded && (
              <AttentionAction onClick={toggle} tabIndex={-1}>
                {link}
              </AttentionAction>
            )}
            {expanded && (
              <div className="action-row-body">
                {status === "RESOLVED" ? (
                  <p className="action-row-resolved">
                    {t("w10fleet_resolved_by")
                      .replace("{who}", followUps[alert.id]?.operator || "—")
                      .replace("{note}", followUps[alert.id]?.note || "—")}
                  </p>
                ) : (
                  <>
                    <ActionCard snapshot={snapshot} alert={alert} onSent={markSent} />
                    <div className="action-row-secondary">
                      <button
                        type="button"
                        className="ghost-button is-small"
                        onClick={() => onWhatsApp(alert)}
                      >
                        <MessageCircle size={15} /> {t("btn_wa_alert")}
                      </button>
                      <label className="action-row-resolve">
                        <span className="sr-only">{t("w10fleet_resolve_note_label")}</span>
                        <input
                          type="text"
                          value={notes[alert.id] || ""}
                          onChange={(e) => setNotes((s) => ({ ...s, [alert.id]: e.target.value }))}
                          placeholder={t("btn_resolve_placeholder")}
                        />
                      </label>
                      <button
                        type="button"
                        className="ghost-button is-small"
                        onClick={() => recordFollowUp(alert, "RESOLVED")}
                        disabled={!notes[alert.id]?.trim()}
                      >
                        {t("btn_mark_resolved")}
                      </button>
                    </div>
                    {errors[alert.id] && (
                      <p role="alert" className="action-card-warning">
                        {errors[alert.id]}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </AttentionRow>
        );
      })}
    </ul>
  );
}
