// Driver-app wording of API text that is not the driver's own (gate holds, provenance notes).
import { localizeRecorded } from "../../shared/i18n/index.jsx";

// A dispatch instruction in the driver's language when the API wrote it from a fixed
// template (the API's gate hold, the console's send previews, Work orders' proof request); a person's
// message stays as sent.
export function instructionText(text, t) {
  return localizeRecorded(
    text,
    ["lx_instr_gate_hold", "ea_gate_hold_text", "ea_route_text", "s4_wo_proof_request"],
    t,
  );
}

// A plan dispatch rendered from its language-neutral fields (template "plan_dispatch_v1");
// any other dispatch keeps the stored text through instructionText.
export function dispatchBody(dispatch, t) {
  const fields = dispatch?.fields;
  if (fields?.template !== "plan_dispatch_v1") return instructionText(dispatch?.instruction, t);
  const fill = (key, values) =>
    Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key));
  const lines = [
    fill("fm_pd_head", { plan: fields.plan_id, date: fields.plan_date, truck: fields.truck_code }),
  ];
  for (const stop of fields.stops || []) {
    lines.push(
      fill("fm_pd_stop", {
        order: stop.order,
        shift: stop.shift,
        window: stop.window ? ` (${stop.window})` : "",
        tons: Math.round(stop.tons),
        district: stop.kecamatan,
        facility: stop.facility_display || stop.facility,
      }),
    );
  }
  const areas = (fields.reason?.areas || []).map((a) =>
    fill("fm_pd_area", { district: a.kecamatan, tons: Math.round(a.forecast_tons) }),
  );
  if (areas.length) lines.push(fill("fm_pd_reason", { areas: areas.join(", ") }));
  return lines.join("\n");
}

// The safety classification's provenance note: the API's English label, or the same in Indonesian.
export function safetyNote(safety, t, lang) {
  const classification = String(safety?.classification || "");
  if (lang === "en" || !classification) return safety?.label || undefined;
  if (classification.startsWith("SIMULATED")) return t("lx_safety_note_simulated");
  if (classification === "OBSERVED_APP_EVENTS") return t("lx_safety_note_observed");
  return undefined;
}
