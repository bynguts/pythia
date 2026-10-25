import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../../shared/api/client.js";
import { fetchOutlook, fleetDenominator } from "../../shared/hooks/useBaseline.js";
import { signedPercent } from "../../shared/hooks/useSnapshot.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { IntegratedPlanning } from "./IntegratedPlanning.jsx";
import { ExecutiveSummary } from "./ExecutiveSummary.jsx";
import { PlanningApproval, ScenarioPanel } from "./PlanningApproval.jsx";
import { PlanQuotaUsage, PlanRules } from "./PlanConstraints.jsx";
import { isWeekendDate, localIsoDate } from "./planDate.js";
import { readPlanningScenario } from "./scenarioLink.js";
import { WEIGHBRIDGE_LANES } from "../twin/twinLinks.js";
import { Users, Workflow } from "lucide-react";

const VENUES = ["gbk", "jis", "monas"];
const MAX_PLAN_DAYS = 30; // /api/baseline/scenario serves up to 30 days ahead

function daysFromToday(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const now = new Date();
  return Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5,
  );
}

// Teardown v4 R2: Rencana opens on today's forecast (the same baseline as Prediksi
// and the twin). A manual what-if is opt-in, and once set every figure carries a
// "Skenario" label. A twin or event hand-off arrives as ?scenario=… (scenarioLink.js).
export function PlanningDecisionFlow({
  attendance,
  setAttendance,
  rainfall,
  setRainfall,
  eventLat,
  eventLng,
  snapshot,
  queue,
}) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const [searchParams] = useSearchParams();
  const [outlook, setOutlook] = useState(null);
  const [loading, setLoading] = useState(false);
  const forecastRequest = useRef(0);
  const planRequest = useRef(0);
  const [forecastError, setForecastError] = useState(false);
  // Operations optimizer state for forecast-to-dispatch handoff.
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [approved, setApproved] = useState(false);
  const [optimizerError, setOptimizerError] = useState(null);
  // The plan is for one calendar day; weekday or weekend follows from it.
  const [planDate, setPlanDate] = useState(() => localIsoDate());
  const [venue, setVenue] = useState("gbk");
  const [handoff, setHandoff] = useState(null);
  const [laneQueue, setLaneQueue] = useState(null);
  const weekend = isWeekendDate(planDate);
  // A closed weighbridge lane (?lanes=) changes only the simulated TPA queue, never tonnes.
  const lanesOpen = handoff?.lanes ?? null;
  const scenarioActive = rainfall > 0 || attendance > 0 || lanesOpen != null;

  const role = localStorage.getItem("pythia_role") || "guest";

  const [aiOutlook, setAiOutlook] = useState([]);

  useEffect(() => {
    const load = () =>
      apiFetch("/ai/event-forecast")
        .then((r) => r.json())
        .then((body) => setAiOutlook(body.outlook || []))
        .catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  // A hand-off (?scenario=…) from the twin or the event list sets the what-if once.
  useEffect(() => {
    const incoming = readPlanningScenario(searchParams);
    if (!incoming) return;
    setHandoff(incoming);
    setRainfall(incoming.rainfall);
    setAttendance(incoming.attendance);
    if (incoming.venue && VENUES.includes(incoming.venue)) setVenue(incoming.venue);
    if (incoming.date) setPlanDate(incoming.date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // The lane scenario's queue before/after comes from the twin briefing (same simulation).
  useEffect(() => {
    setLaneQueue(null);
    if (lanesOpen == null) return undefined;
    const controller = new AbortController();
    apiFetch(`/twin/briefing?scenario=${encodeURIComponent(handoff.id)}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (body?.after?.weighbridge_lanes === lanesOpen) setLaneQueue(body);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [handoff, lanesOpen]);

  // An agreement at the XR table on this scenario and day (a session note, never an approval).
  const [agreement, setAgreement] = useState(null);
  useEffect(() => {
    setAgreement(null);
    if (!handoff?.id) return undefined;
    const controller = new AbortController();
    const query = new URLSearchParams({ scenario: handoff.id, date: planDate });
    const load = () =>
      apiFetch(`/twin/agreements?${query}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => setAgreement(body?.agreements?.[0] || null))
        .catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [handoff, planDate]);

  const dayIndex = daysFromToday(planDate);
  const dateInRange = dayIndex >= 0 && dayIndex < MAX_PLAN_DAYS;
  const place =
    handoff?.lat != null
      ? { lat: handoff.lat, lng: handoff.lng }
      : { lat: eventLat ?? null, lng: eventLng ?? null };

  async function run() {
    const request = ++forecastRequest.current;
    ++planRequest.current;
    setPlanLoading(false);
    setLoading(true);
    setForecastError(false);
    setPlan(null);
    setApproved(false);
    setOptimizerError(null);
    try {
      if (!dateInRange) throw new Error("date");
      const result = await fetchOutlook({
        rainfall,
        attendance,
        venue: place.lat == null ? venue : undefined,
        lat: place.lat,
        lng: place.lng,
        date: planDate,
        days: dayIndex < 7 ? 7 : MAX_PLAN_DAYS,
      });
      if (request === forecastRequest.current) setOutlook(result);
    } catch {
      if (request === forecastRequest.current) {
        setOutlook(null);
        setForecastError(true);
      }
    } finally {
      if (request === forecastRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attendance, rainfall, eventLat, eventLng, planDate, venue, handoff]);

  function resetScenario() {
    setHandoff(null);
    setRainfall(0);
    setAttendance(0);
  }

  async function generatePlan() {
    const request = ++planRequest.current;
    setPlanLoading(true);
    setApproved(false);
    setOptimizerError(null);
    try {
      // The optimizer plans the same day the outlook describes: its rain (forecast
      // or what-if) and its event, so its demand matches the figures above it.
      const params = new URLSearchParams({
        rainfall_mm: String(outlook?.weather?.rainfall_mm ?? rainfall ?? 0),
        event_attendance: String(attendance),
        plan_date: planDate,
        top_n: "5",
      });
      if (outlook?.event?.lat != null) {
        params.append("event_lat", String(outlook.event.lat));
        params.append("event_lng", String(outlook.event.lng));
      }
      const response = await apiFetch(`/operations/plan?${params.toString()}`, {
        method: "POST",
      });
      if (!response.ok) {
        if (request === planRequest.current)
          setOptimizerError({ status: response.status, action: "generate" });
        return;
      }
      const planData = await response.json();
      if (request === planRequest.current) setPlan(planData);
    } catch {
      if (request === planRequest.current) setOptimizerError({ status: 0, action: "generate" });
    } finally {
      if (request === planRequest.current) setPlanLoading(false);
    }
  }

  async function approvePlan() {
    if (!plan) return;
    const request = ++planRequest.current;
    setPlanLoading(true);
    setOptimizerError(null);
    try {
      const response = await apiFetch(`/operations/${encodeURIComponent(plan.plan_id)}/approve`, {
        method: "POST",
      });
      if (!response.ok) {
        if (request === planRequest.current)
          setOptimizerError({ status: response.status, action: "approve" });
        return;
      }
      const approvedData = await response.json();
      if (request === planRequest.current) {
        setPlan(approvedData);
        setApproved(true);
      }
    } catch {
      if (request === planRequest.current) setOptimizerError({ status: 0, action: "approve" });
    } finally {
      if (request === planRequest.current) setPlanLoading(false);
    }
  }

  const number = (value) => Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 2 });
  // Sign from the printed value, so a delta that rounds to zero reads "0", never "+0" or "-0".
  const signedNumber = (value) => {
    const text = number(value);
    if (!/[1-9]/.test(text)) return number(0);
    return Number(value) > 0 ? `+${text}` : text;
  };
  const reason = (code) => {
    if (code === "no_permit_compliant_vehicle") return t("w10num_reason_no_permit");
    if (code === "no_available_vehicle") return t("w10num_reason_no_vehicle");
    if (code === "no_feasible_assignment") return t("w10num_reason_infeasible");
    const [binding, bindingArea] = code.split(":");
    const bindingLabel = t(`pln6_binding_${binding}`);
    if (bindingArea && bindingLabel !== `pln6_binding_${binding}`) {
      return `${bindingLabel}: ${bindingArea.replace(/_/g, " ")}`;
    }
    if (code.startsWith("insufficient_capacity:")) {
      return t("w10num_reason_capacity").replace(
        "{area}",
        code.slice("insufficient_capacity:".length).replace(/_/g, " "),
      );
    }
    return t("w10num_reason_other");
  };
  const errorKey = optimizerError
    ? { 401: "w10num_err_401", 403: "w10num_err_403", 404: "w10num_err_404", 422: "w10num_err_422" }[
        optimizerError.status
      ] ||
      (optimizerError.status === 429
        ? "w10num_err_429"
        : optimizerError.status === 0
          ? "w10num_err_network"
          : optimizerError.action === "approve"
            ? "w10num_err_approve"
            : "w10num_err_generate")
    : null;

  const isScenario = outlook?.kind === "scenario" || (outlook != null && lanesOpen != null);
  // The twin's scenario names (dr_scn_*) first, then this lane's, then a generic origin.
  const labelKey = handoff
    ? [`dr_scn_${handoff.id}`, `w10num_scn_${handoff.id}`].find((key) => t(key) !== key)
    : null;
  const scenarioLabel = handoff
    ? labelKey
      ? t(labelKey)
      : t("w10num_scn_from_twin")
    : t("w10num_scn_manual");
  // The briefing describes today; on another plan date its queue is not this day's.
  const laneQueueShown =
    laneQueue && outlook && laneQueue.date === outlook.date && laneQueue.before && laneQueue.after
      ? laneQueue
      : null;
  const delta =
    isScenario && outlook.baseline ? outlook.total_tonnage_t - outlook.baseline.total_tonnage_t : null;
  const deltaPct =
    delta != null && outlook.baseline.total_tonnage_t > 0
      ? (delta / outlook.baseline.total_tonnage_t) * 100
      : null;

  return (
    <IntegratedPlanning
      summary={<ExecutiveSummary outlook={outlook} snapshot={snapshot} queue={queue} />}
      scenario={{
        inputs: (
          <ScenarioPanel mode="inputs">
            <div className="panel-title">
              <div>
                <h2>{t("w10num_plan_basis_title")}</h2>
                <p>{t("w10num_plan_basis_sub")}</p>
              </div>
              <div className="panel-header-icon-wrap">
                <Users size={18} />
              </div>
            </div>
            <div className="plan-date-row">
              <label>
                <span>{t("pln6_plan_date")}</span>
                <input
                  type="date"
                  data-testid="plan-date"
                  value={planDate}
                  min={localIsoDate()}
                  onChange={(event) => event.target.value && setPlanDate(event.target.value)}
                />
              </label>
              <span className="day-kind-chip" data-testid="plan-day-kind">
                {t(weekend ? "pln6_day_weekend" : "pln6_day_weekday")}
              </span>
            </div>

            <div
              className={`plan-outlook${isScenario ? " is-scenario" : ""}`}
              data-testid="plan-outlook"
              data-kind={isScenario ? "scenario" : outlook?.kind || "loading"}
              aria-live="polite"
            >
              <p className="plan-outlook-basis">
                {isScenario ? (
                  <span className="scenario-badge" data-testid="plan-scenario-badge">
                    {t("w10num_scenario_badge")}
                  </span>
                ) : (
                  <span className="classification-badge modeled">{t("w10num_badge_model")}</span>
                )}{" "}
                {isScenario
                  ? t("w10num_plan_scenario_basis")
                      .replace("{label}", scenarioLabel)
                      .replace("{date}", outlook.date)
                  : outlook
                    ? t(dayIndex === 0 ? "w10num_plan_today_basis" : "w10num_plan_day_basis").replace(
                        "{date}",
                        outlook.date,
                      )
                    : t(loading ? "w10num_calculating" : "w10num_loading")}
              </p>
              {isScenario && agreement && (
                <p
                  className="plan-xr-agreed"
                  data-testid="plan-xr-agreed"
                  data-participants={agreement.participants}
                >
                  <strong>{t("dr_plan_agreed").replace("{n}", number(agreement.participants))}</strong>
                  {" · "}
                  <span>{t("dr_plan_agreed_note")}</span>
                </p>
              )}
              {isScenario && lanesOpen != null && (
                <p className="plan-lanes-note" data-testid="plan-lanes-note">
                  {t("w10num_plan_lanes_note")
                    .replace("{closed}", WEIGHBRIDGE_LANES - lanesOpen)
                    .replace("{total}", WEIGHBRIDGE_LANES)}
                  {laneQueueShown && (
                    <>
                      {" "}
                      <strong
                        data-testid="plan-lanes-queue"
                        data-before={laneQueueShown.before.queue_minutes_per_truck}
                        data-after={laneQueueShown.after.queue_minutes_per_truck}
                      >
                        {t("w10num_plan_lanes_queue")
                          .replace("{before}", number(laneQueueShown.before.queue_minutes_per_truck))
                          .replace("{after}", number(laneQueueShown.after.queue_minutes_per_truck))}
                      </strong>
                    </>
                  )}
                </p>
              )}
              {outlook && (
                <dl className="plan-outlook-grid">
                  <div>
                    <dt>{t("w10num_plan_total")}</dt>
                    <dd data-testid="plan-total" data-value={outlook.total_tonnage_t}>
                      {number(outlook.total_tonnage_t)} t
                    </dd>
                    {deltaPct != null && (
                      <small data-testid="plan-delta">
                        {t("w10num_plan_vs_baseline")
                          .replace("{base}", number(outlook.baseline.total_tonnage_t))
                          .replace("{pct}", signedPercent(deltaPct))}
                      </small>
                    )}
                  </div>
                  <div>
                    <dt>{t("w10num_today_at_risk")}</dt>
                    <dd data-testid="plan-at-risk" data-value={outlook.kecamatan_at_risk}>
                      {t("w10num_n_of_m")
                        .replace("{n}", outlook.kecamatan_at_risk)
                        .replace("{m}", outlook.kecamatan_count)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("w10num_today_trucks")}</dt>
                    <dd data-testid="plan-trucks" data-value={outlook.trucks_needed}>
                      {number(outlook.trucks_needed)}
                    </dd>
                    <small>
                      {t("w10num_trucks_city_note").replace("{t}", outlook.units?.truck_capacity_tons)}
                    </small>
                  </div>
                  <div>
                    <dt>{t("w10num_fleet_pilot")}</dt>
                    <dd data-testid="fleet-denominator">{fleetDenominator(t, outlook.fleet)}</dd>
                    <small>{t("honesty_sim_badge")}</small>
                  </div>
                </dl>
              )}
            </div>

            <div className="ai-outlook">
              <h3>{t("w10num_ai_outlook")}</h3>
              {aiOutlook.length === 0 ? (
                <div className="ai-feed-empty">{t("w10num_ai_outlook_empty")}</div>
              ) : (
                <table className="ai-outlook-table">
                  <thead>
                    <tr>
                      <th>{t("w10num_th_date")}</th>
                      <th>{t("w10num_th_rain")}</th>
                      <th>{t("w10num_th_event")}</th>
                      <th>Δ Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiOutlook.map((d) => (
                      <tr key={d.date}>
                        <td>
                          {new Date(`${d.date}T00:00:00`).toLocaleDateString(locale, {
                            day: "2-digit",
                            month: "short",
                          })}
                          {d.is_holiday ? ` ${t("w10num_holiday_suffix")}` : ""}
                        </td>
                        <td>{number(d.rainfall_mm)} mm</td>
                        <td>
                          {d.events?.length
                            ? d.events
                                .map((e) =>
                                  t("w10num_event_people")
                                    .replace("{name}", e.name)
                                    .replace("{n}", number(e.expected_attendance)),
                                )
                                .join(", ")
                            : "—"}
                        </td>
                        <td
                          className={
                            d.volume_delta_pct > 15
                              ? "text-danger"
                              : d.volume_delta_pct > 5
                                ? "text-warning"
                                : "text-normal"
                          }
                        >
                          {signedNumber(d.volume_delta_pct)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <details className="manual-whatif" open={scenarioActive} data-testid="manual-whatif">
              <summary>{t("w10num_scenario_open")}</summary>
              <p className="kec-note">{t("w10num_scenario_explain")}</p>
              <div className="manual-whatif-grid">
                <label>
                  <span>{t("plan_att")}</span>
                  <input
                    type="range"
                    min="0"
                    max="200000"
                    step="5000"
                    value={attendance}
                    data-testid="scenario-attendance"
                    onChange={(event) => setAttendance(Number(event.target.value))}
                  />
                  <small>{t("w10num_people").replace("{n}", number(attendance))}</small>
                </label>
                <label>
                  <span>{t("plan_rain")}</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={rainfall}
                    data-testid="scenario-rain"
                    onChange={(event) => setRainfall(Number(event.target.value))}
                  />
                  <small>
                    {rainfall > 0
                      ? t("w10num_mm_day").replace("{n}", number(rainfall))
                      : t("w10num_scn_rain_forecast")}
                  </small>
                </label>
                <label>
                  <span>{t("w10num_scn_venue")}</span>
                  <select value={venue} onChange={(event) => setVenue(event.target.value)}>
                    {VENUES.map((id) => (
                      <option key={id} value={id}>
                        {t(`w10num_venue_${id}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="manual-whatif-actions">
                {scenarioActive && (
                  <button className="ghost-button" type="button" onClick={resetScenario}>
                    {t("w10num_scn_reset")}
                  </button>
                )}
                <button className="primary-button" onClick={run} disabled={loading}>
                  {loading ? t("w10num_calculating") : t("btn_run_scenario")}
                </button>
              </div>
            </details>
            {forecastError && (
              <p className="unmet-reasons-box optimizer-error" role="alert">
                {t(dateInRange ? "w10num_forecast_error" : "w10num_date_out_of_range")}
              </p>
            )}
          </ScenarioPanel>
        ),
        recommendation: (
          <ScenarioPanel mode="recommendation">
            <div className="optimizer-section">
              <div className="optimizer-head">
                <h3>{t("plan_opt_title")}</h3>
              </div>

              {!plan && (
                <>
                  <div className="plan-preflight-grid" aria-label={t("w10num_preflight")}>
                    <div>
                      <span>{t("plan_demand")}</span>
                      <strong>{outlook ? `${number(outlook.total_tonnage_t)} t` : "—"}</strong>
                    </div>
                    <div>
                      <span>{t("w10num_extra_need")}</span>
                      <strong data-testid="plan-extra-need">
                        {outlook
                          ? t("w10num_extra_need_value")
                              .replace("{deploy}", number(outlook.recommendation.deployable_trucks))
                              .replace("{reserve}", number(outlook.recommendation.fleet_reserve))
                              .replace("{short}", number(outlook.recommendation.shortfall_trucks))
                          : "—"}
                      </strong>
                    </div>
                    <div>
                      <span>{t("plan_tpa_queue")}</span>
                      <strong>
                        {queue?.trucks_waiting != null && queue?.estimated_wait_minutes != null
                          ? t("w10num_queue_peak_value")
                              .replace("{n}", number(queue.trucks_waiting))
                              .replace("{m}", number(Math.round(queue.estimated_wait_minutes)))
                          : "—"}
                      </strong>
                    </div>
                  </div>

                  <button
                    className="primary-button plan-generate-btn"
                    onClick={generatePlan}
                    disabled={planLoading || loading}
                  >
                    {planLoading ? t("w10num_optimizing") : t("btn_generate_plan")}
                  </button>

                  <div className="optimizer-empty-state" aria-live="polite">
                    <Workflow size={18} />
                    <div>
                      <strong>{t("plan_awaiting_title")}</strong>
                      <p>{t("plan_awaiting_desc")}</p>
                    </div>
                  </div>
                </>
              )}

              {errorKey && (
                <div className="unmet-reasons-box optimizer-error" role="alert">
                  <strong>{t("w10num_plan_label")}</strong> {t(errorKey)}
                </div>
              )}

              {plan && (
                <div className="optimizer-plan-card">
                  <div className="plan-header">
                    <strong>{t("w10num_plan_id").replace("{id}", plan.plan_id)}</strong>
                    <span className={`plan-status-badge ${plan.status}`}>
                      {t(
                        plan.status === "proposed"
                          ? "w10num_status_proposed"
                          : plan.status === "approved"
                            ? "w10num_status_approved"
                            : "w10num_status_unknown",
                      )}
                    </span>
                  </div>

                  {plan.scope && (
                    <p className="kec-note" data-testid="plan-scope">
                      {t("pln6_scope")
                        .replace("{date}", plan.plan_date || planDate)
                        .replace("{n}", number(plan.scope.districts))
                        .replace("{total}", number(plan.scope.district_total))}
                    </p>
                  )}
                  <div className="plan-stats-grid">
                    <div className="plan-stat-item">
                      <span>{t("w10num_plan_demand_total")}</span>
                      <strong>{number(plan.total_demand_tons)} t</strong>
                    </div>
                    <div className="plan-stat-item">
                      <span>{t("w10num_plan_assigned")}</span>
                      <strong>{number(plan.total_assigned_tons)} t</strong>
                    </div>
                    <div className="plan-stat-item">
                      <span>{t("w10num_plan_status")}</span>
                      <strong className={plan.unmet_reasons?.length ? "text-danger" : "text-success"}>
                        {t(plan.unmet_reasons?.length ? "w10num_plan_unmet" : "w10num_plan_feasible")}
                      </strong>
                    </div>
                  </div>

                  {plan.feasible === false && plan.unassigned_tons > 0 && (
                    <div className="unmet-reasons-box" role="status" data-testid="plan-shortfall">
                      <strong>{t("pln6_infeasible").replace("{t}", number(plan.unassigned_tons))}</strong>{" "}
                      {t("pln6_infeasible_note")}
                    </div>
                  )}
                  {plan.feasible === true && plan.quota_usage && (
                    <p className="kec-note" data-testid="plan-feasible">
                      {t("pln6_feasible")}
                    </p>
                  )}
                  <PlanQuotaUsage plan={plan} />
                  <PlanRules plan={plan} />
                  {plan.unmet_reasons?.length > 0 && (
                    <div className="unmet-reasons-box">
                      <strong>{t("w10num_constraint_warnings")}</strong>
                      <ul>
                        {plan.unmet_reasons.map((r, i) => (
                          <li key={i}>{reason(r)}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="assign-title">{t("w10num_assignments")}</div>
                  <div className="assignments-container">
                    {(plan.assignments || []).map((a, i) => (
                      <div key={i} className="assign-card">
                        <div className="assign-info">
                          <strong>{t("w10num_truck").replace("{code}", a.truck_code)}</strong>
                          <span>&rarr; {a.area.replace(/_/g, " ").toUpperCase()}</span>
                          {a.shift && (
                            <span className="kec-note">
                              {t("pln6_trip")
                                .replace("{n}", number(a.trip_index))
                                .replace("{shift}", t(`pln6_shift_${a.shift}`))
                                .replace(
                                  "{facility}",
                                  plan.rules?.facilities?.find((f) => f.name === a.facility)?.display_name ||
                                    a.facility,
                                )}
                            </span>
                          )}
                        </div>
                        <div className="assign-evidence">
                          <span>
                            {t("w10num_load")} <b>{number(a.assigned_tons)} t</b>
                          </span>
                          {a.evidence?.permit_compliant ? (
                            <span className="ok">{t("w10num_permit_ok")}</span>
                          ) : (
                            <span className="warn">{t("w10num_permit_missing")}</span>
                          )}
                        </div>
                      </div>
                    ))}
                    {!plan.assignments?.length && (
                      <p className="kec-note optimizer-empty">{t("w10num_no_assignments")}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </ScenarioPanel>
        ),
      }}
      evidence={
        <PlanningApproval
          plan={plan}
          planLoading={planLoading}
          approved={approved}
          approvePlan={approvePlan}
          role={role}
        />
      }
      unmetCount={plan?.unmet_reasons?.length || 0}
      planStatus={plan?.status}
    />
  );
}
