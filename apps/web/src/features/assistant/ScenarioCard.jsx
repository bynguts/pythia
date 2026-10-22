import { Box, Glasses } from "lucide-react";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { findTwinVenue, twinHref } from "../twin/twinLinks.js";

// gsc-2026 P1-9: what Ana ran for a what-if — numbers, plan, data sources and
// provenance — plus deep links that open the same scenario in the Twin or XR.
const PLAN_STEPS = [
  "parse_scenario",
  "district_forecast",
  "normal_day_baseline",
  "resource_units",
  "queue_metric",
];

function classLabel(value) {
  return String(value || "").replaceAll("_", " ");
}

function scenarioTwinHref(scenario) {
  // The backend already mapped the crowd to the nearest twin event preset.
  // Older payloads name the venue only in the scenario ("GBK"); map it to the twin's venue id.
  const query = new URLSearchParams(scenario.links.twin.split("?")[1] || "");
  const city = query.get("city");
  return twinHref({
    city,
    rain: query.get("rain"),
    event: query.get("event"),
    venue: findTwinVenue(city, query.get("venue") || scenario.scenario?.venue).id,
    day: query.get("day"),
    present: true,
  });
}

export function ScenarioCard({ scenario }) {
  const { t, lang } = useLanguage();
  const number = new Intl.NumberFormat(localeFor(lang), { maximumFractionDigits: 1 });
  const { summary, queue_minutes_per_truck: queue } = scenario;
  const metrics = [
    ["asst_scn_extra_tons", `+${number.format(Math.max(0, summary.extra_tons))} t`],
    ["asst_scn_extra_trucks", `+${number.format(summary.extra_trucks)}`],
    ["asst_scn_extra_crews", `+${number.format(summary.extra_crews)}`],
    ["asst_scn_at_risk", number.format(summary.districts_at_risk)],
  ];
  if (queue?.baseline_mean != null && queue?.staggered_mean != null) {
    metrics.push([
      "asst_scn_queue",
      `${number.format(queue.baseline_mean)} → ${number.format(queue.staggered_mean)}${
        queue.scenario_scaled ? ` · ${t("asst_scn_queue_scaled")}` : ""
      }`,
    ]);
  }
  // gsc m9: Ana runs what the Twin/XR links can show; say when the asked values were snapped.
  const asked = scenario.scenario?.snapped_to_twin_presets ? scenario.scenario.requested : null;
  const snappedNote = asked
    ? t("asst_scn_snapped")
        .replace("{asked_rain}", number.format(asked.rainfall_mm ?? 0))
        .replace("{asked_crowd}", number.format(asked.event_attendance ?? asked.attendance ?? 0))
    : null;

  return (
    <section className="assistant-scenario" data-testid="assistant-scenario-card">
      <div className="assistant-scenario-head">
        <h3>{t("asst_scn_title")}</h3>
        <span className="assistant-scenario-badge" data-testid="assistant-scenario-badge">
          {classLabel(scenario.classification)}
        </span>
      </div>
      <dl className="assistant-scenario-metrics">
        {metrics.map(([key, value]) => (
          <div key={key}>
            <dt>{t(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {scenario.top_districts?.length > 0 && (
        <p className="assistant-scenario-districts">
          <strong>{t("asst_scn_top")}:</strong>{" "}
          {scenario.top_districts
            .slice(0, 3)
            .map((d) => `${d.name} +${number.format(d.extra_tons)} t`)
            .join(" · ")}
        </p>
      )}
      <h4>{t("asst_scn_plan")}</h4>
      <ol className="assistant-scenario-plan" data-testid="assistant-scenario-plan">
        {scenario.plan
          .filter((step) => PLAN_STEPS.includes(step))
          .map((step) => (
            <li key={step}>{t(`asst_scn_step_${step}`)}</li>
          ))}
      </ol>
      <h4>{t("asst_scn_sources")}</h4>
      <ul className="assistant-scenario-sources" data-testid="assistant-scenario-sources">
        {scenario.sources.map((source) => (
          <li key={source.id}>
            <span className="assistant-scenario-badge">{classLabel(source.class)}</span>
            <span>{source.source}</span>
          </li>
        ))}
      </ul>
      {snappedNote && (
        <p className="assistant-scenario-note" data-testid="assistant-scenario-snapped">
          {snappedNote}
        </p>
      )}
      <p className="assistant-scenario-note">{t("asst_scn_note")}</p>
      <div className="assistant-scenario-actions">
        <a href={scenarioTwinHref(scenario)} data-testid="assistant-open-twin">
          <Box size={16} aria-hidden="true" />
          {t("asst_scn_open_twin")}
        </a>
        <a href={scenario.links.xr} data-testid="assistant-open-xr">
          <Glasses size={16} aria-hidden="true" />
          {t("asst_scn_open_xr")}
        </a>
      </div>
    </section>
  );
}
