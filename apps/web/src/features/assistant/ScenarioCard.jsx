import { Link } from "react-router-dom";
import { ClipboardCheck, Glasses } from "lucide-react";
import { localeFor, localizeRecorded, useLanguage } from "../../shared/i18n/index.jsx";

// gsc-2026 P1-9: what Ana ran for a what-if — numbers, plan, data sources and
// provenance. In the console it links nowhere: /twin and /xr are legacy routes,
// so only the legacy Twin rail (`inTwin`) keeps its approval and XR links.
const PLAN_STEPS = [
  "parse_scenario",
  "district_forecast",
  "normal_day_baseline",
  "resource_units",
  "queue_metric",
];

// Why the LLM failed, as the API words it (assistant.py _provider_error_reason): lx_fallback_*.
const FALLBACK_REASONS = [
  "lx_fallback_timeout",
  "lx_fallback_unreachable",
  "lx_fallback_invalid",
  "lx_fallback_no_tool",
];

// A provenance class: MODEL OUTPUT / SIMULATED / LLM stay as written; the others are said.
function classLabel(value, t) {
  const text = t(`lx_class_${value}`);
  return text === `lx_class_${value}` ? String(value || "").replaceAll("_", " ") : text;
}

// The API writes a step's or source's basis in English; the fixed ones are said in the
// UI language (numbers kept), anything else stays as written.
function sourceText(source, t, lang) {
  const s = String(source || "");
  if (lang === "en") return s;
  const units =
    /^canonical units: 1 truck = ([\d.]+) t, 1 crew = (\d+) workers per truck, 1 shift = ([\d.]+) h, 1 bin = ([\d.]+) t/.exec(
      s,
    );
  if (units) {
    const [, truck, crew, shift, bin] = units;
    return t("lx_src_units")
      .replace("{truck}", truck)
      .replace("{crew}", crew)
      .replace("{shift}", shift)
      .replace("{bin}", bin);
  }
  const queue =
    /^Seeded discrete-event simulation of one operating day at the TPST Bantargebang weighbridges; arrivals: (.+)\. Not a field measurement\.$/.exec(
      s,
    );
  if (queue) return t("lx_src_queue").replace("{arrivals}", queue[1]);
  const llm = /^LLM tool call \((.*)\)$/.exec(s);
  if (llm) return t("lx_src_llm").replace("{model}", llm[1]);
  if (s.startsWith("Deterministic local parser")) return t("lx_src_local_parser");
  if (s.startsWith("run_scenario:")) return t("lx_src_run_scenario");
  if (s.startsWith("BMKG daily rainfall categories")) return t("lx_src_bmkg");
  if (s === "Prophet + XGBoost per kecamatan, SILIKA DLH 2023 baseline") return t("lx_src_district_model");
  return s;
}

/** What a trace step ran on, in one short line (inputs, model scope, output). */
function traceDetail(step, t, number) {
  const d = step.detail || {};
  if (step.step === "parse_scenario" || step.step === "run_scenario")
    return t("asst_trace_inputs")
      .replace("{rain}", number.format(d.rainfall_mm ?? 0))
      .replace("{crowd}", number.format(d.event_attendance ?? 0))
      .replace("{venue}", d.venue ? String(d.venue).toUpperCase() : "—")
      .replace("{day}", number.format(d.day ?? 0));
  if (step.step === "forecast_model")
    return t("asst_trace_districts")
      .replace("{n}", number.format(d.districts ?? 0))
      .replace("{date}", d.date || "");
  if (step.step === "resource_rule")
    return t("asst_trace_trucks").replace("{n}", number.format(d.trucks_required ?? 0));
  if (step.step === "queue_simulation")
    return t("asst_trace_queue").replace("{n}", number.format(d.trucks_per_day ?? 0));
  return null;
}

/**
 * Who answered: the local rule parser, the parser as a fallback after an LLM
 * error, or an LLM named by the host and model the backend reports as served.
 */
export function providerLabel(provider, model, t, { mode, providerName, fallbackReason } = {}) {
  if (provider === "local" && mode === "fallback")
    return t("ask_provider_fallback").replace(
      "{reason}",
      fallbackReason ? localizeRecorded(fallbackReason, FALLBACK_REASONS, t) : "—",
    );
  if (provider === "local") return t("asst_provider_local");
  if (!provider) return null;
  return `LLM: ${providerName || provider}${model ? ` · ${model}` : ""}`;
}

