import { useLanguage, localeFor } from "../../shared/i18n/index.jsx";
import "./audit.css";

// Real-data resolutions, in display order. Their numbers come from the API
// (/ml/suitability → monthly_backtest), which reads the training pipeline's artifact.
const REAL_RESOLUTIONS = ["landfill_month", "city_month"];

function fill(template, values) {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
}

// Green only when the whole 90% interval of the error reduction is above zero.
function beatsNaive(metrics) {
  const lower = metrics?.skill_ci90_pct?.[0];
  return metrics?.skill_pct > 0 && lower > 0;
}

export function ModelCard({ suitability, resolutionLabel }) {
  const { lang, t } = useLanguage();
  const locale = localeFor(lang);
  const backtest = suitability.monthly_backtest || {};
  const details = suitability.details || {};
  const tons = (value) =>
    `${Number(value).toLocaleString(locale, { maximumFractionDigits: 1 })} ${t("audit_mc_unit")}`;
  const pct = (value, signed = true) =>
    `${signed && value > 0 ? "+" : ""}${Number(value).toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
  const naiveName = (name) => {
    const key = `audit_mc_naive_${name}`;
    const label = t(key);
    return label === key ? name : label;
  };
  const real = REAL_RESOLUTIONS.filter((key) => backtest[key]);
  const synthetic = Object.entries(details)
    .filter(([, detail]) => detail.validation_target === "synthetic")
    .map(([key]) => key);

  return (
    <section className="audit-model-card" data-testid="model-card" aria-labelledby="audit-model-card-title">
      <div className="model-card-intro">
        <h3 id="audit-model-card-title" className="settings-subhead">
          {t("audit_mc_title")}
        </h3>
        <p>{t("audit_mc_intro")}</p>
      </div>

      {real.length === 0 && <p data-testid="model-card-unavailable">{t("audit_mc_unavailable")}</p>}
      <ul className="model-card-list">
        {real.map((key) => {
          const m = backtest[key];
          const good = beatsNaive(m);
          const [lo, hi] = m.skill_ci90_pct || [];
          return (
            <li key={key} className="model-card-row" data-testid={`model-card-${key}`}>
              <div className="model-card-head">
                <strong>{t(`audit_mc_res_${key}`)}</strong>
                <span className="prov prov-real">{t("audit_mc_real_target")}</span>
                <span
                  className={`model-card-verdict ${good ? "good" : "bad"}`}
                  data-testid={`model-card-verdict-${key}`}
                >
                  {good ? t("audit_mc_beats") : t("audit_mc_not_beating")}
                </span>
              </div>
              <p className="model-card-model">{t("audit_mc_model_name")}</p>
              <dl className="model-card-metrics">
                <div>
                  <dt>{t("audit_mc_model_mae")}</dt>
                  <dd>{tons(m.mae_model)}</dd>
                </div>
                <div>
                  <dt>{fill(t("audit_mc_naive_mae"), { name: naiveName(m.strongest_naive) })}</dt>
                  <dd>{tons(m.mae_naive)}</dd>
                </div>
                <div>
                  <dt>{t("audit_mc_mape")}</dt>
                  <dd>
                    {pct(m.mape_model_pct, false)} / {pct(m.mape_naive_pct, false)}
                  </dd>
                </div>
                <div>
                  <dt>{t("audit_mc_skill")}</dt>
                  <dd className={good ? "good" : "bad"}>
                    {fill(t("audit_mc_skill_value"), { skill: pct(m.skill_pct), lo: pct(lo), hi: pct(hi) })}
                  </dd>
                </div>
                <div>
                  <dt>{t("audit_mc_backtest")}</dt>
                  <dd>
                    {fill(t("audit_mc_backtest_value"), {
                      origins: m.origins,
                      h: `${m.horizons_months?.[0]}–${m.horizons_months?.at(-1)}`,
                      from: m.first_origin,
                      to: m.last_origin,
                    })}
                  </dd>
                </div>
              </dl>
              {m.calendar_months && m.normal_months && (
                <small>
                  {fill(t("audit_mc_lebaran"), {
                    cal: pct(m.calendar_months.skill_pct),
                    normal: pct(m.normal_months.skill_pct),
                  })}
                </small>
              )}
            </li>
          );
        })}
      </ul>

      {synthetic.length > 0 && (
        <>
          <h4 className="model-card-subhead">{t("audit_mc_synthetic_title")}</h4>
          <ul className="model-card-synthetic" data-testid="model-card-synthetic">
            {synthetic.map((key) => (
              <li key={key} data-testid={`model-card-synthetic-${key}`}>
                <span>{resolutionLabel(key)}</span>
                <span className="prov prov-sim">{t("audit_mc_synthetic_badge")}</span>
                <small>
                  {key === "hotspot_rank" ? t("audit_mc_hotspot_note") : t("audit_mc_synthetic_note")}
                </small>
              </li>
            ))}
          </ul>
          {/* Teardown v3 fix 7: how the daily model's rain effect is served (engine.rain_response_block). */}
          <p className="model-honesty-note" data-testid="model-card-rain-response">
            <strong>{t("ufx_mc_rain_title")}</strong>
            {t("ufx_mc_rain_response")}
          </p>
        </>
      )}

      <p className="model-honesty-note">
        <strong>{t("audit_mc_caveat_title")}</strong>
        {t("audit_mc_caveat")}
      </p>
    </section>
  );
}
