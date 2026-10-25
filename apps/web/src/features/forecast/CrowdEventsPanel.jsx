import { useState, useEffect } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Calendar, Workflow } from "lucide-react";

export function CrowdEventsPanel({ onSimulateEvent }) {
  const { t } = useLanguage();
  const [events, setEvents] = useState([]);

  async function fetchEvents() {
    try {
      const res = await apiFetch("/events/permits");
      if (res.ok) setEvents(await res.json());
    } catch {
      // API unreachable: keep the previously loaded events
    }
  }

  useEffect(() => {
    fetchEvents();
  }, []);

  return (
    <section className="panel events-panel">
      <div className="panel-title">
        <div>
          <h2>{t("w10num_ev_title")}</h2>
          <p>{t("w10num_ev_sub")}</p>
        </div>
        <div className="panel-header-icon-wrap">
          <Calendar size={18} />
        </div>
      </div>

      <div className="events-list">
        {events.map((ev) => (
          <div className="event-item-card" key={ev.id}>
            <div className="event-header">
              <h3>{ev.name}</h3>
              <span className="permit">{ev.permit_number}</span>
            </div>
            <p className="location">
              {ev.location_name}
              {ev.data_class === "SIMULATED" && (
                <>
                  {" "}
                  <span className="pill provenance-sim">{t("honesty_sim_badge")}</span>
                </>
              )}
            </p>
            <div className="event-body">
              <div className="event-metric">
                <span>{t("w10num_ev_waste")}</span>
                <strong>{ev.predicted_waste_tons} t</strong>
              </div>
              <div className="event-metric">
                <span>{t("w10num_ev_crews")}</span>
                <strong>
                  {t("w10num_ev_crews_value")
                    .replace("{crews}", ev.crews_required)
                    .replace("{workers}", ev.workers_required)
                    .replace("{hours}", ev.man_hours_required)}
                </strong>
              </div>
              <div className="event-metric">
                <span>{t("w10num_ev_trucks")}</span>
                <strong>{t("w10num_ev_trucks_value").replace("{n}", ev.trucks_required)}</strong>
              </div>
              <div className="event-metric">
                <span>{t("w10num_ev_bins")}</span>
                <strong>{ev.bins_required}</strong>
              </div>
            </div>
            {onSimulateEvent && (
              <button className="ghost-button event-simulate-button" onClick={() => onSimulateEvent(ev)}>
                <Workflow size={14} /> {t("w10num_ev_plan")}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
