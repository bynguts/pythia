import { useLanguage } from "../../shared/i18n/index.jsx";
import { signedPercent } from "../../shared/hooks/useSnapshot.js";

// Teardown v4 T1: these rows are the five administrative cities (kota) over the
// next seven days, not kecamatan; today's kecamatan figures live in the baseline.
// `source` (teardown v3 N1): "live" is the backend's list, which may honestly be
// empty; "sample" is the offline fallback, shown only when the backend is
// unreachable and badged as not a forecast; "loading" shows neither.
// wave11 forecast: the evidence section is the surface; this is a plain table in it.
export function PredictionPanel({ predictions: livePredictions, source = "live" }) {
  const { t } = useLanguage();
  const sample = source === "sample";
  const loading = source === "loading";
  const predictions = loading ? [] : livePredictions || [];
  const displayRows = [...predictions].sort((a, b) => (b.predicted_tons || 0) - (a.predicted_tons || 0));

  return (
    <div className="prediction-panel">
      <div className="prediction-head">
        <h3>{t("w10num_pred_title")}</h3>
        <p>{t("w10num_pred_sub")}</p>
      </div>

      {sample && (
        <p className="prediction-sample-note" role="note" data-testid="forecast-sample-badge">
          {t("ufx_fc_sample_badge")}
        </p>
      )}

      {predictions.length === 0 ? (
        <p className="table-empty-state" role="status" data-testid="forecast-empty">
          {t(loading ? "ufx_fc_loading" : "ufx_fc_empty")}
        </p>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table prediction-table">
            <thead>
              <tr>
                <th scope="col">{t("w10num_pred_th_city")}</th>
                <th scope="col">{t("fc_th_date")}</th>
                <th scope="col" className="num">
                  {t("fc_th_volume")}
                </th>
                <th scope="col">{t("fc_th_spike")}</th>
                <th scope="col">{t("fc_th_backup")}</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((item, idx) => {
                const spike = item.spike_percent || 0;
                // The backend's risk class (engine.spike_risk), never a second threshold here.
                const tone =
                  item.risk_level === "critical" ? "danger" : item.risk_level === "high" ? "warning" : "info";
                return (
                  <tr key={`${item.district}-${item.date}-${idx}`}>
                    <td className="prediction-city">{item.district}</td>
                    <td className="num prediction-date">{item.date}</td>
                    <td className="num">
                      {t("ufx_fc_tons_day").replace("{n}", item.predicted_tons?.toFixed(1) || "0.0")}
                    </td>
                    <td>
                      <span className={`prediction-spike tone-${tone}`}>
                        <span className="prediction-spike-track" aria-hidden="true">
                          <span style={{ width: `${Math.min(100, Math.max(0, spike) * 2)}%` }} />
                        </span>
                        <b>{signedPercent(spike)}</b>
                      </span>
                    </td>
                    <td className="prediction-backup">
                      {t("ufx_fc_trucks_crews")
                        .replace("{trucks}", item.recommended_extra_trucks || 0)
                        .replace("{crews}", item.recommended_extra_crews || 0)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