// `inTwin`: the card sits in the legacy Twin's rail, which links on to approval and XR.
// In the console, who answered (provider, model) is not shown on the card: it rides
// `data-provenance` (the audit trail records the provider). The legacy Twin rail keeps its badge.
export function ScenarioCard({ scenario, provider, model, source, inTwin = false }) {
  const { t, lang } = useLanguage();
  const number = new Intl.NumberFormat(localeFor(lang), { maximumFractionDigits: 1 });
  const { summary, queue_minutes_per_truck: queue } = scenario;
  // Equal truck and crew counts are the one-crew-per-truck planning rule, not a bug: say so.
  const crewRule =
    summary.extra_crews === summary.extra_trucks && Number.isFinite(summary.crew_size_workers)
      ? t("units_crew_per_truck").replace("{n}", number.format(summary.crew_size_workers))
      : null;
  const metrics = [
    ["asst_scn_extra_tons", `+${number.format(Math.max(0, summary.extra_tons))} t`],
    ["asst_scn_extra_trucks", `+${number.format(summary.extra_trucks)}`],
    [
      "asst_scn_extra_crews",
      `+${number.format(summary.extra_crews)}`,
      undefined,
      crewRule && { text: crewRule, testId: "assistant-scenario-crew-rule" },
    ],
    ["asst_scn_at_risk", number.format(summary.districts_at_risk)],
  ];
  if (queue?.baseline_mean != null && queue?.staggered_mean != null) {
    // The unstaggered figure carries its departure-spread band, as on the Twin HUD.
    const band =
      Array.isArray(queue.baseline_band) &&
      queue.baseline_band.length === 2 &&
      queue.baseline_band.every(Number.isFinite)
        ? queue.baseline_band
        : null;
    // The simulated day with a staggered departure schedule: not today's approved plan
    // (Reports reads that one). Said in the tooltip and data-provenance, not as a badge.
    metrics.push([
      "asst_scn_queue",
      `${number.format(queue.baseline_mean)}${
        band ? ` (${number.format(band[0])}–${number.format(band[1])})` : ""
      } → ${number.format(queue.staggered_mean)}${queue.scenario_scaled ? ` · ${t("asst_scn_queue_scaled")}` : ""}`,
      "is-queue",
      band && {
        text: t("asst_scn_queue_band")
          .replace("{low}", number.format(band[0]))
          .replace("{high}", number.format(band[1])),
        testId: "assistant-scenario-queue-band",
      },
      { title: t("asst_scn_queue_title"), provenance: "SIMULATED staggered-plan queue metric" },
    ]);
  }
  // gsc m9: Ana runs what the Twin/XR links can show; say when the asked values were snapped.
  const asked = scenario.scenario?.snapped_to_twin_presets ? scenario.scenario.requested : null;
  const assumedCrowd = scenario.scenario?.attendance_assumed
    ? t("asst_scn_assumed_crowd").replace("{n}", number.format(scenario.scenario.event_attendance))
    : null;
  const trace = Array.isArray(scenario.trace) ? scenario.trace : null;
  const providerText = inTwin ? providerLabel(provider, model, t, source) : null;
  // gsc #8: a rain word ("heavy rain") ran at its BMKG category's stated value.
  const rainCategory = scenario.scenario?.rain_category;
  const rainCategoryNote = rainCategory
    ? t("ask_scn_rain_category")
        .replace("{phrase}", rainCategory.phrase)
        .replace("{mm}", number.format(rainCategory.rainfall_mm))
        .replace(
          "{label}",
          lang === "en" ? rainCategory.label_en || rainCategory.bmkg_label : rainCategory.bmkg_label,
        )
        .replace("{range}", rainCategory.range_mm_per_day) +
      (rainCategory.lower_bound ? ` ${t("ask_scn_rain_lower_bound")}` : "")
    : null;
  const snappedNote = asked
    ? t("asst_scn_snapped")
        .replace("{asked_rain}", number.format(asked.rainfall_mm ?? 0))
        .replace("{asked_crowd}", number.format(asked.event_attendance ?? asked.attendance ?? 0))
    : null;

  return (
    <section
      className="assistant-scenario"
      data-testid="assistant-scenario-card"
      data-provenance={[provider, model].filter(Boolean).join(" · ") || undefined}
    >
      <div className="assistant-scenario-head">
        <h3>{t("asst_scn_title")}</h3>
        <span className="assistant-scenario-badge" data-testid="assistant-scenario-badge">
          {classLabel(scenario.classification, t)}
        </span>
        {providerText && (
          <span className="assistant-scenario-badge" data-testid="assistant-provider-badge">
            {providerText}
          </span>
        )}
      </div>
      {rainCategoryNote && (
        <p className="assistant-scenario-note" data-testid="assistant-scenario-rain-category">
          {rainCategoryNote}
        </p>
      )}
      {assumedCrowd && (
        <p className="assistant-scenario-note" data-testid="assistant-scenario-assumed">
          {assumedCrowd}
        </p>
      )}
      <dl className="assistant-scenario-metrics">
        {metrics.map(([key, value, className, note, meta]) => (
          <div key={key} className={className} title={meta?.title} data-provenance={meta?.provenance}>
            <dt>{t(key)}</dt>
            <dd>{value}</dd>
            {note && (
              <dd className="assistant-scenario-metric-note" data-testid={note.testId}>
                {note.text}
              </dd>
            )}
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
      {trace ? (
        <>
          <h4>{t("asst_trace_title")}</h4>
          {/* The steps Ana actually ran, each with its source and provenance class. */}
          <ol className="assistant-scenario-trace" data-testid="assistant-scenario-trace">
            {trace.map((step) => {
              const detail = traceDetail(step, t, number);
              return (
                <li key={step.step} data-testid={`assistant-trace-${step.step}`}>
                  <span className="assistant-scenario-trace-head">
                    {t(`asst_trace_step_${step.step}`)}
                    <span className="assistant-scenario-badge">{classLabel(step.class, t)}</span>
                  </span>
                  {detail && <code>{detail}</code>}
                  <small>{sourceText(step.source, t, lang)}</small>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <>
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
                <span className="assistant-scenario-badge">{classLabel(source.class, t)}</span>
                <span>{sourceText(source.source, t, lang)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {snappedNote && (
        <p className="assistant-scenario-note" data-testid="assistant-scenario-snapped">
          {snappedNote}
        </p>
      )}
      <p className="assistant-scenario-note">{t("asst_scn_note")}</p>
      {inTwin && (
        <div className="assistant-scenario-actions">
          <Link to="/app/tomorrow" data-testid="assistant-review-plan">
            <ClipboardCheck size={16} aria-hidden="true" />
            {t("asst_scn_review_plan")}
          </Link>
          {scenario.links?.xr && (
            <a href={scenario.links.xr} data-testid="assistant-open-xr">
              <Glasses size={16} aria-hidden="true" />
              {t("asst_scn_open_xr")}
            </a>
          )}
        </div>
      )}
    </section>
  );
}
