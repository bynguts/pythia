import { useSearchParams } from "react-router-dom";
import { CalendarRange, CloudSun } from "lucide-react";
import { CarbonPanel } from "../fleet/CarbonPanel.jsx";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { useBaseline } from "../../shared/hooks/useBaseline.js";
import { MetricStrip } from "../../shared/ui/MetricStrip.jsx";
import { SegmentedControl } from "../../shared/ui/SegmentedControl.jsx";
import { CrowdEventsPanel } from "./CrowdEventsPanel.jsx";
import { FacilityGapPanel } from "./FacilityGapPanel.jsx";
import { KecamatanMapPanel, KecamatanRows } from "./KecamatanMapPanel.jsx";
import { MonthlyIntakeStrip } from "./MonthlyIntakeStrip.jsx";
import { PermitSubmissionPanel } from "./PermitSubmissionPanel.jsx";
import { PredictionPanel } from "./PredictionPanel.jsx";
import { ReportActions } from "./ReportActions.jsx";
import { WeatherPanel } from "./WeatherPanel.jsx";

// Teardown v4 P3: four tabs instead of one 3,300 px page. "Ringkasan" is the
// default and keeps the URL clean (/forecast); the others deep-link via ?tab=.
const TABS = [
  { id: "summary", key: "w10num_fc_tab_summary" },
  { id: "kecamatan", key: "w10num_fc_tab_kecamatan" },
  { id: "facilities", key: "w10num_fc_tab_facilities" },
  { id: "events", key: "w10num_fc_tab_events" },
];

