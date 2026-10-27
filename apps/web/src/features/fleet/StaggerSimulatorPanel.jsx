import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { ListRow } from "../../shared/ui/ListRow.jsx";
import { Provenance } from "../../shared/ui/Provenance.jsx";
import { ROLE_PERMISSIONS } from "../settings/roles.js";
import { RefreshCcw, ArrowRight, Info, Hourglass } from "lucide-react";

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

// The rail's foot, unstaggered vs staggered wait from the same seeded
// queue metric as the TPA tab, with its provenance in one mono line.
// One read of the day-mean queue metric, shared by the strip tile and the
// rail foot so both name the same statistic.
export function useQueueMetric() {
  const [metric, setMetric] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    apiFetch("/tpa/queue-metric")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => !cancelled && setMetric(body))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);
  return { metric, loading };
}

export function formatQueueMinutes(value, lang) {
  return value == null ? "—" : Number(value).toLocaleString(localeFor(lang), { maximumFractionDigits: 1 });
}

export function StaggerSummary({ metric, loading, onOpen }) {
  const { t, lang } = useLanguage();
  const minutes = (value) => formatQueueMinutes(value, lang);

  return (
    <section className="stagger-summary" data-testid="fleet-stagger-summary">
      <div className="stagger-summary-head">
        <h2>{t("w11fleet_stagger_title")}</h2>
        <button type="button" className="attn-action" onClick={onOpen}>
          {t("w11fleet_stagger_open")}
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
      {metric ? (
        <>
          <dl className="stagger-summary-pair">
            <div>
              <dt>{t("w11fleet_stagger_before")}</dt>
              <dd>
                <strong>{minutes(metric.baseline_mean)}</strong> {t("w11fleet_stagger_unit")}
              </dd>
            </div>
            <div className="is-better">
              <dt>{t("w11fleet_stagger_after")}</dt>
              <dd>
                <strong>{minutes(metric.staggered_mean)}</strong> {t("w11fleet_stagger_unit")}
              </dd>
            </div>
          </dl>
          <p className="prov-line" data-testid="fleet-stagger-provenance">
            {t("w11fleet_stagger_prov")
              .replace("{lanes}", metric.assumptions?.weighbridge_lanes ?? "—")
              .replace("{cycle}", metric.assumptions?.weigh_cycle_minutes ?? "—")}
          </p>
        </>
      ) : (
        <p className="prov-line">{loading ? t("qm_loading") : t("qm_unavailable")}</p>
      )}
    </section>
  );
}

// Only a role holding dispatch:create may send a hold to a driver (app/core/auth.py ROLES).
function mayDispatch() {
  try {
    return (ROLE_PERMISSIONS[localStorage.getItem("pythia_role")] || []).includes("dispatch:create");
  } catch {
    return false;
  }
}

export function StaggerSimulatorPanel() {
  const { t, lang } = useLanguage();
  const [metric, setMetric] = useState(null);
  // Per-truck gate-slot holds for today's approved plans (GET /api/gate/slots).
  const [gate, setGate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(null);
  const [acceptFailed, setAcceptFailed] = useState(null);

  const runSimulation = useCallback(async () => {
    setLoading(true);
    try {
      const metricRes = await apiFetch("/tpa/queue-metric");
      if (metricRes.ok) setMetric(await metricRes.json());
      const gateRes = await apiFetch("/gate/slots");
      if (gateRes.ok) setGate(await gateRes.json());
    } catch {
      // API unreachable: keep whatever simulation result is already shown (never invented numbers)
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    runSimulation();
  }, [runSimulation]);

  async function accept(rec) {
    setAccepting(rec.id);
    setAcceptFailed(null);
    try {
      const response = await apiFetch(`/gate/slots/recommendations/${encodeURIComponent(rec.id)}/accept`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      setGate((current) => ({
        ...current,
        recommendations: current.recommendations.map((r) =>
          r.id === rec.id ? { ...r, accepted: true, dispatch_id: body.dispatch_id } : r,
        ),
      }));
    } catch {
      setAcceptFailed(rec.id);
    }
    setAccepting(null);
  }

  const recommendations = gate?.recommendations || [];
  const canAccept = mayDispatch();

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

      {gate && (
        <div className="stagger-schedule-wrap" data-testid="gate-slot-recs">
          <h3>
            {t("w12_gate_title")} <Provenance kind="sim">{t("honesty_sim_badge")}</Provenance>
          </h3>
          {recommendations.length === 0 ? (
            <p className="tpa-scenario-note" data-testid="gate-slot-empty">
              {t(
                gate.reason === "no_approved_plan"
                  ? "w12_gate_no_plan"
                  : gate.reason === "saturated"
                    ? "w12_gate_saturated"
                    : "w12_gate_no_holds",
              ).replace("{slots}", (gate.saturated_slots || []).join(", "))}
            </p>
          ) : (
            <ul className="ui-list">
              {recommendations.map((rec) => (
                <ListRow
                  key={rec.id}
                  icon={Hourglass}
                  tone={rec.accepted ? "success" : "warning"}
                  title={t("w12_gate_hold")
                    .replace("{truck}", rec.truck_code)
                    .replace("{n}", rec.hold_minutes)
                    .replace("{from}", rec.from_slot)
                    .replace("{to}", rec.to_slot)}
                  meta={t("w12_gate_gain").replace(
                    "{n}",
                    formatQueueMinutes(rec.expected_wait_reduction_min, lang),
                  )}
                  testId="gate-slot-rec"
                >
                  {rec.accepted ? (
                    <p className="tpa-scenario-note" data-testid="gate-slot-accepted">
                      {t("w12_gate_sent")}
                    </p>
                  ) : (
                    canAccept && (
                      <button
                        type="button"
                        className="ghost-button"
                        data-testid="gate-slot-accept"
                        onClick={() => accept(rec)}
                        disabled={accepting != null}
                      >
                        {t("w12_gate_apply")}
                      </button>
                    )
                  )}
                  {acceptFailed === rec.id && (
                    <p className="tpa-scenario-note" role="alert">
                      {t("w12_gate_apply_failed")}
                    </p>
                  )}
                </ListRow>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
