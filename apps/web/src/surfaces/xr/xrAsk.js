// Ask Pythia on the table (gsc-2026 #7): turn the assistant's run_scenario result
// into the tabletop's shared scenario, and its tool trace into one short line.
// Pure functions (no React, no three.js) so e2e can import them directly.
import { TWIN_EVENT_PRESETS } from "../../features/twin/twinLinks.js";

/**
 * The scenario patch for the table, or `{ otherCity }` when the question was
 * about another city than the one on the table, or null without a scenario.
 * Rain and crowd are the values the tool actually ran (already snapped to the
 * twin presets server-side); the crowd maps to the nearest preset id.
 */
export function askToScenario(result, city) {
  const scenario = result?.scenario;
  if (!scenario || typeof scenario !== "object") return null;
  if (result.city && result.city !== city) return { otherCity: result.city, link: result.links?.xr || null };
  const attendance = Number(scenario.event_attendance) || 0;
  const preset = TWIN_EVENT_PRESETS.reduce((best, p) =>
    Math.abs(p.attendance - attendance) < Math.abs(best.attendance - attendance) ? p : best,
  );
  const rain = Number(scenario.rainfall_mm);
  const day = Number(scenario.day);
  return {
    rain: Number.isFinite(rain) ? Math.max(0, Math.min(300, rain)) : 0,
    eventPreset: preset.id,
    venueId: preset.attendance > 0 && scenario.venue_id ? String(scenario.venue_id) : null,
    day: Number.isInteger(day) ? Math.max(0, Math.min(6, day)) : 0,
  };
}

const TRACE_KEYS = {
  run_scenario: "xr3_trace_forecast",
  forecast_model: "xr3_trace_forecast",
  resource_rule: "xr3_trace_resources",
  queue_simulation: "xr3_trace_queue",
};

/** Locale keys for the steps the tool ran, in order, without repeats. */
export function traceKeys(trace) {
  const keys = [];
  for (const step of Array.isArray(trace) ? trace : []) {
    const key =
      step?.step === "parse_scenario"
        ? step.class === "LLM"
          ? "xr3_trace_llm"
          : "xr3_trace_local"
        : TRACE_KEYS[step?.step];
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}
