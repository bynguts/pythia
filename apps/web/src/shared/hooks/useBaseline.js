import { useEffect, useState } from "react";
import { apiGet } from "../api/client.js";

// The one "today" every workspace prints (GET /api/baseline/today): today's
// forecast weather, no event, the twin's own default frame. Forecast, Planning
// and Twin read their "today" headline from it, so the numbers agree.
const REFRESH_MS = 5 * 60 * 1000;

export function useBaseline(days = 7) {
  const [baseline, setBaseline] = useState(null);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiGet(`/baseline/today?days=${days}`)
        .then((body) => {
          if (cancelled) return;
          setBaseline(body);
          setStatus("online");
        })
        .catch(() => {
          if (!cancelled) setStatus((current) => (current === "online" ? current : "offline"));
        });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [days]);

  return { baseline, status };
}

// A what-if on one day of the baseline week (GET /api/baseline/scenario). Rain 0
// keeps that day's forecast rain; attendance 0 means no event. Same shape as the
// baseline, with `kind: "scenario"` when rain or attendance is set.
export function fetchOutlook({ rainfall = 0, attendance = 0, venue, lat, lng, date, days = 7 } = {}, init) {
  const params = new URLSearchParams({
    rainfall_mm: String(rainfall || 0),
    event_attendance: String(attendance || 0),
    days: String(days),
  });
  if (date) params.set("date", date);
  if (venue) params.set("venue", venue);
  if (lat != null && lng != null) {
    params.set("event_lat", String(lat));
    params.set("event_lng", String(lng));
  }
  return apiGet(`/baseline/scenario?${params.toString()}`, init);
}

// "52 aktif / 59 unit": the fleet denominator every screen shows.
export function fleetDenominator(t, fleet) {
  if (!fleet) return "—";
  return t("w10num_fleet_denominator").replace("{active}", fleet.active).replace("{total}", fleet.total);
}
