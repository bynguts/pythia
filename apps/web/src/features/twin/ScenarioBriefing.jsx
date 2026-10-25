import { useEffect, useState } from "react";
import { ArrowRight, CloudRain, QrCode, Scale, Users } from "lucide-react";
import { apiGet } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { TWIN_SCENARIOS, WEIGHBRIDGE_LANES, twinScenario } from "./twinLinks.js";

const SCENARIO_ICONS = { heavy_rain: CloudRain, gbk_event: Users, weighbridge_lane_down: Scale };

// The three numbers a briefing compares, each with the class of the model behind it.
const ROWS = [
  { key: "tons", field: "total_tonnage_t", label: "dr_row_tons", unit: " t", source: "tonnage" },
  { key: "trucks", field: "trucks_needed", label: "dr_row_trucks", unit: "", source: "trucks" },
  { key: "queue", field: "queue_minutes_per_truck", label: "dr_row_queue", unit: "", source: "queue" },
];

/**
 * "This week's scenario briefing": today's canonical baseline (forecast/baseline,
 * the figures Prediksi and Rencana print) beside one briefing scenario on the same
 * day, from /api/twin/briefing. Choosing a scenario also puts it on the map
 * (`onSelect`); the result goes to Rencana or onto the XR table.
 */
export function ScenarioBriefing({ scenarioId, onSelect, onApply, onOpenTable, onBody }) {
  const { t } = useLanguage();
  const locale = t("twin_locale");
  const [state, setState] = useState({ id: undefined, body: null, error: false });

  useEffect(() => {
    const controller = new AbortController();
    const query = scenarioId ? `?scenario=${encodeURIComponent(scenarioId)}` : "";
    apiGet(`/twin/briefing${query}`, { signal: controller.signal })
      .then((body) => {
        setState({ id: scenarioId, body, error: false });
        onBody?.(body);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setState({ id: scenarioId, body: null, error: true });
      });
    return () => controller.abort();
  }, [scenarioId, onBody]);

  const loading = state.id !== scenarioId;
  const body = loading ? null : state.body;
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const minutes = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const format = (row, value) =>
    Number.isFinite(value) ? `${(row.key === "queue" ? minutes : whole).format(value)}${row.unit}` : "—";
  const delta = (before, after) =>
    Number.isFinite(before) && Number.isFinite(after) && before > 0
      ? `${after >= before ? "+" : "−"}${minutes.format(Math.abs(((after - before) / before) * 100))}%`
      : null;
  // A closed lane is an assumption about the day, and the briefing says so.
  const lanes = twinScenario(scenarioId)?.lanes;
  const lanesNote = lanes
    ? t("dr_lanes_assumption")
        .replace("{closed}", WEIGHBRIDGE_LANES - lanes)
        .replace("{total}", WEIGHBRIDGE_LANES)
    : null;
  const date = body?.date
    ? new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "short" }).format(
        new Date(`${body.date}T00:00:00`),
      )
    : null;

  return (
    <section
      className="twin-briefing"
      aria-labelledby="twin-briefing-title"
      aria-busy={loading}
      data-testid="twin-briefing"
      data-scenario={scenarioId || "none"}
      data-state={loading ? "loading" : state.error ? "error" : "ready"}
    >
      <h2 id="twin-briefing-title" className="twin-panel-title">
        {t("dr_title")}
      </h2>
      <div className="twin-choice twin-briefing-choices" role="group" aria-labelledby="twin-briefing-title">
        {TWIN_SCENARIOS.map(({ id }) => {
          const Icon = SCENARIO_ICONS[id];
          return (
            <button
              key={id}
              type="button"
              data-testid={`twin-briefing-${id}`}
              aria-pressed={scenarioId === id}
              onClick={() => onSelect(scenarioId === id ? null : id)}
            >
              {Icon && <Icon size={15} aria-hidden="true" />}
              {t(`dr_scn_${id}`)}
            </button>
          );
        })}
      </div>

      <table className="twin-briefing-table" data-testid="twin-briefing-table">
        <caption className="sr-only">{t("dr_table_caption")}</caption>
        <thead>
          <tr>
            <td />
            <th scope="col">{t("dr_col_today")}</th>
            <th scope="col">{t("dr_col_scenario")}</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => {
            const before = body?.before?.[row.field];
            const after = body?.after?.[row.field];
            const change = delta(before, after);
            return (
              <tr key={row.key} data-metric={row.key}>
                <th scope="row">
                  {t(row.label)}
                  <small>{t(`twin_class_${body?.classification?.[row.source] || "MODEL_OUTPUT"}`)}</small>
                </th>
                <td data-testid={`twin-briefing-before-${row.key}`} data-value={before ?? ""}>
                  {format(row, before)}
                </td>
                <td data-testid={`twin-briefing-after-${row.key}`} data-value={after ?? ""}>
                  {body?.after ? format(row, after) : "—"}
                  {change && <small>{change}</small>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="twin-note" data-testid="twin-briefing-note">
        {state.error && !loading
          ? t("dr_error")
          : [
              date && t("dr_note_day").replace("{date}", date),
              t(scenarioId ? "dr_note_model" : "dr_note_pick"),
            ]
              .filter(Boolean)
              .join(" · ")}
      </p>
      {lanesNote && (
        <p className="twin-note" data-testid="twin-briefing-assumption">
          {lanesNote}
        </p>
      )}

      <div className="twin-briefing-actions">
        <button
          type="button"
          className="twin-btn primary"
          data-testid="twin-apply-plan"
          disabled={!scenarioId || !body?.after}
          onClick={() => onApply(scenarioId, body.date)}
        >
          {t("dr_apply")} <ArrowRight size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="twin-btn secondary"
          data-testid="twin-briefing-table-open"
          aria-haspopup="dialog"
          onClick={onOpenTable}
        >
          <QrCode size={16} aria-hidden="true" /> {t("dr_open_table")}
        </button>
      </div>
    </section>
  );
}
