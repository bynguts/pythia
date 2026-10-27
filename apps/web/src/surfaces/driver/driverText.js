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

// The safety classification's provenance note: the API's English label, or the same in Indonesian.
export function safetyNote(safety, t, lang) {
  const classification = String(safety?.classification || "");
  if (lang === "en" || !classification) return safety?.label || undefined;
  if (classification.startsWith("SIMULATED")) return t("lx_safety_note_simulated");
  if (classification === "OBSERVED_APP_EVENTS") return t("lx_safety_note_observed");
  return undefined;
}
