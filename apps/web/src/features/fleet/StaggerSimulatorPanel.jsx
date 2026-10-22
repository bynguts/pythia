import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { RefreshCcw, Clock, ArrowRight } from "lucide-react";

// gsc P0-5: the one metric, read from GET /api/tpa/queue-metric (seeded, cached, SIMULATED).
export function QueueMetricHeadline({ metric, loading, testId }) {
  const { t } = useLanguage();
  if (!metric) {
    return (
      <p className="tpa-scenario-note" data-testid={`${testId}-status`}>
        {loading ? t("qm_loading") : t("qm_unavailable")}
      </p>
    );
  }
  // gsc n20: every detail field is optional; a missing one reads "—", never "undefined".
  const shown = (value) => (value === undefined || value === null ? "—" : String(value));
  const [lo, hi] = metric.staggered_ci95 || [];
  const detail = t("qm_detail")
    .replace("{bp95}", shown(metric.baseline_p95))
    .replace("{sp95}", shown(metric.staggered_p95))
    .replace("{lo}", shown(lo))
    .replace("{hi}", shown(hi))
    .replace("{n}", shown(metric.replications))
    .replace("{seed}", shown(metric.seed))
    .replace("{trucks}", shown(metric.trucks_per_day));
  return (
    <div
      className="queue-metric-headline"
      data-testid={testId}
      style={{ display: "grid", gap: "var(--space-1)", margin: "0 0 var(--space-3)" }}
    >
      <span className="stagger-label">
        {t("qm_label")}{" "}
        <span className="pill" data-testid={`${testId}-sim-badge`}>
          {t("honesty_sim_badge")}
        </span>
      </span>
      <strong>
        {metric.baseline_mean} → {metric.staggered_mean} {t("qm_min")}
      </strong>
      <small>{detail}</small>
    </div>
  );
}

// Roles holding operations:plan (app/core/auth.py ROLES); only they may POST the slot plan.
const PLAN_ROLES = ["dispatcher", "administrator"];

function mayPlan() {
  try {
    return PLAN_ROLES.includes(localStorage.getItem("pythia_role"));
  } catch {
    return false;
  }
}

export function StaggerSimulatorPanel() {
  const { t } = useLanguage();
  const [metric, setMetric] = useState(null);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);

  const runSimulation = useCallback(async () => {
    setLoading(true);
    try {
      const metricRes = await apiFetch("/tpa/queue-metric");
      if (metricRes.ok) setMetric(await metricRes.json());
      // gsc n19: the slot plan needs operations:plan; other roles skip the POST
      // (it would only 403) and still see the metric.
      if (mayPlan()) {
        const planRes = await apiFetch("/simulator/stagger", { method: "POST" });
        if (planRes.ok) setPlan(await planRes.json());
      }
    } catch {
      // API unreachable: keep whatever simulation result is already shown (never invented numbers)
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    runSimulation();
  }, [runSimulation]);

  const slots = plan?.dispatch_slots || [];

  return (
    <section className="panel wide stagger-panel" data-testid="stagger-panel">
      <div className="panel-title">
        <div>
          <h2>
            {t("stagger_title")}{" "}
            <span className="pill" data-testid="stagger-sim-badge">
              {t("honesty_sim_badge")}
            </span>
          </h2>
          <p>{t("stagger_subtitle")}</p>
        </div>
        <button
          className="primary-button"
          onClick={runSimulation}
          disabled={loading}
          style={{ width: "auto", padding: "0 16px", fontSize: "12.5px" }}
        >
          <RefreshCcw size={14} /> {loading ? t("stagger_running") : t("btn_rerun_optimizer")}
        </button>
      </div>

      <QueueMetricHeadline metric={metric} loading={loading} testId="stagger-queue-metric" />

      {metric && (
        <div className="stagger-compare" style={{ marginBottom: "var(--space-5)" }}>
          <div className="stagger-col before">
            <span className="stagger-label">{t("stagger_uncoord")}</span>
            <strong>
              {metric.baseline_mean} {t("qm_min")}
            </strong>
            <small>
              {metric.baseline_max_queue} {t("stagger_queued")}
            </small>
          </div>
          <div
            className="stagger-arrow"
            style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <ArrowRight size={18} />
          </div>
          <div className="stagger-col after">
            <span className="stagger-label">{t("stagger_pythia")}</span>
            <strong>
              {metric.staggered_mean} {t("qm_min")}
            </strong>
            <small>
              {metric.staggered_max_queue} {t("stagger_queued")}
            </small>
          </div>
          {/* gsc n21: the reduction is only shown next to the baseline it is measured against. */}
          {metric.baseline_mean > 0 && metric.assumptions?.baseline && (
            <div className="stagger-badge" data-testid="stagger-reduction-badge">
              -
              {Math.round(((metric.baseline_mean - metric.staggered_mean) / metric.baseline_mean) * 1000) /
                10}
              % {t("stagger_delay_badge")}
            </div>
          )}
        </div>
      )}
      {metric?.baseline_mean > 0 && metric.assumptions?.baseline && (
        <p className="tpa-scenario-note" data-testid="stagger-baseline-assumption">
          {t("stagger_baseline_assumption")}
        </p>
      )}

      {slots.length > 0 && (
        <div className="stagger-schedule-wrap">
          <h3 style={{ fontSize: "13px", fontWeight: 700, margin: "0 0 10px", color: "var(--ui-ink)" }}>
            {t("stagger_slots_title")}
          </h3>
          <p className="tpa-scenario-note" data-testid="stagger-fleet-note">
            {t("stagger_fleet_note")
              .replace("{fleet}", plan.fleet_per_shift)
              .replace("{trucks}", plan.trucks_per_day)}
          </p>
          <div className="table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th scope="col">{t("stagger_th_slot")}</th>
                  <th scope="col">{t("stagger_th_departure")}</th>
                  <th scope="col">{t("stagger_th_trucks")}</th>
                  <th scope="col">{t("stagger_th_wait")}</th>
                  <th scope="col">{t("stagger_th_status")}</th>
                </tr>
              </thead>
              <tbody>
                {slots.slice(0, 10).map((slot) => (
                  <tr key={slot.slot_index}>
                    <td>
                      <span className="plate-badge">S-{String(slot.slot_index).padStart(2, "0")}</span>
                    </td>
                    <td>
                      <span style={{ fontFamily: "var(--mono, monospace)", fontWeight: 600 }}>
                        <Clock
                          size={12}
                          style={{ display: "inline-block", verticalAlign: "-1px", marginRight: "4px" }}
                        />
                        {slot.suggested_departure} WIB
                      </span>
                    </td>
                    <td>{slot.trucks_in_slot}</td>
                    <td>
                      <span className="speed-badge">
                        {slot.tpa_wait_est_minutes} {t("qm_min")}
                      </span>
                    </td>
                    <td>
                      <span className="pill">{t("stagger_slot_planned")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
