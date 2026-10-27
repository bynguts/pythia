// Pure derivations for the Fleet & drivers screen.
import { clockTime, jakartaToday } from "../readiness/clock.js";

const WEEK_MS = 7 * 24 * 3600 * 1000;
const JAKARTA = "Asia/Jakarta";

// Display thresholds of the "Drivers this week" table (the API returns raw percentages).
export const PROOF_OK_PCT = 95;
export const ON_TIME_OK_PCT = 80;

export const isOpen = (report) => report.status === "baru";
export const isMajor = (report) => report.severity === "berat";

// Roadworthy = the fleet less every truck off the road: open major damage or in the
// workshop (the status overview's damaged trucks), so it agrees with "N in the workshop".
export function damageStats(reports, totalTrucks, workshopCodes = []) {
  const open = reports.filter(isOpen);
  const openTrucks = new Set(open.map((r) => r.truck_code));
  const majorTrucks = new Set(open.filter(isMajor).map((r) => r.truck_code));
  const fixedThisWeek = reports.filter(
    (r) => r.status === "selesai" && r.resolved_at && Date.now() - Date.parse(r.resolved_at) <= WEEK_MS,
  );
  return {
    open,
    fixedThisWeek,
    openTruckCount: openTrucks.size,
    majorCount: majorTrucks.size,
    workshopCount: workshopCodes.length,
    roadworthy:
      totalTrucks == null
        ? null
        : Math.max(0, totalTrucks - new Set([...majorTrucks, ...workshopCodes]).size),
  };
}

// "05:06" for today, "Sun" within the last week, "12 Oct" before that.
export function sinceLabel(iso, locale) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "—";
  const day = (value) => new Intl.DateTimeFormat("en-CA", { timeZone: JAKARTA }).format(value);
  if (day(at) === jakartaToday()) return clockTime(iso);
  const options =
    Date.now() - at.getTime() < WEEK_MS ? { weekday: "short" } : { day: "numeric", month: "short" };
  return new Intl.DateTimeFormat(locale, { timeZone: JAKARTA, ...options }).format(at);
}

// "Wed 28 Oct" for a YYYY-MM-DD date.
export function dueLabel(date, locale) {
  const at = new Date(`${date}T12:00:00+07:00`);
  if (Number.isNaN(at.getTime())) return date;
  return new Intl.DateTimeFormat(locale, {
    timeZone: JAKARTA,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(at);
}

// "Wed" for a YYYY-MM-DD date.
export function weekdayLabel(date, locale) {
  const at = new Date(`${date}T12:00:00+07:00`);
  if (Number.isNaN(at.getTime())) return date;
  return new Intl.DateTimeFormat(locale, { timeZone: JAKARTA, weekday: "short" }).format(at);
}

// truck_code -> earliest booked service date (today or later) from the service records.
export function bookedByTruck(records) {
  const today = jakartaToday();
  const map = {};
  for (const record of records) {
    if (!record.service_date || record.service_date < today) continue;
    if (!map[record.truck_code] || record.service_date < map[record.truck_code]) {
      map[record.truck_code] = record.service_date;
    }
  }
  return map;
}

// The busiest drivers on duty now, highest hours first.
export function dutyRows(safety, driverByTruck, limit = 6) {
  if (!safety) return [];
  return safety.trucks
    .filter((truck) => truck.duty_minutes > 0)
    .sort((a, b) => b.duty_minutes - a.duty_minutes)
    .slice(0, limit)
    .map((truck) => ({
      truck_code: truck.truck_code,
      name: driverByTruck[truck.truck_code] || truck.truck_code,
      minutes: truck.duty_minutes,
      state: truck.duty_state,
      override: Boolean(truck.override),
      simulated: truck.classification === "SIMULATED",
    }));
}
