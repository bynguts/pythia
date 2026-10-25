import { signedPercent } from "../../shared/hooks/useSnapshot.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { StatusPill } from "../../shared/ui/StatusPill.jsx";
import { CloudRain } from "lucide-react";

// Teardown v4 P4: a forecast is never "live"; the advice comes from the risk
// level code (forecast/weather.py), not the backend's English sentence.
export function WeatherPanel({ weather }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const forecast = weather?.forecast || [];
  const peak = forecast.reduce(
    (best, item) => (item.waste_impact_percent > (best?.waste_impact_percent || 0) ? item : best),
    forecast[0],
  );
  const trendRows = forecast.slice(0, 7);
  const maxRainfall = Math.max(...trendRows.map((item) => item.rainfall_mm || 0), 1);
  const maxImpact = Math.max(...trendRows.map((item) => item.waste_impact_percent || 0), 1);
  const day = (iso, options) => new Date(`${iso}T00:00:00`).toLocaleDateString(locale, options);

  return (
    <section className="panel weather-panel">
      <div className="panel-title">
        <div>
          <h2>{t("w10num_wx_title")}</h2>
          <p>{t("w10num_wx_sub")}</p>
        </div>
        <StatusPill tone={weather?.source === "open-meteo" ? "success" : "warning"}>
          {t(weather?.source === "open-meteo" ? "w10num_wx_source_forecast" : "w10num_wx_source_fallback")}
        </StatusPill>
      </div>
      {peak && (
        <div className="weather-hero">
          <CloudRain size={26} />
          <div>
            <strong>{day(peak.date, { weekday: "long", day: "numeric", month: "short" })}</strong>
            <span>
              {t("w10num_wx_peak")
                .replace("{mm}", peak.rainfall_mm.toFixed(1))
                .replace("{p}", Math.round(peak.precipitation_probability))}
            </span>
          </div>
          <b>{signedPercent(peak.waste_impact_percent)}</b>
        </div>
      )}
      <div className="weather-strip">
        {trendRows.map((item) => (
          <article key={item.date} className={`weather-day ${item.risk_level}`}>
            <div>
              <strong>{day(item.date, { weekday: "short" })}</strong>
              <small>{day(item.date, { month: "short", day: "numeric" })}</small>
            </div>
            <span>{Math.round(item.rainfall_mm)} mm</span>
            <small>
              {Math.round(item.temperature_min_c)}–{Math.round(item.temperature_max_c)} °C
            </small>
          </article>
        ))}
      </div>
      <div className="weather-trend-chart" aria-label={t("w10num_wx_trend")}>
        <h3>{t("w10num_wx_trend")}</h3>
        {trendRows.map((item) => {
          const rainWidth = Math.max(4, ((item.rainfall_mm || 0) / maxRainfall) * 100);
          const impactWidth = Math.max(4, ((item.waste_impact_percent || 0) / maxImpact) * 100);
          return (
            <article className="weather-trend-row" key={`${item.date}-trend`}>
              <span>{day(item.date, { weekday: "short" })}</span>
              <div className="weather-trend-bars">
                <i className="rainfall-bar" style={{ width: `${rainWidth}%` }} />
                <i className="impact-bar" style={{ width: `${impactWidth}%` }} />
              </div>
              <b>{Math.round(item.rainfall_mm)} mm</b>
              <em>{signedPercent(item.waste_impact_percent)}</em>
            </article>
          );
        })}
      </div>
      {peak && <p className="weather-advice">{t(`w10num_wx_advice_${peak.risk_level || "normal"}`)}</p>}
    </section>
  );
}
