import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { RefreshCcw, Clock, ArrowRight, Info } from "lucide-react";

// The landfill beacon describes the modelled peak hour of a simulated day, never the
// wall clock; every surface labels it the same way ("modelled peak hour 09:00").
export function modelledPeakLabel(t, hour) {
  if (hour === undefined || hour === null) return null;
  return t("queue_modelled_peak").replace("{hour}", `${String(hour).padStart(2, "0")}:00`);
}

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
  // gsc teardown #3: the baseline is a range over plausible departure spreads, not one point.
  const sensitivityRows = metric.sensitivity?.rows || [];
  const [bandLow, bandHigh] = metric.sensitivity?.baseline_band || [];
  const band =
    sensitivityRows.length > 0
      ? t("qm_band")
          .replace("{low}", shown(bandLow))
          .replace("{high}", shown(bandHigh))
          .replace("{sd_lo}", shown(sensitivityRows[0].departure_sd_minutes))
          .replace("{sd_hi}", shown(sensitivityRows[sensitivityRows.length - 1].departure_sd_minutes))
          .replace("{sd}", shown(metric.baseline_departure_sd_minutes))
          .replace("{lanes}", shown(metric.assumptions?.weighbridge_lanes))
          .replace("{cycle}", shown(metric.assumptions?.weigh_cycle_minutes))
      : null;
  return (
    <div
      className="queue-metric-headline"
      data-testid={testId}
      style={{ display: "grid", gap: "var(--space-1)", margin: "0 0 var(--space-3)" }}
    >
      <span className="stagger-label">
        {t("qm_label")}{" "}
        <span className="pill provenance-sim" data-testid={`${testId}-sim-badge`}>
          {t("honesty_sim_badge")}
        </span>
      </span>
      <strong>
        {metric.baseline_mean} → {metric.staggered_mean} {t("qm_min")}
      </strong>
      {/* Teardown v4 F10: P95, CI, replications and seed sit behind "Metode", one tap away. */}
      <details className="metric-method" data-testid={`${testId}-method`}>
        <summary>
          <Info size={14} aria-hidden="true" /> {t("dr_method")}
        </summary>
        <small>{detail}</small>
        {band && <small data-testid={`${testId}-band`}>{band}</small>}
      </details>
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
            <span className="pill provenance-sim" data-testid="stagger-sim-badge">
              {t("honesty_sim_badge")}
            </span>
          </h2>
          <p>{t("stagger_subtitle")}</p>
        </div>
        <button className="ghost-button" type="button" onClick={runSimulation} disabled={loading}>
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
          {t("stagger_baseline_assumption").replace("{sd}", metric.baseline_departure_sd_minutes ?? "—")}
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
                      <span style={{ fontWeight: 600 }}>
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
