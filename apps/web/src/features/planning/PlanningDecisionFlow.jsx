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
import { Provenance } from "../../shared/ui/Provenance.jsx";
import { WEIGHBRIDGE_LANES } from "../twin/twinLinks.js";
import { ROLE_PERMISSIONS } from "../settings/roles.js";
import { ArrowRight } from "lucide-react";

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
// and the twin). wave12: its inputs fill themselves; a what-if arrives only as a twin,
// Ana or event hand-off (?scenario=…, scenarioLink.js), and then every figure carries a
// "Skenario" label.
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

  const storedRole = localStorage.getItem("pythia_role") || "guest";
  // The server's view of this session decides who may approve; the stored role only
  // labels the column while that answer is pending or unreachable.
  const [session, setSession] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/auth/session", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then(setSession)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const role = session?.role || storedRole;
  const canApprove = (session?.permissions || ROLE_PERMISSIONS[role] || []).includes("operations:approve");

  // The approver's inbox: with no plan built on this page, step 03 shows the newest
  // plan proposed from any browser (a dispatcher proposes, a supervisor approves).
  const [inboxPlan, setInboxPlan] = useState(null);
  const inboxOpen = canApprove && !plan && !approved;
  useEffect(() => {
    if (!inboxOpen) return undefined;
    const controller = new AbortController();
    const load = () =>
      apiFetch("/operations/plans?status=proposed&limit=1", { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then((plans) => plans && setInboxPlan(plans[0] || null))
        .catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [inboxOpen]);
  const reviewPlan = plan || inboxPlan;

  // wave12: the proposer learns of the approval live. While this page's plan waits, read
  // it by id every 15 s; the poll ends once it is approved, replaced or the page closes.
  const waitingPlanId = plan?.status === "proposed" ? plan.plan_id : null;
  useEffect(() => {
    if (!waitingPlanId) return undefined;
    let live = true;
    const controller = new AbortController();
    const id = setInterval(() => {
      apiFetch(`/operations/plans/${encodeURIComponent(waitingPlanId)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then((latest) => {
          if (!live || latest?.status !== "approved") return;
          setPlan(latest);
          setApproved(true);
        })
        .catch(() => {});
    }, 15000);
    return () => {
      live = false;
      controller.abort();
      clearInterval(id);
    };
  }, [waitingPlanId]);

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

  // wave12: the day's inputs fill themselves (Open-Meteo rain, official events, submitted
  // permits, holidays) and /forecast/tomorrow explains each as a driver. Forecast week only.
  const [dayDrivers, setDayDrivers] = useState(null);
  useEffect(() => {
    setDayDrivers(null);
    const index = daysFromToday(planDate);
    if (index < 0 || index >= 7) return undefined;
    const controller = new AbortController();
    apiFetch(`/forecast/tomorrow?date=${planDate}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then(setDayDrivers)
      .catch(() => {});
    return () => controller.abort();
  }, [planDate]);

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
    if (!reviewPlan) return;
    const fromInbox = !plan;
    const request = ++planRequest.current;
    setPlanLoading(true);
    setOptimizerError(null);
    try {
      const response = await apiFetch(`/operations/${encodeURIComponent(reviewPlan.plan_id)}/approve`, {
        method: "POST",
      });
      if (!response.ok) {
        if (request === planRequest.current)
          setOptimizerError({ status: response.status, action: "approve" });
        return;
      }
      const approvedData = await response.json();
      if (request === planRequest.current) {
        if (fromInbox) setInboxPlan(approvedData);
        else setPlan(approvedData);
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
  const effect = (tons) => (tons == null ? t("w12_effect_unknown") : `${signedNumber(tons)} t`);
  const driverLine = (driver) => {
    const detail = driver.detail || {};
    if (driver.kind === "weather") {
      return t(
        driver.input_classification === "REAL_FORECAST_INPUT"
          ? "w12_driver_weather"
          : "w12_driver_weather_none",
      )
        .replace("{mm}", number(detail.rainfall_mm))
        .replace("{effect}", effect(driver.effect_tons));
    }
    if (driver.kind === "event") {
      return t(detail.data_class === "official" ? "w12_driver_event" : "w12_driver_event_permit")
        .replace("{name}", detail.name || "—")
        .replace("{n}", detail.attendance == null ? "—" : number(detail.attendance))
        .replace("{effect}", effect(driver.effect_tons));
    }
    if (driver.kind === "holiday") return t("w12_driver_holiday").replace("{name}", detail.name);
    return t(detail.weekend ? "w12_driver_weekend" : "w12_driver_weekday");
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

  const assigned = plan?.assignments || [];

  return (
    <IntegratedPlanning
      summary={<ExecutiveSummary outlook={outlook} snapshot={snapshot} queue={queue} />}
      hasOutlook={outlook != null}
      scenario={{
        inputs: (
          <ScenarioPanel mode="inputs">
            {/* Without a 7-day outlook the empty column would leave a hole: stack instead. */}
            <div className={`plan-stage-split${aiOutlook.length ? "" : " is-stacked"}`}>
              <div className="plan-stage-main">
                <div className="plan-block-head">
                  <h3>{t("w10num_plan_basis_title")}</h3>
                  <p>{t("w10num_plan_basis_sub")}</p>
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
                  <span className="prov prov-proxy day-kind-chip" data-testid="plan-day-kind">
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
                      <span className="prov prov-sim scenario-badge" data-testid="plan-scenario-badge">
                        {t("w10num_scenario_badge")}
                      </span>
                    ) : (
                      <Provenance kind="model">{t("w10num_badge_model")}</Provenance>
                    )}{" "}
                    <span>
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
                    </span>
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
                          {outlook.kecamatan_at_risk}{" "}
                          <span className="plan-outlook-unit">
                            {t("w11plan_of_m").replace("{m}", outlook.kecamatan_count)}
                          </span>
                        </dd>
                        <small>{t("w10num_today_at_risk_helper")}</small>
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
                        <Provenance kind="sim" bare>
                          {t("honesty_sim_badge")}
                        </Provenance>
                      </div>
                    </dl>
                  )}
                  {!isScenario && dayDrivers?.drivers?.length > 0 && (
                    <div data-testid="plan-drivers" data-date={dayDrivers.date}>
                      <p className="kec-note">
                        <Provenance kind="model">{t("w10num_badge_model")}</Provenance>{" "}
                        {t("w12_drivers_title")}
                      </p>
                      <ul>
                        {dayDrivers.drivers.map((driver, i) => (
                          <li key={i} data-testid="plan-driver" data-kind={driver.kind}>
                            {driverLine(driver)}
                          </li>
                        ))}
                        {dayDrivers.with_events_total_t !== dayDrivers.total_tonnage_t && (
                          <li data-testid="plan-driver-with-events">
                            {t("w12_driver_with_events").replace(
                              "{t}",
                              number(dayDrivers.with_events_total_t),
                            )}
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              <div className="ai-outlook plan-stage-side">
                <div className="plan-block-head plan-block-head-row">
                  <h3>{t("w10num_ai_outlook")}</h3>
                  <Provenance kind="model">{t("w10num_badge_model")}</Provenance>
                </div>
                {aiOutlook.length === 0 ? (
                  <p className="ai-feed-empty">{t("w10num_ai_outlook_empty")}</p>
                ) : (
                  <div className="ui-table-wrap">
                    <table className="ui-table plan-table ai-outlook-table">
                      <thead>
                        <tr>
                          <th scope="col">{t("w10num_th_date")}</th>
                          <th scope="col" className="num">
                            {t("w10num_th_rain")}
                          </th>
                          <th scope="col">{t("w10num_th_event")}</th>
                          <th scope="col" className="num">
                            {t("w11plan_th_delta")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {aiOutlook.map((d) => (
                          <tr key={d.date}>
                            <td className="plan-table-date">
                              {new Date(`${d.date}T00:00:00`).toLocaleDateString(locale, {
                                weekday: "short",
                                day: "2-digit",
                                month: "short",
                              })}
                              {d.is_holiday ? ` ${t("w10num_holiday_suffix")}` : ""}
                            </td>
                            <td className="num">{number(d.rainfall_mm)} mm</td>
                            <td className="plan-table-event">
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
                              className={`num ${
                                d.volume_delta_pct > 15
                                  ? "text-danger"
                                  : d.volume_delta_pct > 5
                                    ? "text-warning"
                                    : "text-muted"
                              }`}
                            >
                              {signedNumber(d.volume_delta_pct)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* wave12: no manual sliders; a what-if arrives only as a hand-off (?scenario=…). */}
            {scenarioActive && (
              <button
                className="text-button"
                type="button"
                data-testid="plan-scenario-reset"
                onClick={resetScenario}
              >
                {t("w10num_scn_reset")}
              </button>
            )}
            {forecastError && (
              <p className="plan-note plan-note-danger optimizer-error" role="alert">
                {t(dateInRange ? "w10num_forecast_error" : "w10num_date_out_of_range")}
              </p>
            )}
          </ScenarioPanel>
        ),
        recommendation: (
          <ScenarioPanel mode="recommendation">
            <div className="optimizer-section">
              {!plan && (
                <div className="plan-stage-split">
                  <div className="plan-stage-main">
                    <div className="plan-block-head">
                      <h3>{t("plan_opt_title")}</h3>
                      <p>{t("plan_awaiting_desc")}</p>
                    </div>
                    <button
                      type="button"
                      className="primary-button plan-generate-btn"
                      onClick={generatePlan}
                      disabled={planLoading || loading}
                    >
                      {planLoading ? t("w10num_optimizing") : t("btn_generate_plan")}
                      {!planLoading && <ArrowRight size={16} aria-hidden="true" />}
                    </button>
                  </div>
                  <div className="plan-preflight-grid" role="group" aria-label={t("w10num_preflight")}>
                    <div>
                      <span>{t("plan_demand")}</span>
                      <strong>{outlook ? `${number(outlook.total_tonnage_t)} t` : "—"}</strong>
                      <Provenance kind="model" bare>
                        {t("w10num_badge_model")}
                      </Provenance>
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
                      <Provenance kind="sim" bare>
                        {t("honesty_sim_badge")}
                      </Provenance>
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
                      <Provenance kind="sim" bare>
                        {t("honesty_sim_badge")}
                      </Provenance>
                    </div>
                  </div>
                </div>
              )}

              {errorKey && (
                <p className="plan-note plan-note-danger optimizer-error" role="alert">
                  <strong>{t("w10num_plan_label")}</strong> {t(errorKey)}
                </p>
              )}

              {plan && (
                <div className="optimizer-plan">
                  <div className="plan-stage-split">
                    <div className="plan-stage-main">
                      <div className="plan-header">
                        <h3>{t("w10num_plan_id").replace("{id}", plan.plan_id)}</h3>
                        <span
                          className={`prov ${plan.status === "approved" ? "prov-real" : "prov-sim"} plan-status-badge`}
                        >
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
                      <dl className="plan-stats-grid">
                        <div className="plan-stat-item">
                          <dt>{t("w10num_plan_demand_total")}</dt>
                          <dd>{number(plan.total_demand_tons)} t</dd>
                        </div>
                        <div className="plan-stat-item">
                          <dt>{t("w10num_plan_assigned")}</dt>
                          <dd>{number(plan.total_assigned_tons)} t</dd>
                        </div>
                        <div className="plan-stat-item">
                          <dt>{t("w10num_plan_status")}</dt>
                          <dd className={plan.unmet_reasons?.length ? "text-danger" : "text-success"}>
                            {t(plan.unmet_reasons?.length ? "w10num_plan_unmet" : "w10num_plan_feasible")}
                          </dd>
                        </div>
                      </dl>

                      {plan.feasible === false && plan.unassigned_tons > 0 && (
                        <p className="plan-note plan-note-danger" role="status" data-testid="plan-shortfall">
                          <strong>{t("pln6_infeasible").replace("{t}", number(plan.unassigned_tons))}</strong>{" "}
                          {t("pln6_infeasible_note")}
                        </p>
                      )}
                      {plan.feasible === true && plan.quota_usage && (
                        <p className="kec-note" data-testid="plan-feasible">
                          {t("pln6_feasible")}
                        </p>
                      )}
                      {plan.unmet_reasons?.length > 0 && (
                        <div className="plan-note plan-note-danger">
                          <strong>{t("w10num_constraint_warnings")}</strong>
                          <ul>
                            {plan.unmet_reasons.map((r, i) => (
                              <li key={i}>{reason(r)}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    <div className="plan-stage-side">
                      <h4 className="assign-title">{t("w10num_assignments")}</h4>
                      <ul className="assignments-container">
                        {assigned.map((a, i) => (
                          <li key={i} className="assign-card">
                            <div className="assign-info">
                              <strong>{t("w10num_truck").replace("{code}", a.truck_code)}</strong>
                              <span>
                                <ArrowRight size={13} aria-hidden="true" /> {a.area.replace(/_/g, " ")}
                              </span>
                              {a.shift && (
                                <span className="kec-note">
                                  {t("pln6_trip")
                                    .replace("{n}", number(a.trip_index))
                                    .replace("{shift}", t(`pln6_shift_${a.shift}`))
                                    .replace(
                                      "{facility}",
                                      plan.rules?.facilities?.find((f) => f.name === a.facility)
                                        ?.display_name || a.facility,
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
                          </li>
                        ))}
                      </ul>
                      {!assigned.length && (
                        <p className="kec-note optimizer-empty">{t("w10num_no_assignments")}</p>
                      )}
                    </div>
                  </div>
                  <PlanQuotaUsage plan={plan} />
                  <PlanRules plan={plan} />
                </div>
              )}
            </div>
          </ScenarioPanel>
        ),
      }}
      evidence={
        <PlanningApproval
          plan={reviewPlan}
          planLoading={planLoading}
          approved={approved}
          approvePlan={approvePlan}
          role={role}
          canApprove={canApprove}
          fromInbox={!plan && inboxPlan != null}
        />
      }
      unmetCount={reviewPlan?.unmet_reasons?.length || 0}
      planStatus={reviewPlan?.status}
    />
  );
}
