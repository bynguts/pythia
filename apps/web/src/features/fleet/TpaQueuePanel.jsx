import { useState, useEffect } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Clock } from "lucide-react";
import { QueueMetricHeadline } from "./StaggerSimulatorPanel.jsx";

export function TpaQueuePanel() {
  const { t } = useLanguage();
  const [live, setLive] = useState(null);
  const [queue, setQueue] = useState(null);
  const [metric, setMetric] = useState(null);
  const [metricLoading, setMetricLoading] = useState(true);
  const [mode, setMode] = useState("live");
  const [scenario, setScenario] = useState("peak");

  async function fetchQueue(sc = scenario) {
    try {
      const res = await apiFetch(`/tpa/queue-status?scenario=${sc}`);
      if (res.ok) setQueue(await res.json());
    } catch {
      // API unreachable: keep the previous queue status
    }
  }

  useEffect(() => {
    apiFetch("/tpa/queue-metric")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMetric)
      .catch(() => {})
      .finally(() => setMetricLoading(false));
  }, []);

  useEffect(() => {
    const load = () =>
      apiFetch("/ai/tpa-queue-live")
        .then((r) => r.json())
        .then(setLive)
        .catch(() => {});
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (mode !== "whatif") return;
    fetchQueue(scenario);
    const interval = setInterval(() => fetchQueue(scenario), 6000);
    return () => clearInterval(interval);
  }, [mode, scenario]);

  const congestionClass =
    {
      low: "text-normal",
      moderate: "text-warning",
      high: "text-diverted",
      severe: "text-danger",
    }[live?.congestion_level] || "text-normal";
  const trendArrow = { rising: "↑", falling: "↓", stable: "→" }[live?.trend] || "→";

  return (
    <section className="panel tpa-queue-panel" data-testid="tpa-queue-panel">
      <div className="panel-title">
        <div>
          <h2>
            {t("tpa_panel_title")}{" "}
            <span className="pill" data-testid="tpa-sim-badge">
              {t("honesty_sim_badge")}
            </span>
          </h2>
          <p>{t("tpa_subtitle")}</p>
        </div>
        <div className="tpa-scenario-toggle" role="group" aria-label={t("tpa_mode_aria")}>
          {[
            ["live", t("tpa_mode_now")],
            ["whatif", t("tpa_mode_whatif")],
          ].map(([id, label]) => (
            <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="panel-header-icon-wrap">
          <Clock size={18} />
        </div>
      </div>
      <QueueMetricHeadline metric={metric} loading={metricLoading} testId="tpa-queue-metric" />
      {mode === "live" ? (
        !live || live.status === "no_data" ? (
          <div className="ai-feed-empty">{t("ai_engine_waiting")}</div>
        ) : (
          <div className="tpa-live-gauge">
            <div className={`tpa-wait-number ${congestionClass}`}>
              {Math.round(live.predicted_wait_min)}
              <span> {t("qm_min")}</span> {trendArrow}
            </div>
            <div className="tpa-live-stats">
              <div>
                <span>{t("tpa_in_queue")}</span>
                <strong>
                  {live.trucks_in_queue} {t("tpa_trucks")}
                </strong>
              </div>
              <div>
                <span>{t("tpa_arriving")}</span>
                <strong>
                  {live.arriving_soon} {t("tpa_trucks")}
                </strong>
              </div>
              <div>
                <span>{t("tpa_arrival_rate")}</span>
                <strong data-testid="tpa-arrival-rate">
                  {live.arrival_rate_per_h.toFixed(0)}
                  {t("tpa_per_hour")}
                </strong>
              </div>
              <div>
                <span>CI95</span>
                <strong>
                  {live.wait_ci95.map((v) => v.toFixed(0)).join("–")} {t("qm_min")}
                </strong>
              </div>
            </div>
            <div className={`pill ${congestionClass}`}>{live.congestion_level.toUpperCase()}</div>
          </div>
        )
      ) : (
        <div className="tpa-whatif">
          <div className="tpa-scenario-toggle" role="group" aria-label={t("tpa_scenario_aria")}>
            {[
              ["peak", t("tpa_scenario_peak")],
              ["live", t("tpa_scenario_clock")],
            ].map(([id, label]) => (
              <button key={id} className={scenario === id ? "active" : ""} onClick={() => setScenario(id)}>
                {label}
              </button>
            ))}
          </div>
          {queue && (
            <>
              {queue.arrival_profile && (
                <p className="tpa-scenario-note">
                  {t("tpa_arrival_profile")} {queue.arrival_profile} · {queue.method}
                </p>
              )}

              <div className="tpa-status-grid">
                <div className="tpa-status-card">
                  <span>{t("tpa_queued")}</span>
                  <strong data-testid="tpa-queued-trucks">
                    {queue.queue_trucks_max ?? queue.trucks_in_queue} {t("tpa_units")}
                  </strong>
                  {/* gsc m8: trucks waiting (peak, mean) are not arrivals; both are shown apart. */}
                  {queue.queue_trucks_mean != null && (
                    <small data-testid="tpa-queue-mean">
                      {t("tpa_queue_peak_mean").replace("{n}", Number(queue.queue_trucks_mean).toFixed(1))}
                    </small>
                  )}
                  {queue.arrivals_per_hour != null && (
                    <small data-testid="tpa-arrivals-per-hour">
                      {t("tpa_arrivals_per_hour").replace("{n}", queue.arrivals_per_hour)}
                    </small>
                  )}
                </div>
                <div className="tpa-status-card">
                  <span>{t("tpa_est_wait")}</span>
                  <strong className={queue.avg_wait_minutes > 60 ? "text-danger" : "text-success"}>
                    {queue.avg_wait_minutes} {t("qm_min")}
                  </strong>
                </div>
                <div className="tpa-status-card">
                  <span>{t("tpa_weighbridge")}</span>
                  <strong
                    className={queue.weighbridge_status.includes("DEGRADED") ? "text-danger" : "text-success"}
                  >
                    {queue.weighbridge_status}
                  </strong>
                </div>
              </div>

              <div className="tpa-logs">
                <h3>{t("tpa_log_title")}</h3>
                <ul>
                  {queue.scale_logs?.map((log, i) => (
                    <li key={i}>
                      <span className="time">
                        <Clock
                          size={12}
                          style={{ display: "inline-block", verticalAlign: "-1px", marginRight: "3px" }}
                        />
                        {log.time}
                      </span>
                      <span className="truck">{log.truck}</span>
                      <span className="weight">
                        {log.weight_ton} {t("tpa_tons")}
                      </span>
                      <span className={`status-badge ${log.status.toLowerCase()}`}>{log.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
