import { useState, useEffect } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";

// Reroute events need the operator's confirmation: one row each, one primary action.
export function AiNotificationFeed({ events, onAck }) {
  const { t, lang } = useLanguage();
  if (!events.length) return null;
  const latestFirst = events
    .map((e, i) => ({ ...e, _index: e._serverIndex ?? i }))
    .reverse()
    .slice(0, 6);
  return (
    <ul className="ai-feed">
      {latestFirst.map((e) => (
        <li key={e._index} className={`ai-feed-item ai-feed-${e.event_type}`}>
          <div className="ai-feed-head">
            <span className="ai-feed-title">
              {e.truck_code && <b className="mono-id">{e.truck_code}</b>}{" "}
              {t(`w10fleet_event_${e.event_type}`)}
            </span>
            <span className="ai-feed-time">
              {new Date(e.created_at).toLocaleTimeString(localeFor(lang), {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          {e.status === "new" ? (
            <button type="button" className="ghost-button ai-ack-btn" onClick={() => onAck(e._index)}>
              {t("w10fleet_reroute_confirm")}
            </button>
          ) : (
            <span className="ai-ack-done">{t("w10fleet_reroute_confirmed")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AStarReroutingPanel({ jamActive, aiEvents, onAckEvent }) {
  const { t, lang } = useLanguage();
  const [info, setInfo] = useState(null);

  useEffect(() => {
    const load = () =>
      apiFetch("/fleet/astar-reroute")
        .then((res) => res.json())
        .then(setInfo)
        .catch(() => {});
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  const rerouteEvents = (aiEvents || [])
    .map((e, serverIndex) => ({ ...e, _serverIndex: serverIndex }))
    .filter((e) => e.event_type === "auto_reroute" || e.event_type === "jam_cleared");
  const diverted = info?.diversion_applied;
  // No route payload yet: show a dash, never a made-up distance or ETA.
  const dist = info?.active_route?.distance_km;
  const eta = info?.active_route?.eta_minutes;

  return (
    <section className="reroute-block" data-testid="astar-panel">
      <div className="reroute-head">
        <div>
          <h3>
            {t("w10fleet_reroute_title")}{" "}
            <span className="pill provenance-sim" data-testid="astar-sim-badge">
              {t("honesty_sim_badge")}
            </span>
          </h3>
          <p>{t("w10fleet_reroute_sub")}</p>
        </div>
        <span className={`traffic-status-badge ${jamActive ? "congested" : "clear"}`}>
          <span className={`status-dot ${jamActive ? "danger" : "success"}`} />
          {jamActive ? t("astar_status_jam") : t("astar_status_clear")}
        </span>
      </div>

      <dl className="reroute-stats">
        <div className="astar-stat-col">
          <dt>{t("astar_dist")}</dt>
          <dd>
            <strong>
              {dist == null
                ? "—"
                : `${Number(dist).toLocaleString(localeFor(lang), { maximumFractionDigits: 1 })} km`}
            </strong>
          </dd>
        </div>
        <div className="astar-stat-col">
          <dt>{t("astar_eta")}</dt>
          <dd>
            <strong>{eta == null ? "—" : `${Math.round(eta)} ${t("fmap_min")}`}</strong>
          </dd>
        </div>
        <div className="astar-stat-col">
          <dt>{t("astar_status")}</dt>
          <dd>
            <strong className={diverted ? "text-diverted" : "text-normal"}>
              {diverted ? t("w10fleet_reroute_diverted") : t("astar_primary")}
            </strong>
          </dd>
        </div>
      </dl>

      <AiNotificationFeed events={rerouteEvents} onAck={onAckEvent} />
    </section>
  );
}
