import React from "react";
import { CalendarRange, CloudSun } from "lucide-react";
import { MetricStrip } from "../ui/MetricStrip.jsx";
import { SegmentedControl } from "../ui/SegmentedControl.jsx";
import { useLanguage } from "../i18n.jsx";

export function WasteForecast({
  metrics,
  forecast,
  weather,
  events,
  districts,
  reportActions,
  horizon,
  onHorizonChange,
}) {
  const { lang, t } = useLanguage();
  const horizonOptions = [
    { value: "7d", label: `7 ${t("fc_days")}` },
    { value: "14d", label: `14 ${t("fc_days")}` },
    { value: "30d", label: `30 ${t("fc_days")}` },
  ];

  return (
    <section className="forecast-workspace workspace-page" data-testid="forecast-workspace" aria-labelledby="forecast-title">
      <header className="workspace-heading forecast-heading">
        <div>
          <span className="workspace-kicker"><CloudSun size={14} /> {t("fc_kicker")}</span>
          <h1 id="forecast-title">{lang === "id" ? "Prediksi timbulan sampah" : "Waste generation forecast"}</h1>
          <p>{lang === "id" ? "Temukan wilayah yang membutuhkan tambahan armada sebelum beban layanan meningkat." : "Find districts that need more fleet capacity before service demand rises."}</p>
        </div>
        <div className="forecast-heading-actions">
          <div className="forecast-horizon-control">
            <span className="control-label"><CalendarRange size={14} /> {t("fc_horizon_label")}</span>
            <SegmentedControl value={horizon} options={horizonOptions} onChange={onHorizonChange} />
          </div>
          {reportActions}
        </div>
      </header>

      <MetricStrip metrics={metrics} />

      <div className="forecast-command-grid" data-testid="forecast-command-grid">
        <section className="forecast-primary-analysis" data-testid="forecast-primary-analysis" aria-labelledby="forecast-analysis-title">
          <div className="section-intro">
            <div><span className="surface-kicker">{t("fc_priority_kicker")}</span><h2 id="forecast-analysis-title">{t("fc_priority_title")}</h2></div>
            <p>{t("fc_priority_sub")}</p>
          </div>
          {districts}
        </section>
        <aside className="forecast-context-rail" aria-label={t("fc_context_label")}>
          <div className="section-intro compact">
            <div><span className="surface-kicker">{t("fc_context_kicker")}</span><h2>{t("fc_context_title")}</h2></div>
          </div>
          {weather}
          {events}
        </aside>
      </div>

      <section className="forecast-evidence-section" aria-labelledby="forecast-evidence-title">
        <div className="section-intro">
          <div><span className="surface-kicker">{t("fc_evidence_kicker")}</span><h2 id="forecast-evidence-title">{t("fc_evidence_title")}</h2></div>
          <p>{t("fc_evidence_sub")}</p>
        </div>
        {forecast}
      </section>
    </section>
  );
}
