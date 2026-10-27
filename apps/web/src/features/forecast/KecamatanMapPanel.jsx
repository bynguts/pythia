import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Provenance } from "../../shared/ui/Provenance.jsx";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { fetchOutlook, useBaseline } from "../../shared/hooks/useBaseline.js";
import { signedPercent } from "../../shared/hooks/useSnapshot.js";

const CITIES = ["Jakarta Pusat", "Jakarta Barat", "Jakarta Selatan", "Jakarta Timur", "Jakarta Utara"];
const VENUES = ["gbk", "jis", "monas"];

function horizonStats(row) {
  const series = row.series || [];
  if (series.length < 2) return null;
  const peak = series.reduce((best, day) => (day.predicted_tons > best.predicted_tons ? day : best));
  return { days: series.length, total: series.reduce((sum, day) => sum + day.predicted_tons, 0), peak };
}

// Forecast: one ranked, flat list of districts (heaviest first, as the API
// sorts them): rank, name and what it needs, then the tonnage and its risk on the
// right. The bar is decorative; the text carries the amount once. A selectable list
// puts a real button on the name so the row works from the keyboard.
export function KecamatanRows({ rows, loading, selectedSlug, onSelect, rankOf }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const maxTons = rows.length ? Math.max(...rows.map((row) => row.predicted_tons)) : 1;
  if (loading) return <p className="panel-loading">{t("w10num_loading")}</p>;
  return (
    <ol className="kec-list">
      {rows.map((k, index) => {
        const stats = horizonStats(k);
        const rank = rankOf ? rankOf(k) : index + 1;
        const risky = k.risk_level && k.risk_level !== "normal";
        return (
          <li
            className={`kec-row${selectedSlug === k.slug ? " active" : ""}${risky ? ` is-${k.risk_level}` : ""}`}
            key={k.slug}
          >
            <span className="kec-rank" aria-hidden="true">
              {String(rank).padStart(2, "0")}
            </span>
            <div className="kec-main">
              <div className="kec-head">
                {onSelect ? (
                  <button
                    type="button"
                    className="kec-name"
                    aria-pressed={selectedSlug === k.slug}
                    onClick={() => onSelect(selectedSlug === k.slug ? null : k.slug)}
                  >
                    {k.kecamatan}
                  </button>
                ) : (
                  <strong className="kec-name">{k.kecamatan}</strong>
                )}
                <span>{k.city}</span>
              </div>
              {/* #42: the bar is decorative; the kec-meta text announces amount and unit. */}
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (k.predicted_tons / maxTons) * 100)}%` }} />
              </div>
              <p className="kec-meta">
                <span>
                  {t("w10num_kec_resources")
                    .replace("{trucks}", k.trucks_required)
                    .replace("{crews}", k.crews_required)
                    .replace("{hours}", k.man_hours_required)}
                </span>
                <span
                  className={`kec-facility tps-${k.facility_over_capacity ? "over" : k.facility_readiness || "unknown"}`}
                >
                  {k.facility_over_capacity
                    ? t("w10num_tps_over")
                    : t(`w10num_tps_${k.facility_readiness || "unknown"}`)}
                </span>
              </p>
              {stats && (
                <p className="kec-horizon">
                  {t("w10num_kec_horizon")
                    .replace("{days}", stats.days)
                    .replace("{total}", Math.round(stats.total).toLocaleString(locale))
                    .replace("{date}", stats.peak.date)
                    .replace("{peak}", Math.round(stats.peak.predicted_tons))}
                </p>
              )}
            </div>
            <div className="kec-figure">
              <b>{k.predicted_tons.toLocaleString(locale)} t</b>
              {risky && (
                <span className={`kec-risk risk-${k.risk_level}`}>
                  {t(`w10num_risk_${k.risk_level}`)} · {signedPercent(k.spike_percent)}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
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

  const rankBySlug = Object.fromEntries(rows.map((row, index) => [row.slug, index + 1]));

  return (
    <section className="panel wide kecamatan-panel" data-testid="kecamatan-panel">
      <header className="ui-section-head kecamatan-head">
        <div>
          <h2>{t("w10num_kec_title")}</h2>
          <p>
            {active ? (
              <span className="prov prov-sim scenario-badge" data-testid="kecamatan-scenario-badge">
                {t("w10num_scenario_badge")}
              </span>
            ) : (
              <Provenance kind="model">{t("w10num_badge_model")}</Provenance>
            )}{" "}
            {data
              ? t(active ? "w10num_kec_total_scenario" : "w10num_kec_total")
                  .replace("{n}", data.kecamatan_count)
                  .replace("{t}", number(data.total_tonnage_t))
                  .replace("{base}", number(active?.baseline?.total_tonnage_t))
              : t("w10num_loading")}
          </p>
        </div>
      </header>

      <div className="forecast-filter-bar">
        <input
          type="search"
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

      <details className="scenario-disclosure" open={Boolean(active)}>
        <summary>
          <SlidersHorizontal size={16} aria-hidden="true" />
          {t("w10num_scenario_open")}
        </summary>
        <p className="kec-note">{t("w10num_scenario_explain")}</p>
        <div className="scenario-controls">
          <label>
            <span>
              {t("w10num_scn_rain")}: <b>{rain ? `${rain} mm` : t("w10num_scn_rain_forecast")}</b>
            </span>
            <input type="range" min="0" max="100" value={rain} onChange={(e) => setRain(+e.target.value)} />
          </label>
          <label>
            <span>
              {t("w10num_scn_attendance")}: <b>{attendance.toLocaleString(locale)}</b>
            </span>
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
            <span>{t("w10num_scn_venue")}</span>
            <select className="city-select" value={venue} onChange={(e) => setVenue(e.target.value)}>
              {VENUES.map((id) => (
                <option key={id} value={id}>
                  {t(`w10num_venue_${id}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="scenario-actions">
            {active && (
              <button className="text-button" type="button" onClick={resetScenario}>
                {t("w10num_scn_reset")}
              </button>
            )}
            <button className="ghost-button" type="button" onClick={runScenario} disabled={loading}>
              {loading ? t("w10num_calculating") : t("w10num_scn_run")}
            </button>
          </div>
        </div>
        {scenarioError && (
          <p className="kec-note" role="alert">
            {t("w10num_scn_error")}
          </p>
        )}
      </details>

      {selected && (
        <section className="kec-details-panel" data-testid="kec-details" aria-labelledby="kec-details-title">
          <div className="kec-details-panel-title">
            <div>
              <h3 id="kec-details-title">
                {selected.kecamatan} ({selected.city})
              </h3>
              <p>{t("w10num_kec_detail_sub")}</p>
            </div>
            <button className="text-button" type="button" onClick={() => setSelectedSlug(null)}>
              {t("w10num_close")}
            </button>
          </div>
          <div className="kec-details-grid">
            <dl className="kec-details-list">
              <div>
                <dt>{t("w10num_kec_detail_normal")}</dt>
                <dd>{number(selected.normal_tons)} t</dd>
              </div>
              <div>
                <dt>{t("w10num_kec_detail_spike")}</dt>
                <dd>
                  {signedPercent(selected.spike_percent)} · {t(`w10num_risk_${selected.risk_level}`)}
                </dd>
              </div>
              <div className="is-total">
                <dt>{t("w10num_kec_detail_day")}</dt>
                <dd>{number(selected.predicted_tons)} t</dd>
              </div>
            </dl>
            <dl className="kec-details-list">
              <div>
                <dt>{t("w10num_kec_detail_trucks")}</dt>
                <dd>{selected.trucks_required}</dd>
              </div>
              <div>
                <dt>{t("w10num_kec_detail_crews")}</dt>
                <dd>
                  {t("w10num_kec_detail_crews_value")
                    .replace("{crews}", selected.crews_required)
                    .replace("{workers}", selected.workers_required)}
                </dd>
              </div>
              <div>
                <dt>{t("w10num_kec_detail_hours")}</dt>
                <dd>{selected.man_hours_required}</dd>
              </div>
              <div>
                <dt>{t("w10num_kec_detail_bins")}</dt>
                <dd>{selected.bins_required}</dd>
              </div>
              <div className="is-total">
                <dt>{t("w10num_kec_detail_tps")}</dt>
                <dd className={selected.facility_over_capacity ? "status-overcapacity" : "status-normal"}>
                  {selected.facility_over_capacity
                    ? t("w10num_tps_over")
                    : t(`w10num_tps_${selected.facility_readiness || "unknown"}`)}
                </dd>
              </div>
            </dl>
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
        </section>
      )}

      <KecamatanRows
        rows={displayedRows}
        loading={!data}
        selectedSlug={selectedSlug}
        onSelect={setSelectedSlug}
        rankOf={(row) => rankBySlug[row.slug]}
      />

      {filteredRows.length > 8 && (
        <button className="link-button show-more-btn" type="button" onClick={() => setShowAll(!showAll)}>
          {showAll ? t("w10num_show_top8") : t("w10num_show_all_kec").replace("{n}", filteredRows.length)}
        </button>
      )}
      <p className="kec-note">{t("w10num_kec_note")}</p>
    </section>
  );
}
