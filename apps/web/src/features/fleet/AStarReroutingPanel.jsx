import { useState, useEffect } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";

export function AiNotificationFeed({ events, onAck }) {
  const { t } = useLanguage();
  if (!events.length) {
    return <div className="ai-feed-empty">{t("ai_feed_empty")}</div>;
  }
  const latestFirst = events
    .map((e, i) => ({ ...e, _index: e._serverIndex ?? i }))
    .reverse()
    .slice(0, 6);
  return (
    <div className="ai-feed">
      {latestFirst.map((e) => (
        <div key={e._index} className={`ai-feed-item ai-feed-${e.event_type}`}>
          <div className="ai-feed-head">
            <span className="ai-feed-badge">{e.event_type}</span>
            <span className="ai-feed-time">{new Date(e.created_at).toLocaleTimeString("id-ID")}</span>
          </div>
          <div className="ai-feed-title">{e.title}</div>
          {e.status === "new" ? (
            <button className="ai-ack-btn" onClick={() => onAck(e._index)}>
              {t("ai_feed_ack")}
            </button>
          ) : (
            <span className="ai-ack-done">{t("ai_feed_acked")}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function AStarReroutingPanel({ jamActive, aiEvents, onAckEvent }) {
  const { t } = useLanguage();
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
    <section className="panel astar-panel" data-testid="astar-panel">
      <div className="panel-title">
        <div>
          <h2>
            {t("astar_monitor_title")}{" "}
            <span className="pill provenance-sim" data-testid="astar-sim-badge">
              {t("honesty_sim_badge")}
            </span>
          </h2>
          <p>{t("astar_subtitle")}</p>
        </div>
        <span className={`traffic-status-badge ${jamActive ? "congested" : "clear"}`}>
          <span className={`status-dot ${jamActive ? "danger" : "success"}`} />
          {jamActive ? t("astar_status_jam") : t("astar_status_clear")}
        </span>
      </div>

      <div className="astar-info-card">
        <div className="astar-stats">
          <div className="astar-stat-col">
            <span>{t("astar_dist")}</span>
            <strong>{dist == null ? "—" : `${Number(dist).toFixed(1)} km`}</strong>
          </div>
          <div className="astar-stat-col">
            <span>{t("astar_eta")}</span>
            <strong>{eta == null ? "—" : `${Math.round(eta)} min`}</strong>
          </div>
          <div className="astar-stat-col">
            <span>{t("astar_status")}</span>
            <strong className={diverted ? "text-diverted" : "text-normal"}>
              {diverted ? t("astar_diverted") : t("astar_primary")}
            </strong>
          </div>
        </div>

        <div className="astar-reroute-details">
          <div className="astar-route-step">
            <span>{t("astar_corridor_label")}</span>
            <strong>Daan Mogot ⇄ Bantargebang</strong>
          </div>
          <div className="astar-route-step">
            <span>{t("astar_engine_label")}</span>
            <strong>A* Heuristic (OSRM Grid)</strong>
          </div>
        </div>
      </div>

      <AiNotificationFeed events={rerouteEvents} onAck={onAckEvent} />
    </section>
  );
}
