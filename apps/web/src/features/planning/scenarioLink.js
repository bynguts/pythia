// The hand-off into Rencana (shared by the numbers and twin screens):
// /planning?scenario=<id>&rain_mm=<n>&attendance=<n>&venue=<gbk|jis|monas>&lat=&lng=&lanes=<n>&date=<YYYY-MM-DD>
// Every parameter is optional; without them Rencana starts from today's baseline.
// `lanes` (open weighbridge lanes, 1..WEIGHBRIDGE_LANES) changes only the simulated TPA queue.

import { WEIGHBRIDGE_LANES } from "../twin/twinLinks.js";

export function planningScenarioPath({
  scenario = "custom",
  rainfall,
  attendance,
  venue,
  lat,
  lng,
  lanes,
  date,
} = {}) {
  const params = new URLSearchParams({ scenario });
  if (rainfall > 0) params.set("rain_mm", String(rainfall));
  if (attendance > 0) params.set("attendance", String(attendance));
  if (venue) params.set("venue", venue);
  if (lat != null && lng != null) {
    params.set("lat", String(lat));
    params.set("lng", String(lng));
  }
  if (lanes) params.set("lanes", String(lanes));
  if (date) params.set("date", date);
  return `/planning?${params.toString()}`;
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

export function readPlanningScenario(searchParams) {
  const id = searchParams.get("scenario");
  if (!id) return null;
  const lat = searchParams.get("lat");
  const lng = searchParams.get("lng");
  const date = searchParams.get("date");
  const lanes = Number(searchParams.get("lanes"));
  return {
    id: /^[a-z0-9_-]{1,40}$/i.test(id) ? id : "custom",
    rainfall: number(searchParams.get("rain_mm")),
    attendance: Math.round(number(searchParams.get("attendance"))),
    venue: searchParams.get("venue") || null,
    lat: lat != null && lng != null && Number.isFinite(Number(lat)) ? Number(lat) : null,
    lng: lat != null && lng != null && Number.isFinite(Number(lng)) ? Number(lng) : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : null,
    // Only a closure counts: all lanes open (or a nonsense value) is no lane scenario.
    lanes: Number.isInteger(lanes) && lanes >= 1 && lanes < WEIGHBRIDGE_LANES ? lanes : null,
  };
}