export function ForecastWorkspace({
  snapshot,
  forecastSource,
  horizon,
  onHorizonChange,
  onSimulateEvent,
  onPermitSubmitted,
}) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab = TABS.some((item) => item.id === requested) ? requested : "summary";
  const { baseline, status } = useBaseline();
  const horizonOptions = [
    { value: "7d", label: `7 ${t("fc_days")}` },
    { value: "14d", label: `14 ${t("fc_days")}` },
    { value: "30d", label: `30 ${t("fc_days")}` },
  ];

  function selectTab(id) {
    setSearchParams(id === "summary" ? {} : { tab: id }, { replace: true });
  }

  function handleTabKeyDown(event, index) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length];
    selectTab(next.id);
    document.getElementById(`forecast-tab-${next.id}`)?.focus();
  }

  const tons = (value) => Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 1 });
  const loading = !baseline;
  const rain = baseline?.weather;
  const metrics = [
    {
      label: t("w10num_today_total"),
      value: loading ? (
        "—"
      ) : (
        <span data-testid="baseline-total" data-value={baseline.total_tonnage_t}>
          {tons(baseline.total_tonnage_t)} t
        </span>
      ),
      helper: t("w10num_today_total_helper"),
    },
    {
      label: t("w10num_today_at_risk"),
      value: loading ? (
        "—"
      ) : (
        <span data-testid="baseline-at-risk" data-value={baseline.kecamatan_at_risk}>
          {t("w10num_n_of_m")
            .replace("{n}", baseline.kecamatan_at_risk)
            .replace("{m}", baseline.kecamatan_count)}
        </span>
      ),
      helper: t("w10num_today_at_risk_helper"),
      tone: baseline?.kecamatan_at_risk > 0 ? "danger" : undefined,
    },
    {
      label: t("w10num_today_trucks"),
      value: loading ? (
        "—"
      ) : (
        <span data-testid="baseline-trucks" data-value={baseline.trucks_needed}>
          {Number(baseline.trucks_needed).toLocaleString(locale)}
        </span>
      ),
      helper: t("w10num_today_trucks_helper").replace("{t}", baseline?.units?.truck_capacity_tons ?? "—"),
    },
    {
      label: t("w10num_today_rain"),
      value: loading ? "—" : `${tons(rain.rainfall_mm)} mm`,
      helper: t(rain?.input === "forecast" ? "w10num_rain_forecast" : "w10num_rain_assumed_dry"),
      tone: "warning",
    },
  ];

  return (
    <section
      className="forecast-workspace workspace-page"
      data-testid="forecast-workspace"
      aria-labelledby="forecast-title"
    >
      <header className="workspace-heading forecast-heading">
        <div>
          <span className="workspace-kicker">
            <CloudSun size={14} /> {t("fc_kicker")}
          </span>
          <h1 id="forecast-title">{t("hon_fc_title")}</h1>
          <p>{t("hon_fc_sub")}</p>
        </div>
        <div className="forecast-heading-actions">
          <div className="forecast-horizon-control">
            <span className="control-label">
              <CalendarRange size={14} /> {t("fc_horizon_label")}
            </span>
            <SegmentedControl value={horizon} options={horizonOptions} onChange={onHorizonChange} />
          </div>
          <ReportActions />
        </div>
      </header>

      <p className="baseline-basis" data-testid="baseline-basis">
        <span className="classification-badge modeled">{t("w10num_badge_model")}</span>{" "}
        {status === "offline" && !baseline
          ? t("w10num_baseline_unavailable")
          : t("w10num_baseline_basis").replace("{date}", baseline?.date ?? "…")}
      </p>
      <MetricStrip metrics={metrics} />

      <div className="workspace-tabs forecast-tabs" role="tablist" aria-label={t("w10num_fc_tabs_label")}>
        {TABS.map((item, index) => (
          <button
            key={item.id}
            id={`forecast-tab-${item.id}`}
            className="workspace-tab"
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls="forecast-tabpanel"
            tabIndex={tab === item.id ? 0 : -1}
            data-testid={`forecast-tab-${item.id}`}
            onClick={() => selectTab(item.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {t(item.key)}
          </button>
        ))}
      </div>

      <div
        id="forecast-tabpanel"
        className="forecast-tabpanel"
        role="tabpanel"
        aria-labelledby={`forecast-tab-${tab}`}
      >
        {tab === "summary" && (
          <>
            <div className="forecast-command-grid" data-testid="forecast-command-grid">
              <section
                className="forecast-primary-analysis"
                data-testid="forecast-primary-analysis"
                aria-labelledby="forecast-analysis-title"
              >
                <div className="section-intro">
                  <div>
                    <span className="surface-kicker">{t("fc_priority_kicker")}</span>
                    <h2 id="forecast-analysis-title">{t("fc_priority_title")}</h2>
                  </div>
                  <p>{t("fc_priority_sub")}</p>
                </div>
                <WeekTrend baseline={baseline} />
                <KecamatanRows rows={(baseline?.kecamatan || []).slice(0, 8)} loading={loading} />
                {baseline && (
                  <button
                    type="button"
                    className="text-button show-more-btn"
                    onClick={() => selectTab("kecamatan")}
                  >
                    {t("w10num_fc_all_kecamatan").replace("{n}", baseline.kecamatan_count)}
                  </button>
                )}
              </section>
              <aside className="forecast-context-rail" aria-label={t("fc_context_label")}>
                <div className="section-intro compact">
                  <div>
                    <span className="surface-kicker">{t("fc_context_kicker")}</span>
                    <h2>{t("fc_context_title")}</h2>
                  </div>
                </div>
                <WeatherPanel weather={snapshot.weather} />
                <MonthlyIntakeStrip />
              </aside>
            </div>
            <section className="forecast-evidence-section" aria-labelledby="forecast-evidence-title">
              <div className="section-intro">
                <div>
                  <span className="surface-kicker">{t("fc_evidence_kicker")}</span>
                  <h2 id="forecast-evidence-title">{t("fc_evidence_title")}</h2>
                </div>
                <p>{t("fc_evidence_sub")}</p>
              </div>
              <PredictionPanel predictions={snapshot.critical_predictions} source={forecastSource} />
            </section>
            {/* The fleet's carbon estimate (simulated) moved here from Armada; collapsed, last. */}
            <details className="scenario-disclosure forecast-carbon" data-testid="forecast-carbon">
              <summary>{t("carbon_title")}</summary>
              <CarbonPanel />
            </details>
          </>
        )}
        {tab === "kecamatan" && <KecamatanMapPanel horizon={horizon} />}
        {tab === "facilities" && <FacilityGapPanel />}
        {tab === "events" && (
          <div className="forecast-events-grid">
            <CrowdEventsPanel onSimulateEvent={onSimulateEvent} />
            <PermitSubmissionPanel onPermitSubmitted={onPermitSubmitted} />
          </div>
        )}
      </div>
    </section>
  );
}

// Teardown v4 P2-style: one honest trend instead of repeated tiles, the baseline
// week's daily tonnage as a bar row (same series the twin's timeline steps through).
function WeekTrend({ baseline }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const totals = baseline?.horizon?.daily_total_tons || [];
  if (!totals.length) return null;
  const dates = baseline.horizon.dates;
  const atRisk = baseline.horizon.daily_kecamatan_at_risk || [];
  const max = Math.max(...totals);
  const min = Math.min(...totals);
  return (
    <figure className="week-trend" data-testid="baseline-week-trend">
      <figcaption>
        {t("w10num_week_trend").replace(
          "{range}",
          `${Math.round(min).toLocaleString(locale)}–${Math.round(max).toLocaleString(locale)} t`,
        )}
      </figcaption>
      <ol>
        {totals.map((value, index) => {
          const day = new Date(`${dates[index]}T00:00:00`);
          // Scale between 60% and 100% of the bar so a 3% swing stays visible but honest.
          const height = max > min ? 60 + ((value - min) / (max - min)) * 40 : 100;
          return (
            <li key={dates[index]} className={atRisk[index] > 0 ? "at-risk" : undefined}>
              <span className="week-trend-bar" style={{ height: `${height}%` }} aria-hidden="true" />
              <b>{Math.round(value).toLocaleString(locale)}</b>
              <small>
                {index === 0
                  ? t("w10num_today")
                  : day.toLocaleDateString(locale, { weekday: "short", day: "numeric" })}
              </small>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
