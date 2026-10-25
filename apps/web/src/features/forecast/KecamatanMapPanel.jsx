import { useState } from "react";
import { MapPinned } from "lucide-react";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { fetchOutlook, useBaseline } from "../../shared/hooks/useBaseline.js";
import { signedPercent } from "../../shared/hooks/useSnapshot.js";

const CITIES = ["Jakarta Pusat", "Jakarta Barat", "Jakarta Selatan", "Jakarta Timur", "Jakarta Utara"];
const VENUES = ["gbk", "jis", "monas"];

// #42: darkened to meet WCAG AA (4.5:1) against the card background.
const READINESS_COLOR = {
  sufficient: "#15803d",
  tight: "#92400e",
  under_capacity: "#b91c1c",
  unknown: "#475569",
};

function horizonStats(row) {
  const series = row.series || [];
  if (series.length < 2) return null;
  const peak = series.reduce((best, day) => (day.predicted_tons > best.predicted_tons ? day : best));
  return { days: series.length, total: series.reduce((sum, day) => sum + day.predicted_tons, 0), peak };
}

// One row per kecamatan from the baseline (or its what-if): the list the summary
// tab shows as the top 8 and the kecamatan tab shows in full.
export function KecamatanRows({ rows, loading, selectedSlug, onSelect }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const maxTons = rows.length ? Math.max(...rows.map((row) => row.predicted_tons)) : 1;
  if (loading) return <p className="panel-loading">{t("w10num_loading")}</p>;
  return (
    <div className="kec-list">
      {rows.map((k) => {
        const stats = horizonStats(k);
        return (
          <article
            className={`kec-row${selectedSlug === k.slug ? " active" : ""}`}
            key={k.slug}
            onClick={onSelect ? () => onSelect(selectedSlug === k.slug ? null : k.slug) : undefined}
          >
            <div className="kec-head">
              <strong>{k.kecamatan}</strong>
              <span>{k.city}</span>
            </div>
            {/* #42: the bar is decorative; the kec-meta text announces amount and unit. */}
            <div className="bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, (k.predicted_tons / maxTons) * 100)}%` }} />
            </div>
            <div className="kec-meta">
              <b>{k.predicted_tons.toLocaleString(locale)} t</b>
              <span>
                {t("w10num_kec_resources")
                  .replace("{trucks}", k.trucks_required)
                  .replace("{crews}", k.crews_required)
                  .replace("{hours}", k.man_hours_required)}
              </span>
              {k.risk_level && k.risk_level !== "normal" && (
                <span className={`kec-risk risk-${k.risk_level}`}>
                  {t(`w10num_risk_${k.risk_level}`)} · {signedPercent(k.spike_percent)}
                </span>
              )}
              {stats && (
                <span className="kec-horizon">
                  {t("w10num_kec_horizon")
                    .replace("{days}", stats.days)
                    .replace("{total}", Math.round(stats.total).toLocaleString(locale))
                    .replace("{date}", stats.peak.date)
                    .replace("{peak}", Math.round(stats.peak.predicted_tons))}
                </span>
              )}
              <span className="kec-facility" style={{ color: READINESS_COLOR[k.facility_readiness] }}>
                {k.facility_over_capacity
                  ? t("w10num_tps_over")
                  : t(`w10num_tps_${k.facility_readiness || "unknown"}`)}
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function KecamatanMapPanel({ horizon = "7d" }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const horizonDays = Math.max(2, Math.min(30, parseInt(horizon, 10) || 7));
  const { baseline } = useBaseline(horizonDays);
  const [scenario, setScenario] = useState(null);
  const [scenarioError, setScenarioError] = useState(false);
  const [rain, setRain] = useState(0);
  const [attendance, setAttendance] = useState(0);
  const [venue, setVenue] = useState("gbk");
  const [loading, setLoading] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState(null);
  const [search, setSearch] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  // The scenario answers for its own horizon; a changed horizon drops back to the baseline.
  const active = scenario && scenario.horizon?.dates?.length === horizonDays ? scenario : null;
  const data = active || baseline;

  async function runScenario() {
    setLoading(true);
    setScenarioError(false);
    try {
      setScenario(await fetchOutlook({ rainfall: rain, attendance, venue, days: horizonDays }));
    } catch {
      setScenarioError(true);
    } finally {
      setLoading(false);
    }
  }

  function resetScenario() {
    setScenario(null);
    setRain(0);
    setAttendance(0);
  }

  const rows = data?.kecamatan || [];
  const filteredRows = rows.filter(
    (k) => k.kecamatan.toLowerCase().includes(search.toLowerCase()) && (!cityFilter || k.city === cityFilter),
  );
  const displayedRows = showAll ? filteredRows : filteredRows.slice(0, 8);
  const selected = rows.find((row) => row.slug === selectedSlug);
  const number = (value) => Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 1 });

  return (
    <section className="panel wide kecamatan-panel" data-testid="kecamatan-panel">
      <div className="panel-title">
        <div>
          <h2>{t("w10num_kec_title")}</h2>
          <p>
            {active ? (
              <span className="scenario-badge" data-testid="kecamatan-scenario-badge">
                {t("w10num_scenario_badge")}
              </span>
            ) : (
              <span className="classification-badge modeled">{t("w10num_badge_model")}</span>
            )}{" "}
            {data
              ? t(active ? "w10num_kec_total_scenario" : "w10num_kec_total")
                  .replace("{n}", data.kecamatan_count)
                  .replace("{t}", number(data.total_tonnage_t))
                  .replace("{base}", number(active?.baseline?.total_tonnage_t))
              : t("w10num_loading")}
          </p>
        </div>
        <div className="panel-header-icon-wrap">
          <MapPinned size={18} />
        </div>
      </div>

      <details className="scenario-disclosure" open={Boolean(active)}>
        <summary>{t("w10num_scenario_open")}</summary>
        <p className="kec-note">{t("w10num_scenario_explain")}</p>
        <div className="scenario-controls">
          <label>
            {t("w10num_scn_rain")}: <b>{rain ? `${rain} mm` : t("w10num_scn_rain_forecast")}</b>
            <input type="range" min="0" max="100" value={rain} onChange={(e) => setRain(+e.target.value)} />
          </label>
          <label>
            {t("w10num_scn_attendance")}: <b>{attendance.toLocaleString(locale)}</b>
            <input
              type="range"
              min="0"
              max="200000"
              step="5000"
              value={attendance}
              onChange={(e) => setAttendance(+e.target.value)}
            />
          </label>
          <label>
            {t("w10num_scn_venue")}
            <select className="city-select" value={venue} onChange={(e) => setVenue(e.target.value)}>
              {VENUES.map((id) => (
                <option key={id} value={id}>
                  {t(`w10num_venue_${id}`)}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-button" onClick={runScenario} disabled={loading}>
            {loading ? t("w10num_calculating") : t("w10num_scn_run")}
          </button>
          {active && (
            <button className="text-button" type="button" onClick={resetScenario}>
              {t("w10num_scn_reset")}
            </button>
          )}
        </div>
        {scenarioError && (
          <p className="kec-note" role="alert">
            {t("w10num_scn_error")}
          </p>
        )}
      </details>

      <div className="forecast-filter-bar">
        <input
          type="text"
          placeholder={t("w10num_kec_search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
          aria-label={t("w10num_kec_search")}
        />
        <select
          value={cityFilter}
          onChange={(e) => setCityFilter(e.target.value)}
          className="city-select"
          aria-label={t("w10num_kec_city_filter")}
        >
          <option value="">{t("w10num_kec_all_cities")}</option>
          {CITIES.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </select>
      </div>

      {selected && (
        <div className="kec-details-panel" data-testid="kec-details">
          <div className="kec-details-panel-title">
            <div>
              <h3>
                {selected.kecamatan} ({selected.city})
              </h3>
              <p>{t("w10num_kec_detail_sub")}</p>
            </div>
            <button className="text-button" onClick={() => setSelectedSlug(null)}>
              {t("w10num_close")}
            </button>
          </div>
          <div className="kec-details-grid">
            <div className="kec-details-section">
              <h4>{t("w10num_kec_detail_volume")}</h4>
              <ul className="kec-details-list">
                <li className="kec-details-item">
                  <span>{t("w10num_kec_detail_normal")}</span>
                  <b>{number(selected.normal_tons)} t</b>
                </li>
                <li className="kec-details-item">
                  <span>{t("w10num_kec_detail_spike")}</span>
                  <b>
                    {signedPercent(selected.spike_percent)} · {t(`w10num_risk_${selected.risk_level}`)}
                  </b>
                </li>
                <li className="kec-details-item-total">
                  <span>{t("w10num_kec_detail_day")}</span>
                  <span>{number(selected.predicted_tons)} t</span>
                </li>
              </ul>
            </div>
            <div className="kec-details-section">
              <h4>{t("w10num_kec_detail_needs")}</h4>
              <ul className="kec-details-list">
                <li className="kec-details-item">
                  <span>{t("w10num_kec_detail_trucks")}</span>
                  <b>{selected.trucks_required}</b>
                </li>
                <li className="kec-details-item">
                  <span>{t("w10num_kec_detail_crews")}</span>
                  <b>
                    {t("w10num_kec_detail_crews_value")
                      .replace("{crews}", selected.crews_required)
                      .replace("{workers}", selected.workers_required)}
                  </b>
                </li>
                <li className="kec-details-item">
                  <span>{t("w10num_kec_detail_hours")}</span>
                  <b>{selected.man_hours_required}</b>
                </li>
                <li className="kec-details-item">
                  <span>{t("w10num_kec_detail_bins")}</span>
                  <b>{selected.bins_required}</b>
                </li>
                <li className="kec-details-item-total">
                  <span>{t("w10num_kec_detail_tps")}</span>
                  <span className={selected.facility_over_capacity ? "status-overcapacity" : "status-normal"}>
                    {selected.facility_over_capacity
                      ? t("w10num_tps_over")
                      : t(`w10num_tps_${selected.facility_readiness || "unknown"}`)}
                  </span>
                </li>
              </ul>
            </div>
          </div>
          {selected.series?.length > 1 && (
            <div className="kec-series" data-testid="kec-daily-series">
              <h4>{t("w10num_kec_series").replace("{n}", selected.series.length)}</h4>
              <div
                className="kec-series-chart"
                role="img"
                aria-label={t("w10num_kec_series").replace("{n}", selected.series.length)}
              >
                {selected.series.map((d) => {
                  const max = Math.max(...selected.series.map((x) => x.predicted_tons), 1);
                  return (
                    <div key={d.date} className="kec-series-bar" title={`${d.date}: ${d.predicted_tons} t`}>
                      <span
                        style={{ height: `${Math.max(4, Math.round((d.predicted_tons / max) * 100))}%` }}
                      />
                      <small>{d.date.slice(5)}</small>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <KecamatanRows
        rows={displayedRows}
        loading={!data}
        selectedSlug={selectedSlug}
        onSelect={setSelectedSlug}
      />

      {filteredRows.length > 8 && (
        <button className="text-button show-more-btn" onClick={() => setShowAll(!showAll)}>
          {showAll ? t("w10num_show_top8") : t("w10num_show_all_kec").replace("{n}", filteredRows.length)}
        </button>
      )}
      <p className="kec-note">{t("w10num_kec_note")}</p>
    </section>
  );
}
