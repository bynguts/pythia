// SPJ stops a plan generates carry fixed Indonesian text in the record (api routers/operations.py
// _tps_stops): a planning-point name and address, a SILIKA TPS address note. Said in the UI
// language here; a stop someone named stays as written.
import { localizeRecorded } from "../i18n/index.jsx";

const STOP_KEYS = ["lx_stop_plan_name", "lx_stop_plan_address", "lx_stop_tps_address"];

export function stopText(text, t) {
  return localizeRecorded(text, STOP_KEYS, t);
}
