import { useLanguage } from "../../shared/i18n/index.jsx";
import { signedPercent } from "../../shared/hooks/useSnapshot.js";
import { CloudRain } from "lucide-react";

// Teardown v4 T1: these rows are the five administrative cities (kota) over the
// next seven days, not kecamatan; today's kecamatan figures live in the baseline.
// `source` (teardown v3 N1): "live" is the backend's list, which may honestly be
// empty; "sample" is the offline fallback, shown only when the backend is
// unreachable and badged as not a forecast; "loading" shows neither.
export function PredictionPanel({ predictions: livePredictions, source = "live" }) {
  const { t } = useLanguage();
  const sample = source === "sample";
  const loading = source === "loading";
  const predictions = loading ? [] : livePredictions || [];
  const displayRows = [...predictions].sort((a, b) => (b.predicted_tons || 0) - (a.predicted_tons || 0));

  return (
    <section className="panel wide prediction-panel">
      <div className="panel-title">
        <div>
          <h2>{t("w10num_pred_title")}</h2>
          <p>{t("w10num_pred_sub")}</p>
        </div>
        <div className="panel-header-icon-wrap">
          <CloudRain size={18} />
        </div>
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
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col" style={{ width: "24%" }}>
                  {t("w10num_pred_th_city")}
                </th>
                <th scope="col" style={{ width: "16%" }}>
                  {t("fc_th_date")}
                </th>
                <th scope="col" style={{ width: "18%" }}>
                  {t("fc_th_volume")}
                </th>
                <th scope="col" style={{ width: "20%" }}>
                  {t("fc_th_spike")}
                </th>
                <th scope="col" style={{ width: "22%" }}>
                  {t("fc_th_backup")}
                </th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((item, idx) => {
                const spike = item.spike_percent || 0;
                // The backend's risk class (engine.spike_risk), never a second threshold here.
                const isCrit = item.risk_level === "critical";
                const isHigh = item.risk_level === "high";
                const tone = isCrit ? "danger" : isHigh ? "warning" : "info";

                return (
                  <tr key={`${item.district}-${item.date}-${idx}`}>
                    <td>
                      <strong style={{ color: "var(--ui-ink)", fontWeight: 700 }}>{item.district}</strong>
                    </td>
                    <td>
                      <span
                        style={{
                          fontFamily: "var(--mono, monospace)",
                          fontSize: "12px",
                          color: "var(--ui-muted)",
                        }}
                      >
                        {item.date}
                      </span>
                    </td>
                    <td>
                      <span
                        style={{
                          fontFamily: "var(--mono, monospace)",
                          fontWeight: 600,
                          color: "var(--ui-ink)",
                        }}
                      >
                        {t("ufx_fc_tons_day").replace("{n}", item.predicted_tons?.toFixed(1) || "0.0")}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <div
                          style={{
                            flex: 1,
                            height: "6px",
                            background: "var(--ui-surface-muted)",
                            borderRadius: "9999px",
                            overflow: "hidden",
                            border: "1px solid var(--ui-border)",
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${Math.min(100, Math.max(0, spike) * 2)}%`,
                              background: isCrit
                                ? "var(--ui-danger)"
                                : isHigh
                                  ? "var(--ui-warning)"
                                  : "var(--ui-accent)",
                            }}
                          />
                        </div>
                        <span
                          className={`pill ${tone}`}
                          style={{ minWidth: "48px", justifyContent: "center" }}
                        >
                          {signedPercent(spike)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="zone-tag">
                        {t("ufx_fc_trucks_crews")
                          .replace("{trucks}", item.recommended_extra_trucks || 0)
                          .replace("{crews}", item.recommended_extra_crews || 0)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
