import { useState, useEffect } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Leaf } from "lucide-react";

export function CarbonPanel() {
  const { t } = useLanguage();
  const [carbon, setCarbon] = useState(null);

  useEffect(() => {
    const load = () =>
      apiFetch("/ai/carbon-live")
        .then((r) => r.json())
        .then(setCarbon)
        .catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  const hasData = carbon && carbon.status !== "no_data";

  return (
    <section className="panel carbon-panel" id="carbon-panel" data-testid="carbon-panel">
      <div className="panel-title">
        <div>
          <h2>
            {t("carbon_title")}{" "}
            <span className="pill" data-testid="carbon-sim-badge">
              {t("honesty_sim_badge")}
            </span>
          </h2>
          <p>{t("carbon_subtitle")}</p>
        </div>
        <div className="panel-header-icon-wrap">
          <Leaf size={18} />
        </div>
      </div>
      {hasData ? (
        <>
          <div className="carbon-grid">
            <div className="carbon-stat">
              <span>{t("carbon_distance")}</span>
              <strong>{carbon.total_distance_km.toFixed(1)} km</strong>
            </div>
            <div className="carbon-stat">
              <span>{t("carbon_fuel")}</span>
              <strong>{carbon.fuel_l.toFixed(1)} L</strong>
            </div>
            <div className="carbon-stat">
              <span>CO₂</span>
              <strong>{carbon.co2_kg.toFixed(1)} kg</strong>
            </div>
            <div className="carbon-stat">
              <span>{t("carbon_below_reference")}</span>
              <strong style={{ color: "var(--ui-success)" }}>{carbon.fuel_saved_l.toFixed(1)} L</strong>
            </div>
          </div>
          <div className="carbon-badge" data-testid="carbon-reference-note">
            {t("carbon_reference_note")}
          </div>
        </>
      ) : (
        <div className="ai-feed-empty">{t("ai_engine_waiting")}</div>
      )}
    </section>
  );
}
