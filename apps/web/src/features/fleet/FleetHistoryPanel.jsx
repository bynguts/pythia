import { useState, useEffect } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";

// H2: these trips are rebuilt from the route model for whatever date is picked;
// the panel says so in both languages instead of reading as archived AVL logs.
// Teardown v4 F9: history lives in the truck drawer, one truck at a time, today first.
export function FleetHistoryPanel({ truckCode }) {
  const { t, lang } = useLanguage();
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [history, setHistory] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ truck_code: truckCode });
    if (date) params.append("date", date);
    apiFetch(`/fleet/history?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => !cancelled && setHistory(rows))
      .catch(() => !cancelled && setHistory([]));
    return () => {
      cancelled = true;
    };
  }, [truckCode, date]);

  // The backend labels every record (record_note, English); show it, translated.
  const backendNote = history.find((trip) => trip.record_note)?.record_note;
  const number = (value) => Number(value).toLocaleString(localeFor(lang), { maximumFractionDigits: 1 });

  return (
    <section className="trip-history" id="history-panel" data-testid="fleet-history-surface">
      <p className="history-record-note" data-testid="history-record-note">
        <span className="pill warning">{t("pln6_hist_badge")}</span>{" "}
        <span title={backendNote || undefined}>{t("pln6_hist_note")}</span>
      </p>
      <label className="trip-history-date">
        {t("pln6_hist_date")}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      {history.length === 0 ? (
        <p className="rail-empty">{t("pln6_hist_empty")}</p>
      ) : (
        <ul className="trip-list">
          {history.map((trip) => {
            const devCount = trip.deviations_count ?? trip.deviations_detected ?? 0;
            return (
              <li key={`${trip.truck_code}-${trip.date}`}>
                <span>
                  <b>{t("w10fleet_trip_line").replace("{km}", number(trip.distance_km))}</b>
                  <small>
                    {t("w10fleet_trip_meta")
                      .replace("{l}", number(trip.fuel_consumed_liters))
                      .replace("{n}", String(trip.points?.length || 0))}
                  </small>
                </span>
                <span className={`pill ${devCount > 0 ? "danger" : "success"}`}>
                  {devCount > 0
                    ? t("pln6_hist_deviations").replace("{n}", String(devCount))
                    : t("pln6_hist_compliant")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
