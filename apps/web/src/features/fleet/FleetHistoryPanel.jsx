import { useState, useEffect } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { History, Calendar } from "lucide-react";

// H2: these trips are rebuilt from the route model for whatever date is picked;
// the panel says so in both languages instead of reading as archived AVL logs.
export function FleetHistoryPanel({ filterTruck, setFilterTruck }) {
  const { t } = useLanguage();
  const [date, setDate] = useState(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  const [history, setHistory] = useState([]);

  async function loadHistory() {
    try {
      const params = new URLSearchParams();
      if (filterTruck && filterTruck !== "ALL") params.append("truck_code", filterTruck);
      if (date) params.append("date", date);
      const res = await apiFetch(`/fleet/history?${params.toString()}`);
      if (!res.ok) throw new Error("no api");
      setHistory(await res.json());
    } catch {
      setHistory([]);
    }
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterTruck, date]);

  // The backend labels every record (record_note, English); show it, translated.
  const backendNote = history.find((trip) => trip.record_note)?.record_note;

  return (
    <section className="panel wide" id="history-panel">
      <div className="panel-title">
        <div>
          <h2>{t("pln6_hist_title")}</h2>
          <p>{t("pln6_hist_sub")}</p>
        </div>
        <div className="panel-header-icon-wrap">
          <History size={18} />
        </div>
      </div>
      <p className="history-record-note" data-testid="history-record-note">
        <span className="pill warning">{t("pln6_hist_badge")}</span>{" "}
        <span title={backendNote || undefined}>{t("pln6_hist_note")}</span>
      </p>
      <div className="history-filter-panel">
        <span className="history-title">
          <Calendar size={16} /> {t("pln6_hist_filter")}
        </span>
        <label>
          {t("pln6_hist_truck")}
          <select value={filterTruck} onChange={(e) => setFilterTruck(e.target.value)}>
            <option value="ALL">{t("pln6_hist_all")}</option>
            <option value="T-001">T-001</option>
            <option value="T-047">T-047</option>
            <option value="T-112">T-112</option>
          </select>
        </label>
        <label>
          {t("pln6_hist_date")}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col" style={{ width: "16%" }}>
                {t("pln6_hist_truck")}
              </th>
              <th scope="col" style={{ width: "18%" }}>
                {t("pln6_hist_driver")}
              </th>
              <th scope="col" style={{ width: "16%" }}>
                {t("pln6_hist_date")}
              </th>
              <th scope="col" style={{ width: "14%" }}>
                {t("pln6_hist_distance")}
              </th>
              <th scope="col" style={{ width: "12%" }}>
                {t("pln6_hist_fuel")}
              </th>
              <th scope="col" style={{ width: "12%" }}>
                {t("pln6_hist_points")}
              </th>
              <th scope="col" style={{ width: "12%" }}>
                {t("pln6_hist_deviation")}
              </th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 ? (
              <tr>
                <td className="table-empty-state" colSpan={7}>
                  {t("pln6_hist_empty")}
                </td>
              </tr>
            ) : (
              history.map((trip) => {
                const devCount = trip.deviations_count ?? trip.deviations_detected ?? 0;
                return (
                  <tr key={`${trip.truck_code}-${trip.date}`}>
                    <td>
                      <span className="plate-badge">{trip.truck_code}</span>
                    </td>
                    <td>
                      <strong style={{ color: "var(--ui-ink)", fontWeight: 600 }}>{trip.driver_name}</strong>
                    </td>
                    <td>
                      <span
                        style={{
                          fontFamily: "var(--mono, monospace)",
                          fontSize: "12px",
                          color: "var(--ui-muted)",
                        }}
                      >
                        {trip.date}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontFamily: "var(--mono, monospace)", fontWeight: 600 }}>
                        {trip.distance_km} km
                      </span>
                    </td>
                    <td>
                      <span style={{ fontFamily: "var(--mono, monospace)", color: "var(--ui-muted)" }}>
                        {trip.fuel_consumed_liters} L
                      </span>
                    </td>
                    <td>
                      <span className="speed-badge">
                        {t("pln6_hist_pts").replace("{n}", String(trip.points?.length || 0))}
                      </span>
                    </td>
                    <td>
                      <span className={`pill ${devCount > 0 ? "danger" : "success"}`}>
                        <span className={`status-dot ${devCount > 0 ? "danger" : "success"}`} />
                        {devCount > 0
                          ? t("pln6_hist_deviations").replace("{n}", String(devCount))
                          : t("pln6_hist_compliant")}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
