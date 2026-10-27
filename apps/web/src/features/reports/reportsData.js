import { apiGet } from "../../shared/api/client.js";

// Reports: everything the close-of-day page reads, shaped for display.
// Each source can fail on its own (a role may lack a permission): the page then shows "—"
// or an empty list for that part instead of failing as a whole.

const ZONE = "Asia/Jakarta";
const DAYS = 7;

export function jakartaDate(offsetDays = 0, from = new Date()) {
  const day = new Date(from.getTime() + offsetDays * 86400000);
  return day.toLocaleDateString("sv-SE", { timeZone: ZONE });
}

export function localDay(iso) {
  return iso ? new Date(iso).toLocaleDateString("sv-SE", { timeZone: ZONE }) : null;
}

export function clockTime(iso) {
  return iso
    ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: ZONE })
    : "";
}

const value = (result) => (result.status === "fulfilled" ? result.value : null);

// alert_id -> its newest follow-up { status, note }. /alert/follow-ups is newest first.
function followUps(events) {
  const latest = new Map();
  for (const event of events || []) {
    const alertId = event?.payload?.alert_id;
    if (alertId && !latest.has(alertId)) latest.set(alertId, event.payload);
  }
  return latest;
}

function exceptionRows(today, exceptions, damage, events) {
  const latest = followUps(events);
  const linked = new Set();
  const rows = [];
  for (const record of exceptions?.exceptions || []) {
    const at = record.reported_at || record.created_at;
    if (localDay(at) !== today) continue;
    if (record.damage_report_id) linked.add(record.damage_report_id);
    const followUp = latest.get(`driver-exception:${record.exception_id}`);
    const status = followUp?.status || null;
    rows.push({
      key: `exception-${record.exception_id}`,
      at,
      kind: record.kind,
      detail: record.note || "",
      truck: record.truck_code || null,
      state: status === "RESOLVED" ? "handled" : status ? "seen" : "open",
      note: followUp?.note || "",
    });
  }
  for (const report of damage?.reports || []) {
    if (localDay(report.created_at) !== today || linked.has(report.report_id)) continue;
    rows.push({
      key: `damage-${report.report_id}`,
      at: report.created_at,
      kind: "damage",
      detail: report.component || "",
      severity: report.severity,
      truck: report.truck_code || null,
      state: report.status === "selesai" ? "handled" : "open",
      note: "",
    });
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function carriedItems(damage, plans, tomorrow) {
  const workshop = (damage?.reports || [])
    .filter((report) => report.severity === "berat" && report.status !== "selesai")
    .map((report) => ({
      key: `damage-${report.report_id}`,
      truck: report.truck_code,
      component: report.component,
    }));
  const plan = (plans || []).find((candidate) => candidate.plan_date === tomorrow) || null;
  return { workshop, plan };
}

export async function loadReports() {
  const today = jakartaDate();
  const tomorrow = jakartaDate(1);
  const dates = Array.from({ length: DAYS }, (_, index) => jakartaDate(index - (DAYS - 1)));
  const [recaps, exceptions, damage, events, plans, suitability, forecast, valueModel] = await Promise.all([
    Promise.allSettled(dates.map((date) => apiGet(`/recap/daily?date=${date}`))),
    Promise.allSettled([apiGet("/driver/exceptions")]),
    Promise.allSettled([apiGet("/damage-reports")]),
    Promise.allSettled([apiGet("/alert/follow-ups")]),
    Promise.allSettled([apiGet("/operations/plans?status=approved&limit=100")]),
    Promise.allSettled([apiGet("/ml/suitability")]),
    // Tomorrow's tonnes come from the same forecast the Tomorrow page prints, not the plan's demand.
    Promise.allSettled([apiGet(`/forecast/tomorrow?date=${tomorrow}`)]),
    // Value per 1,000 gate trips: SIMULATED x ASSUMPTION, the same queue simulation as the TPA tab.
    Promise.allSettled([apiGet("/reports/value-model")]),
  ]);
  const days = recaps.map((result, index) => ({ date: dates[index], recap: value(result) }));
  const recap = days[days.length - 1].recap;
  if (!recap) throw new Error("recap unavailable");
  const damageBody = value(damage[0]);
  const planList = value(plans[0]);
  return {
    today,
    tomorrow,
    recap,
    days,
    exceptions: exceptionRows(today, value(exceptions[0]), damageBody, value(events[0])),
    carried: carriedItems(damageBody, planList, tomorrow),
    backtest: value(suitability[0])?.monthly_backtest?.landfill_month || null,
    tomorrowTons: value(forecast[0])?.total_tonnage_t ?? null,
    valueModel: value(valueModel[0]),
  };
}
